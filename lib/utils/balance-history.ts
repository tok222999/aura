import { AuraTransaction } from '../types/aura'

const RESERVED_SPEND_STATUSES = new Set([
  'shielded',
  'initiated',
  'locking_base',
  'routing_near',
  'processing',
  'routing_shielded',
  'settling_destination',
])

/** Reconstruct a prior ledger balance from effects included in today's balance. */
export function getHistoricalLedgerBalance(
  currentBalanceUsd: number,
  transactions: AuraTransaction[],
  timestamp: number
): number {
  let balance = currentBalanceUsd

  for (const tx of transactions) {
    if (!tx.createdAt || tx.createdAt <= timestamp) continue

    if ((tx.type === 'deposit' || tx.type === 'receive') && tx.status === 'completed') {
      balance -= tx.toAmount
    } else if (
      (tx.type === 'send' || tx.type === 'withdraw') &&
      (tx.status === 'completed' || RESERVED_SPEND_STATUSES.has(tx.status))
    ) {
      balance += tx.fromAmount
    }
  }

  return Math.max(0, Number(balance.toFixed(2)))
}
