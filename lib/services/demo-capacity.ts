/**
 * The small testnet flow used for readiness and the recorded live proof.
 * Keep these values shared between the server preflight and client telemetry
 * so a UI check cannot silently drift from the capacity calculation.
 */
export const DEMO_DEPOSIT_AMOUNT_USD = 1
export const DEMO_PAYOUT_AMOUNT_USD = 0.5
export const DEMO_RUN_TARGET = 3

/** Return an amount that the cent-based USDC form can actually allocate. */
export function getSharedJuryAvailableCapacityUsd(
  sourceCapacityUsd: number | null | undefined,
  allocatedUsd: number | null | undefined,
): number | null {
  if (
    typeof sourceCapacityUsd !== 'number' || !Number.isFinite(sourceCapacityUsd) ||
    typeof allocatedUsd !== 'number' || !Number.isFinite(allocatedUsd)
  ) return null
  const remaining = Math.max(0, sourceCapacityUsd - allocatedUsd)
  return Math.floor((remaining + 1e-9) * 100) / 100
}

export function canAllocateSharedJuryDeposit(
  sourceCapacityUsd: number | null | undefined,
  allocatedUsd: number | null | undefined,
  requestedUsd: number | null | undefined,
): boolean {
  if (typeof requestedUsd !== 'number' || !Number.isFinite(requestedUsd) || requestedUsd <= 0) return false
  const availableUsd = getSharedJuryAvailableCapacityUsd(sourceCapacityUsd, allocatedUsd)
  return availableUsd !== null && requestedUsd <= availableUsd + 1e-9
}
