/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { AuraLogo } from '@/components/aura-logo'
import { OdometerCounter } from '@/components/odometer-counter'
import { CryptoIcon } from '@/components/crypto-icon'
import { UnlinkabilityModal } from '@/components/unlinkability-modal'
import { VaultSecurityModal } from '@/components/vault-security-modal'
import { useAura } from '@/lib/context/aura-context'
import { AssetSymbol, ChainId, AuraTransaction } from '@/lib/types/aura'
import { formatAuraTx } from '@/lib/utils'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { NetworkRouteSelector } from '@/components/network-route-selector'
import { DEMO_DESTINATION_NETWORKS, DEMO_ENTRY_NETWORKS, PUBLIC_ASSET_CAPABILITIES, PUBLIC_DESTINATION_ASSET_OPTIONS } from '@/lib/config/capabilities'
import { PrivateBalanceExplainer } from '@/components/private-balance-explainer'
import { LiveProtocolStream, ProtocolLogEntry } from '@/components/live-protocol-stream'
import {
  ZapIcon,
  SparkleIcon,
  ShieldIcon,
  SlidersIcon,
  PlusIcon,
  ArrowUpRightIcon,
  ArrowDownIcon,
  RefreshIcon,
  CloseIcon,
  ArrowRightIcon,
  CheckIcon,
  WalletIcon,
  ClockIcon,
} from '@/components/aura-icons'

export default function BalancePage() {
  const {
    privateBalance,
    executeDeposit,
    executeWithdraw,
    transactions,
    refreshTransactions,
    resyncBalance,
    resetDemoData,
    setPrivacyPolicy,
    wallet,
    connectWallet,
    refreshDemoWallet,
    rates,
    isLive,
    pendingDepositTransfer,
  } = useAura()
  // Read the query string after hydration. Reading window during the initial
  // state calculation made the server render the normal balance layout while
  // the browser rendered the jury layout, which triggered a hydration error.
  const [isJuryTour, setIsJuryTour] = useState(false)
  useEffect(() => {
    setIsJuryTour(new URLSearchParams(window.location.search).get('tour') === '1')
  }, [])

  // The jury path is intentionally the fast, already-funded route. Keep the
  // balance card on the same policy as the Quick Demo before the walkthrough
  // opens; otherwise the first frame can show the private 24-hour-ready amount
  // while the Quick preflight correctly allows the mature fast balance.
  useEffect(() => {
    if (isJuryTour && privateBalance.privacyPolicy !== 'fast') {
      setPrivacyPolicy('fast')
    }
  }, [isJuryTour, privateBalance.privacyPolicy, setPrivacyPolicy])

  // Auto-refresh demo wallet balances from live Base Sepolia RPC
  useEffect(() => {
    if (wallet.isDemoWallet && refreshDemoWallet) {
      refreshDemoWallet()
    }
  }, [wallet.isDemoWallet, refreshDemoWallet])
  const [activeModal, setActiveModal] = useState<'none' | 'add' | 'withdraw'>('none')
  const [walletConnectionError, setWalletConnectionError] = useState<string | null>(null)
  const [withdrawAmount, setWithdrawAmount] = useState('5.00')
  const [showSecurityModal, setShowSecurityModal] = useState(false)
  const [depositAmount, setDepositAmount] = useState('1.00')
  const [depositStatus, setDepositStatus] = useState<'idle' | 'moving' | 'done' | 'pending'>('idle')
  const [depositTx, setDepositTx] = useState<AuraTransaction | null>(null)
  const [depositBaseTxHash, setDepositBaseTxHash] = useState<string | null>(null)
  const [depositZcashTxid, setDepositZcashTxid] = useState<string | null>(null)
  const [depositBaseConfirmed, setDepositBaseConfirmed] = useState<boolean>(false)
  const [depositZcashConfirmed, setDepositZcashConfirmed] = useState<boolean>(false)
  const [depositLogs, setDepositLogs] = useState<ProtocolLogEntry[]>([])
  const [depositError, setDepositError] = useState<string | null>(null)

  const openAddMoney = async (amount?: number) => {
    setWalletConnectionError(null)

    // The jury URL uses the provisioned demo wallet. Start that session before
    // opening Add Money so the modal never opens in a misleading disconnected
    // state while the automatic jury activation is still settling.
    const juryRoute = isJuryTour || (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('tour') === '1'
    )
    if ((juryRoute || wallet.isDemoWallet) && !wallet.connected) {
      try {
        await connectWallet('demo')
      } catch (error) {
        setWalletConnectionError(error instanceof Error ? error.message : 'Could not start the demo wallet.')
        return
      }
    }

    if (amount !== undefined) {
      setDepositAmount(amount.toFixed(2))
    }
    setDepositStatus('idle')
    setActiveModal('add')
  }

  const addDepositLog = (tag: string, message: string, type: ProtocolLogEntry['type'] = 'info', explorerUrl?: string, explorerLabel?: string) => {
    const time = new Date().toLocaleTimeString()
    setDepositLogs((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].message === message) return prev
      return [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          time,
          tag,
          message,
          type,
          explorerUrl,
          explorerLabel,
        },
      ]
    })
  }

  const [pendingDepositAmount, setPendingDepositAmount] = useState<number | null>(null)
  const [selectedDepositAsset, setSelectedDepositAsset] = useState<AssetSymbol>('USDC')
  const [selectedDepositChain, setSelectedDepositChain] = useState<ChainId>('base')

  // A deposit can finish on the server after this page is closed. Restore the
  // local watcher from the durable browser record so the next visit continues
  // the same transaction instead of leaving a stale "shielding" banner on
  // screen. This never credits funds; refreshTransactions still requires the
  // confirmed Zcash shielded leg before clearing the pending record.
  useEffect(() => {
    if (
      !pendingDepositTransfer ||
      !wallet.isDemoWallet ||
      depositStatus !== 'idle'
    ) return

    setPendingDepositAmount(pendingDepositTransfer.amount)
    setDepositBaseTxHash((current) => current || pendingDepositTransfer.txHash)
    setDepositStatus('pending')
  }, [pendingDepositTransfer, wallet.isDemoWallet, depositStatus])

  const activeBaseTxHash = depositBaseTxHash ||
    depositTx?.legs?.deposit?.txHash ||
    pendingDepositTransfer?.txHash ||
    null

  const activeBaseConfirmed = depositBaseConfirmed ||
    depositTx?.legs?.deposit?.status === 'confirmed' ||
    false

  const activeInventoryBacked = Boolean(
    depositTx?.settlementMode === 'jury_inventory' &&
    depositTx.backingSource === 'confirmed_zcash_inventory',
  )

  // A pooled backing allocation is not a per-deposit Zcash transaction. Never
  // render a pool allocation as a made-up txid or as an on-chain confirmation.
  const activeZcashTxid = activeInventoryBacked
    ? null
    : depositZcashTxid || depositTx?.legs?.shielded?.txHash || null

  const activeZcashConfirmed = !activeInventoryBacked && Boolean(
    (depositZcashConfirmed || depositTx?.legs?.shielded?.status === 'confirmed') &&
    activeZcashTxid,
  )

  const [withdrawStatus, setWithdrawStatus] = useState<'idle' | 'sending' | 'done' | 'pending'>('idle')
  const [withdrawTxHash, setWithdrawTxHash] = useState<string | null>(null)
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [selectedWithdrawAsset, setSelectedWithdrawAsset] = useState<AssetSymbol>('SOL')
  const [selectedWithdrawChain, setSelectedWithdrawChain] = useState<ChainId>('solana')
  const [withdrawDestination, setWithdrawDestination] = useState('')
  const [withdrawAcknowledgedWarning, setWithdrawAcknowledgedWarning] = useState(false)
  const [inspectTx, setInspectTx] = useState<AuraTransaction | null>(null)

  // Once a public deposit exists, keep polling the same durable intent. This
  // never creates a second Base transfer; the context reuses its persisted tx.
  // Connected wallets are excluded because retrying their proof would reopen a
  // wallet signature prompt; the sponsored demo wallet is fully automatic.
  useEffect(() => {
    if (depositStatus !== 'pending' || !wallet.isDemoWallet || pendingDepositAmount === null) return
    let cancelled = false
    let attempts = 0
    const timer = window.setInterval(async () => {
      if (cancelled || attempts >= 360) return
      attempts += 1

      // If the shielded note was already broadcast to Zcash, check ledger confirmation instead of re-posting deposit
      if (depositZcashTxid || depositTx) {
        try {
          const txs = await refreshTransactions('all')
          if (cancelled) return
          const target = txs.find((t) =>
            (depositZcashTxid && t.legs?.shielded?.txHash?.toLowerCase() === depositZcashTxid.toLowerCase()) ||
            (depositBaseTxHash && t.legs?.deposit?.txHash?.toLowerCase() === depositBaseTxHash.toLowerCase()) ||
            (depositTx && t.id === depositTx.id)
          )
          if (target) {
            setDepositTx(target)
            if (target.legs?.deposit?.status === 'confirmed') setDepositBaseConfirmed(true)
            if (target.legs?.shielded?.txHash) setDepositZcashTxid(target.legs.shielded.txHash)
            const targetUsesPool = target.settlementMode === 'jury_inventory' && target.backingSource === 'confirmed_zcash_inventory'
            const isConfirmed = target.status === 'completed' && (
              targetUsesPool || Boolean(target.legs?.shielded?.status === 'confirmed' && target.legs?.shielded?.txHash)
            )
            if (isConfirmed) {
              setDepositBaseConfirmed(true)
              setDepositZcashConfirmed(!targetUsesPool)
              setDepositStatus('done')
              setPendingDepositAmount(null)
              setDepositError(null)
              window.clearInterval(timer)
              return
            }
          }
        } catch {
          // Keep polling smoothly
        }
        return
      }

      try {
        const tx = await executeDeposit(
          'USDC',
          pendingDepositAmount,
          'base',
          'deposit',
          undefined,
          (progress) => {
            if (progress.baseTxHash) setDepositBaseTxHash(progress.baseTxHash)
            if (progress.baseConfirmed !== undefined) setDepositBaseConfirmed(progress.baseConfirmed)
            if (progress.zcashTxid) setDepositZcashTxid(progress.zcashTxid)
            if (progress.zcashConfirmed !== undefined) setDepositZcashConfirmed(progress.zcashConfirmed)
            if (progress.transaction) setDepositTx(progress.transaction)
          }
        )
        if (cancelled) return
        if (tx) {
          setDepositTx(tx)
          if (tx.legs?.deposit?.txHash) setDepositBaseTxHash(tx.legs.deposit.txHash)
          if (tx.legs?.deposit?.status === 'confirmed') setDepositBaseConfirmed(true)
          if (tx.legs?.shielded?.txHash) setDepositZcashTxid(tx.legs.shielded.txHash)
          const usesPoolBacking = tx.settlementMode === 'jury_inventory' && tx.backingSource === 'confirmed_zcash_inventory'
          const isShieldedConfirmed = tx.status === 'completed' && (
            usesPoolBacking || Boolean(tx.legs?.shielded?.status === 'confirmed' && tx.legs?.shielded?.txHash)
          )
          if (isShieldedConfirmed) {
            setDepositBaseConfirmed(true)
            setDepositZcashConfirmed(!usesPoolBacking)
            setDepositStatus('done')
            setPendingDepositAmount(null)
            setDepositError(null)
            void refreshTransactions()
            window.clearInterval(timer)
          }
        }
      } catch (error) {
        if (cancelled) return
        const failure = error as Error & { pendingFinality?: boolean; txHash?: string; transaction?: AuraTransaction; code?: string }
        if (failure.txHash) setDepositBaseTxHash(failure.txHash)
        if (failure.transaction) setDepositTx(failure.transaction)
        if (failure.pendingFinality || failure.code === 'TX_ALREADY_USED' || failure.message?.includes('already being processed')) {
          // In-flight or already claimed; do not display error banner
          return
        }
        setDepositError(failure instanceof Error ? failure.message : 'The same deposit is still processing.')
        window.clearInterval(timer)
      }
      if (attempts >= 360 && !cancelled) {
        setDepositError('The same deposit is still processing. No second transfer was sent; the saved transaction remains available in Activity.')
        window.clearInterval(timer)
      }
    }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [depositStatus, executeDeposit, pendingDepositAmount, wallet.isDemoWallet, depositZcashTxid, depositTx, depositBaseTxHash, refreshTransactions])

  const curTot = privateBalance.totalUsd || 0
  const publicBalanceKnown = wallet.balanceSource === 'onchain' || wallet.balanceSource === 'sandbox_usdc'
  const publicUsdcBalance = wallet.publicUsdcBalance ?? 0
  const privateBalanceUnavailable = !privateBalance.vaultSynced ||
    privateBalance.syncStatus === 'error' ||
    privateBalance.zcashStateSynced !== true ||
    privateBalance.onChainZecBackedUsd == null
  // The jury invite uses the Fast policy. Keep every balance presentation on
  // that same authoritative chain-backed field; otherwise the card can show
  // the normal 24-hour subset while Quick Demo correctly sees the full Fast
  // amount.
  const juryFastReadyUsd = isJuryTour && typeof privateBalance.fastAvailableToSendUsd === 'number'
    ? privateBalance.fastAvailableToSendUsd
    : null
  const displayedReadyUsd = juryFastReadyUsd ?? privateBalance.readyToSpendUsd
  const displayedWaitingUsd = juryFastReadyUsd === null
    ? privateBalance.shieldedWaitRemainingUsd
    : Math.max(0, Number((curTot - juryFastReadyUsd).toFixed(2)))

  const completedPrivatePayments = transactions
    .filter((transaction) => transaction.type === 'send' && transaction.status === 'completed')
    .sort((a, b) => b.createdAt - a.createdAt)
  const latestPrivatePayment = completedPrivatePayments[0] || null

  // The balance screen is the jury's starting point. Keep stale failed
  // experiments out of this compact preview; the full Activity page remains
  // the honest audit trail for every attempt, including failures.
  const recentBalanceActivity = transactions
    .filter((transaction) => transaction.status !== 'failed')
    .slice(0, 3)

  // Show an incoming banner only for a live deposit transaction. The server's
  // unconfirmed aggregate can outlive a terminal failed row after a retry
  // expires; rendering it directly would make a failed deposit look pending.
  const activeIncomingDeposit = transactions.find((transaction) => {
    if (transaction.type !== 'deposit' && transaction.type !== 'receive') return false
    const matchesPendingTransfer = pendingDepositTransfer?.txHash
      ? transaction.legs?.deposit?.txHash?.toLowerCase() === pendingDepositTransfer.txHash.toLowerCase()
      : true
    if (!matchesPendingTransfer) return false
    if (transaction.status === 'completed' || transaction.status === 'failed') return false
    if (transaction.legs?.deposit?.status === 'failed' || transaction.legs?.shielded?.status === 'failed') return false
    return transaction.status === 'processing' ||
      transaction.status === 'initiated' ||
      transaction.status === 'locking_base' ||
      transaction.status === 'routing_shielded' ||
      transaction.status === 'shielded' ||
      transaction.status === 'settling_destination' ||
      transaction.legs?.deposit?.status === 'pending' ||
      transaction.legs?.shielded?.status === 'broadcasting'
  })
  const incomingDepositUsd = activeIncomingDeposit?.toAmount ?? 0
  const incomingDepositUsesPoolBacking = Boolean(
    activeIncomingDeposit?.settlementMode === 'jury_inventory' &&
    activeIncomingDeposit.backingSource === 'confirmed_zcash_inventory',
  )

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setDepositError(null)
    const val = parseFloat(depositAmount)
    if (isNaN(val) || val <= 0) {
      setDepositError('Please enter a valid deposit amount.')
      return
    }
    setDepositStatus('moving')
    setDepositBaseTxHash(null)
    setDepositZcashTxid(null)
    setDepositBaseConfirmed(false)
    setDepositZcashConfirmed(false)
    setDepositLogs([])
    addDepositLog('INIT', `Submitting $${val.toFixed(2)} ${selectedDepositAsset} deposit on Base Sepolia...`, 'pending')
    try {
      const tx = await executeDeposit(
        selectedDepositAsset,
        val,
        selectedDepositChain,
        'deposit',
        undefined,
        (progress) => {
          if (progress.baseTxHash) {
            setDepositBaseTxHash(progress.baseTxHash)
            addDepositLog('BASE', `Broadcasted to Base Sepolia (${progress.baseTxHash.slice(0, 10)}...). Waiting for block confirmation (~2-3s)...`, 'pending', `https://sepolia.basescan.org/tx/${progress.baseTxHash}`, 'View on BaseScan ↗')
          }
          if (progress.baseConfirmed !== undefined) {
            setDepositBaseConfirmed(progress.baseConfirmed)
            if (progress.baseConfirmed) {
              addDepositLog('CONFIRMED', 'Base Sepolia deposit confirmed on-chain ✓', 'success')
            }
          }
          if (progress.zcashTxid) {
            setDepositZcashTxid(progress.zcashTxid)
            addDepositLog('ZCASH', `Shielded note broadcasted to Zcash Testnet (${progress.zcashTxid.slice(0, 10)}...). Entering shielded pool...`, 'pending', `https://testnet.cipherscan.app/tx/${progress.zcashTxid}`, 'View on Zcash Explorer ↗')
          }
          if (progress.zcashConfirmed !== undefined) {
            setDepositZcashConfirmed(progress.zcashConfirmed)
          }
          if (progress.logTag && progress.logMessage) {
            addDepositLog(progress.logTag, progress.logMessage, progress.logTag === 'SETTLED' || progress.logTag === 'CONFIRMED' ? 'success' : 'info')
          }
          if (progress.transaction) setDepositTx(progress.transaction)
        }
      )
      if (tx) {
        setDepositTx(tx)
        if (tx.legs?.deposit?.txHash) setDepositBaseTxHash(tx.legs.deposit.txHash)
        if (tx.legs?.deposit?.status === 'confirmed') setDepositBaseConfirmed(true)
        if (tx.legs?.shielded?.txHash) setDepositZcashTxid(tx.legs.shielded.txHash)
        const usesPoolBacking = tx.settlementMode === 'jury_inventory' && tx.backingSource === 'confirmed_zcash_inventory'
        const isShieldedConfirmed = tx.status === 'completed' && (
          usesPoolBacking || Boolean(tx.legs?.shielded?.status === 'confirmed' && tx.legs?.shielded?.txHash)
        )
        if (isShieldedConfirmed) {
          setDepositBaseConfirmed(true)
          setDepositZcashConfirmed(!usesPoolBacking)
          setDepositStatus('done')
          setPendingDepositAmount(null)
          addDepositLog(
            'SETTLED',
            usesPoolBacking
              ? `Base deposit confirmed and backed by AURA's confirmed shielded Zcash pool ✓ Added +$${val.toFixed(2)} to Private Balance!`
              : `Zcash shielded note confirmed in block ✓ Added +$${val.toFixed(2)} to Private Balance!`,
            'success'
          )
          void refreshTransactions()
        } else {
          setDepositStatus('pending')
          setPendingDepositAmount(val)
            addDepositLog(
              'SYNC',
              usesPoolBacking
                ? 'Base deposit confirmed; waiting for the pooled private-balance allocation to finish...'
                : 'Monitoring Zcash Testnet for the confirmed shielded transaction...',
              'pending',
            )
        }
      } else {
        setDepositStatus('idle')
        setDepositError('Deposit failed to process.')
      }
    } catch (err: unknown) {
      const failure = err as Error & { pendingFinality?: boolean; txHash?: string; transaction?: AuraTransaction }
      if (failure.txHash) setDepositBaseTxHash(failure.txHash)
      if (failure.transaction) setDepositTx(failure.transaction)
      if (failure.pendingFinality) {
        setDepositStatus('pending')
        setPendingDepositAmount(val)
        setDepositError(null)
      } else {
        setDepositStatus('idle')
        setDepositError(err instanceof Error ? err.message : 'Deposit failed. Please try again.')
      }
    }
  }

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setWithdrawError(null)
    const val = parseFloat(withdrawAmount)
    if (isNaN(val) || val <= 0) {
      setWithdrawError('Please enter a valid withdrawal amount.')
      return
    }

    const trimmedDest = withdrawDestination.trim()
    let destinationToUse = trimmedDest

    if (selectedWithdrawChain === 'solana') {
      if (!destinationToUse) {
        setWithdrawError('Solana withdrawals require a valid Solana Devnet recipient address (Base58 format).')
        return
      }
      if (!/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(destinationToUse)) {
        setWithdrawError('Invalid Solana recipient address. Must be a valid Base58 public key (32-44 characters).')
        return
      }
    } else if (selectedWithdrawChain === 'base') {
      if (!destinationToUse && wallet.connected && !wallet.isDemoWallet) {
        destinationToUse = wallet.address
      }
      if (!destinationToUse || !/^0x[a-fA-F0-9]{40}$/.test(destinationToUse)) {
        setWithdrawError('Base withdrawals require a valid 42-character EVM address (0x...).')
        return
      }
      if (wallet.isDemoWallet && destinationToUse.toLowerCase() === wallet.address.toLowerCase()) {
        setWithdrawError('Use a different Base Sepolia address. The demo wallet cannot send a payout to itself.')
        return
      }
    }

    setWithdrawStatus('sending')
    try {
      const tx = await executeWithdraw(selectedWithdrawAsset, val, selectedWithdrawChain, destinationToUse)
      if (tx) {
        const hash = tx.legs?.delivery?.txHash || ''
        setWithdrawTxHash(hash)
        // Point 12 Fix: Only show fully completed if confirmed on-chain; otherwise show broadcasting/pending
        if (tx.toChain === 'solana' ? hasCompletedDestinationDelivery(tx) : tx.status === 'completed') {
          setWithdrawStatus('done')
        } else {
          setWithdrawStatus('pending')
        }
      } else {
        setWithdrawStatus('idle')
        setWithdrawError('Withdrawal failed to process.')
      }
    } catch (err: unknown) {
      setWithdrawStatus('idle')
      setWithdrawError(err instanceof Error ? err.message : 'Withdrawal failed. Please check destination address.')
    }
  }

  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · PRIVATE BALANCE
            </small>
            <h1>Private Balance</h1>
            <p>
              This is the money you moved into your Private Balance. Pay from here instead of paying directly from your main wallet.{' '}
              {privateBalanceUnavailable
                ? 'It is still syncing. Missing data is shown as unavailable, not as zero.'
                : 'The balance becomes available when the selected payment timing allows it.'}
            </p>
          </div>

          <div style={{ display: isJuryTour ? 'none' : undefined }}>
            <PrivateBalanceExplainer compact />
          </div>

          {/* Visual Route Flow */}
          <div className="visual-flow" style={{ marginBottom: 24, display: isJuryTour ? 'none' : undefined }}>
            <span>ADD MONEY</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span className="visual-flow-highlight">PRIVATE BALANCE</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span>PAY A RECIPIENT</span>
          </div>

          {/* If Wallet Not Connected: Direct Choice Card */}
          {!wallet.connected && (
            <div
              style={{
                maxWidth: 680,
                margin: '0 auto 24px',
                background: '#ffffff',
                border: '1px solid #e2ddf0',
                borderRadius: 16,
                padding: '20px 22px',
                boxShadow: '0 4px 16px rgba(107, 85, 223, 0.08)',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        Start here
                    </span>
                  </div>
                  <p style={{ margin: 0, fontSize: 13, color: '#625c6c', lineHeight: 1.4 }}>
                    Use the demo wallet for the testnet walkthrough, or connect MetaMask / Coinbase to add USDC on Base Sepolia. Phantom support is planned next.
                  </p>
                  {walletConnectionError && (
                    <p role="alert" style={{ color: 'var(--danger)', fontSize: 12, margin: '8px 0 0' }}>
                      {walletConnectionError}
                    </p>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={async () => {
                      setWalletConnectionError(null)
                      try {
                        await connectWallet('demo')
                      } catch (error) {
                        setWalletConnectionError(error instanceof Error ? error.message : 'Could not start the demo wallet.')
                      }
                    }}
                    style={{
                      background: 'var(--violet)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 10,
                      padding: '10px 16px',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <SparkleIcon size={14} color="#fff" />
                    <span>Try Demo Wallet</span>
                  </button>

                  <button
                    type="button"
                    onClick={async () => {
                      setWalletConnectionError(null)
                      try {
                        await connectWallet('metamask')
                      } catch (error) {
                        setWalletConnectionError(error instanceof Error ? error.message : 'Could not connect the wallet.')
                      }
                    }}
                    style={{
                      background: '#fff',
                      color: 'var(--violet)',
                      border: '1px solid #d9d0ff',
                      borderRadius: 10,
                      padding: '10px 16px',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <WalletIcon size={14} color="var(--violet)" />
                    <span>Connect Wallet</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Demo Wallet Live On-Chain Indicator Card */}
          {wallet.isDemoWallet && (
            <div
              style={{
                maxWidth: 680,
                margin: '0 auto 24px',
                background: '#ffffff',
                border: '1px solid #e2ddf0',
                borderRadius: 16,
                padding: '18px 20px',
                boxShadow: '0 4px 16px rgba(107, 85, 223, 0.06)',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 10,
                      background: '#ede8ff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--violet)',
                    }}
                  >
                    <SparkleIcon size={18} />
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 14, color: '#191820' }}>Demo Wallet</strong>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          background: '#f0ecfc',
                          color: 'var(--violet)',
                          padding: '2px 8px',
                          borderRadius: 6,
                        }}
                      >
                        Base Sepolia Testnet
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                      <span style={{ fontSize: 12, color: '#77727d', fontFamily: 'var(--font-ui)' }}>
                        {wallet.address.slice(0, 8)}...{wallet.address.slice(-6)}
                      </span>
                      <a
                        href={`https://sepolia.basescan.org/address/${wallet.address}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, color: 'var(--violet)', textDecoration: 'underline' }}
                        title="View address on BaseScan"
                      >
                        BaseScan ↗
                      </a>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, color: '#77727d', fontWeight: 700 }}>Public Wallet Balance (Base Sepolia · Public)</div>
                    <strong style={{ fontSize: 15, color: '#191820' }}>
                      {publicBalanceKnown ? `$${publicUsdcBalance.toFixed(2)} USDC` : 'Unavailable · RPC unavailable'}
                    </strong>
                    <div style={{ fontSize: 11, color: wallet.demoCanSend ? 'var(--green)' : 'var(--warning)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                      {wallet.demoCanSend && wallet.balanceSource === 'onchain' ? <CheckIcon size={12} color="var(--green)" /> : null}
                      <span>{wallet.demoCanSend && wallet.balanceSource === 'onchain' ? 'Demo wallet pays testnet gas' : 'Demo sending unavailable'}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!publicBalanceKnown || !wallet.demoCanSend || wallet.balanceSource !== 'onchain' || publicUsdcBalance <= 0}
                    onClick={() => void openAddMoney(Math.min(5, publicUsdcBalance || 5))}
                    style={{
                      background: 'var(--violet)',
                      color: '#fff',
                      border: 0,
                      borderRadius: 10,
                      padding: '8px 14px',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: !publicBalanceKnown || !wallet.demoCanSend || wallet.balanceSource !== 'onchain' || publicUsdcBalance <= 0 ? 'not-allowed' : 'pointer',
                      opacity: !publicBalanceKnown || !wallet.demoCanSend || wallet.balanceSource !== 'onchain' || publicUsdcBalance <= 0 ? 0.55 : 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <PlusIcon size={14} color="#fff" />
                    <span>Add</span>
                  </button>
                </div>
              </div>

              <div
                style={{
                  borderTop: '1px solid #f1eff5',
                  paddingTop: 10,
                  fontSize: 12,
                  color: '#77727d',
                  lineHeight: 1.4,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <span>
                  {wallet.demoCanSend
                    ? wallet.balanceSource === 'onchain'
                      ? 'Test USDC is sent from this demo wallet after you choose Add. Each transfer is verified before it is added to your balance.'
                      : 'The Base Sepolia network could not be checked. The displayed balance may be old; sending is paused.'
                    : 'This demo wallet is view-only on this run. Connect your own Base Sepolia wallet to add test funds.'}
                </span>
                {!wallet.demoCanSend && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await connectWallet('metamask')
                      } catch (error) {
                        setWalletConnectionError(error instanceof Error ? error.message : 'Could not connect the wallet.')
                      }
                    }}
                    style={{ border: '1px solid #d9d0ff', background: '#fff', color: 'var(--violet)', borderRadius: 7, padding: '5px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                  >
                    Connect Wallet
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Incoming Deposit Shielding Banner */}
          {incomingDepositUsd > 0 && (
            <div
              style={{
                maxWidth: 680,
                margin: '0 auto 20px',
                background: '#faf8ff',
                border: '1px solid #d9d0ff',
                borderRadius: 16,
                padding: '16px 20px',
                boxShadow: '0 4px 16px rgba(107, 85, 223, 0.08)',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: 'var(--violet)',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <SparkleIcon size={18} color="#fff" />
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 15, color: '#191820' }}>
                        +${incomingDepositUsd.toFixed(2)} USDC Incoming
                      </strong>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          background: '#ede8ff',
                          color: 'var(--violet)',
                          padding: '2px 8px',
                          borderRadius: 6,
                        }}
                      >
                        {incomingDepositUsesPoolBacking ? 'Private Balance allocation' : 'Shielding into Private Balance'}
                      </span>
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#625c6c', lineHeight: 1.4 }}>
                      {incomingDepositUsesPoolBacking
                        ? 'Received on Base Sepolia. The matching value is allocated from AURA&apos;s confirmed shielded Zcash Testnet inventory; no new deposit-specific Zcash transaction is required.'
                        : 'Received on Base Sepolia. The matching value is being allocated from AURA&apos;s confirmed shielded Zcash Testnet pool.'}
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {activeBaseTxHash && (
                    <a
                      href={`https://sepolia.basescan.org/tx/${activeBaseTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 11, color: 'var(--violet)', textDecoration: 'underline', fontWeight: 600 }}
                      title="View deposit on BaseScan"
                    >
                      BaseScan ↗
                    </a>
                  )}
                  {activeZcashTxid && (
                    <a
                      href={`https://testnet.cipherscan.app/tx/${activeZcashTxid}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 11, color: 'var(--violet)', textDecoration: 'underline', fontWeight: 600 }}
                      title="View shielded note on Zcash Explorer"
                    >
                      Zcash Explorer ↗
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Hero Card */}
          <div className="balance-hero-card">
            <div className="card-head">
              <AuraLogo height={18} />
              <small>AURA PRIVATE STATE</small>
            </div>

            <div className="card-main">
              {privateBalance.syncStatus === 'syncing' ? (
                <div>
                  <small>Private Balance · Zcash Testnet</small>
                  <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--violet, #6b55df)', margin: '14px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <SparkleIcon size={18} color="var(--violet)" />
                    <span>Preparing your private balance...</span>
                  </div>
                  <small style={{ color: '#77727d' }}>Checking the confirmed Zcash state</small>
                </div>
              ) : privateBalanceUnavailable || privateBalance.syncStatus === 'error' || (privateBalance.vaultSynced === false && privateBalance.orchardPoolSynced === false) ? (
                <div>
                  <small>AURA Private Balance · Testnet</small>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--danger)', margin: '12px 0' }}>
                    Private balance temporarily unavailable
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <small style={{ color: '#77727d' }}>Ledger sync interrupted</small>
                    <button
                      type="button"
                      onClick={() => resyncBalance()}
                      style={{
                        background: 'var(--violet, #6b55df)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Retry Sync
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <small>AURA Private Balance · Testnet</small>
                  <strong style={{ fontSize: 56 }}>
                    <OdometerCounter value={privateBalance.totalUsd} />
                  </strong>
                  <small style={{ display: 'block', marginTop: 4 }}>
                    {privateBalance.zcashStateSynced
                      ? 'Confirmed private balance · ready under the selected timing'
                      : 'The confirmed private balance is still syncing; spending is paused.'}
                  </small>
                  {incomingDepositUsd > 0 && (
                    <div style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, background: '#ede8ff', padding: '4px 10px', borderRadius: 8, color: 'var(--violet)', fontSize: 12, fontWeight: 700 }}>
                      <ClockIcon size={12} color="var(--violet)" />
                        <span>+${incomingDepositUsd.toFixed(2)} USDC incoming · {incomingDepositUsesPoolBacking ? 'pool allocation' : 'shielding'}</span>
                    </div>
                  )}
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SparkleIcon size={14} color="var(--violet)" />
                <div>
                  Private Balance
                  <small style={{ display: 'block', marginTop: 2 }}>
                    {privateBalance.syncStatus === 'syncing'
                      ? 'Preparing balance...'
                      : privateBalanceUnavailable
                        ? 'Balance temporarily unavailable'
                      : privateBalance.totalUsd > 0
                        ? 'Private balance synced'
                        : 'No funds in balance yet'}
                  </small>
                </div>
              </label>
            </div>

            {/* Payment state, not an investment chart: AURA is a spending account. */}
            <div
              style={{
                margin: '18px 0 12px',
                padding: '14px 0 4px',
                borderTop: '1px solid var(--line)',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <small style={{ fontSize: 10, fontWeight: 800, color: '#77727d', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Payment readiness
                </small>
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  Private Balance · not a portfolio
                </small>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                <div style={{ border: '1px solid #d9d0ff', borderRadius: 10, padding: '10px 11px', background: '#fbfaff' }}>
                  <small style={{ display: 'block', color: 'var(--violet)', fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Ready to spend</small>
                  <strong style={{ display: 'block', marginTop: 5, color: 'var(--ink)', fontSize: 18 }}>
                    {privateBalanceUnavailable
                      ? privateBalance.syncStatus === 'syncing' ? 'Preparing...' : 'Unavailable'
                      : `$${(displayedReadyUsd ?? 0).toFixed(2)}`}
                  </strong>
                </div>
                <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 11px', background: '#fcfbff' }}>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Waiting for selected timing</small>
                  <strong style={{ display: 'block', marginTop: 5, color: 'var(--ink)', fontSize: 18 }}>
                    {privateBalanceUnavailable
                      ? privateBalance.syncStatus === 'syncing' ? 'Preparing...' : 'Unavailable'
                      : `$${(displayedWaitingUsd ?? 0).toFixed(2)}`}
                  </strong>
                </div>
                {incomingDepositUsd > 0 ? (
                  <div style={{ border: '1px solid #c9bcf8', borderRadius: 10, padding: '10px 11px', background: '#f7f4ff' }}>
                    <small style={{ display: 'block', color: 'var(--violet)', fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{incomingDepositUsesPoolBacking ? 'Incoming · Pool backing' : 'Incoming · Shielding'}</small>
                    <strong style={{ display: 'block', marginTop: 5, color: 'var(--violet)', fontSize: 18 }}>
                      +${incomingDepositUsd.toFixed(2)}
                    </strong>
                  </div>
                ) : (
                  <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 11px', background: '#fcfbff' }}>
                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 9, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Private payments</small>
                    <strong style={{ display: 'block', marginTop: 5, color: 'var(--ink)', fontSize: 18 }}>
                      {completedPrivatePayments.length}
                    </strong>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 0 12px', color: 'var(--muted)', fontSize: 11 }}>
                <span>
                  {latestPrivatePayment
                    ? `Latest private payment · $${latestPrivatePayment.fromAmount.toFixed(2)} · ${latestPrivatePayment.toChain === 'solana' ? 'Solana Devnet' : latestPrivatePayment.toChain}`
                    : curTot > 0 ? 'No private payment has been sent from this balance yet.' : 'Add money to create a balance for private spending.'}
                </span>
                <span style={{ color: privateBalanceUnavailable ? 'var(--warning)' : 'var(--green)', fontWeight: 700 }}>
                  {privateBalanceUnavailable ? 'Chain data pending' : 'Spend state synced'}
                </span>
              </div>
            </div>

            <details style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <summary style={{ cursor: 'pointer', color: 'var(--violet)', fontSize: 11, fontWeight: 800, letterSpacing: '0.04em' }}>
                Technical details
              </summary>
              <div className="card-meta" style={{ marginTop: 10 }}>
              {(() => {
                const zecPrice = rates?.ZEC?.usdPrice
                return (
                  <span>
                    {privateBalance.zecEquivalent === null
                      ? 'ZEC balance unavailable'
                      : `≈ ${privateBalance.zecEquivalent.toFixed(2)} ZEC equivalent · `}{' '}
                    <em>
                      {zecPrice && Number.isFinite(zecPrice) ? `ZEC reference $${zecPrice.toFixed(2)}` : 'ZEC market reference unavailable'}
                    </em>
                  </span>
                )
              })()}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: isLive ? 'var(--green)' : 'var(--warning)', display: 'inline-block' }} />
                <span>{isLive ? 'Live Oracle' : 'Base Rate'} · Ledger {privateBalance.syncStatus === 'syncing' ? 'Syncing...' : privateBalance.syncStatus === 'error' ? 'Unavailable' : 'Synced'}</span>
                <button
                  type="button"
                  title="Refresh your AURA balance"
                  onClick={() => resyncBalance()}
                  style={{
                    background: 'transparent',
                    border: '1px solid #d9d0ff',
                    color: 'var(--violet, #6b55df)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <RefreshIcon size={11} color="var(--violet)" />
                  <span>Resync</span>
                </button>
                <button
                  type="button"
                  title="Demo wallet recovery and local browser settings"
                  onClick={() => setShowSecurityModal(true)}
                  style={{
                    background: 'transparent',
                    border: '1px solid #d9d0ff',
                    color: 'var(--violet, #6b55df)',
                    borderRadius: 6,
                    padding: '2px 8px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <span>Recovery</span>
                </button>
              </span>
              </div>
            </details>

            {/* Dual Balance Display */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '16px 0 20px' }}>
              <div className="card-asset" style={{ margin: 0, display: 'grid', gridTemplateColumns: '36px 1fr auto', alignItems: 'center', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <SparkleIcon size={22} color="var(--violet)" />
                </div>
                <div>
                  <strong style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#191820', lineHeight: 1.3 }}>
                    {privateBalanceUnavailable ? 'Private balance syncing' : 'Ready to spend'}
                  </strong>
                  <small style={{ display: 'block', color: '#77727d', fontSize: 11, marginTop: 2 }}>
                    {privateBalanceUnavailable
                      ? 'Waiting for confirmed private state.'
                      : 'Confirmed private balance · available under the selected timing.'}
                  </small>
                </div>
                <b>
                    {privateBalanceUnavailable
                    ? <span style={{ color: 'var(--muted)', fontSize: 13 }}>{privateBalance.syncStatus === 'syncing' ? 'Preparing...' : 'Unavailable'}</span>
                    : <OdometerCounter value={displayedReadyUsd ?? 0} />}
                </b>
              </div>

              {(displayedWaitingUsd ?? 0) > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderRadius: 12,
                    background: '#fcfbfe',
                    border: '1px solid #e7e4eb',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        background: '#ede8ff',
                        color: 'var(--violet, #6b55df)',
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      <SparkleIcon size={12} />
                    </span>
                    <div>
                      <div style={{ fontWeight: 700, color: '#191820' }}>
                        Waiting
                      </div>
                      <div style={{ color: '#77727d', fontSize: 11, marginTop: 2 }}>
                        Confirmed in AURA&apos;s testnet balance; the selected wait has not elapsed. (${(displayedWaitingUsd ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pending)
                      </div>
                    </div>
                  </div>
                  <span
                    title="This amount is confirmed in AURA's testnet balance. The wait may reduce simple timing clues; it does not prove unlinkability."
                    style={{
                      fontSize: 11,
                      color: 'var(--violet, #6b55df)',
                      background: '#f4efff',
                      padding: '3px 8px',
                      borderRadius: 6,
                      fontWeight: 600,
                    }}
                  >
                    Waiting
                  </span>
                </div>
              )}

              {incomingDepositUsd > 0 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderRadius: 12,
                    background: '#faf8ff',
                    border: '1px dashed #d9d0ff',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        background: '#ede8ff',
                        color: 'var(--violet)',
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      <ClockIcon size={12} color="var(--violet)" />
                    </span>
                    <div>
                      <div style={{ fontWeight: 700, color: '#191820' }}>
                        Incoming Deposit · Shielding into private balance
                      </div>
                      <div style={{ color: '#77727d', fontSize: 11, marginTop: 2 }}>
                        Confirmed on Base Sepolia · backed by AURA&apos;s confirmed shielded Zcash Testnet pool
                      </div>
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--violet)',
                      background: '#ede8ff',
                      padding: '3px 8px',
                      borderRadius: 6,
                    }}
                  >
                    +${incomingDepositUsd.toFixed(2)} USDC
                  </span>
                </div>
              )}
            </div>

            {/* Privacy Policy Selector */}
            <div style={{ background: '#faf9fc', border: '1px solid #e7e4eb', borderRadius: 14, padding: '14px 16px', marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: '#77727d', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  When should this balance become available to pay?
                </span>
                <small style={{ color: '#77727d', fontSize: 11 }}>
                  Choose the speed first; the wait is shown below.
                </small>
              </div>
              <p style={{ margin: '0 0 10px', color: '#77727d', fontSize: 11, lineHeight: 1.45 }}>
                Demo timing setting · waiting can reduce simple timing clues, but is not a privacy guarantee.
              </p>

              <div className="aura-chip-group">
                {[
                  {
                    id: 'fast',
                    label: 'Fast',
                    desc: 'Pay after the required confirmations. Fastest option, with less time between adding and paying.',
                    icon: ZapIcon,
                  },
                  {
                    id: 'private',
                    label: '1-day buffer',
                    desc: 'Wait 24 hours before paying. More separation; recommended starting point.',
                    icon: SparkleIcon,
                  },
                  {
                    id: 'strong',
                    label: '3-day buffer',
                    desc: 'Wait 72 hours before paying. Longer separation, not a guarantee.',
                    icon: ShieldIcon,
                  },
                  {
                    id: 'custom',
                    label: '7-day buffer',
                    desc: 'Wait 7 days before paying. Longest demo option, not a guarantee.',
                    icon: SlidersIcon,
                  },
                ].map((policy) => {
                  const isActive = privateBalance.privacyPolicy === policy.id || (!privateBalance.privacyPolicy && policy.id === 'private')
                  const Icon = policy.icon
                  return (
                    <button
                      key={policy.id}
                      type="button"
                      className={`aura-policy-card ${isActive ? 'active' : ''}`}
                      onClick={() => setPrivacyPolicy(policy.id as any)}
                    >
                      <div className="aura-policy-icon-badge">
                        <Icon size={18} />
                      </div>
                      <div>
                        <span className="aura-policy-title">{policy.label}</span>
                        <span className="aura-policy-desc">{policy.desc}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="card-buttons-4">
              <button
                type="button"
                className="btn-primary"
                onClick={() => void openAddMoney()}
              >
                <PlusIcon size={18} color="#fff" />
                Add Money
              </button>

              <Link href="/send">
                <ArrowUpRightIcon size={18} color="var(--violet)" />
                Pay
              </Link>

              <Link href="/receive">
                <ArrowDownIcon size={18} color="var(--violet)" />
                Receive
              </Link>

              <button
                type="button"
                onClick={() => {
                  setActiveModal('withdraw')
                  setWithdrawStatus('idle')
                  setWithdrawAcknowledgedWarning(false)
                }}
              >
                <RefreshIcon size={18} color="var(--violet)" />
                Withdraw
              </button>
            </div>
          </div>

          {/* Recent Activity Section */}
          <div style={{ maxWidth: 680, margin: '30px auto 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Recent Private Activity</h3>
              <Link href="/activity" style={{ color: 'var(--violet, #6b55df)', fontSize: 13, fontWeight: 700 }}>
                View full history →
              </Link>
            </div>

            <div className="activity-table-card">
              {transactions.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#77727d', fontSize: 13 }}>
                  No transactions yet.
                </div>
              ) : recentBalanceActivity.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#77727d', fontSize: 13 }}>
                  No completed activity yet.
                </div>
              ) : (
                recentBalanceActivity.map((tx) => {
                  const formatted = formatAuraTx(tx)
                  const isDemoSeed = tx.id === 'tx_rec_01' || tx.id === 'tx_snd_02' || tx.id === 'tx_dep_03' || tx.id === 'tx_wth_04'

                  return (
                    <div key={tx.id} className="activity-item-row">
                      <div>
                        <strong>
                          {formatted.title}
                          {isDemoSeed && (
                            <span style={{ background: '#f1f0f4', color: '#77727d', fontSize: 9, padding: '2px 5px', borderRadius: 4, marginLeft: 6, fontWeight: 700, verticalAlign: 'middle' }}>
                              Demo Seed
                            </span>
                          )}
                        </strong>
                        <small>{formatted.subtitle}</small>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: formatted.isPositive ? 'var(--green)' : '#191820' }}>
                          {formatted.amountFormatted}
                        </div>
                        <span
                          className={formatted.isShielded ? 'comp-tag-private' : 'comp-tag-public'}
                          style={{ marginTop: 2, display: 'inline-block' }}
                        >
                          {formatted.statusLabel}
                        </span>
                        <a
                          onClick={() => setInspectTx(tx)}
                          style={{
                            display: 'block',
                            fontSize: 10,
                            color: 'var(--violet, #6b55df)',
                            cursor: 'pointer',
                            marginTop: 2,
                            fontWeight: 600,
                          }}
                        >
                          Inspect Route ↗
                        </a>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </main>

      <AuraFooter />

      {/* Modal: Add Money */}
      {activeModal === 'add' && (
        <div className="modal-backdrop" onClick={() => setActiveModal('none')}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SparkleIcon size={14} color="var(--violet)" />
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Move money into Private Balance
                </span>
              </div>
              <button type="button" className="modal-close" onClick={() => setActiveModal('none')} title="Close">
                <CloseIcon size={14} />
              </button>
            </div>
            <div className="modal-body" style={{ textAlign: 'left' }}>
              <p style={{ margin: '0 0 16px', color: '#77727d', fontSize: 13, lineHeight: 1.5 }}>
                Your testnet payment goes to Aura&apos;s public deposit address. Aura verifies it and records the demo balance after Base confirmation and pool allocation.
              </p>

              <form onSubmit={handleDepositSubmit}>
                {depositError && (
                  <div style={{ background: 'var(--danger-light)', color: 'var(--danger)', padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, fontWeight: 600 }}>
                    {depositError}
                  </div>
                )}
                {depositStatus === 'idle' ? null : (
                  <div
                    className="modal-status-badge deposit-progress"
                    style={{
                      display: 'block',
                      background: depositStatus === 'done' ? 'var(--green-light)' : '#fbfaff',
                      border: depositStatus === 'done' ? '1px solid #bbf7d0' : '1px solid #e9e5f5',
                      padding: '16px',
                      marginBottom: 16,
                      borderRadius: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: depositStatus === 'done' ? 'var(--green)' : 'var(--violet)' }}>
                        {depositStatus === 'done' ? (
                          <>
                            <CheckIcon size={16} color="var(--green)" />
                            <span>Added to Private Balance!</span>
                          </>
                        ) : (
                          <>
                            <RefreshIcon size={14} color="var(--violet)" />
                            <span>Moving into Private Balance...</span>
                          </>
                        )}
                      </strong>
                      <span style={{ fontSize: 11, fontWeight: 700, color: depositStatus === 'done' ? 'var(--green)' : 'var(--violet)' }}>
                        {depositStatus === 'done' ? 'Confirmed ✓' : activeBaseConfirmed ? 'Step 2 of 2' : 'Step 1 of 2'}
                      </span>
                    </div>

                    {/* Step 1: Base Sepolia Public Entry */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: '#ffffff',
                        border: '1px solid #ede9fe',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: activeBaseConfirmed ? 'var(--green)' : '#ede9fe',
                            color: activeBaseConfirmed ? '#ffffff' : 'var(--violet)',
                            fontSize: 11,
                            fontWeight: 800,
                          }}
                        >
                          {activeBaseConfirmed ? '✓' : '1'}
                        </span>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                            Base Sepolia (Public Entry)
                          </div>
                          <div style={{ fontSize: 11, color: activeBaseConfirmed ? 'var(--green)' : '#77727d' }}>
                            {activeBaseConfirmed
                              ? 'Confirmed on-chain ✓'
                              : activeBaseTxHash
                              ? 'Broadcasted · Confirming (2–3s)...'
                              : 'Submitting transaction...'}
                          </div>
                        </div>
                      </div>
                      {activeBaseTxHash && (
                        <a
                          href={`https://sepolia.basescan.org/tx/${activeBaseTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 11,
                            color: 'var(--violet)',
                            textDecoration: 'underline',
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <span>View on BaseScan</span>
                          <span>↗</span>
                        </a>
                      )}
                    </div>

                    {/* Step 2: Zcash Testnet Shielded Step */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: '#ffffff',
                        border: '1px solid #ede9fe',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: activeZcashConfirmed ? 'var(--green)' : activeZcashTxid ? 'var(--violet)' : '#f1eff5',
                            color: activeZcashConfirmed || activeZcashTxid ? '#ffffff' : '#77727d',
                            fontSize: 11,
                            fontWeight: 800,
                          }}
                        >
                          {activeZcashConfirmed ? '✓' : '2'}
                        </span>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                            {activeInventoryBacked ? 'Private backing (Zcash pool)' : 'Zcash Testnet (Shielded Pool)'}
                          </div>
                          <div style={{ fontSize: 11, color: activeZcashConfirmed ? 'var(--green)' : activeZcashTxid ? 'var(--violet)' : '#77727d' }}>
                            {activeInventoryBacked
                              ? 'Backed by confirmed shielded Zcash inventory ✓'
                              : activeZcashConfirmed
                              ? 'Shielded transaction confirmed on-chain ✓'
                              : activeZcashTxid
                              ? 'Shielded tx broadcasted · Confirming...'
                              : activeBaseConfirmed
                              ? 'Preparing private-balance allocation...'
                              : 'Awaiting Base confirmation'}
                          </div>
                        </div>
                      </div>
                      {activeZcashTxid && (
                        <a
                          href={`https://testnet.cipherscan.app/tx/${activeZcashTxid}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 11,
                            color: 'var(--violet)',
                            textDecoration: 'underline',
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <span>View on Zcash Explorer</span>
                          <span>↗</span>
                        </a>
                      )}
                    </div>

                    {/* Live Protocol Execution Stream */}
                    {depositLogs.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <LiveProtocolStream
                          logs={depositLogs}
                          isLive={depositStatus === 'moving' || depositStatus === 'pending'}
                          summaryStatus={depositStatus === 'done'
                            ? 'SETTLED ✓'
                            : activeInventoryBacked && activeBaseConfirmed
                              ? 'POOL BACKING ALLOCATION'
                              : activeBaseConfirmed
                                ? 'SHIELDING ON ZCASH'
                                : 'BASE CONFIRMING'}
                          maxHeight={160}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="modal-input-group">
                  <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, display: 'block' }}>Select asset</label>
                  <div className="modal-asset-grid">
                    {PUBLIC_ASSET_CAPABILITIES.map((item) => {
                      const isLive = item.status === 'LIVE'
                      return (
                      <button
                        key={item.symbol}
                        type="button"
                        disabled={!isLive}
                        onClick={() => {
                          if (isLive) {
                            setSelectedDepositAsset(item.symbol as AssetSymbol)
                            setSelectedDepositChain(item.chain as ChainId)
                          }
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: selectedDepositAsset === item.symbol ? '1.5px solid var(--violet)' : '1px solid #e7e4eb',
                          background: selectedDepositAsset === item.symbol ? 'var(--lav)' : '#fff',
                          cursor: isLive ? 'pointer' : 'not-allowed',
                          opacity: isLive ? 1 : 0.55,
                          textAlign: 'left',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <CryptoIcon name={item.symbol} size={22} />
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 13, color: selectedDepositAsset === item.symbol ? 'var(--violet)' : '#191820' }}>
                              {item.label}
                            </div>
                            <div style={{ fontSize: 10, color: '#77727d' }}>
                              {item.network}
                            </div>
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 800,
                            padding: '2px 5px',
                            borderRadius: 4,
                            background: isLive ? 'var(--green)' : '#f1eff5',
                            color: isLive ? '#fff' : '#77727d',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}
                        >
                          {item.badge}
                        </span>
                      </button>
                      )
                    })}
                  </div>
                </div>

                <div className="modal-input-group">
                  <NetworkRouteSelector
                    title="Public entry network"
                    selectedId={selectedDepositChain}
                    options={DEMO_ENTRY_NETWORKS}
                    onSelect={(item) => {
                      setSelectedDepositChain(item.id as ChainId)
                      setSelectedDepositAsset(item.id === 'base' ? 'USDC' : selectedDepositAsset)
                    }}
                    helper="Current live route starts on Base Sepolia and enters the Zcash Testnet middle."
                  />
                </div>

                <div className="modal-input-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ margin: 0, fontSize: 12, fontWeight: 700 }}>Amount ($)</label>
                    <span style={{ fontSize: 11, color: '#77727d' }}>
                      {publicBalanceKnown ? `Wallet Balance: $${publicUsdcBalance.toFixed(2)} USDC` : 'Wallet balance: unavailable'}
                    </span>
                  </div>
                  <div style={{ color: '#68636e', fontSize: 11, lineHeight: 1.4, marginBottom: 8 }}>
                    Public Base balance and confirmed private-pool capacity are separate. AURA checks the Zcash backing before sending any Base transfer.
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => setDepositAmount(publicUsdcBalance.toFixed(2))}
                      disabled={!publicBalanceKnown}
                      className="aura-max-btn"
                    >
                      MAX
                    </button>
                  </div>
                  {publicBalanceKnown && parseFloat(depositAmount) > publicUsdcBalance && (
                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--danger-light)', padding: '6px 10px', borderRadius: 6 }}>
                      <small style={{ color: 'var(--danger)', fontWeight: 600 }}>
                        Exceeds wallet balance (${publicUsdcBalance.toFixed(2)} max).
                      </small>
                      <a
                        href="https://faucet.circle.com/"
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          background: '#fff',
                          border: '1px solid var(--danger-border)',
                          borderRadius: 4,
                          color: 'var(--danger)',
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 8px',
                          textDecoration: 'none',
                        }}
                      >
                        Circle USDC Faucet ↗
                      </a>
                    </div>
                  )}
                  <div className="modal-amount-presets">
                    {['1.00', '5.00', '10.00', '25.00', '50.00', '100.00'].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setDepositAmount(preset)}
                        className={`aura-preset-btn ${depositAmount === preset ? 'active' : ''}`}
                        style={{ padding: '7px 0', textAlign: 'center', fontSize: 12 }}
                      >
                        ${preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Pre-Confirmation Review & What Happens Next */}
                <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 10, padding: '12px 14px', margin: '14px 0', fontSize: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                    What happens next?
                  </div>
                  <div style={{ fontSize: 12, color: '#4c3a7d', lineHeight: 1.45, marginBottom: 10 }}>
            AURA verifies your Base Sepolia payment, allocates the matching value from its confirmed shielded private inventory, and credits your tenant-scoped balance immediately after Base confirmation and successful pool allocation.
                  </div>
                  <div style={{ borderTop: '1px dashed #d1c4f5', paddingTop: 8, display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: '#68636e' }}>Deposit amount:</span>
                    <strong style={{ color: '#191820' }}>${depositAmount} {selectedDepositAsset} (Base)</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: '#68636e' }}>Private Balance Added:</span>
                    <strong style={{ color: 'var(--green-dark)' }}>
                      ≈ ${Number(depositAmount || 0).toFixed(2)}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#68636e' }}>Route:</span>
                    <strong style={{ color: '#191820' }}>Test route · no simulated provider fee</strong>
                  </div>
                </div>

                {depositStatus === 'done' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveModal('none')
                      setDepositStatus('idle')
                    }}
                    className="modal-action-btn"
                  >
                    Done — Close
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="modal-action-btn"
                    disabled={
                      depositStatus === 'moving' ||
                      parseFloat(depositAmount) <= 0 ||
                      !publicBalanceKnown ||
                       parseFloat(depositAmount) > publicUsdcBalance ||
                      isNaN(parseFloat(depositAmount))
                    }
                  >
                    {depositStatus === 'moving' ? 'Moving into Private Balance...' : 'Add to Private Balance'}
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Withdraw */}
      {activeModal === 'withdraw' && (
        <div className="modal-backdrop" onClick={() => setActiveModal('none')}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RefreshIcon size={14} color="var(--violet)" />
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Move money back to a public wallet
                </span>
              </div>
              <button type="button" className="modal-close" onClick={() => setActiveModal('none')} title="Close">
                <CloseIcon size={14} />
              </button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.4 }}>
                This takes money out of Private Balance and creates a public-chain transaction.
              </div>
              <form onSubmit={handleWithdrawSubmit}>
                {withdrawError && (
                  <div style={{ background: 'var(--danger-light)', color: 'var(--danger)', padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, fontWeight: 600 }}>
                    {withdrawError}
                  </div>
                )}
                {withdrawStatus === 'done' ? (
                  <div className="modal-status-badge" style={{ background: 'var(--green-light)', color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px' }}>
                    <CheckIcon size={16} color="var(--green)" />
                    <div>
                      <strong>Withdrew ${withdrawAmount} {selectedWithdrawAsset} to public wallet.</strong>
                      {withdrawTxHash && (
                        <div style={{ fontSize: 11, color: 'var(--green-dark)', marginTop: 2, wordBreak: 'break-all' }}>
                          Confirmed On-Chain: {withdrawTxHash.slice(0, 18)}...
                        </div>
                      )}
                    </div>
                  </div>
                ) : withdrawStatus === 'pending' ? (
                  <div className="modal-status-badge" style={{ background: 'var(--warning-light)', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px' }}>
                    <SparkleIcon size={16} color="var(--warning)" />
                    <div>
                      <strong>Withdrawal is processing — awaiting network confirmation</strong>
                      <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 2 }}>
                        The transfer is not confirmed yet. Its status will update when the network responds.
                      </div>
                    </div>
                  </div>
                ) : withdrawStatus === 'sending' ? (
                  <div className="modal-status-badge">
                      Sending from Aura&apos;s server-operated testnet wallet → {selectedWithdrawChain.toUpperCase()}...
                  </div>
                ) : null}

                <div className="modal-input-group">
                  <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, display: 'block' }}>Asset</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                    {PUBLIC_DESTINATION_ASSET_OPTIONS.map(({ symbol: asset, status }) => (
                      <button
                        key={asset}
                        type="button"
                        disabled={status !== 'LIVE'}
                        className={`aura-chip ${selectedWithdrawAsset === asset ? 'active' : ''}`}
                        onClick={() => {
                          if (status !== 'LIVE') return
                          setSelectedWithdrawAsset(asset)
                          setSelectedWithdrawChain('solana')
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          padding: '10px 8px',
                          borderRadius: 10,
                          fontWeight: 700,
                          border: selectedWithdrawAsset === asset ? '1.5px solid var(--violet)' : '1px solid #e7e4eb',
                          background: selectedWithdrawAsset === asset ? 'var(--lav)' : '#fff',
                          color: selectedWithdrawAsset === asset ? 'var(--violet)' : '#191820',
                          opacity: status === 'LIVE' ? 1 : 0.55,
                          cursor: status === 'LIVE' ? 'pointer' : 'not-allowed',
                        }}
                      >
                        <CryptoIcon name={asset} size={18} />
                        <span>{asset}{status !== 'LIVE' ? ' · Coming next' : ''}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="modal-input-group">
                  <NetworkRouteSelector
                    title="Destination network"
                    selectedId={selectedWithdrawChain}
                    options={DEMO_DESTINATION_NETWORKS}
                    onSelect={(item) => {
                      const chain = item.id as ChainId
                      setSelectedWithdrawChain(chain)
                      setSelectedWithdrawAsset(chain === 'solana' ? 'SOL' : 'USDC')
                    }}
                    helper="Choose the public network where this private balance exits."
                  />
                </div>

                <div className="modal-input-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ margin: 0 }}>Amount ($)</label>
                    <span style={{ fontSize: 11, color: '#77727d' }}>
                      Available: <strong style={{ color: '#191820' }}>{privateBalanceUnavailable ? 'unavailable' : `$${(privateBalance.availableToSendUsd ?? privateBalance.totalUsd ?? 0).toFixed(2)}`}</strong>
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      disabled={privateBalanceUnavailable}
                      onClick={() => {
                        const available = privateBalance.availableToSendUsd ?? privateBalance.totalUsd ?? 0
                        setWithdrawAmount(Math.max(0, Math.floor(available * 100) / 100).toFixed(2))
                      }}
                      className="aura-max-btn"
                      title="Use the available private balance"
                    >
                      MAX
                    </button>
                  </div>
                  {!privateBalanceUnavailable && parseFloat(withdrawAmount) > (privateBalance.availableToSendUsd ?? privateBalance.totalUsd ?? 0) && (
                    <small style={{ color: 'var(--danger)', display: 'block', marginTop: 4 }}>
                      Amount exceeds available balance (${(privateBalance.availableToSendUsd ?? privateBalance.totalUsd ?? 0).toFixed(2)} max).
                    </small>
                  )}
                  <div className="aura-preset-group">
                    {['1.00', '2.50', '5.00', '10.00', '25.00', '100.00'].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setWithdrawAmount(preset)}
                        className={`aura-preset-btn ${withdrawAmount === preset ? 'active' : ''}`}
                      >
                        ${preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Destination Address Field */}
                <div className="modal-input-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ margin: 0 }}>Destination Public Wallet</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {selectedWithdrawChain === 'base' && wallet.connected && !wallet.isDemoWallet && (
                        <button
                          type="button"
                          onClick={() => setWithdrawDestination(wallet.address)}
                          style={{
                            background: '#f0edff',
                            border: '1px solid #d9d0ff',
                            color: 'var(--violet)',
                            borderRadius: 4,
                            padding: '2px 6px',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Use Connected Wallet
                        </button>
                      )}
                      <span style={{ fontSize: 10, background: 'var(--green-light)', color: 'var(--green-dark)', padding: '2px 8px', borderRadius: 4, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ZapIcon size={10} color="var(--green-dark)" />
                        <span>Route → {selectedWithdrawChain.toUpperCase()}</span>
                      </span>
                    </div>
                  </div>
                  <input
                    type="text"
                    placeholder={
                      selectedWithdrawChain === 'solana'
                        ? 'Enter Solana wallet address (Base58, e.g. 7EcPnR...)'
                        : 'Enter Base / EVM address (0x...) or leave blank for connected wallet'
                    }
                    value={withdrawDestination}
                    onChange={(e) => {
                      const val = e.target.value
                      setWithdrawDestination(val)
                      const clean = val.trim()
                      if (clean.startsWith('0x')) {
                        setSelectedWithdrawChain('base')
                      } else if (/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(clean)) {
                        setSelectedWithdrawChain('solana')
                      }
                    }}
                    style={{ width: '100%', fontFamily: 'var(--font-ui)', fontSize: 12 }}
                  />
                  {selectedWithdrawChain === 'solana' && !withdrawDestination && (
                    <small style={{ color: 'var(--warning)', display: 'block', marginTop: 4, fontSize: 11 }}>
                      Please provide a valid Solana Devnet recipient address.
                    </small>
                  )}
                </div>

                {/* Public Exit & Linkability Warning */}
                <div
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    borderRadius: 10,
                    padding: '12px 14px',
                    margin: '16px 0',
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: 'var(--ink)',
                  }}
                >
                  <strong style={{ display: 'block', marginBottom: 4, color: 'var(--violet)' }}>
                    Public Network Advisory
                  </strong>
                  <div>
                    This takes money out of Private Balance and creates a <strong>public blockchain exit transaction</strong>.
                  </div>
                  <div style={{ marginTop: 4, color: 'var(--muted)' }}>
                    The destination, amount and timing may be visible on the destination blockchain. Exiting back into the same public wallet you deposited from allows outside observers to correlate amounts.
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => setWithdrawAcknowledgedWarning(true)}
                      style={{
                        padding: '4px 10px',
                        background: withdrawAcknowledgedWarning ? 'var(--green)' : '#fff',
                        color: withdrawAcknowledgedWarning ? '#fff' : 'var(--ink)',
                        border: '1px solid var(--line)',
                        borderRadius: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      {withdrawAcknowledgedWarning ? (
                        <>
                          <CheckIcon size={11} color="#fff" />
                          <span>Acknowledged</span>
                        </>
                      ) : (
                        'Understand Risk'
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveModal('none')}
                      style={{
                        padding: '4px 10px',
                        background: '#fff',
                        color: '#634f19',
                        border: '1px solid #d5c898',
                        borderRadius: 6,
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      Keep in Private Balance
                    </button>
                    <button
                      type="button"
                      onClick={() => setWithdrawDestination('')}
                      style={{
                        padding: '4px 10px',
                        background: '#fff',
                        color: '#634f19',
                        border: '1px solid #d5c898',
                        borderRadius: 6,
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      Use Different Address
                    </button>
                  </div>
                </div>

                {withdrawStatus === 'done' || withdrawStatus === 'pending' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveModal('none')
                      setWithdrawStatus('idle')
                      setWithdrawAcknowledgedWarning(false)
                    }}
                    className="modal-action-btn"
                  >
                    Done — Close
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="modal-action-btn"
                    disabled={
                      withdrawStatus === 'sending' ||
                      privateBalanceUnavailable ||
                      parseFloat(withdrawAmount) <= 0 ||
                      parseFloat(withdrawAmount) > (privateBalance.availableToSendUsd ?? privateBalance.totalUsd ?? 0) ||
                      isNaN(parseFloat(withdrawAmount))
                    }
                  >
                    {withdrawStatus === 'sending' ? 'Withdrawing...' : 'Confirm Withdrawal'}
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      )}

      <UnlinkabilityModal
        isOpen={!!inspectTx}
        onClose={() => setInspectTx(null)}
        transaction={inspectTx}
      />

      <VaultSecurityModal
        isOpen={showSecurityModal}
        onClose={() => setShowSecurityModal(false)}
      />
    </>
  )
}
