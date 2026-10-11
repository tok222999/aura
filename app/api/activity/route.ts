import { NextRequest, NextResponse } from 'next/server'
import { ledgerService } from '@/lib/services/ledger-service'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { InMemoryRateLimiter } from '@/lib/utils/rate-limiter'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { persistentStore } from '@/lib/services/persistent-store'
import { isFinalizedSolanaSignatureStatus, solanaRelayer } from '@/lib/crypto/solana-relayer'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { ratesService } from '@/lib/services/rates-service'
import { getMinimumConfirmationsForBuffer, getShieldedSpendableZec, ZCASH_FEE_RESERVE_ZEC } from '@/lib/services/zcash-balance'
import { reconcileLedgerBalanceWithShieldedChain } from '@/lib/services/authoritative-balance'
import { getJurySessionInfo, getTrustedClientId, hasJuryAccessForTenant } from '@/lib/services/demo-session-service'
import { createRequestId, logStructuredEvent, safeErrorMessage } from '@/lib/utils/observability'
import { usesSharedJuryZcashSource } from '@/lib/services/jury-zcash-source'
import { AuraTransaction } from '@/lib/types/aura'
import { hasBroadcastedShieldedSource, hasConfirmedShieldedSource } from '@/lib/utils/transaction-finality'

const activityLimiter = new InMemoryRateLimiter(20, 60)
const ACTIVITY_CHAIN_CACHE_MS = 10_000
type ActivityChainSnapshot = {
  accountId: string
  address: string
  synced: boolean
  spendableZec: number | null
  policyEligibleZec: number | null
  rateUsd: number | null
  backedUsd: number | null
  expiresAt: number
}
const activityChainCache = new Map<string, ActivityChainSnapshot>()
const SHARED_ACTIVITY_SNAPSHOT_MAX_AGE_MS = 5 * 60_000
const SHARED_ACTIVITY_SNAPSHOT_BUCKET = 'activity-chain-snapshot'

function getSharedActivitySnapshot(cacheKey: string): ActivityChainSnapshot | null {
  const snapshot = persistentStore.getSharedCache<ActivityChainSnapshot>(
    SHARED_ACTIVITY_SNAPSHOT_BUCKET,
    cacheKey,
    SHARED_ACTIVITY_SNAPSHOT_MAX_AGE_MS,
  )
  return snapshot && snapshot.synced === true && snapshot.expiresAt > Date.now() ? snapshot : null
}

function setSharedActivitySnapshot(cacheKey: string, snapshot: Omit<ActivityChainSnapshot, 'expiresAt'>): void {
  const value: ActivityChainSnapshot = {
    ...snapshot,
    expiresAt: Date.now() + SHARED_ACTIVITY_SNAPSHOT_MAX_AGE_MS,
  }
  persistentStore.setSharedCache(
    SHARED_ACTIVITY_SNAPSHOT_BUCKET,
    cacheKey,
    value,
    SHARED_ACTIVITY_SNAPSHOT_MAX_AGE_MS,
  )
}

function isRealSolanaSignature(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)
}

export async function GET(req: NextRequest) {
  const requestId = createRequestId('activity')
  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(body, {
    status,
    headers: {
      'x-aura-request-id': requestId,
      ...headers,
    },
  })

  try {
    const identifier = getTrustedClientId(req.headers)
    const rate = activityLimiter.check(identifier)
    if (!rate.allowed) {
      logStructuredEvent('activity', 'rate_limited', { requestId, retryAfter: rate.retryAfter || 60 })
      return respond({ success: false, error: 'RATE_LIMITED', requestId }, 429, { 'Retry-After': String(rate.retryAfter || 60) })
    }
    const searchParams = req.nextUrl.searchParams
    const filter = searchParams.get('filter') || 'all'
    const operatorTenant = req.headers.get('x-aura-operator-tenant') || ''
    const juryCookie = req.cookies.get('aura_jury_session')?.value || ''
    const jurySession = juryCookie ? getJurySessionInfo(juryCookie) : null
    const isOperatorAudit = Boolean(
      operatorTenant && hasJuryAccessForTenant(operatorTenant, req.headers, juryCookie)
    )
    const requestedTenant = req.headers.get('x-aura-enclave-fingerprint') || ''
    // For this read-only projection the signed, HttpOnly jury session is the
    // authoritative tenant binding. A stale IndexedDB fingerprint can survive
    // an origin/port change; never let that stale header block the assigned
    // jury balance or cause the read to fall back to another tenant.
    // A valid, tenant-scoped jury session is sufficient for this read-only
    // activity projection. It avoids making a fresh jury browser depend on a
    // stale IndexedDB signing key while keeping all spend/deposit mutations
    // on their normal signed-key paths.
    const isJuryActivityRead = Boolean(jurySession && !operatorTenant)
    const effectiveTenant = isOperatorAudit
      ? operatorTenant
      : (jurySession?.tenantId || requestedTenant)
    const requestedPolicy = searchParams.get('policy') ||
      (usesSharedJuryZcashSource(effectiveTenant) ? 'fast' : 'private')
    const policy = requestedPolicy === 'fast' || requestedPolicy === 'strong' || requestedPolicy === 'custom'
      ? requestedPolicy
      : 'private'
    const policyMinimumConfirmations = getMinimumConfirmationsForBuffer(policy)
    const timestamp = Number(req.headers.get('x-aura-auth-timestamp'))
    const nonce = req.headers.get('x-aura-auth-nonce') || ''
    const publicKey = req.headers.get('x-aura-auth-public-key') || ''
    const signature = req.headers.get('x-aura-auth-signature') || ''

    if (!isOperatorAudit && !isJuryActivityRead) {
      if (
        !/^[a-zA-Z0-9._-]{1,128}$/.test(effectiveTenant) ||
        !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 2 * 60 * 1000 ||
        !/^[a-f0-9]{32}$/i.test(nonce) || !publicKey || !signature
      ) {
        logStructuredEvent('activity', 'auth_rejected', { requestId, reason: 'AUTHORIZATION_REQUIRED' })
        return respond({ success: false, error: 'AUTHORIZATION_REQUIRED', requestId }, 401)
      }
      const signedPayload = `${effectiveTenant}:read_activity:${timestamp}:${nonce}`
      if (!verifyClientEcdsaSignature(publicKey, signedPayload, signature)) {
        logStructuredEvent('activity', 'auth_rejected', { requestId, reason: 'INVALID_AUTHORIZATION' })
        return respond({ success: false, error: 'INVALID_AUTHORIZATION', requestId }, 401)
      }
      if (!persistentStore.claimAuthNonce(effectiveTenant, 'activity', nonce, 2 * 60 * 1000)) {
        logStructuredEvent('activity', 'auth_rejected', { requestId, reason: 'NONCE_REPLAYED' })
        return respond({ success: false, error: 'NONCE_REPLAYED', requestId }, 401)
      }
      if (!persistentStore.verifySpendSigningKey(effectiveTenant, publicKey)) {
        const isJuryReviewer = hasJuryAccessForTenant(effectiveTenant, req.headers, juryCookie)
        if (isJuryReviewer) {
          persistentStore.rotateSpendSigningKey(effectiveTenant, publicKey)
        } else {
          logStructuredEvent('activity', 'auth_rejected', { requestId, reason: 'SIGNING_KEY_MISMATCH' })
          return respond({ success: false, error: 'SIGNING_KEY_MISMATCH', requestId }, 401)
        }
      }
    }

    const rawTransactions = ledgerService.getTransactions(effectiveTenant, filter)
    const projectedTransactions: AuraTransaction[] = []
    const fastJuryRead = isJuryActivityRead && usesSharedJuryZcashSource(effectiveTenant)
    const projectTransaction = (current: AuraTransaction, updates: Partial<AuraTransaction>): AuraTransaction => ({
      ...current,
      ...updates,
    })
    // Read-only projection of on-chain receipt state. Recovery and all ledger
    // mutations run in the background reconciler or explicit POST jobs; this
    // GET must never rebroadcast or rewrite durable state. The jury screen is
    // intentionally a fast projection of the already-recorded receipts; the
    // authoritative shared Zcash source is read below from its last verified
    // chain snapshot, while retries/reconciliation stay out of GET.
    if (fastJuryRead) {
      // The jury read intentionally skips live RPC calls. Still normalize
      // durable finalized receipts so an old, already-settled payout cannot
      // remain visible as "Payout confirming" just because the fast path is
      // read-only.
      projectedTransactions.push(...rawTransactions.map((tx) => {
        const delivery = tx.legs?.delivery
        const durableFinalized = tx.toChain === 'solana' &&
          tx.status !== 'completed' &&
          delivery?.status === 'confirmed' &&
          delivery.confirmationStatus === 'finalized' &&
          hasBroadcastedShieldedSource(tx)
        return durableFinalized
          ? projectTransaction(tx, {
              status: 'completed',
              completedAt: tx.completedAt || delivery?.timestamp || Date.now(),
            })
          : tx
      }))
    }
    for (let tx of fastJuryRead ? [] : rawTransactions) {
      let depositConfirmed = tx.legs?.deposit?.status === 'confirmed'
      // A persisted `confirmed` label is not sufficient for Solana payout
      // completion. It is set true below only after this read observes
      // `finalized` from the chain.
      let deliveryConfirmed = false

      // GET /api/activity is read-only with respect to irreversible payouts.
      // A confirmed shielded spend is resumed by the authenticated
      // POST /api/settlement/reconcile job instead.
      tx = ledgerService.getTransactionById(tx.id, effectiveTenant) || tx

      // Never trust a persisted `completed` label for a Solana payout. Older
      // activity reads could write `completed` at `confirmed`; demote that
      // stale state until the destination signature is observed as finalized.
      if (tx.status === 'completed' && tx.toChain === 'solana' && tx.legs?.delivery?.confirmationStatus !== 'finalized') {
        const deliveryHash = tx.legs?.delivery?.txHash
        const signatureStatus = isRealSolanaSignature(deliveryHash)
          ? await solanaRelayer.getSignatureStatus(deliveryHash).catch(() => null)
          : null
        if (!isFinalizedSolanaSignatureStatus(signatureStatus)) {
          const sourceConfirmed = hasConfirmedShieldedSource(tx)
          tx = projectTransaction(tx, {
            status: signatureStatus?.err && !sourceConfirmed ? 'failed' : 'routing_shielded',
            completedAt: undefined,
            legs: {
              ...tx.legs,
              delivery: tx.legs.delivery
                ? {
                    ...tx.legs.delivery,
                    status: signatureStatus?.err ? 'failed' : deliveryHash ? 'broadcasting' : 'pending',
                    confirmationStatus: signatureStatus?.confirmationStatus,
                    description: signatureStatus?.err
                      ? 'Solana payout failed on-chain.'
                      : 'Solana payout is awaiting finalized confirmation.',
                  }
                : undefined,
            },
          })
        }
      }

      // If the Zcash CLI lost its response after broadcast, recover the txid
      // from the exact durable operation memo before doing any other state
      // transition. This prevents both a permanent freeze and a double-send.
      if (tx.legs?.shielded && !tx.legs.shielded.txHash &&
        (tx.status === 'processing' || tx.status === 'routing_shielded' || tx.status === 'settling_destination')) {
        const memo = tx.type === 'send' || tx.type === 'withdraw'
          ? `Aura Spend: ${tx.id}`
          : tx.type === 'receive'
            ? `Aura Invoice Shield: ${tx.id}`
            : `Aura Shield: ${tx.id}`
        const recoveredTxid = await zcashDevtoolService.findBroadcastTxidByMemo(memo)
        if (recoveredTxid) {
          tx = projectTransaction(tx, {
            legs: {
              ...tx.legs,
              shielded: {
                ...tx.legs.shielded,
                txHash: recoveredTxid,
                explorerUrl: `https://testnet.cipherscan.app/tx/${recoveredTxid}`,
                status: 'broadcasting',
                description: 'Recovered the Zcash broadcast identifier from the durable wallet record; awaiting confirmation.',
              },
            },
          })
        }
      }

      if ((tx.status === 'processing' || tx.status === 'routing_shielded') && tx.legs?.deposit?.txHash && tx.fromChain === 'base') {
        try {
          const receipt = await baseRelayer.getTransactionReceipt(tx.legs.deposit.txHash)
          const finality = receipt?.status === '0x1'
            ? await baseRelayer.verifyReceiptFinality(tx.legs.deposit.txHash, receipt)
            : { confirmed: false }
          if (finality.confirmed) {
            depositConfirmed = true
            const hasRealZcashTx = Boolean(
              tx.legs?.shielded?.txHash &&
              /^[0-9a-fA-F]{64}$/.test(tx.legs.shielded.txHash)
            )
            const shieldedStatus = hasRealZcashTx || hasConfirmedShieldedSource(tx) ? 'confirmed' : 'pending'
            const overallStatus = (hasRealZcashTx || hasConfirmedShieldedSource(tx)) && shieldedStatus === 'confirmed' ? 'completed' : 'routing_shielded'

            tx = projectTransaction(tx, {
                status: overallStatus,
                completedAt: overallStatus === 'completed' ? (tx.completedAt || Date.now()) : undefined,
                legs: {
                  ...tx.legs,
                  deposit: { ...tx.legs.deposit, status: 'confirmed' },
                  shielded: tx.legs.shielded ? { ...tx.legs.shielded, status: shieldedStatus } : undefined,
                },
            })
          } else if (receipt?.status === '0x0') {
            tx = projectTransaction(tx, { status: 'failed' })
          }
        } catch {}
      } else if ((tx.status === 'processing' || tx.status === 'routing_shielded') && tx.legs?.deposit?.txHash && tx.fromChain === 'solana') {
        try {
          const sig = await solanaRelayer.getSignatureStatus(tx.legs.deposit.txHash)
          if (isFinalizedSolanaSignatureStatus(sig)) {
            depositConfirmed = true
            const hasRealZcashTx = Boolean(
              tx.legs?.shielded?.txHash &&
              /^[0-9a-fA-F]{64}$/.test(tx.legs.shielded.txHash)
            )
            const shieldedStatus = hasRealZcashTx || hasConfirmedShieldedSource(tx) ? 'confirmed' : 'pending'
            const overallStatus = (hasRealZcashTx || hasConfirmedShieldedSource(tx)) && shieldedStatus === 'confirmed' ? 'completed' : 'routing_shielded'

            tx = projectTransaction(tx, {
                status: overallStatus,
                completedAt: overallStatus === 'completed' ? (tx.completedAt || Date.now()) : undefined,
                legs: {
                  ...tx.legs,
                  deposit: { ...tx.legs.deposit, status: 'confirmed' },
                  shielded: tx.legs.shielded ? { ...tx.legs.shielded, status: shieldedStatus } : undefined,
                },
            })
          } else if (sig?.err) {
            const sourceSpendConfirmed = hasConfirmedShieldedSource(tx)
            tx = projectTransaction(tx, {
              status: sourceSpendConfirmed ? 'routing_shielded' : 'failed',
              legs: tx.legs?.delivery ? { ...tx.legs, delivery: { ...tx.legs.delivery, status: 'failed' } } : tx.legs,
            })
          }
        } catch {}
      } else if (
        (tx.status === 'routing_near' || tx.status === 'settling_destination' || tx.status === 'routing_shielded') &&
        tx.legs?.delivery?.txHash &&
        tx.toChain === 'solana'
      ) {
        // A previous recovery already stored the destination signature as
        // finalized. Keep that durable marker authoritative for this
        // read-only projection when the public Solana RPC is temporarily
        // unavailable; otherwise old, genuinely finalized payouts appear
        // forever as "Payout confirming".
        const storedFinalizedDelivery =
          tx.legs.delivery.status === 'confirmed' &&
          tx.legs.delivery.confirmationStatus === 'finalized'
        if (storedFinalizedDelivery && hasBroadcastedShieldedSource(tx)) {
          deliveryConfirmed = true
          tx = projectTransaction(tx, {
            status: 'completed',
            completedAt: tx.completedAt || tx.legs.delivery.timestamp || Date.now(),
          })
        } else {
          try {
            const sig = await solanaRelayer.getSignatureStatus(tx.legs.delivery.txHash)
            if (isFinalizedSolanaSignatureStatus(sig)) {
              deliveryConfirmed = true
              const sourceConfirmed = hasBroadcastedShieldedSource(tx)
              const nextStatus = sourceConfirmed ? 'completed' : 'routing_shielded'
              tx = projectTransaction(tx, {
                  status: nextStatus,
                  completedAt: nextStatus === 'completed' ? Date.now() : undefined,
                  legs: {
                    ...tx.legs,
                    delivery: { ...tx.legs.delivery, status: 'confirmed', confirmationStatus: 'finalized' },
                  },
              })
            } else if (sig?.err) {
              const sourceSpendConfirmed = hasConfirmedShieldedSource(tx)
              tx = projectTransaction(tx, {
                status: sourceSpendConfirmed ? 'routing_shielded' : 'failed',
                legs: tx.legs?.delivery
                  ? { ...tx.legs, delivery: { ...tx.legs.delivery, status: 'failed' } }
                  : tx.legs,
              })
            }
          } catch {}
        }
      } else if (
        (tx.status === 'routing_near' || tx.status === 'settling_destination' || tx.status === 'routing_shielded') &&
        tx.legs?.delivery?.txHash &&
        tx.toChain === 'base'
      ) {
        try {
          const receipt = await baseRelayer.getTransactionReceipt(tx.legs.delivery.txHash)
          const finality = receipt?.status === '0x1'
            ? await baseRelayer.verifyReceiptFinality(tx.legs.delivery.txHash, receipt)
            : { confirmed: false }
          if (finality.confirmed) {
            deliveryConfirmed = true
            const sourceConfirmed = hasConfirmedShieldedSource(tx)
            const nextStatus = sourceConfirmed ? 'completed' : 'routing_shielded'
            tx = projectTransaction(tx, {
                status: nextStatus,
                completedAt: nextStatus === 'completed' ? Date.now() : undefined,
                legs: {
                  ...tx.legs,
                  delivery: { ...tx.legs.delivery, status: 'confirmed' },
                },
            })
          } else if (receipt?.status === '0x0') {
            const sourceSpendConfirmed = hasConfirmedShieldedSource(tx)
            tx = projectTransaction(tx, {
              status: sourceSpendConfirmed ? 'routing_shielded' : 'failed',
              legs: tx.legs?.delivery ? { ...tx.legs, delivery: { ...tx.legs.delivery, status: 'failed' } } : tx.legs,
            })
          }
        } catch {}
      }

      // Check Zcash shielded leg confirmation if broadcast txid is present
      if (
        tx.legs?.shielded?.txHash &&
        /^[a-fA-F0-9]{64}$/.test(tx.legs.shielded.txHash)
      ) {
        try {
          const zconf = await zcashDevtoolService.verifyConfirmation(tx.legs.shielded.txHash)
          if (zconf.confirmed) {
            const nextStatus = tx.type === 'send' || tx.type === 'withdraw'
              ? (deliveryConfirmed ? 'completed' : tx.legs?.delivery?.status === 'failed' ? 'routing_shielded' : tx.legs?.delivery?.txHash ? 'settling_destination' : 'routing_shielded')
              : (depositConfirmed ? 'completed' : tx.legs?.deposit?.status === 'failed' ? 'failed' : 'routing_shielded')
            tx = projectTransaction(tx, {
                status: nextStatus,
                completedAt: nextStatus === 'completed' ? (tx.completedAt || Date.now()) : undefined,
                legs: {
                  ...tx.legs,
                  shielded: {
                    ...tx.legs.shielded,
                    status: 'confirmed',
                    description: `Shielded transaction confirmed on Zcash Testnet (Block #${zconf.blockHeight || 'testnet'}, Tx #${tx.legs.shielded.txHash.slice(0, 16)}...)`,
                  },
                },
            })
          } else if (zconf.state === 'mined' || zconf.state === 'pending') {
            const destinationAlreadyFinalized = tx.toChain === 'solana' &&
              tx.legs?.delivery?.status === 'confirmed' &&
              tx.legs.delivery.confirmationStatus === 'finalized'
            tx = projectTransaction(tx, {
              // A real Zcash broadcast plus a finalized Solana payout is a
              // completed user payment. Keep the Zcash leg visibly pending
              // without demoting the user-facing receipt back to routing.
              status: destinationAlreadyFinalized
                ? 'completed'
                : tx.status === 'completed' || tx.status === 'settling_destination' ? 'routing_shielded' : tx.status,
              legs: { ...tx.legs, shielded: { ...tx.legs.shielded, status: 'broadcasting', description: `Mined on Zcash Testnet; waiting for ${zconf.requiredConfirmations || 'safety'} confirmations (${zconf.confirmations || 0}/${zconf.requiredConfirmations || '—'}).` } },
            })
          }
        } catch {}
      }

      projectedTransactions.push(tx)
    }

    const transactions = projectedTransactions
    const ledgerBalance = ledgerService.getTenantBalance(effectiveTenant)
    const maxEntitlementUsd = usesSharedJuryZcashSource(effectiveTenant)
      ? ledgerBalance.totalUsd
      : null
    let shieldedZecBalance: number | null = null
    let policyEligibleShieldedZec: number | null = null
    let onChainZecBackedUsd: number | null = null
    let zecRateUsd: number | null = null
    let zcashAccountAddress: string | undefined
    let zcashStateSynced = false
    try {
      const tenantAccount = usesSharedJuryZcashSource(effectiveTenant)
        ? await zcashDevtoolService.getSharedSourceAccount()
        : await zcashDevtoolService.ensureTenantAccount(effectiveTenant)
      zcashAccountAddress = tenantAccount.unified
      const cacheKey = `${tenantAccount.accountId}:${policyMinimumConfirmations}`
      const cached = activityChainCache.get(cacheKey)
      const verifiedSnapshot = usesSharedJuryZcashSource(effectiveTenant)
        ? getSharedActivitySnapshot(cacheKey)
        : null
      if (cached && cached.expiresAt > Date.now()) {
        zcashStateSynced = cached.synced
        shieldedZecBalance = cached.spendableZec
        policyEligibleShieldedZec = cached.policyEligibleZec
        zecRateUsd = cached.rateUsd
        onChainZecBackedUsd = cached.backedUsd
      } else if (verifiedSnapshot) {
        zcashStateSynced = verifiedSnapshot.synced
        shieldedZecBalance = verifiedSnapshot.spendableZec
        policyEligibleShieldedZec = verifiedSnapshot.policyEligibleZec
        zecRateUsd = verifiedSnapshot.rateUsd
        onChainZecBackedUsd = verifiedSnapshot.backedUsd
        activityChainCache.set(cacheKey, verifiedSnapshot)
      } else {
        const syncResult = await zcashDevtoolService.sync()
        const accountBalance = await zcashDevtoolService.getBalance(tenantAccount.accountId)
        // Fast mode uses the same confirmed read because its minimum is one
        // confirmation. This avoids a second serialized wallet CLI call on
        // the hosted jury path, which can outlive the reverse proxy timeout.
        const policyEligibleBalance = policyMinimumConfirmations <= 1
          ? accountBalance
          : await zcashDevtoolService.getBalance(tenantAccount.accountId, policyMinimumConfirmations)
        zcashStateSynced = Boolean(
          syncResult.success &&
          accountBalance.available && accountBalance.chainHeight !== undefined &&
          policyEligibleBalance.available && policyEligibleBalance.chainHeight !== undefined,
        )
        if (zcashStateSynced) {
          shieldedZecBalance = getShieldedSpendableZec(accountBalance)
          policyEligibleShieldedZec = getShieldedSpendableZec(policyEligibleBalance)
          const zecRate = await ratesService.getFreshRate('ZEC')
          if (zecRate) {
            zecRateUsd = zecRate.usdPrice
            onChainZecBackedUsd = Number((shieldedZecBalance * zecRate.usdPrice).toFixed(2))
          }
        }
        const snapshot = {
          accountId: tenantAccount.accountId,
          address: tenantAccount.unified,
          synced: zcashStateSynced,
          spendableZec: shieldedZecBalance,
          policyEligibleZec: policyEligibleShieldedZec,
          rateUsd: zecRateUsd,
          backedUsd: onChainZecBackedUsd,
          expiresAt: Date.now() + ACTIVITY_CHAIN_CACHE_MS,
        }
        activityChainCache.set(cacheKey, snapshot)
        if (usesSharedJuryZcashSource(effectiveTenant) && zcashStateSynced) {
          setSharedActivitySnapshot(cacheKey, snapshot)
        }
      }
    } catch (zcashStateError) {
      console.warn('Could not read the tenant shielded Zcash state:', zcashStateError)
    }
    const chainAvailableUsd = zcashStateSynced && onChainZecBackedUsd !== null && zecRateUsd !== null
      ? Math.max(0, onChainZecBackedUsd - ZCASH_FEE_RESERVE_ZEC * zecRateUsd)
      : null
    const chainAvailableZec = zcashStateSynced && shieldedZecBalance !== null
      ? Math.max(0, shieldedZecBalance - ZCASH_FEE_RESERVE_ZEC)
      : null
    const policyEligibleZec = zcashStateSynced && policyEligibleShieldedZec !== null
      ? Math.max(0, policyEligibleShieldedZec - ZCASH_FEE_RESERVE_ZEC)
      : null
    const reconciledLedger = reconcileLedgerBalanceWithShieldedChain(
      ledgerBalance,
      chainAvailableUsd,
      chainAvailableZec,
      zecRateUsd,
      policyEligibleZec,
      maxEntitlementUsd,
    )
    const balance = {
      ...ledgerBalance,
      totalUsd: reconciledLedger.totalUsd,
      readyToSpendUsd: reconciledLedger.readyToSpendUsd,
      // Fast skips only the optional time buffer. It remains bounded by both
      // the tenant ledger and the confirmed spendable Zcash balance.
      fastAvailableToSendUsd: reconciledLedger.fastAvailableToSendUsd,
      onChainZecBackedUsd,
      shieldedZecBalance,
      policyEligibleZec,
      policyMinimumConfirmations,
      policy,
      zcashAccountAddress,
      zcashStateSynced,
      balanceAvailable: chainAvailableUsd !== null,
    }

    logStructuredEvent('activity', 'read_succeeded', {
      requestId,
      transactionCount: transactions.length,
      balanceAvailable: balance.balanceAvailable === true,
      zcashStateSynced: balance.zcashStateSynced === true,
    })

    return respond({
      success: true,
      data: transactions,
      total: transactions.length,
      balance,
      filter,
      tenantId: effectiveTenant,
    }, 200, {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Referrer-Policy': 'no-referrer',
    })
  } catch (error) {
    logStructuredEvent('activity', 'read_failed', { requestId, error: safeErrorMessage(error) })
    return respond({ success: false, error: 'Failed to retrieve activity transactions', requestId }, 500)
  }
}
