/**
 * Reconciles the durable demo ledger with the tenant's confirmed shielded
 * balance. The chain value is supplied by the live Zcash account reader; it
 * is never invented by this helper.
 */
export interface LedgerBalanceSnapshot {
  totalUsd: number
  readyToSpendUsd: number
  unconfirmedUsd: number
  onChainZecBackedUsd: number
  enclaveBackedUsd: number
  /** Outbound reservations that are not terminal and therefore still consume chain funds. */
  pendingOutboundUsd?: number
  /** Exact ZEC quantity reserved by non-terminal outbound spends. */
  pendingOutboundZec?: number
  /** Legacy pending spends without a persisted ZEC reservation cannot be priced safely. */
  hasUnpricedPendingOutbound?: boolean
  /** Exact ZEC quantity still inside the selected privacy maturity window. */
  immatureBufferedZec?: number
}

export interface ReconciledBalanceSnapshot extends LedgerBalanceSnapshot {
  fastAvailableToSendUsd: number
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

export function reconcileLedgerBalanceWithShieldedChain(
  ledger: LedgerBalanceSnapshot,
  confirmedChainUsd: number | null,
  confirmedChainZec?: number | null,
  zecUsd?: number | null,
  policyEligibleChainZec?: number | null,
  maxEntitlementUsd?: number | null,
): ReconciledBalanceSnapshot {
  // A failed chain read is not evidence of a zero balance. Keep the last
  // durable ledger view for display while the caller marks the chain state as
  // unavailable and blocks spend actions until a fresh read succeeds.
  if (confirmedChainUsd === null) {
    return {
      ...ledger,
      fastAvailableToSendUsd: Math.max(0, ledger.readyToSpendUsd),
    }
  }
  const chainUsd = nonNegativeFinite(confirmedChainUsd)
  const chainZec = confirmedChainZec == null ? null : nonNegativeFinite(confirmedChainZec)
  const currentZecUsd = zecUsd == null ? null : nonNegativeFinite(zecUsd)
  // The dedicated tenant's confirmed shielded ZEC quantity is the source of
  // truth for holdings. Non-terminal outbound reservations remain authoritative
  // in the ledger and must be subtracted from that live balance; otherwise a
  // second request can spend the same notes while the chain still reports the
  // pre-spend balance.
  const pendingOutboundUsd = nonNegativeFinite(ledger.pendingOutboundUsd)
  const pendingOutboundZec = nonNegativeFinite(ledger.pendingOutboundZec)
  const hasUnpricedPendingOutbound = ledger.hasUnpricedPendingOutbound === true
  const immatureBufferedZec = nonNegativeFinite(ledger.immatureBufferedZec)
  const entitlementCap = typeof maxEntitlementUsd === 'number' && Number.isFinite(maxEntitlementUsd)
    ? Math.max(0, maxEntitlementUsd)
    : null

  // Once the live ZEC quantity and current rate are available, all outbound
  // reservations are accounted for in ZEC first. This prevents a price move
  // from turning a $60 reservation made at one rate into a different number
  // of ZEC at the next rate.
  if (chainZec !== null && currentZecUsd !== null && currentZecUsd > 0) {
    const availableZec = hasUnpricedPendingOutbound
      ? 0
      : Math.max(0, chainZec - pendingOutboundZec)
    const eligibleZec = policyEligibleChainZec == null
      ? null
      : Math.max(0, Math.min(chainZec, policyEligibleChainZec) - pendingOutboundZec)
    let totalUsd = Number((availableZec * currentZecUsd).toFixed(2))
    const fallbackImmatureZec = ledger.totalUsd > 0
      ? (Math.max(0, ledger.totalUsd - nonNegativeFinite(ledger.readyToSpendUsd)) / Math.max(ledger.totalUsd, 0.00000001)) * chainZec
      : 0
    const immatureZec = eligibleZec === null
      ? (immatureBufferedZec > 0 ? immatureBufferedZec : fallbackImmatureZec)
      : Math.max(0, availableZec - eligibleZec)
    const readyZec = eligibleZec === null ? Math.max(0, availableZec - immatureZec) : eligibleZec
    let readyToSpendUsd = Number((readyZec * currentZecUsd).toFixed(2))
    if (entitlementCap !== null) {
      totalUsd = Number(Math.min(totalUsd, entitlementCap).toFixed(2))
      readyToSpendUsd = Number(Math.min(readyToSpendUsd, totalUsd).toFixed(2))
    }
    return {
      ...ledger,
      totalUsd,
      readyToSpendUsd,
      pendingOutboundUsd: Number((pendingOutboundZec * currentZecUsd).toFixed(2)),
      pendingOutboundZec,
      hasUnpricedPendingOutbound,
      immatureBufferedZec: immatureZec,
      fastAvailableToSendUsd: totalUsd,
    }
  }

  // Compatibility path for old callers that only have a USD snapshot. New
  // spend reservations always use the ZEC path above.
  let totalUsd = Number(Math.max(0, chainUsd - pendingOutboundUsd).toFixed(2))
  // A recovered wallet can legitimately have live notes before the old ledger
  // row is present. There is no maturity metadata to restore in that case, so
  // the only honest recovery behavior is to treat that chain-confirmed amount
  // as ready; normal deposits always carry a non-zero ledger total here.
  const ledgerTotalUsd = nonNegativeFinite(ledger.totalUsd)
  const ledgerImmatureUsd = Math.max(
    0,
    ledgerTotalUsd - nonNegativeFinite(ledger.readyToSpendUsd),
  )
  const immatureUsd = ledgerTotalUsd > 0
    ? (ledgerImmatureUsd * chainUsd) / ledgerTotalUsd
    : 0
  let readyToSpendUsd = Number(Math.max(0, chainUsd - immatureUsd - pendingOutboundUsd).toFixed(2))
  if (entitlementCap !== null) {
    totalUsd = Number(Math.min(totalUsd, entitlementCap).toFixed(2))
    readyToSpendUsd = Number(Math.min(readyToSpendUsd, totalUsd).toFixed(2))
  }
  return {
    ...ledger,
    totalUsd,
    readyToSpendUsd,
    pendingOutboundUsd,
    pendingOutboundZec,
    hasUnpricedPendingOutbound,
    immatureBufferedZec,
    fastAvailableToSendUsd: totalUsd,
  }
}
