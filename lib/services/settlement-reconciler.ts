import { ledgerService } from '@/lib/services/ledger-service'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { persistentStore } from '@/lib/services/persistent-store'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { isFinalizedSolanaSignatureStatus, solanaRelayer } from '@/lib/crypto/solana-relayer'
import { AuraTransaction } from '@/lib/types/aura'
import { hasBroadcastedShieldedSource, hasConfirmedShieldedSource } from '@/lib/utils/transaction-finality'

export function classifyDestinationSettlement(args: {
  deliveryConfirmed: boolean
  deliveryFailedOnChain: boolean
  deliveryHash?: string
  broadcastUncertain: boolean
}): {
  status: 'completed' | 'routing_shielded' | 'settling_destination'
  deliveryStatus: 'confirmed' | 'failed' | 'broadcasting'
  closePendingOperation: boolean
} {
  const definitiveFailure = args.deliveryFailedOnChain || (!args.deliveryHash && !args.broadcastUncertain)
  if (args.deliveryConfirmed) {
    return { status: 'completed', deliveryStatus: 'confirmed', closePendingOperation: true }
  }
  if (definitiveFailure) {
    return { status: 'routing_shielded', deliveryStatus: 'failed', closePendingOperation: true }
  }
  return { status: 'settling_destination', deliveryStatus: 'broadcasting', closePendingOperation: false }
}

/**
 * Reconcile a confirmed shielded spend and, only from an explicit worker/job,
 * resume its destination payout. Read endpoints must not call this function.
 */
export async function resumeConfirmedShieldedPayout(tx: AuraTransaction, tenantId: string): Promise<AuraTransaction> {
  const shieldedTxid = tx.legs?.shielded?.txHash
  const inventoryBacked = hasConfirmedShieldedSource(tx) && tx.settlementMode === 'jury_inventory'
  const sourceBroadcasted = hasBroadcastedShieldedSource(tx)
  const delivery = tx.legs?.delivery
  const retryingFailedDestination = delivery?.status === 'failed'
  if (
    (tx.type !== 'send' && tx.type !== 'withdraw') || tx.fromChain !== 'zcash' ||
    (tx.status !== 'routing_shielded' && !(tx.status === 'settling_destination' && retryingFailedDestination && !delivery?.txHash)) ||
    (!inventoryBacked && (!shieldedTxid || !/^[0-9a-fA-F]{64}$/.test(shieldedTxid))) ||
    !tx.recipientAddress || (delivery?.txHash && !retryingFailedDestination)
  ) return tx

  const zcashConfirmation = inventoryBacked
    ? { confirmed: true }
    : await zcashDevtoolService.verifyConfirmation(shieldedTxid!).catch(() => ({ confirmed: false }))
  if (!zcashConfirmation.confirmed && !sourceBroadcasted) return tx

  const confirmedSource = ledgerService.updateTransaction(tx.id, {
    status: 'routing_shielded',
    legs: tx.legs?.shielded ? {
      ...tx.legs,
      shielded: {
        ...tx.legs.shielded,
        status: zcashConfirmation.confirmed ? 'confirmed' : 'broadcasting',
        description: inventoryBacked
          ? 'Backed by AURA’s confirmed shielded Zcash Testnet inventory. Destination payout is pending.'
          : zcashConfirmation.confirmed
            ? `Shielded spend confirmed on Zcash Testnet (Tx #${shieldedTxid!.slice(0, 16)}...). Destination payout is pending.`
            : `Shielded spend broadcast to Zcash Testnet (Tx #${shieldedTxid!.slice(0, 16)}...). Destination payout may proceed while confirmation finishes.`,
      },
      delivery: retryingFailedDestination && tx.legs.delivery ? {
        ...tx.legs.delivery,
        txHash: undefined,
        status: 'pending',
        confirmationStatus: undefined,
        description: 'Previous destination payout failed on-chain; retrying only the destination leg.',
      } : tx.legs.delivery,
    } : tx.legs,
  }, tenantId) || tx

  if (!persistentStore.claimTransactionSettlement(tenantId, tx.id)) return confirmedSource

  let deliveryHash: string | undefined
  let deliveryDescription = 'Destination payout is pending after confirmed Zcash spend.'
  let broadcastUncertain = false
  let deliveryConfirmed = false
  let deliveryFailedOnChain = false
  const destinationOperationId = `destination-payout:${tenantId}:${tx.id}`
  const saveDestinationIntent = async (intent: {
    signature?: string
    recentBlockhash?: string
    senderAddress?: string
    txHash?: string
    nonce?: string
  }) => {
    const operation = persistentStore.savePendingOperation({
      id: destinationOperationId,
      kind: 'destination_payout',
      status: 'prepared',
      tenantId,
      txId: tx.id,
      createdAt: confirmedSource.createdAt,
      updatedAt: Date.now(),
      transaction: confirmedSource,
      destinationChain: tx.toChain,
      recipientAddress: tx.recipientAddress,
      amountUsd: Number(tx.toAmount),
      expectedSignature: intent.signature,
      expectedTxHash: intent.txHash,
      expectedNonce: intent.nonce,
      senderAddress: intent.senderAddress,
      recentBlockhash: intent.recentBlockhash,
    })
    if (!operation) throw new Error('Could not persist the destination payout identity before broadcast.')
    if (!persistentStore.markTransactionSettlementExternalEffectMayHaveStarted(tenantId, tx.id)) {
      throw new Error('Could not persist the destination payout lock before broadcast.')
    }
    persistentStore.updatePendingOperation(destinationOperationId, { status: 'broadcasting' })
  }
  try {
    if (tx.toChain === 'solana') {
      const result = await solanaRelayer.sendSol(tx.recipientAddress, Number(tx.toAmount), saveDestinationIntent)
      deliveryHash = result.signature
      broadcastUncertain = Boolean(result.broadcastUncertain)
      if (deliveryHash) {
        const status = await solanaRelayer.getSignatureStatus(deliveryHash).catch(() => null)
        deliveryConfirmed = isFinalizedSolanaSignatureStatus(status)
        deliveryFailedOnChain = Boolean(status?.err)
      }
      deliveryDescription = result.success
        ? `Solana Devnet payout broadcast to ${tx.recipientAddress.slice(0, 8)}...`
        : result.error || 'Solana Devnet payout is pending after the confirmed Zcash spend.'
    } else if (tx.toChain === 'base') {
      const result = await baseRelayer.sendUsdc(tx.recipientAddress, Number(tx.toAmount), saveDestinationIntent)
      deliveryHash = result.txHash
      broadcastUncertain = Boolean(result.broadcastUncertain)
      if (deliveryHash) {
        const receipt = await baseRelayer.getTransactionReceipt(deliveryHash).catch(() => null)
        deliveryConfirmed = receipt?.status === '0x1' && (await baseRelayer.verifyReceiptFinality(deliveryHash, receipt)).confirmed
        deliveryFailedOnChain = receipt?.status === '0x0'
      }
      deliveryDescription = result.success
        ? `Base Sepolia payout broadcast to ${tx.recipientAddress.slice(0, 8)}...`
        : result.message || result.error || 'Base Sepolia payout is pending after the confirmed Zcash spend.'
    }

    const destinationState = classifyDestinationSettlement({
      deliveryConfirmed,
      deliveryFailedOnChain,
      deliveryHash,
      broadcastUncertain,
    })
    const updated = ledgerService.updateTransaction(tx.id, {
      status: destinationState.status,
      completedAt: deliveryConfirmed ? (tx.completedAt || Date.now()) : confirmedSource.completedAt,
      legs: {
        ...confirmedSource.legs,
        shielded: confirmedSource.legs?.shielded ? { ...confirmedSource.legs.shielded, status: zcashConfirmation.confirmed ? 'confirmed' : 'broadcasting' } : undefined,
        delivery: confirmedSource.legs?.delivery ? {
          ...confirmedSource.legs.delivery,
          txHash: deliveryHash,
          status: destinationState.deliveryStatus,
          confirmationStatus: deliveryConfirmed ? (tx.toChain === 'solana' ? 'finalized' : 'confirmed') : undefined,
          description: broadcastUncertain
            ? `${deliveryDescription} Checking the chain before any retry.`
            : deliveryDescription,
        } : undefined,
      },
    }, tenantId) || confirmedSource

    persistentStore.updatePendingOperation(destinationOperationId, {
      status: destinationState.closePendingOperation ? 'confirmed' : 'recovery_required',
      expectedSignature: tx.toChain === 'solana' ? deliveryHash : undefined,
      expectedTxHash: tx.toChain === 'base' ? deliveryHash : undefined,
      transaction: updated,
    })

    if (deliveryConfirmed) {
      persistentStore.deletePendingOperation(destinationOperationId)
      persistentStore.releaseTransactionSettlement(tenantId, tx.id)
    } else if (destinationState.closePendingOperation && destinationState.status === 'routing_shielded') {
      // Definitive destination failure is retryable, but only after the old
      // operation is closed. The Zcash source remains confirmed and reserved.
      persistentStore.deletePendingOperation(destinationOperationId)
      persistentStore.releaseTransactionSettlement(tenantId, tx.id)
    }
    return updated
  } catch (error) {
    deliveryDescription = error instanceof Error ? error.message : String(error)
    const externalEffectMayHaveStarted = Boolean(deliveryHash || broadcastUncertain || persistentStore.transactionSettlementExternalEffectMayHaveStarted(tenantId, tx.id))
    const definitiveFailure = !externalEffectMayHaveStarted
    const updated = ledgerService.updateTransaction(tx.id, {
      status: definitiveFailure ? 'routing_shielded' : 'settling_destination',
      legs: {
        ...confirmedSource.legs,
        shielded: confirmedSource.legs?.shielded ? { ...confirmedSource.legs.shielded, status: zcashConfirmation.confirmed ? 'confirmed' : 'broadcasting' } : undefined,
        delivery: confirmedSource.legs?.delivery ? {
          ...confirmedSource.legs.delivery,
          txHash: deliveryHash,
          status: definitiveFailure ? 'failed' : 'broadcasting',
          description: deliveryDescription,
        } : undefined,
      },
    }, tenantId) || confirmedSource
    if (definitiveFailure) {
      persistentStore.deletePendingOperation(destinationOperationId)
      persistentStore.releaseTransactionSettlement(tenantId, tx.id)
    }
    return updated
  }
}
