import { isFinalizedSolanaSignatureStatus, solanaRelayer } from '@/lib/crypto/solana-relayer'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { ledgerService } from '@/lib/services/ledger-service'
import { persistentStore, StoredDurableOperation } from '@/lib/services/persistent-store'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { AuraTransaction } from '@/lib/types/aura'
import { resumeConfirmedShieldedPayout } from '@/lib/services/settlement-reconciler'
import { generateSecureId } from '@/lib/utils'
import { ratesService } from '@/lib/services/rates-service'
import { getShieldedSpendableZec, ZCASH_FEE_RESERVE_ZEC } from '@/lib/services/zcash-balance'
import { getSharedJuryEntitlementUsd, usesSharedJuryZcashSource } from '@/lib/services/jury-zcash-source'
import { hasBroadcastedShieldedSource, hasFinalizedSolanaDelivery } from '@/lib/utils/transaction-finality'

// A broadcast id that is absent from both the wallet history and the public
// explorer is not safe to retry immediately: a slow lightwalletd response can
// otherwise create a second shield. Once the original durable intent is old
// enough and a fresh wallet sync succeeds, it is safe to recover the deposit.
const UNKNOWN_DEPOSIT_RECOVERY_GRACE_MS = 90_000
// A confirmed Base deposit must never remain in an endless shield/retry loop.
// Four distinct broadcasts are enough to recover a transient wallet/network
// failure; after that the operation becomes an explicit terminal failure so
// the UI cannot present an unbounded "in progress" balance.
const MAX_DEPOSIT_SHIELD_ATTEMPTS = 4
// A Zcash spend can expire before it is mined on testnet. Keep the reserved
// ledger amount and retry the same durable payment with a new memo, but cap
// the number of real broadcasts so a broken wallet cannot loop forever.
const MAX_SPEND_SHIELD_ATTEMPTS = 4

function isZcashTxid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

function samePaymentHash(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  return /^0x[0-9a-f]{64}$/i.test(left) && /^0x[0-9a-f]{64}$/i.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function zcashRecoveredTransaction(
  operation: StoredDurableOperation,
  txid: string,
  state: 'confirmed' | 'pending' | 'expired' | 'unknown',
): AuraTransaction {
  const source = operation.transaction
  const shielded = source.legs?.shielded
  const confirmed = state === 'confirmed'
  const expired = state === 'expired'
  const status = confirmed ? 'completed' : expired ? 'failed' : 'routing_shielded'
  return {
    ...source,
    status,
    completedAt: confirmed ? (source.completedAt || Date.now()) : undefined,
    legs: {
      ...source.legs,
      shielded: shielded ? {
        ...shielded,
        txHash: txid,
        explorerUrl: `https://testnet.cipherscan.app/tx/${txid}`,
        status: confirmed ? 'confirmed' : expired ? 'failed' : 'broadcasting',
        description: confirmed
          ? `Shielded transaction confirmed on Zcash Testnet (Tx #${txid.slice(0, 16)}...).`
          : expired
            ? `Zcash transaction expired unmined (Tx #${txid.slice(0, 16)}...). No shielded credit was recorded.`
          : `Recovered the Zcash broadcast from the durable wallet record (Tx #${txid.slice(0, 16)}...). Awaiting confirmation.`,
      } : undefined,
    },
  }
}

function saveRecoveredTransaction(
  transaction: AuraTransaction,
  tenantId: string,
  ledger: typeof ledgerService,
): AuraTransaction {
  const existing = ledger.getTransactionById(transaction.id, tenantId)
  if (existing) {
    return ledger.updateTransaction(transaction.id, transaction, tenantId) || existing
  }
  return ledger.addTransaction(transaction, tenantId)
}

async function retryDepositShield(
  operation: StoredDurableOperation,
  store: typeof persistentStore,
  ledger: typeof ledgerService,
  expiredTxid?: string,
): Promise<void> {
  await store.withExternalBroadcastLock(async () => {
    const current = store.getPendingOperation(operation.id)
    if (!current || current.kind !== 'deposit_shield') return

    const destinationAddress = current.recipientAddress || current.transaction?.legs?.shielded?.destinationAddress
    const amountZec = current.amountZec || current.transaction?.backingZec || 0
    if (!destinationAddress || amountZec <= 0) return

    // Re-check the durable identity after acquiring the process-wide lock.
    // Another worker may have already recovered this operation while this
    // worker was waiting for the lock.
    if (current.zcashTxid && current.zcashTxid !== expiredTxid) {
      const state = await zcashDevtoolService.verifyConfirmation(current.zcashTxid).catch(() => ({ state: 'unknown' as const, confirmed: false }))
      if (state.state !== 'expired') return
    }

    if (current.memo) {
      const activeTxid = await zcashDevtoolService.findBroadcastTxidByMemo(current.memo).catch(() => undefined)
      if (activeTxid && activeTxid !== expiredTxid) {
        const activeState = await zcashDevtoolService.verifyConfirmation(activeTxid).catch(() => ({ state: 'unknown' as const, confirmed: false }))
        if (activeState.state !== 'expired') {
          const recovered = saveRecoveredTransaction({
            ...current.transaction,
            status: activeState.confirmed ? 'completed' : 'routing_shielded',
            completedAt: activeState.confirmed ? (current.transaction.completedAt || Date.now()) : undefined,
            legs: {
              ...current.transaction.legs,
              shielded: {
                ...(current.transaction.legs?.shielded || {}),
                chain: 'zcash',
                txHash: activeTxid,
                explorerUrl: `https://testnet.cipherscan.app/tx/${activeTxid}`,
                status: activeState.confirmed ? 'confirmed' : 'broadcasting',
                description: 'Recovered the active Zcash broadcast from its unique retry memo.',
              },
            },
          }, current.tenantId, ledger)
          store.updatePendingOperation(current.id, {
            status: activeState.confirmed ? 'confirmed' : 'broadcasted',
            zcashTxid: activeTxid,
            transaction: recovered,
          })
          return
        }
      }
    }

    const attemptNumber = Math.max(1, (current.attemptNumber || 1) + 1)
    const attemptId = generateSecureId('shield-attempt')
    const baseMemo = (current.memo || `Aura Shield ${current.txId}`).replace(/ retry [0-9]+ [a-zA-Z0-9_-]+$/, '')
    const retryMemo = `${baseMemo} retry ${attemptNumber} ${attemptId}`
    const existingShielded = current.transaction?.legs?.shielded
    const retryTransaction: AuraTransaction = {
      ...current.transaction,
      status: 'routing_shielded',
      legs: {
        ...current.transaction?.legs,
        shielded: {
          ...(existingShielded || {}),
          chain: 'zcash',
          status: 'broadcasting',
          description: `Retry ${attemptNumber}: previous Zcash shield expired; preparing a fresh broadcast.`,
        },
      },
    }
    const prepared = store.updatePendingOperation(current.id, {
      status: 'broadcasting',
      memo: retryMemo,
      attemptNumber,
      attemptId,
      transaction: retryTransaction,
    })
    if (!prepared) return

    const retryResult = await zcashDevtoolService.sendShielded(
      destinationAddress,
      amountZec,
      retryMemo,
      () => {
        if (!store.updatePendingOperation(current.id, { status: 'broadcasting' })) {
          throw new Error('Could not persist the Zcash retry before broadcast.')
        }
      },
      current.senderAccountId,
    ).catch((err) => ({ success: false, error: String(err), txid: undefined }))

    if (!retryResult.success || !retryResult.txid) {
      store.updatePendingOperation(current.id, {
        status: 'recovery_required',
        transaction: {
          ...retryTransaction,
          legs: {
            ...retryTransaction.legs,
            shielded: {
              ...(retryTransaction.legs?.shielded || {}),
              chain: 'zcash',
              status: 'pending',
              description: `Retry ${attemptNumber} was not broadcast; durable recovery remains queued.`,
            },
          },
        },
      })
      return
    }

    const newTxid = retryResult.txid
    const updatedTx: AuraTransaction = {
      ...retryTransaction,
      legs: {
        ...retryTransaction.legs,
        shielded: {
          ...(retryTransaction.legs?.shielded || {}),
          chain: 'zcash',
          txHash: newTxid,
          explorerUrl: `https://testnet.cipherscan.app/tx/${newTxid}`,
          status: 'broadcasting',
          description: `Zcash retry ${attemptNumber} broadcast (Tx #${newTxid.slice(0, 16)}...). Awaiting confirmation.`,
        },
      },
    }
    const stored = saveRecoveredTransaction(updatedTx, current.tenantId, ledger)
    store.updatePendingOperation(current.id, {
      status: 'broadcasted',
      zcashTxid: newTxid,
      transaction: stored,
    })
  })
}

async function retrySpendShield(
  operation: StoredDurableOperation,
  store: typeof persistentStore,
  ledger: typeof ledgerService,
  expiredTxid?: string,
): Promise<void> {
  await store.withExternalBroadcastLock(async () => {
    const current = store.getPendingOperation(operation.id)
    if (!current || current.kind !== 'spend_shield') return

    const destinationAddress = current.recipientAddress || current.transaction?.legs?.shielded?.destinationAddress
    const amountZec = current.amountZec || 0
    if (!destinationAddress || amountZec <= 0) return

    // Another worker may have already advanced this operation while this
    // worker waited for the external broadcast lock.
    if (current.zcashTxid && current.zcashTxid !== expiredTxid) {
      const state = await zcashDevtoolService.verifyConfirmation(current.zcashTxid).catch(() => ({ state: 'unknown' as const, confirmed: false }))
      if (state.state !== 'expired') return
    }

    // Recover an active retry by its exact memo before broadcasting anything.
    if (current.memo) {
      const activeTxid = await zcashDevtoolService.findBroadcastTxidByMemo(current.memo).catch(() => undefined)
      if (activeTxid && activeTxid !== expiredTxid) {
        const activeState = await zcashDevtoolService.verifyConfirmation(activeTxid).catch(() => ({ state: 'unknown' as const, confirmed: false }))
        if (activeState.state !== 'expired') {
          const recovered = saveRecoveredTransaction({
            ...current.transaction,
            status: activeState.confirmed ? 'routing_shielded' : 'routing_shielded',
            completedAt: undefined,
            legs: {
              ...current.transaction.legs,
              shielded: {
                ...(current.transaction.legs?.shielded || {}),
                chain: 'zcash',
                txHash: activeTxid,
                explorerUrl: `https://testnet.cipherscan.app/tx/${activeTxid}`,
                status: activeState.confirmed ? 'confirmed' : 'broadcasting',
                description: activeState.confirmed
                  ? 'Recovered the confirmed Zcash spend from its unique retry memo.'
                  : 'Recovered the active Zcash spend from its unique retry memo; awaiting confirmation.',
              },
            },
          }, current.tenantId, ledger)
          store.updatePendingOperation(current.id, {
            status: activeState.confirmed ? 'confirmed' : 'broadcasted',
            zcashTxid: activeTxid,
            transaction: recovered,
          })
          return
        }
      }
    }

    const attemptNumber = Math.max(1, (current.attemptNumber || 1) + 1)
    if (attemptNumber > MAX_SPEND_SHIELD_ATTEMPTS) return
    const attemptId = generateSecureId('spend-attempt')
    const baseMemo = (current.memo || `Aura Spend: ${current.txId}`).replace(/ retry [0-9]+ [a-zA-Z0-9_-]+$/, '')
    const retryMemo = `${baseMemo} retry ${attemptNumber} ${attemptId}`
    const existingShielded = current.transaction?.legs?.shielded
    const retryTransaction: AuraTransaction = {
      ...current.transaction,
      status: 'routing_shielded',
      completedAt: undefined,
      legs: {
        ...current.transaction?.legs,
        shielded: {
          ...(existingShielded || {}),
          chain: 'zcash',
          status: 'broadcasting',
          description: `Retry ${attemptNumber}: previous Zcash spend expired; preparing a fresh broadcast.`,
        },
      },
    }
    const prepared = store.updatePendingOperation(current.id, {
      status: 'broadcasting',
      memo: retryMemo,
      attemptNumber,
      attemptId,
      transaction: retryTransaction,
    })
    if (!prepared) return

    const retryResult = await zcashDevtoolService.sendShielded(
      destinationAddress,
      amountZec,
      retryMemo,
      () => {
        if (!store.updatePendingOperation(current.id, { status: 'broadcasting' })) {
          throw new Error('Could not persist the Zcash spend retry before broadcast.')
        }
      },
      current.senderAccountId,
    ).catch((err) => ({ success: false, error: String(err), txid: undefined }))

    if (!retryResult.success || !retryResult.txid) {
      store.updatePendingOperation(current.id, {
        status: 'recovery_required',
        transaction: {
          ...retryTransaction,
          legs: {
            ...retryTransaction.legs,
            shielded: {
              ...(retryTransaction.legs?.shielded || {}),
              chain: 'zcash',
              status: 'pending',
              description: `Retry ${attemptNumber} was not broadcast; the reserved payment remains queued for recovery.`,
            },
          },
        },
      })
      return
    }

    const newTxid = retryResult.txid
    const updatedTx: AuraTransaction = {
      ...retryTransaction,
      legs: {
        ...retryTransaction.legs,
        shielded: {
          ...(retryTransaction.legs?.shielded || {}),
          chain: 'zcash',
          txHash: newTxid,
          explorerUrl: `https://testnet.cipherscan.app/tx/${newTxid}`,
          status: 'broadcasting',
          description: `Zcash spend retry ${attemptNumber} broadcast (Tx #${newTxid.slice(0, 16)}...). Awaiting confirmation.`,
        },
      },
    }
    const stored = saveRecoveredTransaction(updatedTx, current.tenantId, ledger)
    store.updatePendingOperation(current.id, {
      status: 'broadcasted',
      zcashTxid: newTxid,
      transaction: stored,
    })
  })
}

/**
 * Shared jury deposits do not create a new Zcash transaction. If Base was
 * confirmed while the pooled inventory was fully allocated, keep the exact
 * source payment pending and allocate it later under the same ledger lock.
 */
async function reconcileSharedPoolBacking(
  operation: StoredDurableOperation,
  store: typeof persistentStore,
  ledger: typeof ledgerService,
): Promise<void> {
  const sourceAccount = await zcashDevtoolService.getSharedSourceAccount().catch(() => null)
  const rate = await ratesService.getFreshRate('ZEC').catch(() => null)
  if (!sourceAccount || !rate) return
  const sourceBalance = await zcashDevtoolService.getBalance(sourceAccount.accountId).catch(() => null)
  const sourceZec = sourceBalance ? getShieldedSpendableZec(sourceBalance) : 0
  const sourceCapacityUsd = Number(Math.max(0, sourceZec - ZCASH_FEE_RESERVE_ZEC).toFixed(6)) * rate.usdPrice
  if (!sourceBalance?.available || !Number.isFinite(sourceCapacityUsd)) return

  const allocation = store.mutateLedger<{ allocated: boolean; transaction: AuraTransaction | null }>((all) => {
    const tenantTransactions = Array.isArray(all[operation.tenantId]) ? all[operation.tenantId] : []
    const current = tenantTransactions.find((candidate) => candidate.id === operation.txId) || operation.transaction
    if (current.status === 'completed' && current.legs?.shielded?.status === 'confirmed') {
      return { ledger: all, result: { allocated: true, transaction: current } }
    }

    const existingEntitlementUsd = getSharedJuryEntitlementUsd(ledger, store.listPendingOperations(), operation.id)
    const amountUsd = Number(operation.amountUsd ?? current.toAmount)
    if (!Number.isFinite(amountUsd) || existingEntitlementUsd + amountUsd > sourceCapacityUsd + 1e-9) {
      return { ledger: all, result: { allocated: false, transaction: null } }
    }

    const beforeUsd = ledger.getTenantBalance(operation.tenantId).totalUsd
    const allocated: AuraTransaction = {
      ...current,
      status: 'completed',
      completedAt: current.completedAt || Date.now(),
      settlementMode: 'jury_inventory',
      backingSource: 'confirmed_zcash_inventory',
      balanceCheckpoint: {
        beforeUsd,
        afterUsd: Number((beforeUsd + amountUsd).toFixed(2)),
        deltaUsd: amountUsd,
        capturedAt: Date.now(),
      },
      legs: {
        ...current.legs,
        shielded: current.legs?.shielded ? {
          ...current.legs.shielded,
          status: 'confirmed',
          txHash: undefined,
          explorerUrl: undefined,
          description: 'Backed by AURA’s confirmed shielded Zcash Testnet inventory.',
        } : undefined,
      },
    }
    const existingIndex = tenantTransactions.findIndex((candidate) => candidate.id === operation.txId)
    if (existingIndex >= 0) tenantTransactions[existingIndex] = allocated
    else tenantTransactions.unshift(allocated)
    all[operation.tenantId] = tenantTransactions
    return { ledger: all, result: { allocated: true, transaction: allocated } }
  })

  if (!allocation.allocated || !allocation.transaction) return
  store.updatePendingOperation(operation.id, { status: 'confirmed', transaction: allocation.transaction })
  const paymentHash = operation.paymentTxHash || operation.sourceTxHash
  if (paymentHash) {
    store.consumeDemoDepositBinding(paymentHash)
    store.releasePaymentTxHash(paymentHash)
  }
  store.deletePendingOperation(operation.id)
}

async function reconcileZcashOperation(
  operation: StoredDurableOperation,
  store: typeof persistentStore,
  ledger: typeof ledgerService,
): Promise<void> {
  const inventoryBackedOperation =
    operation.transaction.settlementMode === 'jury_inventory' &&
    operation.transaction.backingSource === 'confirmed_zcash_inventory' &&
    !operation.zcashTxid
  const legacySharedDeposit =
    operation.kind === 'deposit_shield' &&
    (operation.status === 'broadcasted' || operation.status === 'recovery_required') &&
    (
      isZcashTxid(operation.zcashTxid) ||
      isZcashTxid(operation.transaction.legs?.shielded?.txHash)
    )
  if (
    (operation.kind === 'deposit_backing' || operation.kind === 'deposit_shield') &&
    usesSharedJuryZcashSource(operation.tenantId) &&
    (operation.kind === 'deposit_backing' || inventoryBackedOperation || legacySharedDeposit)
  ) {
    await reconcileSharedPoolBacking(operation, store, ledger)
    return
  }
  if (!operation.memo) return

  const existing = ledger.getTransactionById(operation.txId, operation.tenantId)
  const existingTxid = existing?.legs?.shielded?.txHash
  let txid = isZcashTxid(operation.zcashTxid)
    ? operation.zcashTxid
    : isZcashTxid(existingTxid)
      ? existingTxid
      : await zcashDevtoolService.findBroadcastTxidByMemo(operation.memo)
  if (!txid) {
    // A confirmed Base deposit can legitimately have a durable intent but no
    // Zcash txid when the first broadcast failed before the wallet accepted it.
    // Keep recovery alive instead of treating the missing txid as a terminal read.
    if (operation.kind === 'deposit_shield' && operation.status === 'recovery_required') {
      await retryDepositShield(operation, store, ledger)
    }
    return
  }

  let confirmation = await zcashDevtoolService.verifyConfirmation(txid).catch(() => ({ confirmed: false, state: 'unknown' as const }))

  // A terminally failed deposit must never be revived by a later reconciliation
  // pass just because its old Zcash tx is still present in wallet history.
  if (operation.kind === 'deposit_shield' && ledger.getTransactionById(operation.txId, operation.tenantId)?.status === 'failed') {
    store.deletePendingOperation(operation.id)
    return
  }

  // An unmined operation remains durable and keeps its claim/reservation. A
  // later request must be able to observe the same txid instead of starting a
  // duplicate shield. Only a mined or definitively expired tx can leave this
  // recovery state.
  if (confirmation.state === 'unknown' && operation.kind === 'deposit_shield' && operation.status === 'broadcasted') {
    const existingDeposit = ledger.getTransactionById(operation.txId, operation.tenantId)

    // Legacy failed rows could leave a stale durable operation behind. They
    // must not be retried or counted as a new deposit.
    if (existingDeposit?.status === 'failed') {
      store.deletePendingOperation(operation.id)
      return
    }

    const operationAge = Date.now() - Math.min(operation.createdAt || Date.now(), operation.updatedAt || Date.now())
    if (operationAge >= UNKNOWN_DEPOSIT_RECOVERY_GRACE_MS) {
      const sync = await zcashDevtoolService.sync().catch(() => ({ success: false }))
      const activeTxid = operation.memo
        ? await zcashDevtoolService.findBroadcastTxidByMemo(operation.memo).catch(() => undefined)
        : undefined

      // A successful sync plus no exact wallet/explorer identity means this
      // txid never became a live Zcash transaction. Retry the same durable
      // Base deposit with a unique attempt memo; never credit it here.
      if (sync.success && !activeTxid) {
        await retryDepositShield(operation, store, ledger, txid)
        return
      }
    }
  }

  if (confirmation.state === 'pending' || confirmation.state === 'mined' || confirmation.state === 'unknown') {
    store.updatePendingOperation(operation.id, {
      status: 'broadcasted',
      zcashTxid: txid,
    })
    return
  }

  // If this is a deposit and Zcash broadcast expired unmined, DO NOT mark failed or delete.
  // The Base funds are confirmed; trigger a fresh shield broadcast with current tip
  // while the bounded retry budget remains. Once it is exhausted, persist a clear
  // failed ledger row and remove the durable in-flight operation. The Base claim is
  // intentionally kept consumed so the same public deposit cannot be credited twice.
  if (operation.kind === 'deposit_shield' && confirmation.state === 'expired') {
    if ((operation.attemptNumber || 1) >= MAX_DEPOSIT_SHIELD_ATTEMPTS) {
      const recovered = zcashRecoveredTransaction(operation, txid, 'expired')
      const failed = saveRecoveredTransaction({
        ...recovered,
        status: 'failed',
        completedAt: undefined,
        legs: recovered.legs?.deposit && recovered.legs.shielded
          ? {
              ...recovered.legs,
              shielded: {
                ...recovered.legs.shielded,
                status: 'failed',
                description: `Zcash shielding expired after ${operation.attemptNumber || 1} broadcasts. No private credit was recorded and automatic retry has stopped.`,
              },
            }
          : recovered.legs,
      }, operation.tenantId, ledger)
      store.updatePendingOperation(operation.id, {
        status: 'recovery_required',
        zcashTxid: txid,
        transaction: failed,
      })
      store.deletePendingOperation(operation.id)
      return
    }
    await retryDepositShield(operation, store, ledger, txid)
    return
  }

  const recovered = zcashRecoveredTransaction(operation, txid, confirmation.state === 'confirmed' ? 'confirmed' : 'expired')

  if (operation.kind === 'spend_shield') {
    if (confirmation.state === 'expired' && (operation.attemptNumber || 1) < MAX_SPEND_SHIELD_ATTEMPTS) {
      await retrySpendShield(operation, store, ledger, txid)
      return
    }
    const stored = saveRecoveredTransaction({
      ...recovered,
      status: confirmation.state === 'confirmed' ? 'routing_shielded' : 'failed',
      completedAt: undefined,
      balanceCheckpoint: recovered.balanceCheckpoint,
    }, operation.tenantId, ledger)
    if (confirmation.state === 'expired') {
      ledger.releaseReservation(operation.tenantId, operation.txId, 'Zcash shielded spend expired before confirmation; no destination payout was sent.')
    }
    store.updatePendingOperation(operation.id, {
      status: confirmation.state === 'confirmed' ? 'confirmed' : 'recovery_required',
      zcashTxid: txid,
      transaction: stored,
    })
    store.deletePendingOperation(operation.id)
    return
  }

  // A receive invoice is consumed only as part of the same recovery pass as
  // the recipient ledger write. This closes the crash window between a Zcash
  // broadcast and the old post-broadcast invoice mutation.
  if (operation.kind === 'invoice_shield' && operation.requestId) {
    const request = store.getPaymentRequest(operation.requestId)
    if (!request) return
    if (request.status === 'consumed' && confirmation.state === 'confirmed') {
      if (!samePaymentHash(request.txHash, operation.paymentTxHash)) {
        store.updatePendingOperation(operation.id, { status: 'recovery_required' })
        return
      }
    } else if (confirmation.state === 'confirmed') {
      const consumed = store.recoverPaymentRequestConsumption(operation.requestId, {
        payAmount: operation.amountUsd ?? recovered.fromAmount,
        payAsset: recovered.fromAsset,
        payChain: recovered.fromChain,
        txHash: operation.paymentTxHash || operation.sourceTxHash || '',
      })
      if (!consumed.success) {
        store.updatePendingOperation(operation.id, { status: 'recovery_required' })
        return
      }
    }
  }

  const checkpointBefore = confirmation.state === 'confirmed'
    ? ledger.getTenantBalance(operation.tenantId).totalUsd
    : undefined
  const checkpointAfter = checkpointBefore === undefined
    ? undefined
    : Number((checkpointBefore + recovered.toAmount).toFixed(2))
  const stored = saveRecoveredTransaction({
    ...recovered,
    balanceCheckpoint: confirmation.state === 'confirmed' && checkpointBefore !== undefined && checkpointAfter !== undefined
      ? { beforeUsd: checkpointBefore, afterUsd: checkpointAfter, deltaUsd: recovered.toAmount, capturedAt: Date.now() }
      : recovered.balanceCheckpoint,
  }, operation.tenantId, ledger)
  store.updatePendingOperation(operation.id, {
    status: confirmation.state === 'confirmed' ? 'confirmed' : 'recovery_required',
    zcashTxid: txid,
    transaction: stored,
  })

  if (confirmation.state === 'expired' && operation.requestId) {
    // The external shield never reached the chain. Undo a request mutation
    // that may have been written just before a process crash, so the payer's
    // source payment can be retried exactly once after the wallet recovers.
    const request = store.getPaymentRequest(operation.requestId)
    if (request?.status === 'consumed' && (request.txHash || '') === (operation.paymentTxHash || operation.sourceTxHash || '')) {
      store.revertPaymentRequestConsumption(operation.requestId)
    }
  }
  if (operation.paymentTxHash || operation.sourceTxHash) {
    if (confirmation.state === 'confirmed') {
      store.consumeDemoDepositBinding(operation.paymentTxHash || operation.sourceTxHash || '')
    }
    store.releasePaymentTxHash(operation.paymentTxHash || operation.sourceTxHash || '')
  }
  if (operation.requestId) store.releasePaymentRequestProcessing(operation.requestId)
  // The ledger now contains the exact operation identity; the durable intent
  // is no longer needed and can be removed atomically after the write.
  store.deletePendingOperation(operation.id)
}

async function reconcileDestinationOperation(
  operation: StoredDurableOperation,
  store: typeof persistentStore,
  ledger: typeof ledgerService,
): Promise<void> {
  const existing = ledger.getTransactionById(operation.txId, operation.tenantId)
  const source = existing || operation.transaction
  const expectedSignature = operation.expectedSignature
  const expectedTxHash = operation.expectedTxHash

  if (operation.destinationChain === 'solana' && expectedSignature) {
    const status = await solanaRelayer.getSignatureStatus(expectedSignature).catch(() => null)
    if (status) {
      const finalized = isFinalizedSolanaSignatureStatus(status)
      const updated: AuraTransaction = {
        ...source,
        status: status.err
          ? (source.legs?.shielded?.status === 'confirmed' ? 'routing_shielded' : 'failed')
          : finalized && (source.legs?.shielded?.status === 'confirmed' || Boolean(source.legs?.shielded?.txHash)) ? 'completed' : 'settling_destination',
        completedAt: finalized && !status.err ? (source.completedAt || Date.now()) : undefined,
        legs: {
          ...source.legs,
          delivery: source.legs?.delivery ? {
            ...source.legs.delivery,
            txHash: expectedSignature,
            status: status.err ? 'failed' : finalized ? 'confirmed' : 'broadcasting',
            confirmationStatus: finalized ? 'finalized' : status.confirmationStatus,
            description: status.err
              ? 'Solana payout failed on-chain; the confirmed Zcash source remains reserved for a destination-only retry.'
              : finalized
                ? 'Solana payout finalized after restart recovery.'
                : 'Solana payout identity recovered; awaiting finalized confirmation.',
          } : undefined,
        },
      }
      saveRecoveredTransaction(updated, operation.tenantId, ledger)
      // A non-finalized signature remains live and must keep its claim. A
      // definitive on-chain failure is different: release the claim so the
      // explicit settlement worker can retry only the destination leg.
      if (status.err || finalized) {
        store.releaseTransactionSettlement(operation.tenantId, operation.txId)
        store.deletePendingOperation(operation.id)
      } else {
        store.updatePendingOperation(operation.id, { status: 'broadcasted', transaction: updated })
      }
      return
    }

    // A null result after the full RPC pool has been checked is still
    // inconclusive. Blockhash expiry only proves that a *new* submission with
    // this blockhash would fail; it does not prove that the original signed
    // transaction was never accepted. Keep the exact durable identity and
    // settlement claim, so no retry can create a second payout.
    return
  }

  if (operation.destinationChain === 'base' && expectedTxHash) {
    const chainTx = await baseRelayer.getTransactionByHash(expectedTxHash).catch(() => null)
    if (!chainTx) return
    const receipt = await baseRelayer.getTransactionReceipt(expectedTxHash).catch(() => null)
    if (!receipt) {
      // The exact hash is known, but the transaction is still pending. Keep
      // the settlement claim so a timeout cannot create a second nonce.
      const updatedPending: AuraTransaction = {
        ...source,
        status: 'settling_destination',
        legs: source.legs?.delivery ? {
          ...source.legs,
          delivery: {
            ...source.legs.delivery,
            txHash: expectedTxHash,
            status: 'broadcasting',
            description: 'Base payout identity recovered after restart; awaiting receipt confirmation.',
          },
        } : source.legs,
      }
      saveRecoveredTransaction(updatedPending, operation.tenantId, ledger)
      store.updatePendingOperation(operation.id, { status: 'broadcasted', transaction: updatedPending })
      return
    }
    const failed = receipt.status === '0x0'
    const updated: AuraTransaction = {
      ...source,
      status: failed ? (source.legs?.shielded?.status === 'confirmed' ? 'routing_shielded' : 'failed') : source.legs?.shielded?.status === 'confirmed' ? 'completed' : 'settling_destination',
      completedAt: failed ? undefined : source.completedAt || Date.now(),
      legs: {
        ...source.legs,
        delivery: source.legs?.delivery ? {
          ...source.legs.delivery,
          txHash: expectedTxHash,
          status: failed ? 'failed' : 'confirmed',
          confirmationStatus: failed ? undefined : 'confirmed',
          description: failed
            ? 'Base payout failed on-chain; the confirmed Zcash source remains reserved for a destination-only retry.'
            : 'Base payout confirmed after restart recovery.',
        } : undefined,
      },
    }
    saveRecoveredTransaction(updated, operation.tenantId, ledger)
    store.releaseTransactionSettlement(operation.tenantId, operation.txId)
    store.deletePendingOperation(operation.id)
  }
}

/**
 * Rebuild a lost deposit intent from the durable ledger. A confirmed Base
 * receipt is the recovery anchor; no browser state is needed to recreate the
 * Zcash retry metadata. The ledger row is never credited again by this scan.
 */
function rebuildMissingDepositOperations(
  store: typeof persistentStore,
  ledger: typeof ledgerService,
): void {
  for (const tenantId of ledger.listTenantIds()) {
    for (const transaction of ledger.getTransactions(tenantId)) {
      const depositHash = transaction.legs?.deposit?.txHash
      const shieldedStatus = transaction.legs?.shielded?.status
      if (
        (transaction.type !== 'deposit' && transaction.type !== 'receive') ||
        transaction.fromChain !== 'base' ||
        transaction.legs?.deposit?.status !== 'confirmed' ||
        shieldedStatus === 'confirmed' ||
        !depositHash ||
        !transaction.backingZec ||
        transaction.backingZec <= 0
      ) continue

      const operationId = `deposit-shield:${tenantId}:${transaction.id}`
      if (store.getPendingOperation(operationId)) continue
      const destinationAddress = transaction.legs?.shielded?.destinationAddress
      if (!destinationAddress) continue
      const attemptId = generateSecureId('shield-attempt')
      store.savePendingOperation({
        id: operationId,
        kind: 'deposit_shield',
        status: 'recovery_required',
        tenantId,
        txId: transaction.id,
        createdAt: transaction.createdAt,
        updatedAt: Date.now(),
        transaction: {
          ...transaction,
          status: 'routing_shielded',
          legs: {
            ...transaction.legs,
            shielded: {
              ...(transaction.legs?.shielded || {}),
              chain: 'zcash',
              status: 'pending',
              description: 'Recovered a confirmed Base deposit; Zcash shielding is queued for retry.',
            },
          },
        },
        sourceTxHash: depositHash,
        paymentTxHash: depositHash,
        memo: `Aura Shield: ${transaction.id} retry 1 ${attemptId}`,
        amountUsd: transaction.toAmount,
        amountZec: transaction.backingZec,
        recipientAddress: destinationAddress,
        attemptNumber: 1,
        attemptId,
      })
    }
  }
}

let reconciliationInFlight: Promise<void> | null = null
let shieldedConfirmationReconciliationInFlight: Promise<void> | null = null
const MAX_SHIELDED_CONFIRMATION_CHECKS_PER_TICK = 16

function isReconciliationCandidate(transaction: AuraTransaction): boolean {
  const shielded = transaction.legs?.shielded
  return Boolean(
    transaction.toChain === 'solana' &&
    hasFinalizedSolanaDelivery(transaction) &&
    shielded?.txHash &&
    /^[a-f0-9]{64}$/i.test(shielded.txHash) &&
    shielded.status !== 'confirmed' &&
    shielded.status !== 'failed' &&
    !transaction.privateSettlementRecovery,
  )
}

function updateFinalizedPrivateLeg(
  transaction: AuraTransaction,
  tenantId: string,
  ledger: typeof ledgerService,
  confirmation: Awaited<ReturnType<typeof zcashDevtoolService.verifyConfirmation>>,
): AuraTransaction {
  const shielded = transaction.legs?.shielded
  if (!shielded?.txHash) return transaction
  const confirmed = confirmation.state === 'confirmed' && confirmation.confirmed
  const expired = confirmation.state === 'expired'
  if (!confirmed && !expired) return transaction

  const nextShielded = {
    ...shielded,
    status: confirmed ? 'confirmed' as const : 'failed' as const,
    confirmationStatus: confirmed ? 'confirmed' as const : undefined,
    description: confirmed
      ? `Shielded transaction confirmed on Zcash Testnet (Block #${confirmation.blockHeight || 'testnet'}, Tx #${shielded.txHash.slice(0, 16)}...).`
      : `Zcash transaction expired after the Solana payout was finalized (Tx #${shielded.txHash.slice(0, 16)}...). Operator recovery is required; no refund or duplicate payout was created.`,
  }
  return ledger.updateTransaction(transaction.id, {
    legs: { ...transaction.legs, shielded: nextShielded },
    privateSettlementRecovery: expired ? {
      status: 'required',
      reason: 'expired',
      txHash: shielded.txHash,
      detectedAt: Date.now(),
      message: 'Solana delivery is finalized, but the private Zcash settlement expired and needs operator recovery.',
    } : undefined,
  }, tenantId) || transaction
}

/**
 * Continue confirmed Zcash spends from the server worker itself. A browser
 * refresh is an observation path only; it is never the liveness mechanism for
 * the recipient payout.
 */
export function reconcileConfirmedShieldedPayouts(
  store: typeof persistentStore,
  ledger: typeof ledgerService,
): Promise<void> {
  if (shieldedConfirmationReconciliationInFlight) return shieldedConfirmationReconciliationInFlight
  shieldedConfirmationReconciliationInFlight = (async () => {
    let confirmationChecks = 0
    for (const tenantId of ledger.listTenantIds()) {
      const transactions = ledger.getTransactions(tenantId)
      for (const originalTransaction of transactions) {
        let transaction = originalTransaction
        if (isReconciliationCandidate(transaction) && confirmationChecks < MAX_SHIELDED_CONFIRMATION_CHECKS_PER_TICK) {
          confirmationChecks += 1
          const shieldedHash = transaction.legs.shielded!.txHash!
          try {
            const confirmation = await zcashDevtoolService.verifyConfirmation(shieldedHash)
            transaction = updateFinalizedPrivateLeg(transaction, tenantId, ledger, confirmation)
          } catch (error) {
            console.warn(`Finalized payout private-leg reconciliation delayed for ${transaction.id}:`, error)
          }
        }

        if (
          transaction.status !== 'completed' &&
          hasFinalizedSolanaDelivery(transaction) &&
          hasBroadcastedShieldedSource(transaction)
        ) {
          ledger.updateTransaction(transaction.id, {
            status: 'completed',
            completedAt: transaction.completedAt || transaction.legs?.delivery?.timestamp || Date.now(),
          }, tenantId)
          continue
        }
        const shieldedHash = transaction.legs?.shielded?.txHash || ''
        const destinationOperationId = `destination-payout:${tenantId}:${transaction.id}`
        const retryableDestinationFailure = transaction.status === 'settling_destination' &&
          transaction.legs?.delivery?.status === 'failed' &&
          !transaction.legs.delivery.txHash
        const eligible = (transaction.type === 'send' || transaction.type === 'withdraw') &&
          transaction.fromChain === 'zcash' &&
          (transaction.status === 'routing_shielded' || retryableDestinationFailure) &&
          transaction.legs?.shielded?.status === 'confirmed' &&
          /^[a-f0-9]{64}$/i.test(shieldedHash) &&
          (!transaction.legs?.delivery?.txHash || transaction.legs.delivery.status === 'failed')
        if (!eligible || store.getPendingOperation(destinationOperationId)) continue
        try {
          await resumeConfirmedShieldedPayout(transaction, tenantId)
        } catch (error) {
          console.warn(`Confirmed shielded payout reconciliation delayed for ${transaction.id}:`, error)
        }
      }
    }
  })().finally(() => {
    shieldedConfirmationReconciliationInFlight = null
  })
  return shieldedConfirmationReconciliationInFlight
}

/**
 * Run once per request burst. It is safe to call from read/status routes: it
 * only resumes durable records and never invents a chain receipt or retries a
 * destination while its exact signed identity is still unresolved.
 */
export async function reconcilePendingOperations(
  store: typeof persistentStore = persistentStore,
  ledger: typeof ledgerService = ledgerService,
): Promise<void> {
  if (reconciliationInFlight) return reconciliationInFlight
  reconciliationInFlight = (async () => {
    rebuildMissingDepositOperations(store, ledger)
    for (const operation of store.listPendingOperations()) {
      try {
        if (operation.kind === 'destination_payout') {
          await reconcileDestinationOperation(operation, store, ledger)
        } else {
          await reconcileZcashOperation(operation, store, ledger)
        }
      } catch (error) {
        console.warn(`Durable operation reconciliation delayed for ${operation.id}:`, error)
      }
    }
  })().finally(() => {
    reconciliationInFlight = null
  })
  return reconciliationInFlight
}
