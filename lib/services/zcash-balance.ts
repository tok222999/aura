export interface ZcashSpendablePools {
  orchardSpendable: number
  saplingSpendable: number
  ironwoodSpendable?: number
  unshieldedSpendable?: number
  /** Some devtool builds expose only one aggregate shielded spendable value. */
  totalSpendable?: number
  poolBreakdownAvailable?: boolean
}

/** ZIP-317 conventional minimum fee: 10,000 zatoshis = 0.0001 ZEC. */
export const ZIP317_MINIMUM_FEE_ZEC = 0.0001
/** Minimum reserve used by the demo PCZT sender for the Zcash network fee. */
export const ZCASH_FEE_RESERVE_ZEC = ZIP317_MINIMUM_FEE_ZEC
export const ZCASH_TARGET_BLOCK_TIME_SECONDS = 75

/**
 * A mined Zcash transaction is not yet safe to use as the source of an
 * irreversible destination payout.  Operators may tune this for testnet;
 * the default keeps a shallow reorg from immediately becoming a payout.
 */
export function getZcashSettlementSafetyConfirmations(): number {
  const configured = Number.parseInt(process.env.ZCASH_SETTLEMENT_SAFETY_CONFIRMATIONS || '2', 10)
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 10_000 ? configured : 2
}

/**
 * Convert the product's time buffer into the wallet's note-confirmation
 * policy. The Rust sender applies this policy while selecting notes; the
 * ledger's wall-clock check remains a second, independent guard.
 */
export function getMinimumConfirmationsForBuffer(bufferMode: string): number {
  const waitSeconds = bufferMode === 'private'
    ? 24 * 60 * 60
    : bufferMode === 'strong'
      ? 72 * 60 * 60
      : bufferMode === 'custom'
        ? 7 * 24 * 60 * 60
        : 0
  return Math.max(1, Math.ceil(waitSeconds / ZCASH_TARGET_BLOCK_TIME_SECONDS) + 1)
}

/** Amount available to the PCZT sender. Its default spend policy excludes transparent UTXOs. */
export function getShieldedSpendableZec(balance: ZcashSpendablePools | null | undefined): number {
  if (!balance) return 0
  if (balance.poolBreakdownAvailable === false && Number.isFinite(balance.totalSpendable)) {
    return Number(Math.max(0, balance.totalSpendable || 0).toFixed(8))
  }
  const orchard = Number.isFinite(balance.orchardSpendable) ? Math.max(0, balance.orchardSpendable) : 0
  const sapling = Number.isFinite(balance.saplingSpendable) ? Math.max(0, balance.saplingSpendable) : 0
  const ironwood = Number.isFinite(balance.ironwoodSpendable) ? Math.max(0, balance.ironwoodSpendable || 0) : 0
  return Number((orchard + sapling + ironwood).toFixed(8))
}

export function canFundShieldedSend(
  balance: ZcashSpendablePools | null | undefined,
  amountZec: number,
  feeReserveZec = ZCASH_FEE_RESERVE_ZEC
): boolean {
  if (!Number.isFinite(amountZec) || amountZec <= 0 || !Number.isFinite(feeReserveZec) || feeReserveZec < 0) return false
  return getShieldedSpendableZec(balance) >= amountZec + feeReserveZec
}
