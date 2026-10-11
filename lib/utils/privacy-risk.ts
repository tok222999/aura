import { AuraTransaction, PrivacyBufferMode, PrivacyRiskSnapshot } from '@/lib/types/aura'

export const POLICY_WAIT_MS: Record<PrivacyBufferMode, number> = {
  fast: 0,
  private: 24 * 60 * 60 * 1000,
  strong: 72 * 60 * 60 * 1000,
  custom: 7 * 24 * 60 * 60 * 1000,
}

export function getPolicyWaitMs(policy: PrivacyBufferMode): number {
  return POLICY_WAIT_MS[policy]
}

/**
 * Convert a funding row to the value used by the current Privacy Check.
 * Confirmed rows created by the live route carry the exact ZEC quantity;
 * legacy rows fall back to their recorded USD display value only when that
 * quantity was not persisted.
 */
export function fundingValueUsdAtRate(transaction: AuraTransaction, zecUsd?: number): number {
  if (typeof transaction.backingZec === 'number' && Number.isFinite(transaction.backingZec) && transaction.backingZec > 0 &&
    typeof zecUsd === 'number' && Number.isFinite(zecUsd) && zecUsd > 0) {
    return transaction.backingZec * zecUsd
  }
  return transaction.toAmount || transaction.fromAmount || 0
}

/** Public entry amount for correlation; it must not change with today's ZEC price. */
export function fundingCorrelationValueUsd(transaction: AuraTransaction): number {
  const publicAmount = Number(transaction.fromAmount)
  if (Number.isFinite(publicAmount) && publicAmount > 0) return publicAmount
  const fallback = Number(transaction.toAmount)
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0
}

export function fundingAgeMs(transaction: AuraTransaction, now: number): number {
  return Math.max(0, now - (transaction.completedAt || transaction.createdAt))
}

function amountEchoWindowMs(policy: PrivacyBufferMode): number {
  // Use a policy-relative window rather than pretending that a 61-minute gap
  // removes a visible amount clue.
  return policy === 'fast'
    ? 24 * 60 * 60 * 1000
    : policy === 'private'
      ? 7 * 24 * 60 * 60 * 1000
      : policy === 'strong'
        ? 7 * 24 * 60 * 60 * 1000
        : 14 * 24 * 60 * 60 * 1000
}

function roundUsd(value: number): number {
  return Number(Math.max(0, value).toFixed(2))
}

export function calculatePrivacyRiskSnapshot(input: {
  transactions: AuraTransaction[]
  totalBalanceUsd: number
  amountUsd: number
  policy: PrivacyBufferMode
  /** Current ZEC/USD rate used to value exact backingZec quantities. */
  zecUsd?: number
  now?: number
}): PrivacyRiskSnapshot {
  const now = input.now ?? Date.now()
  const confirmedFunding = input.transactions
    .filter((transaction) => (transaction.type === 'deposit' || transaction.type === 'receive') && transaction.status === 'completed')
    .sort((left, right) =>
      (right.completedAt ?? right.createdAt) - (left.completedAt ?? left.createdAt)
    )
  const latestFunding = confirmedFunding[0]
  const latestFundingAmount = latestFunding ? fundingValueUsdAtRate(latestFunding, input.zecUsd) : 0
  const latestFundingAgeMs = latestFunding ? fundingAgeMs(latestFunding, now) : null
  const waitMs = POLICY_WAIT_MS[input.policy]
  const immatureBufferedUsd = input.transactions.reduce((waiting, transaction) => {
    if ((transaction.type !== 'deposit' && transaction.type !== 'receive') || transaction.status !== 'completed') return waiting
    return now < (transaction.completedAt ?? transaction.createdAt) + waitMs
      ? waiting + fundingValueUsdAtRate(transaction, input.zecUsd)
      : waiting
  }, 0)
  const totalBalanceUsd = roundUsd(input.totalBalanceUsd)
  const policyReadyUsd = roundUsd(totalBalanceUsd - immatureBufferedUsd)
  const recentTiming = latestFundingAgeMs !== null && latestFundingAgeMs < 60 * 60 * 1000 && latestFundingAmount > 0
  const policyAge = latestFundingAgeMs !== null && input.policy !== 'fast' && latestFundingAgeMs >= 60 * 60 * 1000 && latestFundingAgeMs < waitMs
  const matchingFunding = confirmedFunding.find((transaction) => {
    if (!input.amountUsd || latestFundingAgeMs === null) return false
    const amount = fundingCorrelationValueUsd(transaction)
    if (amount <= 0 || fundingAgeMs(transaction, now) >= amountEchoWindowMs(input.policy)) return false
    const tolerance = Math.min(1.5, Math.max(0.3, amount * 0.02))
    return Math.abs(input.amountUsd - amount) <= tolerance
  })
  const matchingFundingAmountUsd = matchingFunding ? roundUsd(fundingCorrelationValueUsd(matchingFunding)) : null
  const freshBalance = recentTiming && input.amountUsd >= Math.min(1, latestFundingAmount * 0.5)
  const fullBalance = totalBalanceUsd > 0 && input.amountUsd >= totalBalanceUsd * 0.9
  const riskCodes: PrivacyRiskSnapshot['riskCodes'] = []
  // A confirmed public funding history is itself a truthful correlation
  // surface, even when the short timing/amount windows no longer match. Keep
  // the Privacy Check explainable and stable after the clock moves on.
  if (confirmedFunding.length > 0) riskCodes.push('FUNDING_HISTORY_VISIBLE')
  if (recentTiming) riskCodes.push('RECENT_TIMING')
  if (policyAge) riskCodes.push('POLICY_AGE')
  if (matchingFundingAmountUsd !== null) riskCodes.push('AMOUNT_ECHO')
  if (freshBalance && matchingFundingAmountUsd === null) riskCodes.push('FRESH_BALANCE')
  if (fullBalance) riskCodes.push('FULL_BALANCE')
  const recommendedAction = policyReadyUsd < input.amountUsd
    ? 'wait'
    : riskCodes.length > 0 && (recentTiming || matchingFundingAmountUsd !== null)
      ? 'use_mature_balance'
      : 'pay'
  // The hash binds the signed intent to the server's policy decision without
  // making the signature expire every few seconds as a clock advances.
  const fingerprint = JSON.stringify({
    version: 'aura-privacy-risk-v1',
    amountUsd: roundUsd(input.amountUsd),
    policy: input.policy,
    riskCodes,
    totalBalanceUsd,
    policyReadyUsd,
    matchingFundingAmountUsd,
    recommendedAction,
  })
  let hash = ''
  try {
    const crypto = require('crypto') as typeof import('crypto')
    hash = crypto.createHash('sha256').update(fingerprint).digest('hex')
  } catch {
    // This utility is server-only in the quote path. Keep a deterministic
    // fallback for isolated type/test imports that do not expose Node crypto.
    hash = fingerprint
  }
  return {
    schemaVersion: 'aura-privacy-risk-v1',
    hash,
    evaluatedAt: now,
    amountUsd: roundUsd(input.amountUsd),
    policy: input.policy,
    riskCodes,
    totalBalanceUsd,
    policyReadyUsd,
    latestFundingAgeMs,
    matchingFundingAmountUsd,
    recommendedAction,
  }
}
