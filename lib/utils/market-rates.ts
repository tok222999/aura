import { MarketRate } from '@/lib/types/aura'

export const MAX_SETTLEMENT_RATE_AGE_MS = 5 * 60 * 1000

export function isFreshMarketRate(rate: unknown, now = Date.now()): rate is MarketRate {
  if (!rate || typeof rate !== 'object') return false
  const candidate = rate as Partial<MarketRate>
  const age = now - Number(candidate.lastUpdated)
  return candidate.status === 'live' &&
    Number.isFinite(candidate.usdPrice) && Number(candidate.usdPrice) > 0 &&
    Number.isFinite(candidate.lastUpdated) && age >= 0 && age <= MAX_SETTLEMENT_RATE_AGE_MS
}

export async function fetchFreshMarketRate(symbol: string): Promise<MarketRate> {
  let response: Response
  try {
    response = await fetch('/api/rates', { cache: 'no-store' })
  } catch {
    throw new Error(`${symbol} rate is unavailable. No funds were sent; try again later.`)
  }
  const payload = await response.json().catch(() => null)
  const rate = payload?.success ? payload.data?.[symbol] : undefined
  if (!response.ok || !isFreshMarketRate(rate)) {
    throw new Error(`${symbol} rate is stale or unavailable. No funds were sent; try again later.`)
  }
  return rate
}
