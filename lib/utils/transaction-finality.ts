import type { AuraTransaction } from '@/lib/types/aura'

/**
 * The delivery leg uses `confirmed` as its normalized receipt label. The
 * transaction-level `completed` state is the stronger gate: for Solana it is
 * written only after the signature is finalized on-chain.
 */
export function hasCompletedDestinationDelivery(tx: AuraTransaction | null | undefined): boolean {
  if (tx?.toChain === 'solana') return tx.status === 'completed' && hasFinalizedSolanaDelivery(tx)
  return Boolean(
    tx?.status === 'completed' &&
    tx.legs?.delivery?.status === 'confirmed' &&
    tx.legs.delivery.txHash
  )
}

/** A durable, valid Solana signature and finalized marker survive app restarts. */
export function hasFinalizedSolanaDelivery(tx: AuraTransaction | null | undefined): boolean {
  const signature = tx?.legs?.delivery?.txHash || ''
  return Boolean(
    tx?.toChain === 'solana' &&
    tx.legs?.delivery?.status === 'confirmed' &&
    tx.legs.delivery.confirmationStatus === 'finalized' &&
    /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)
  )
}

/** A jury-inventory source is confirmed by the live pool read, not a new txid. */
export function hasConfirmedShieldedSource(tx: AuraTransaction | null | undefined): boolean {
  return Boolean(
    tx?.settlementMode === 'jury_inventory' &&
    tx.backingSource === 'confirmed_zcash_inventory' &&
    tx.legs?.shielded?.status === 'confirmed'
  ) || Boolean(
    tx?.legs?.shielded?.status === 'confirmed' &&
    /^[a-f0-9]{64}$/i.test(tx.legs.shielded.txHash || '')
  )
}

/** A real Zcash broadcast is sufficient to authorize the liquidity-backed
 * destination payout; mining confirmation is reconciled separately. */
export function hasBroadcastedShieldedSource(tx: AuraTransaction | null | undefined): boolean {
  return hasConfirmedShieldedSource(tx) || Boolean(
    tx?.legs?.shielded?.txHash && /^[a-f0-9]{64}$/i.test(tx.legs.shielded.txHash)
  )
}
