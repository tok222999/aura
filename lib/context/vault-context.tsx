/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import {
  AssetSymbol,
  AuraTransaction,
  ChainId,
  PrivacyBufferMode,
  PrivateBalanceState,
} from '@/lib/types/aura'
import { zcashEnclaveService } from '@/lib/services/zcash-enclave-service'
import { useWallet } from './wallet-context'
import { shouldAcceptTenantActivityResponse } from '@/lib/utils/tenant-sync'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { createBaseDepositProofMessage } from '@/lib/crypto/base-relayer'
import { createRequestId, logStructuredEvent, safeErrorMessage } from '@/lib/utils/observability'

export interface DepositProgress {
  baseTxHash?: string
  zcashTxid?: string
  baseConfirmed?: boolean
  zcashConfirmed?: boolean
  transaction?: AuraTransaction
  step?: number
  logTag?: string
  logMessage?: string
}

export interface SendProgress {
  step: number
  tag: string
  message: string
  tx?: AuraTransaction
  explorerUrl?: string
  explorerLabel?: string
}

export interface PendingDepositTransfer {
  amount: number
  amountOnChain: number
  asset: 'USDC' | 'ETH'
  chain: 'base'
  txHash: string
  senderAddress: string
  isDemoWallet: boolean
  tenantId?: string
}

interface VaultContextType {
  privateBalance: PrivateBalanceState
  transactions: AuraTransaction[]
  loadingTransactions: boolean
  privacyPolicy: PrivacyBufferMode
  pendingDepositTransfer: PendingDepositTransfer | null
  clearPendingDepositTransfer: () => void
  setPrivacyPolicy: (policy: PrivacyBufferMode) => void
  refreshTransactions: (
    filter?: string,
    policyOverride?: PrivacyBufferMode,
    options?: RefreshTransactionsOptions,
  ) => Promise<AuraTransaction[]>
  executeDeposit: (
    asset: AssetSymbol,
    amount: number,
    chain?: ChainId,
    type?: 'deposit' | 'receive',
    recipientAddress?: string,
    onProgress?: (progress: DepositProgress) => void
  ) => Promise<AuraTransaction | null>
  executeSend: (
    recipient: string,
    asset: AssetSymbol,
    amount: number,
    chain?: ChainId,
    bufferMode?: PrivacyBufferMode,
    onProgress?: (progress: SendProgress) => void
  ) => Promise<AuraTransaction | null>
  executeWithdraw: (
    asset: AssetSymbol,
    amount: number,
    chain?: ChainId,
    recipient?: string,
    onProgress?: (progress: SendProgress) => void
  ) => Promise<AuraTransaction | null>
  resetDemoData: () => Promise<void>
}

const DEFAULT_BALANCE_STATE: PrivateBalanceState = {
  totalUsd: 0,
  zecEquivalent: null,
  shieldedZecBalance: null,
  onChainZecBackedUsd: null,
  zcashAccountAddress: undefined,
  zcashStateSynced: false,
  availableToSendUsd: 0,
  fastAvailableToSendUsd: null,
  immatureBufferedZec: 0,
  readyToSpendUsd: 0,
  shieldedWaitRemainingUsd: 0,
  shieldedWaitHoursRemaining: 0,
  privacyPolicy: 'fast',
  unconfirmedUsd: 0,
  vaultSynced: false,
  orchardPoolSynced: false,
  lastSyncedAt: 0,
  enclaveKeyFingerprint: 'vault_local_enclave',
  syncStatus: 'syncing',
}

const VaultContext = createContext<VaultContextType | undefined>(undefined)
const PENDING_DEPOSIT_TRANSFER_KEY = 'aura_pending_deposit_transfer_v2'
const LEGACY_PENDING_DEMO_TRANSFER_KEY = 'aura_pending_demo_transfer_v1'

interface RefreshTransactionsOptions {
  /** Readiness checks must prove the active tenant's chain-backed balance. */
  requireAuthoritativeBalance?: boolean
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const { wallet, debitPublicBalance, refreshDemoWallet } = useWallet()

  const [privateBalance, setPrivateBalance] = useState<PrivateBalanceState>(DEFAULT_BALANCE_STATE)
  // Keep the read policy in a ref so changing the jury selector does not
  // recreate refreshTransactions and fire a second/third initial Zcash sync.
  // The first page load should have one authoritative read, not a serialized
  // queue of identical wallet commands.
  const privateBalanceRef = useRef(privateBalance)
  privateBalanceRef.current = privateBalance
  const [transactions, setTransactions] = useState<AuraTransaction[]>([])
  const [loadingTransactions, setLoadingTransactions] = useState(false)
  const refreshRequestIdRef = useRef(0)
  const syncRetryCountRef = useRef(0)
  const syncRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)
  const refreshTransactionsRef = useRef<((filter?: string) => Promise<AuraTransaction[]>) | null>(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (syncRetryTimerRef.current) {
        clearTimeout(syncRetryTimerRef.current)
        syncRetryTimerRef.current = null
      }
    }
  }, [])
  const [enclaveFingerprint, setEnclaveFingerprint] = useState('vault_local_enclave')
  const [pendingDepositTransfer, setPendingDepositTransfer] = useState<PendingDepositTransfer | null>(null)

  useEffect(() => {
    try {
      const current = localStorage.getItem(PENDING_DEPOSIT_TRANSFER_KEY)
      const legacy = localStorage.getItem(LEGACY_PENDING_DEMO_TRANSFER_KEY)
      const stored = JSON.parse(current || legacy || 'null')
      const parsed = !current && stored
        ? { ...stored, amountOnChain: stored.amount, asset: 'USDC', chain: 'base', isDemoWallet: true }
        : stored
      if (
        Number.isFinite(parsed?.amount) && parsed.amount > 0 && parsed.amount <= 1_000_000 &&
        Number.isFinite(parsed?.amountOnChain) && parsed.amountOnChain > 0 &&
        ['USDC', 'ETH'].includes(parsed?.asset) && parsed?.chain === 'base' &&
        /^0x[a-fA-F0-9]{64}$/.test(parsed?.txHash || '') &&
        /^0x[a-fA-F0-9]{40}$/.test(parsed?.senderAddress || '')
      ) {
        const restored: PendingDepositTransfer = {
          ...parsed,
          isDemoWallet: Boolean(parsed.isDemoWallet),
        }
        if (restored.isDemoWallet && (restored.asset !== 'USDC' || restored.amount > 1000)) return
        setPendingDepositTransfer(restored)
        if (!current) localStorage.setItem(PENDING_DEPOSIT_TRANSFER_KEY, JSON.stringify(restored))
        localStorage.removeItem(LEGACY_PENDING_DEMO_TRANSFER_KEY)
      }
    } catch {
      // Ignore malformed browser cache; no funds are inferred from it.
    }
  }, [])
  const rememberPendingDepositTransfer = useCallback((transfer: PendingDepositTransfer | null) => {
    setPendingDepositTransfer(transfer)
    if (typeof window === 'undefined') return
    try {
      if (transfer) {
        const payload = { ...transfer, tenantId: transfer.tenantId || enclaveFingerprint }
        localStorage.setItem(PENDING_DEPOSIT_TRANSFER_KEY, JSON.stringify(payload))
      } else {
        localStorage.removeItem(PENDING_DEPOSIT_TRANSFER_KEY)
      }
      if (!transfer) localStorage.removeItem(LEGACY_PENDING_DEMO_TRANSFER_KEY)
    } catch {
      // The transaction can still be resumed during this page session.
    }
  }, [enclaveFingerprint])

  // Initialize Enclave
  useEffect(() => {
    if (typeof window !== 'undefined') {
      let cancelled = false
      void zcashEnclaveService.getOrCreateEnclaveKey().then((enclave) => {
        if (cancelled) return
        setEnclaveFingerprint(enclave.fingerprint)
        setPrivateBalance((prev) => ({
          ...prev,
          enclaveKeyFingerprint: enclave.fingerprint,
        }))
      }).catch((error) => {
        console.error('Vault initialization failed', error)
      })
      return () => { cancelled = true }
    }
  }, [])

  /**
   * Single Source of Truth Ledger Sync
   * Queries the server-side persistent ledger for the authoritative tenant transactions and balance.
   */
  const refreshTransactions = useCallback(
    async (
      filter: string = 'all',
      policyOverride?: PrivacyBufferMode,
      options?: RefreshTransactionsOptions,
    ): Promise<AuraTransaction[]> => {
      const requestId = ++refreshRequestIdRef.current
      const requireAuthoritativeBalance = options?.requireAuthoritativeBalance === true
      setLoadingTransactions(true)
      try {
        const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
        const authorization = await zcashEnclaveService.signVaultActionLocally('read_activity')
        const clientRequestId = createRequestId('activity-client')
        const policy = policyOverride || privateBalanceRef.current.privacyPolicy || 'private'
        const res = await fetch(`/api/activity?filter=${encodeURIComponent(filter)}&policy=${encodeURIComponent(policy)}`, {
          headers: {
            'x-aura-request-id': clientRequestId,
            'x-aura-enclave-fingerprint': enclave.fingerprint,
            'x-aura-auth-timestamp': String(authorization.clientTimestamp),
            'x-aura-auth-nonce': authorization.nonce,
            'x-aura-auth-public-key': authorization.authPublicKey,
            'x-aura-auth-signature': authorization.signature,
          },
        })
        const responseText = await res.text()
        let json: {
          success?: boolean
          data?: AuraTransaction[]
          error?: unknown
          tenantId?: unknown
          balance?: any
        } | null = null
        try {
          json = responseText ? JSON.parse(responseText) : null
        } catch {
          json = null
        }
        if (!res.ok || !json?.success || !json?.data) {
          const serverError = typeof json?.error === 'string' ? json.error : ''
          const failure = new Error(serverError || `Activity sync returned HTTP ${res.status || 'unknown'}.`) as Error & {
            code?: string
            status?: number
            requestId?: string
          }
          failure.code = serverError || (res.status >= 500 ? 'ACTIVITY_SYNC_FAILED' : 'EMPTY_ACTIVITY_RESPONSE')
          failure.status = res.status
          failure.requestId = res.headers.get('x-aura-request-id') || clientRequestId
          throw failure
        }
        // Recovery can finish while an earlier request is still in flight.
        // Never let an old tenant or an older response overwrite the active
        // tenant's authoritative balance in the UI.
        const currentEnclave = await zcashEnclaveService.getOrCreateEnclaveKey()
        const juryTenant = wallet.isDemoWallet ? wallet.demoTenantId || '' : ''
        const tenantResponseAccepted = juryTenant
          ? String(json.tenantId || '') === juryTenant
          : shouldAcceptTenantActivityResponse(
              requestId,
              refreshRequestIdRef.current,
              String(json.tenantId || ''),
              enclave.fingerprint,
              currentEnclave.fingerprint,
            )
        if (!tenantResponseAccepted || requestId !== refreshRequestIdRef.current) {
          if (requireAuthoritativeBalance) {
            const staleFailure = new Error('The active tenant activity sync was superseded; readiness is not confirmed.') as Error & { code?: string }
            staleFailure.code = 'ACTIVITY_SYNC_STALE'
            throw staleFailure
          }
          return []
        }
        if (json.success && json.data) {
          if (syncRetryTimerRef.current) {
            clearTimeout(syncRetryTimerRef.current)
            syncRetryTimerRef.current = null
          }
          syncRetryCountRef.current = 0
          const txs: AuraTransaction[] = json.data
          const authoritativeBalanceAvailable = json.balance?.balanceAvailable === true &&
            json.balance?.zcashStateSynced === true &&
            typeof json.balance?.onChainZecBackedUsd === 'number'
          if (requireAuthoritativeBalance && !authoritativeBalanceAvailable) {
            const balanceFailure = new Error('The active tenant activity and chain-backed balance sync did not complete.') as Error & { code?: string }
            balanceFailure.code = 'AUTHORITATIVE_BALANCE_SYNC_FAILED'
            throw balanceFailure
          }
          // Irreversible destination recovery is an explicit POST job. The
          // activity GET above remains read-only and only returns the current
          // ledger state.
          for (const tx of txs) {
            if (
              (tx.type === 'send' || tx.type === 'withdraw') &&
              tx.status === 'routing_shielded' &&
              tx.legs?.shielded?.txHash &&
              (!tx.legs?.delivery?.txHash || tx.legs.delivery.status === 'failed')
            ) {
              try {
                const reconcileAuth = await zcashEnclaveService.signVaultActionLocally('reconcile_settlement', tx.id)
                // Do not hold the activity screen in a loading state while a
                // background settlement job checks Zcash and the destination
                // relayer. The read above already returned the authoritative
                // transaction snapshot; the server worker remains the liveness
                // path and the next refresh will show its result.
                void fetch('/api/settlement/reconcile', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-aura-enclave-fingerprint': enclave.fingerprint,
                    'x-aura-auth-timestamp': String(reconcileAuth.clientTimestamp),
                    'x-aura-auth-nonce': reconcileAuth.nonce,
                    'x-aura-auth-public-key': reconcileAuth.authPublicKey,
                    'x-aura-auth-signature': reconcileAuth.signature,
                  },
                  body: JSON.stringify({ txId: tx.id }),
                }).catch(() => undefined)
              } catch {
                // The next scheduled refresh can retry the explicit job.
              }
            }
          }
          setTransactions(txs)

          if (pendingDepositTransfer) {
            const matchingSettledTx = txs.find(
              (t) =>
                t.legs?.deposit?.txHash?.toLowerCase() === pendingDepositTransfer.txHash.toLowerCase() &&
                t.status === 'completed' &&
                t.legs?.shielded?.status === 'confirmed'
            )
            if (matchingSettledTx) {
              rememberPendingDepositTransfer(null)
            }
          }

          // Reconcile Authoritative Balance from Server State
          const chainBalanceAvailable = authoritativeBalanceAvailable
          let cleanBalance = typeof json.balance?.totalUsd === 'number'
            ? json.balance.totalUsd
            : 0
          // The API returns the selected policy's matured amount in
          // `readyToSpendUsd`, while `fastAvailableToSendUsd` is the
          // confirmed shielded amount available to the Fast policy. The jury
          // route intentionally uses Fast, so keep the client card and Pay
          // screen on the same authoritative number instead of showing the
          // older 24-hour subset beside a ready Quick Demo.
          const selectedPolicy = policyOverride || privateBalanceRef.current.privacyPolicy || 'private'
          let readyToSpend = selectedPolicy === 'fast' &&
            typeof json.balance?.fastAvailableToSendUsd === 'number'
            ? json.balance.fastAvailableToSendUsd
            : typeof json.balance?.readyToSpendUsd === 'number'
              ? json.balance.readyToSpendUsd
              : cleanBalance
          let unconfirmed = json.balance?.unconfirmedUsd ?? 0

          // A policy-ready amount is a subset of the authoritative private
          // balance. If an older response races a fresh chain reconciliation
          // and violates that ordering, keep the UI truthful instead of
          // showing "$0 total" beside a spendable mature balance.
          if (readyToSpend > cleanBalance) cleanBalance = readyToSpend

          if (!json.balance) {
            let balance = 0
            for (const tx of txs) {
              if (tx.status === 'completed') {
                if (tx.type === 'deposit' || tx.type === 'receive') {
                  balance += tx.toAmount
                } else if (tx.type === 'send' || tx.type === 'withdraw') {
                  balance -= tx.fromAmount
                }
              } else if (
                tx.status === 'shielded' ||
                tx.status === 'initiated' ||
                tx.status === 'locking_collateral' ||
                tx.status === 'routing_near' ||
                tx.status === 'settling_destination' ||
                tx.status === 'routing_shielded' ||
                tx.status === 'processing'
              ) {
                if (tx.type === 'send' || tx.type === 'withdraw') {
                  if (tx.legs?.delivery?.txHash) {
                    balance -= tx.fromAmount
                  }
                } else {
                  unconfirmed += tx.toAmount
                }
              }
            }
            cleanBalance = Math.max(0, Number(balance.toFixed(2)))
            readyToSpend = cleanBalance
          }

          const waitRemaining = Math.max(0, Number((cleanBalance - readyToSpend).toFixed(2)))
          const syncedZecBalance = typeof json.balance?.shieldedZecBalance === 'number'
            ? json.balance.shieldedZecBalance
            : null
          const syncedZecBackedUsd = typeof json.balance?.onChainZecBackedUsd === 'number'
            ? json.balance.onChainZecBackedUsd
            : null

          setPrivateBalance((prev) => ({
            ...prev,
            totalUsd: cleanBalance,
            readyToSpendUsd: readyToSpend,
            // The send/withdraw screens use this field as their local limit;
            // it must match the server's buffer-aware spendable amount.
            availableToSendUsd: readyToSpend,
            fastAvailableToSendUsd: chainBalanceAvailable && typeof json.balance?.fastAvailableToSendUsd === 'number'
              ? json.balance.fastAvailableToSendUsd
              : null,
            immatureBufferedZec: typeof json.balance?.immatureBufferedZec === 'number'
              ? json.balance.immatureBufferedZec
              : 0,
            shieldedWaitRemainingUsd: waitRemaining,
            shieldedZecBalance: syncedZecBalance,
            onChainZecBackedUsd: syncedZecBackedUsd,
            zcashAccountAddress: typeof json.balance?.zcashAccountAddress === 'string' ? json.balance.zcashAccountAddress : undefined,
            zcashStateSynced: Boolean(json.balance?.zcashStateSynced),
            // Never allow an internal ledger amount to exceed the confirmed
            // value currently available in this tenant's actual Zcash account.
            zecEquivalent: syncedZecBalance,
            unconfirmedUsd: unconfirmed,
            vaultSynced: true,
            orchardPoolSynced: Boolean(json.balance?.zcashStateSynced),
            lastSyncedAt: Date.now(),
            syncStatus: chainBalanceAvailable ? 'synced' : 'error',
          }))
          return txs
        }
        return []
      } catch (err) {
        if (!isMountedRef.current || requestId !== refreshRequestIdRef.current) {
          if (requireAuthoritativeBalance) throw err
          return []
        }
        const failure = err as Error & { code?: string; status?: number; requestId?: string }
        const retryable = !failure.status || failure.status === 429 || failure.status >= 500
        const retryAttempt = syncRetryCountRef.current
        logStructuredEvent('activity-client', 'sync_failed', {
          requestId: failure.requestId || 'local',
          code: failure.code || 'NETWORK_ERROR',
          status: failure.status ?? null,
          retryable,
          retryAttempt,
          error: safeErrorMessage(err),
        })

        if (retryable && syncRetryCountRef.current < 3) {
          const nextAttempt = syncRetryCountRef.current + 1
          syncRetryCountRef.current = nextAttempt
          const delayMs = failure.status === 429 ? 5000 : 750 * nextAttempt
          if (syncRetryTimerRef.current) clearTimeout(syncRetryTimerRef.current)
          syncRetryTimerRef.current = globalThis.setTimeout(() => {
            syncRetryTimerRef.current = null
            if (isMountedRef.current && requestId === refreshRequestIdRef.current) {
              const refresh = refreshTransactionsRef.current
              if (refresh) void refresh('all').catch(() => undefined)
            }
          }, delayMs)
        }

        setPrivateBalance((prev) => {
          // A transient RPC/lightwalletd failure is not proof that a balance
          // became zero. Keep the last verified chain-backed snapshot visible
          // while the scheduled retry runs; only a first-read failure should
          // put a fresh session into the unavailable state.
          const hasVerifiedSnapshot = prev.vaultSynced === true &&
            prev.zcashStateSynced === true &&
            typeof prev.onChainZecBackedUsd === 'number'
          return hasVerifiedSnapshot
            ? { ...prev, syncStatus: 'synced' }
            : { ...prev, vaultSynced: false, syncStatus: 'error' }
        })
        if (requireAuthoritativeBalance) throw err
        return []
      } finally {
        if (isMountedRef.current && requestId === refreshRequestIdRef.current) setLoadingTransactions(false)
      }
    },
    []
  )

  refreshTransactionsRef.current = refreshTransactions

  useEffect(() => {
    // The jury invite is the already-funded Fast path. Start its first
    // authoritative read with the same policy instead of briefly querying the
    // normal 24-hour subset and allowing that response to win the first frame.
    const initialPolicy = typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('tour') === '1'
      ? 'fast' as const
      : undefined
    void refreshTransactions('all', initialPolicy).catch(() => undefined)
  }, [refreshTransactions])

  // Demo activation can happen after the initial activity request. Re-read
  // once the browser has been bound to the explicitly provisioned jury tenant
  // so the first screen cannot remain on the previous tenant's unavailable
  // state.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleJuryTenantActivated = () => {
      // The jury tenant is backed by an already-confirmed shared Zcash source.
      // Keep the first read on the same policy as Quick Demo; otherwise the
      // page briefly shows the private 24-hour subset as "$0" and makes the
      // funded demo look unavailable until the user changes the selector.
      setPrivateBalance((prev) => ({
        ...prev,
        privacyPolicy: 'fast',
        shieldedWaitHoursRemaining: 0,
      }))
      void refreshTransactions('all', 'fast').catch(() => undefined)
    }
    window.addEventListener('aura:jury-tenant-activated', handleJuryTenantActivated)
    return () => window.removeEventListener('aura:jury-tenant-activated', handleJuryTenantActivated)
  }, [refreshTransactions])

  // The wallet and vault providers mount independently. On a fresh jury
  // browser the wallet can finish activation just before the event listener
  // above is attached, leaving the balance card stuck on "Preparing" even
  // though the signed activity read is healthy. Reconcile once per activated
  // tenant as a state-driven fallback; it is read-only and idempotent.
  const refreshedJuryTenantRef = useRef('')
  useEffect(() => {
    const juryTenantId = wallet.isDemoWallet ? wallet.demoTenantId || '' : ''
    if (!juryTenantId || refreshedJuryTenantRef.current === juryTenantId) return
    refreshedJuryTenantRef.current = juryTenantId
    setPrivateBalance((prev) => ({
      ...prev,
      privacyPolicy: 'fast',
      shieldedWaitHoursRemaining: 0,
    }))
    void refreshTransactions('all', 'fast').catch(() => undefined)
  }, [wallet.isDemoWallet, wallet.demoTenantId, refreshTransactions])

  useEffect(() => {
    const hasPendingSettlement = transactions.some((tx) =>
      (tx.type === 'send' || tx.type === 'withdraw') &&
      tx.status !== 'completed' && tx.status !== 'failed' &&
      Boolean(tx.legs?.shielded?.txHash || tx.legs?.delivery?.txHash)
    )
    if (!hasPendingSettlement) return
    const interval = setInterval(() => {
      void refreshTransactions('all').catch(() => undefined)
    }, 15_000)
    return () => clearInterval(interval)
  }, [transactions, refreshTransactions])

  const setPrivacyPolicy = useCallback((policy: PrivacyBufferMode) => {
    setPrivateBalance((prev) => {
      let hours = 24 // 1 Day (24h)
      if (policy === 'fast') {
        hours = 0
      } else if (policy === 'private') {
        hours = 24 // 1 Day (24h)
      } else if (policy === 'strong') {
        hours = 72 // 3 Days (72h)
      } else if (policy === 'custom') {
        hours = 168 // 7 Days (168h)
      }
      return {
        ...prev,
        privacyPolicy: policy,
        shieldedWaitHoursRemaining: hours,
      }
    })
    void refreshTransactions('all', policy).catch(() => undefined)
  }, [refreshTransactions])

  /**
   * Deposit: Shields public funds into private vault.
   * Decrements public balance, posts to server ledger, and resyncs.
   */
  const executeDeposit = useCallback(
    async (
      asset: AssetSymbol,
      amount: number,
      chain: ChainId = 'base',
      type: 'deposit' | 'receive' = 'deposit',
      recipientAddress?: string,
      onProgress?: (progress: DepositProgress) => void
    ): Promise<AuraTransaction | null> => {
      try {
        if (type === 'deposit' && chain !== 'base') {
          throw new Error('This deposit screen currently supports Base Sepolia only.')
        }
        if (type === 'deposit' && (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)) {
          throw new Error('Deposit amount must be greater than zero and no more than $1,000,000.')
        }
        if (type === 'deposit' && asset !== 'USDC') {
          throw new Error('The working demo accepts Base Sepolia USDC entry only.')
        }
        if (type === 'deposit' && Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
          throw new Error('Deposit amount must use no more than two decimal places.')
        }
        if (
          type === 'deposit' &&
          (!wallet.connected || (!wallet.isDemoWallet && wallet.walletProvider !== 'metamask' && wallet.walletProvider !== 'coinbase'))
        ) {
          throw new Error('Choose Try Demo or connect MetaMask / Coinbase Wallet before adding money.')
        }

        // Prepare and exercise the local authorization key before initiating
        // any on-chain transfer. If protected browser storage or signing is
        // unavailable, stop here so funds are never sent without a way to
        // authorize and record the matching deposit afterward.
        const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
        if (type === 'deposit') {
          const signingKey = await zcashEnclaveService.getOrCreateEcdsaKeyPair()
          await signingKey.sign(new TextEncoder().encode(`aura:deposit-preflight:${Date.now()}`))
        }

        let onChainTxHash: string | undefined = undefined
        let amountOnChain: number | undefined
        let depositSenderAddress = wallet.address
        const pendingTransfer = pendingDepositTransfer
        const canReusePendingDemoTransfer = Boolean(
          type === 'deposit' &&
          pendingTransfer &&
          wallet.isDemoWallet &&
          pendingTransfer.isDemoWallet &&
          pendingTransfer.asset === asset &&
          pendingTransfer.chain === chain &&
          pendingTransfer.amount === amount &&
          pendingTransfer.senderAddress.toLowerCase() === wallet.address.toLowerCase()
        )

        let depositConfig: { vaultAddress?: string; usdcContract?: string; chainId?: string } | null = null
        if (type === 'deposit' && !canReusePendingDemoTransfer) {
          // Authorize the readiness probe itself so it cannot provision or
          // inspect a Zcash account for an arbitrary tenant label.
          const configAuthorization = await zcashEnclaveService.signVaultActionLocally('deposit_config')
          const params = new URLSearchParams({ amount: String(amount), asset, tenantId: enclave.fingerprint })
          const configRes = await fetch(`/api/deposit/config?${params.toString()}`, {
            cache: 'no-store',
            headers: {
              'x-aura-enclave-fingerprint': configAuthorization.enclaveFingerprint,
              'x-aura-auth-timestamp': String(configAuthorization.clientTimestamp),
              'x-aura-auth-nonce': configAuthorization.nonce,
              'x-aura-auth-public-key': configAuthorization.authPublicKey,
              'x-aura-auth-signature': configAuthorization.signature,
            },
          })
          const config = await configRes.json().catch(() => ({}))
          if (
            !configRes.ok || !config.success || !config.ready ||
            typeof config.vaultAddress !== 'string' || typeof config.usdcContract !== 'string'
          ) {
            throw new Error(config.message || 'Deposit services are not ready. No funds were sent.')
          }
          depositConfig = config
        }

        if (type === 'deposit' && pendingTransfer) {
          const tenantMatches = !pendingTransfer.tenantId || pendingTransfer.tenantId === enclave.fingerprint
          if (!tenantMatches) {
            rememberPendingDepositTransfer(null)
          } else {
            const matches = pendingTransfer.amount === amount &&
              pendingTransfer.asset === asset && pendingTransfer.chain === chain &&
              pendingTransfer.isDemoWallet === wallet.isDemoWallet &&
              pendingTransfer.senderAddress.toLowerCase() === wallet.address.toLowerCase()
            if (!matches) {
              throw new Error(`A previous ${pendingTransfer.asset} transfer for $${pendingTransfer.amount.toFixed(2)} is still awaiting processing. Retry that exact deposit first, or discard it to start fresh.`)
            }
            onChainTxHash = pendingTransfer.txHash
            amountOnChain = pendingTransfer.amountOnChain
            depositSenderAddress = pendingTransfer.senderAddress
          }
        }

        if (type === 'deposit' && wallet.isDemoWallet) {
          if (asset !== 'USDC') {
            throw new Error('The sponsored demo transfer currently supports Base Sepolia test USDC only.')
          }
          let demoTransfer = pendingTransfer
          if (!demoTransfer) {
            // The HttpOnly sponsorship cookie expires sooner than the jury
            // session. Renew it before a new send, including after an idle
            // video-recording session. Never retry an uncertain broadcast.
            await refreshDemoWallet()
            const demoResponse = await fetch('/api/wallet/demo/deposit', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ amount, expectedAddress: wallet.address, tenantId: enclave.fingerprint }),
            })
            const demoResult = await demoResponse.json().catch(() => ({}))
            if (typeof demoResult.txHash === 'string' && typeof demoResult.senderAddress === 'string' && (demoResult.success || demoResult.pending)) {
              demoTransfer = {
                amount, amountOnChain: amount, asset: 'USDC', chain: 'base',
                txHash: demoResult.txHash, senderAddress: demoResult.senderAddress, isDemoWallet: true,
              }
              rememberPendingDepositTransfer(demoTransfer)
            }
            if (!demoResponse.ok && !demoResult.pending || !demoTransfer) {
              throw new Error(demoResult.message || demoResult.error || 'The demo wallet could not send a verified testnet deposit.')
            }
          }
          onChainTxHash = demoTransfer.txHash
          amountOnChain = demoTransfer.amountOnChain
          depositSenderAddress = demoTransfer.senderAddress
        }

        // Real On-Chain Execution: If user connected a real Web3 wallet (MetaMask / Coinbase)
        if (
          type === 'deposit' &&
          wallet.connected &&
          !wallet.isDemoWallet &&
          (wallet.walletProvider === 'metamask' || wallet.walletProvider === 'coinbase')
        ) {
          if (
            typeof window !== 'undefined' &&
            (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
          ) {
            const eth = (window as unknown as { ethereum: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
            const accounts = (await eth.request({ method: 'eth_accounts' })) as string[]
            const activeAccount = accounts?.[0]
            if (!activeAccount || activeAccount.toLowerCase() !== wallet.address.toLowerCase()) {
              throw new Error('The connected wallet account changed. Reconnect it before depositing.')
            }
            // Read the public payout configuration from the server so the wallet
            // cannot send to an address that the verifier is not watching.
            if (!depositConfig?.vaultAddress || !depositConfig.usdcContract || !depositConfig.chainId) {
              throw new Error('Deposit destination is unavailable. No funds were sent.')
            }
            const vaultDepositAddress = depositConfig.vaultAddress
            const baseSepoliaUsdc = depositConfig.usdcContract

            // Enforce Base Sepolia chain
            const currentChain = (await eth.request({ method: 'eth_chainId' })) as string
            if (currentChain !== depositConfig.chainId) {
              await eth.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: depositConfig.chainId }],
              })
              const switchedChain = (await eth.request({ method: 'eth_chainId' })) as string
              if (switchedChain !== depositConfig.chainId) {
                throw new Error('Wallet did not switch to Base Sepolia. The deposit was not sent.')
              }
            }

            if (!pendingTransfer) {
              try {
                const cleanRecipient = vaultDepositAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')
                const usdcUnits = BigInt(Math.max(1, Math.round(amount * 1e6)))
                amountOnChain = Number(usdcUnits) / 1e6
                const amountHex = usdcUnits.toString(16).padStart(64, '0')
                const transferData = `0xa9059cbb${cleanRecipient}${amountHex}`
                onChainTxHash = (await eth.request({
                  method: 'eth_sendTransaction',
                  params: [{
                    from: wallet.address,
                    to: baseSepoliaUsdc,
                    data: transferData,
                    value: '0x0',
                  }],
                })) as string
                if (typeof onChainTxHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(onChainTxHash)) {
                  throw new Error('Wallet returned an invalid transaction hash.')
                }
                rememberPendingDepositTransfer({
                  amount,
                  amountOnChain: amountOnChain!,
                  asset: asset as 'USDC' | 'ETH',
                  chain: 'base',
                  txHash: onChainTxHash,
                  senderAddress: wallet.address,
                  isDemoWallet: false,
                })
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                console.warn('Wallet transaction rejected or failed:', err)
                throw new Error(`Wallet transaction cancelled: ${msg}`)
              }
            }
          }

          if (type === 'deposit' && !onChainTxHash) {
            throw new Error('Could not send the deposit from the connected wallet. No funds were recorded.')
          }
        }

        if (onChainTxHash) {
          onProgress?.({
            step: 1,
            baseTxHash: onChainTxHash,
            baseConfirmed: false,
            logTag: 'BASE',
            logMessage: `Transaction broadcasted to Base Sepolia (${onChainTxHash.slice(0, 10)}...). Waiting for block confirmation (~2-3s)...`,
          })
        }

        let baseWalletProof: { message: string; signature: string } | undefined
        if (type === 'deposit' && onChainTxHash && !wallet.isDemoWallet && wallet.connected) {
          const eth = (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
          if (!eth || !amountOnChain) throw new Error('Connected Base wallet proof is unavailable. No deposit was credited.')
          const message = createBaseDepositProofMessage({
            tenantId: enclave.fingerprint,
            amountUsd: amount,
            amountOnChain,
            asset,
            chain,
            txHash: onChainTxHash,
            senderAddress: depositSenderAddress,
          })
          const messageHex = `0x${Array.from(new TextEncoder().encode(message)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
          const signature = await eth.request({ method: 'personal_sign', params: [messageHex, depositSenderAddress] })
          if (typeof signature !== 'string') throw new Error('Base wallet did not return a deposit proof. No deposit was credited.')
          baseWalletProof = { message, signature }
        }

        let res: Response | undefined
        let json: { success?: boolean; transaction?: AuraTransaction; message?: string; error?: string } = {}
        for (let attempt = 0; attempt < 3; attempt++) {
          // A retriable shielding failure explicitly means no Zcash broadcast
          // occurred. Re-sign the SAME confirmed Base hash with a fresh nonce;
          // never send a second public-chain transfer during this loop.
          const clientSignature = type === 'deposit' && onChainTxHash
            ? await zcashEnclaveService.signDepositLocally(amount, amountOnChain!, asset, chain, onChainTxHash, depositSenderAddress, baseWalletProof)
            : undefined
          onProgress?.({
            step: 2,
            baseTxHash: onChainTxHash,
            baseConfirmed: false,
            logTag: 'ENCLAVE',
            logMessage: 'Base Sepolia receipt received ✓ Server is verifying the transfer and private-balance backing...',
          })
          res = await fetch('/api/deposit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-aura-enclave-fingerprint': enclave.fingerprint,
            },
            body: JSON.stringify({
              asset,
              amount,
              chain,
              type,
              recipientAddress,
              bufferMode: privateBalance.privacyPolicy || 'private',
              enclaveFingerprint: enclave.fingerprint,
              onChainTxHash,
              clientSignature,
            }),
          })
          json = await res.json().catch(() => ({}))
          if (json.transaction) {
            const zTx = json.transaction.legs?.shielded?.txHash
            const inventoryBacked = json.transaction.settlementMode === 'jury_inventory' && json.transaction.backingSource === 'confirmed_zcash_inventory'
            const isConfirmed = json.transaction.status === 'completed' && json.transaction.legs?.shielded?.status === 'confirmed'
            onProgress?.({
              step: isConfirmed ? 4 : 3,
              baseTxHash: onChainTxHash || json.transaction.legs?.deposit?.txHash,
              baseConfirmed: json.transaction.legs?.deposit?.status === 'confirmed',
              zcashTxid: zTx,
              zcashConfirmed: isConfirmed,
              transaction: json.transaction,
              logTag: isConfirmed ? 'CONFIRMED' : 'ZCASH',
              logMessage: isConfirmed
                ? inventoryBacked
                  ? `Confirmed Zcash inventory allocated ✓ Balance credited +$${amount.toFixed(2)}!`
                  : `Shielded note confirmed on Zcash testnet ✓ Balance credited +$${amount.toFixed(2)}!`
                : zTx
                ? `Shielded transaction broadcasted to Zcash testnet (${zTx.slice(0, 10)}...). Waiting for block confirmation...`
                : 'Allocating shielded inventory in Zcash testnet pool...',
            })
          }
          if (res.ok || json.error !== 'SHIELDED_PAYOUT_UNAVAILABLE' || attempt === 2) break
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
        }

        if (res?.ok && json.success && json.transaction) {
          const zTx = json.transaction.legs?.shielded?.txHash
          const inventoryBacked = json.transaction.settlementMode === 'jury_inventory' && json.transaction.backingSource === 'confirmed_zcash_inventory'
          const isConfirmed = json.transaction.status === 'completed' && json.transaction.legs?.shielded?.status === 'confirmed'
          onProgress?.({
            step: isConfirmed ? 4 : 3,
            baseTxHash: onChainTxHash || json.transaction.legs?.deposit?.txHash,
            baseConfirmed: true,
            zcashTxid: zTx,
            zcashConfirmed: isConfirmed,
            transaction: json.transaction,
            logTag: isConfirmed ? 'SETTLED' : 'ZCASH',
            logMessage: isConfirmed
              ? inventoryBacked
                ? `Base transfer confirmed and backed by confirmed Zcash inventory ✓ +$${amount.toFixed(2)} added to Private Balance!`
                : `Shielded note confirmed on-chain ✓ +$${amount.toFixed(2)} added to Private Balance!`
              : `Shielded transaction broadcasted (${zTx?.slice(0, 10)}...). Confirming on Zcash testnet...`,
          })
          // If this was a self-deposit from connected wallet, debit public wallet
          if (type === 'deposit') {
            if (isConfirmed) {
              rememberPendingDepositTransfer(null)
            }
            if (wallet.isDemoWallet) {
              await refreshDemoWallet()
            } else {
              debitPublicBalance(amount)
            }
          }
          await refreshTransactions()
          return json.transaction
        }
        const pendingFinalityErrors = new Set([
          'TX_NOT_CONFIRMED',
          'BASE_TX_NOT_FINALIZED',
          'BASE_FINALITY_UNAVAILABLE',
        ])
        if (pendingFinalityErrors.has(json.error || '')) {
          const pendingError = new Error(
            json.message || 'Base Sepolia received the deposit. Waiting for the required finality before shielding.'
          ) as Error & { code?: string; pendingFinality?: boolean; txHash?: string; transaction?: AuraTransaction }
          pendingError.code = json.error
          pendingError.pendingFinality = true
          pendingError.txHash = onChainTxHash
          pendingError.transaction = json.transaction
          throw pendingError
        }
        if (json.error === 'TX_ALREADY_USED') {
          const inFlightError = new Error(
            json.message || 'This transaction is already being processed or has already been credited.'
          ) as Error & { code?: string; pendingFinality?: boolean; txHash?: string; transaction?: AuraTransaction }
          inFlightError.code = json.error
          inFlightError.pendingFinality = true
          inFlightError.txHash = onChainTxHash
          inFlightError.transaction = json.transaction
          throw inFlightError
        }
        if (json.error === 'DEMO_DEPOSIT_TENANT_MISMATCH' || (json as { canDiscard?: boolean })?.canDiscard) {
          rememberPendingDepositTransfer(null)
        }
        throw new Error(json.message || json.error || 'Failed to deposit funds into private vault.')
      } catch (err) {
        console.error('Execute deposit error', err)
        throw err
      }
    },
    [wallet, debitPublicBalance, pendingDepositTransfer, refreshDemoWallet, refreshTransactions, rememberPendingDepositTransfer, privateBalance.privacyPolicy]
  )

  /**
   * Spend / Send: Spends from private vault to an external destination.
   * Signs with client intent commitment, verifies balance, updates ledger.
   */
  const executeSend = useCallback(
    async (
      recipient: string,
      asset: AssetSymbol,
      amount: number,
      chain: ChainId = 'solana',
      bufferMode: PrivacyBufferMode = 'private',
      onProgress?: (progress: SendProgress) => void
    ): Promise<AuraTransaction | null> => {
      try {
        onProgress?.({
          step: 1,
          tag: 'ENCLAVE',
          message: 'Authorizing spend intent with client vault enclave key...',
        })
        const quoteAuthorization = await zcashEnclaveService.signVaultActionLocally('quote_request')
        const tenantId = quoteAuthorization.enclaveFingerprint

        onProgress?.({
          step: 2,
          tag: 'QUOTE',
          message: `Acquiring conversion quote for $${amount.toFixed(2)} ${asset} and calculating zero-knowledge privacy snapshot...`,
        })
        const quoteResponse = await fetch('/api/spend/quote', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-aura-enclave-fingerprint': tenantId,
            'x-aura-auth-timestamp': String(quoteAuthorization.clientTimestamp),
            'x-aura-auth-nonce': quoteAuthorization.nonce,
            'x-aura-auth-public-key': quoteAuthorization.authPublicKey,
            'x-aura-auth-signature': quoteAuthorization.signature,
          },
          body: JSON.stringify({
            type: 'send',
            amount,
            asset,
            chain,
            bufferMode,
            enclaveFingerprint: tenantId,
          }),
        })
        const quotePayload = await quoteResponse.json().catch(() => ({}))
        if (!quoteResponse.ok || !quotePayload.success || !quotePayload.quote) {
          throw new Error(quotePayload.message || quotePayload.error || 'A fresh settlement quote is unavailable.')
        }
        const quote = quotePayload.quote

        onProgress?.({
          step: 3,
          tag: 'SIGN',
          message: `Locally signing spend authorization: ${quote.amountZec.toFixed(4)} ZEC equivalent to ${recipient.slice(0, 8)}...`,
        })
        const clientSignature = await zcashEnclaveService.signShieldedSpendLocally(quote.amountZec, recipient, {
          amountUsd: amount,
          asset,
          chain,
          transactionType: 'send',
          bufferMode,
          quoteId: quote.quoteId,
          quoteZecUsd: quote.quoteZecUsd,
          quoteSolUsd: quote.quoteSolUsd,
          quoteExpiresAt: quote.expiresAt,
          privacyRiskHash: quote.privacyRiskHash,
        })

        onProgress?.({
          step: 4,
          tag: 'ZCASH',
          message: 'Allocating shielded note & broadcasting spend to Zcash Testnet...',
        })
        const res = await fetch('/api/spend', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-aura-enclave-fingerprint': clientSignature.enclaveFingerprint,
          },
          body: JSON.stringify({
            type: 'send',
            recipient,
            asset,
            amount,
            chain,
            bufferMode,
            clientSignature,
            enclaveFingerprint: clientSignature.enclaveFingerprint,
            settlementQuote: quote,
          }),
        })

        const json = await res.json()
        if (res.ok && json.transaction && (json.success || json.pendingConfirmation || json.pendingSettlement)) {
          const zTx = json.transaction.legs?.shielded?.txHash
          const delTx = json.transaction.legs?.delivery?.txHash
          if (zTx) {
            onProgress?.({
              step: 4,
              tag: 'ZCASH',
              message: `Zcash shielded spend broadcasted (txid: ${zTx.slice(0, 12)}...).`,
              explorerUrl: `https://testnet.cipherscan.app/tx/${zTx}`,
              explorerLabel: 'View on Zcash Explorer ↗',
              tx: json.transaction,
            })
          }
          if (delTx) {
            onProgress?.({
              step: 5,
              tag: 'SOLANA',
              message: `Destination payout submitted on ${chain.toUpperCase()} (sig: ${delTx.slice(0, 12)}...).`,
              explorerUrl: chain.toLowerCase() === 'solana' ? `https://solscan.io/tx/${delTx}?cluster=devnet` : `https://sepolia.basescan.org/tx/${delTx}`,
              explorerLabel: `View on ${chain.toLowerCase() === 'solana' ? 'Solscan' : 'BaseScan'} ↗`,
              tx: json.transaction,
            })
          }
          // The payout relayer may finalize a few seconds after /api/spend
          // returns. Re-read the authoritative ledger briefly so the Pay page
          // cannot remain on a stale "pending" snapshot after Solana is
          // already finalized. This is read-only and never rebroadcasts.
          let effectiveTransaction: AuraTransaction = json.transaction
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const refreshedTransactions = await refreshTransactions()
            const refreshedTransaction = refreshedTransactions.find((item) => item.id === json.transaction.id)
            if (refreshedTransaction) effectiveTransaction = refreshedTransaction
            if (hasCompletedDestinationDelivery(effectiveTransaction) || effectiveTransaction.status === 'failed') break
            if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 1500))
          }
          const destinationConfirmed = hasCompletedDestinationDelivery(effectiveTransaction)
          onProgress?.({
            step: 6,
            tag: destinationConfirmed ? 'FINALIZED' : 'PENDING',
            message: destinationConfirmed
              ? `Private payment confirmed! Funds sent to ${recipient.slice(0, 8)}... on ${chain.toUpperCase()} ✓`
              : `Private payment is queued. Waiting for ${chain.toUpperCase()} destination confirmation.`,
            tx: effectiveTransaction,
          })
          return effectiveTransaction
        }
        const failure = new Error(json.message || json.error || 'Failed to execute private payment.') as Error & { code?: string }
        failure.code = typeof json.error === 'string' ? json.error : undefined
        throw failure
      } catch (err) {
        console.error('Execute send error', err)
        throw err
      }
    },
    [refreshTransactions]
  )

  /**
   * Withdraw: Exits private balance to a destination address.
   * Section 8 Accounting Fix: Only credit public wallet balance if recipient IS the user's connected wallet!
   */
  const executeWithdraw = useCallback(
    async (
      asset: AssetSymbol,
      amount: number,
      chain: ChainId = 'solana',
      recipient?: string,
      onProgress?: (progress: SendProgress) => void
    ): Promise<AuraTransaction | null> => {
      try {
        onProgress?.({
          step: 1,
          tag: 'ENCLAVE',
          message: 'Authorizing withdrawal from private vault enclave...',
        })
        const quoteAuthorization = await zcashEnclaveService.signVaultActionLocally('quote_request')
        const tenantId = quoteAuthorization.enclaveFingerprint
        const targetRecipient = recipient || wallet.address

        onProgress?.({
          step: 2,
          tag: 'QUOTE',
          message: `Requesting settlement quote for $${amount.toFixed(2)} ${asset} exit...`,
        })
        const quoteResponse = await fetch('/api/spend/quote', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-aura-enclave-fingerprint': tenantId,
            'x-aura-auth-timestamp': String(quoteAuthorization.clientTimestamp),
            'x-aura-auth-nonce': quoteAuthorization.nonce,
            'x-aura-auth-public-key': quoteAuthorization.authPublicKey,
            'x-aura-auth-signature': quoteAuthorization.signature,
          },
          body: JSON.stringify({
            type: 'withdraw',
            amount,
            asset,
            chain,
            bufferMode: 'fast',
            enclaveFingerprint: tenantId,
          }),
        })
        const quotePayload = await quoteResponse.json().catch(() => ({}))
        if (!quoteResponse.ok || !quotePayload.success || !quotePayload.quote) {
          throw new Error(quotePayload.message || quotePayload.error || 'A fresh settlement quote is unavailable.')
        }
        const quote = quotePayload.quote

        onProgress?.({
          step: 3,
          tag: 'SIGN',
          message: `Locally signing withdrawal authorization for ${targetRecipient.slice(0, 8)}...`,
        })
        const clientSignature = await zcashEnclaveService.signShieldedSpendLocally(quote.amountZec, targetRecipient, {
          amountUsd: amount,
          asset,
          chain,
          transactionType: 'withdraw',
          bufferMode: 'fast',
          quoteId: quote.quoteId,
          quoteZecUsd: quote.quoteZecUsd,
          quoteSolUsd: quote.quoteSolUsd,
          quoteExpiresAt: quote.expiresAt,
          privacyRiskHash: quote.privacyRiskHash,
        })

        onProgress?.({
          step: 4,
          tag: 'ZCASH',
          message: 'Relaying withdrawal note to Zcash Testnet shielded pool...',
        })
        const res = await fetch('/api/spend', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-aura-enclave-fingerprint': clientSignature.enclaveFingerprint,
          },
          body: JSON.stringify({
            type: 'withdraw',
            recipient: targetRecipient,
            asset,
            amount,
            chain,
            bufferMode: 'fast',
            clientSignature,
            enclaveFingerprint: clientSignature.enclaveFingerprint,
            settlementQuote: quote,
          }),
        })

        const json = await res.json()
        if (res.ok && json.transaction && (json.success || json.pendingConfirmation || json.pendingSettlement)) {
          const delTx = json.transaction.legs?.delivery?.txHash
          if (delTx) {
            onProgress?.({
              step: 5,
              tag: 'RELAY',
              message: `Withdrawal payout broadcast to ${chain.toUpperCase()} (sig: ${delTx.slice(0, 12)}...).`,
              explorerUrl: chain.toLowerCase() === 'solana' ? `https://solscan.io/tx/${delTx}?cluster=devnet` : `https://sepolia.basescan.org/tx/${delTx}`,
              explorerLabel: `View on ${chain.toLowerCase() === 'solana' ? 'Solscan' : 'BaseScan'} ↗`,
              tx: json.transaction,
            })
          }
          // A demo relayer payout can change the public balance only after the RPC
          // reports it. Never add a local, synthetic balance for a confirmed send.
          const isConfirmed = hasCompletedDestinationDelivery(json.transaction)
          if (isConfirmed && wallet.isDemoWallet && refreshDemoWallet) {
            await refreshDemoWallet()
          }

          await refreshTransactions()
          onProgress?.({
            step: 6,
            tag: 'FINALIZED',
            message: `Withdrawal confirmed on ${chain.toUpperCase()} ✓`,
            tx: json.transaction,
          })
          return json.transaction
        }
        throw new Error(json.message || json.error || 'Failed to execute withdrawal.')
      } catch (err) {
        console.error('Execute withdraw error', err)
        throw err
      }
    },
    [refreshTransactions, refreshDemoWallet, wallet.address, wallet.isDemoWallet]
  )

  const resetDemoData = useCallback(async () => {
    try {
      const authorization = await zcashEnclaveService.signVaultActionLocally('reset_vault')
      await fetch('/api/demo/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authorization),
      })
      if (refreshDemoWallet) {
        await refreshDemoWallet()
      }
      await refreshTransactions()
    } catch (err) {
      console.error('Demo reset error', err)
    }
  }, [refreshDemoWallet, refreshTransactions])

  return (
    <VaultContext.Provider
      value={{
        privateBalance,
        transactions,
        loadingTransactions,
        privacyPolicy: privateBalance.privacyPolicy,
        pendingDepositTransfer,
        clearPendingDepositTransfer: () => rememberPendingDepositTransfer(null),
        setPrivacyPolicy,
        refreshTransactions,
        executeDeposit,
        executeSend,
        executeWithdraw,
        resetDemoData,
      }}
    >
      {children}
    </VaultContext.Provider>
  )
}

export function useVault() {
  const context = useContext(VaultContext)
  if (!context) {
    throw new Error('useVault must be used within a VaultProvider')
  }
  return context
}
