import { baseRelayer, type BaseRelayerService } from '@/lib/crypto/base-relayer'
import { persistentStore, type PersistentStore } from '@/lib/services/persistent-store'

/**
 * Resolve sponsored Base transfers whose broadcast response was uncertain.
 * An unavailable RPC leaves the reservation pending instead of guessing.
 */
export async function reconcilePendingDemoBudget(
  relayer: Pick<BaseRelayerService, 'getTransactionReceipt' | 'verifyReceiptFinality' | 'getTransactionByHash' | 'getFinalizedTransactionCount'> = baseRelayer,
  store: PersistentStore = persistentStore,
): Promise<void> {
  const pending = store.getPendingDemoBudgetReservations()
  await Promise.all(pending.map(async ({ txHash, nonce, senderAddress }) => {
    try {
      const receipt = await relayer.getTransactionReceipt(txHash)
      const finality = receipt?.status === '0x1'
        ? await relayer.verifyReceiptFinality(txHash, receipt)
        : { confirmed: false }
      if (finality.confirmed) {
        store.resolvePendingDemoBudget(txHash, 'confirmed')
        return
      }
      if (receipt?.status === '0x0') {
        store.resolvePendingDemoBudget(txHash, 'reverted')
        return
      }
      // A finalized nonce past this signed transaction's nonce means it can
      // no longer land. The predicted hash must also be absent on the RPC pool.
      // Older records without nonce/sender metadata remain fail-closed.
      if (!nonce || !senderAddress) return
      const transaction = await relayer.getTransactionByHash(txHash)
      if (transaction) return
      const finalizedNonce = await relayer.getFinalizedTransactionCount(senderAddress)
      if (finalizedNonce !== null && finalizedNonce > BigInt(nonce)) {
        store.resolvePendingDemoBudget(txHash, 'absent')
      }
    } catch {
      // Network errors or malformed data are never evidence of absence.
    }
  }))
}
