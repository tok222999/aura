import { AssetSymbol, MarketRate } from '../types/aura'

export function isFreshSettlementRate(
  rate: MarketRate,
  now: number,
  maxAgeMs: number
): boolean {
  const age = now - rate.lastUpdated
  return rate.status === 'live' &&
    Number.isFinite(rate.usdPrice) && rate.usdPrice > 0 &&
    Number.isFinite(rate.lastUpdated) && age >= 0 && age <= maxAgeMs
}

export function areSettlementRatesReady(
  zecRate: MarketRate | null | undefined,
  solRate: MarketRate | null | undefined,
  now: number,
  maxAgeMs: number
): boolean {
  return Boolean(
    zecRate && solRate &&
    isFreshSettlementRate(zecRate, now, maxAgeMs) &&
    isFreshSettlementRate(solRate, now, maxAgeMs)
  )
}

export interface OracleRateObservation {
  price: number
  change24h: number
}

/**
 * Select a rate only when independent sources agree closely enough to price a
 * money movement. A single surviving provider, a wide source spread, or an
 * abnormal jump from the last accepted rate fails closed.
 */
export function selectConsensusRate(
  observations: readonly OracleRateObservation[],
  previousPrice?: number | null,
): OracleRateObservation | null {
  const valid = observations.filter((value) =>
    Number.isFinite(value.price) && value.price > 0 && Number.isFinite(value.change24h)
  )
  if (valid.length < 2) return null

  const prices = valid.map((value) => value.price).sort((a, b) => a - b)
  const middle = Math.floor(prices.length / 2)
  const medianPrice = prices.length % 2 === 1
    ? prices[middle]
    : (prices[middle - 1] + prices[middle]) / 2
  const relativeSpread = (prices[prices.length - 1] - prices[0]) / medianPrice
  if (!Number.isFinite(relativeSpread) || relativeSpread > 0.05) return null

  if (typeof previousPrice === 'number' && Number.isFinite(previousPrice) && previousPrice > 0) {
    const relativeJump = Math.abs(medianPrice - previousPrice) / previousPrice
    if (!Number.isFinite(relativeJump) || relativeJump > 0.25) return null
  }

  return {
    price: medianPrice,
    change24h: valid.reduce((sum, value) => sum + value.change24h, 0) / valid.length,
  }
}

/**
 * RatesService
 * Manages real-time market valuations for Zcash (ZEC) and supported assets.
 * Implements an in-memory TTL cache with clear status distinction ('live' vs 'unavailable').
 */
class RatesService {
  private cache: Map<AssetSymbol, MarketRate> = new Map()
  private lastFetchTime = 0
  private oracleLive = false
  private refreshInFlight: Promise<void> | null = null
  private readonly CACHE_TTL_MS = 60 * 1000 // 60 seconds
  private readonly UNAVAILABLE_RETRY_MS = 5 * 1000
  private readonly MAX_SETTLEMENT_RATE_AGE_MS = 5 * 60 * 1000
  private readonly SOURCE_TIMEOUT_MS = 2500

  private readonly RATE_SYMBOLS: AssetSymbol[] = ['ZEC', 'USDC', 'USDT', 'ETH', 'SOL']

  constructor() {
    this.seedUnavailableRates()
  }

  private seedUnavailableRates() {
    for (const symbol of this.RATE_SYMBOLS) {
      this.cache.set(symbol, {
        symbol,
        usdPrice: 0,
        change24h: 0,
        lastUpdated: 0,
        status: 'unavailable',
      })
    }
  }

  public isOracleLive(): boolean {
    return this.oracleLive
  }

  public async getRates(): Promise<{ rates: Record<AssetSymbol, MarketRate>; isLive: boolean }> {
    const now = Date.now()
    const settlementRatesReady = areSettlementRatesReady(
      this.cache.get('ZEC'),
      this.cache.get('SOL'),
      now,
      this.MAX_SETTLEMENT_RATE_AGE_MS,
    )
    const retryUnavailable = !settlementRatesReady && now - this.lastFetchTime > this.UNAVAILABLE_RETRY_MS
    if (now - this.lastFetchTime > this.CACHE_TTL_MS || retryUnavailable) {
      if (!this.refreshInFlight) {
        this.refreshInFlight = this.refreshFromOracle().finally(() => {
          this.refreshInFlight = null
        })
      }
      await this.refreshInFlight
    }

    const result: Partial<Record<AssetSymbol, MarketRate>> = {}
    this.cache.forEach((rate, symbol) => {
      result[symbol] = rate
    })
    return {
      rates: result as Record<AssetSymbol, MarketRate>,
      isLive: this.oracleLive,
    }
  }

  public async getRate(symbol: AssetSymbol): Promise<MarketRate> {
    const { rates } = await this.getRates()
    return rates[symbol] || this.cache.get(symbol)!
  }

  /**
   * Return a price only when that specific asset was fetched successfully and
   * recently enough for settlement. Display fallbacks must never price money
   * movement.
   */
  public async getFreshRate(symbol: AssetSymbol): Promise<MarketRate | null> {
    const rate = await this.getRate(symbol)
    return isFreshSettlementRate(rate, Date.now(), this.MAX_SETTLEMENT_RATE_AGE_MS) ? rate : null
  }

  public getRateSync(symbol: AssetSymbol): MarketRate {
    return this.cache.get(symbol) || {
      symbol,
      usdPrice: 0,
      change24h: 0,
      lastUpdated: 0,
      status: 'unavailable',
    }
  }

  public calculateZecEquivalent(usdAmount: number, zecPrice: number): number {
    if (zecPrice <= 0) return 0
    return Number((usdAmount / zecPrice).toFixed(4))
  }

  public calculateUsdEquivalent(zecAmount: number, zecPrice: number): number {
    return Number((zecAmount * zecPrice).toFixed(2))
  }

  private async refreshFromOracle(): Promise<void> {
    const observations: Partial<Record<AssetSymbol, OracleRateObservation[]>> = {}
    const add = (symbol: AssetSymbol, price: unknown, change24h: unknown) => {
      const numericPrice = Number(price)
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) return
      const numericChange = Number(change24h)
      ;(observations[symbol] ||= []).push({
        price: numericPrice,
        change24h: Number.isFinite(numericChange) ? numericChange : 0,
      })
    }
    const fetchJson = async (url: string): Promise<any> => {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.SOURCE_TIMEOUT_MS), cache: 'no-store' })
      if (!response.ok) throw new Error(`Price source returned HTTP ${response.status}`)
      return response.json()
    }

    const [coinGecko, cryptoCompare, coinCap, coinbase, kraken] = await Promise.allSettled([
      fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=zcash,ethereum,solana,usd-coin,tether&vs_currencies=usd&include_24hr_change=true'),
      fetchJson('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=ZEC,ETH,SOL,USDC,USDT&tsyms=USD'),
      Promise.all(['zcash', 'ethereum', 'solana', 'usd-coin', 'tether'].map(async (asset) => ({ asset, data: await fetchJson(`https://api.coincap.io/v2/assets/${asset}`) }))),
      // Coinbase's public spot endpoint does not require an API key. It is a
      // second independent source for settlement-critical ZEC/SOL pricing
      // when CryptoCompare is unavailable or requires credentials.
      Promise.allSettled(['ZEC', 'ETH', 'SOL', 'USDC', 'USDT'].map(async (symbol) => ({
        symbol,
        data: await fetchJson(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`),
      }))),
      // Kraken is an independent spot source for the settlement-critical
      // ZEC/SOL pair. Coinbase alone must not satisfy the two-source quorum.
      fetchJson('https://api.kraken.com/0/public/Ticker?pair=ZECUSD,SOLUSD'),
    ])

    if (coinGecko.status === 'fulfilled') {
      const data = coinGecko.value
      add('ZEC', data.zcash?.usd, data.zcash?.usd_24h_change)
      add('ETH', data.ethereum?.usd, data.ethereum?.usd_24h_change)
      add('SOL', data.solana?.usd, data.solana?.usd_24h_change)
      add('USDC', data['usd-coin']?.usd, data['usd-coin']?.usd_24h_change)
      add('USDT', data.tether?.usd, data.tether?.usd_24h_change)
    }
    if (cryptoCompare.status === 'fulfilled') {
      const raw = cryptoCompare.value?.RAW || {}
      for (const [symbol, key] of [['ZEC', 'ZEC'], ['ETH', 'ETH'], ['SOL', 'SOL'], ['USDC', 'USDC'], ['USDT', 'USDT']] as const) {
        add(symbol, raw[key]?.USD?.PRICE, raw[key]?.USD?.CHANGEPCT24HOUR)
      }
    }
    if (coinCap.status === 'fulfilled') {
      const symbolByAsset: Record<string, AssetSymbol> = { zcash: 'ZEC', ethereum: 'ETH', solana: 'SOL', 'usd-coin': 'USDC', tether: 'USDT' }
      for (const item of coinCap.value) {
        const symbol = symbolByAsset[item.asset]
        const data = item.data
        if (symbol) add(symbol, data?.data?.priceUsd, data?.data?.changePercent24Hr)
      }
    }
    if (coinbase.status === 'fulfilled') {
      for (const result of coinbase.value) {
        if (result.status !== 'fulfilled') continue
        const amount = Number(result.value.data?.data?.amount)
        if (result.value.symbol && Number.isFinite(amount) && amount > 0) {
          add(result.value.symbol as AssetSymbol, amount, 0)
        }
      }
    }
    if (kraken.status === 'fulfilled') {
      const result = kraken.value?.result || {}
      const zec = result.XZECZUSD || result.ZECUSD
      const sol = result.SOLUSD
      add('ZEC', zec?.c?.[0], 0)
      add('SOL', sol?.c?.[0], 0)
    }

    const now = Date.now()
    for (const symbol of this.RATE_SYMBOLS) {
      const values = observations[symbol] || []
      const previous = this.cache.get(symbol)
      const consensus = selectConsensusRate(values, previous?.status === 'live' ? previous.usdPrice : null)
      if (consensus) {
        this.cache.set(symbol, {
          symbol,
          usdPrice: Number(consensus.price.toFixed(8)),
          change24h: Number(consensus.change24h.toFixed(2)),
          lastUpdated: now,
          status: 'live',
        })
        continue
      }

      // Never carry a stale or single-source price into a money movement.
      // Keep a still-fresh last-known-good value when one oracle refresh is
      // temporarily inconclusive; the server-side settlement check still
      // rejects it as soon as it passes the five-minute safety window.
      const previousAge = previous ? now - previous.lastUpdated : Infinity
      if (previous?.status === 'live' && previousAge >= 0 && previousAge <= this.MAX_SETTLEMENT_RATE_AGE_MS) {
        this.cache.set(symbol, previous)
        continue
      }
      this.cache.set(symbol, {
        symbol,
        usdPrice: 0,
        change24h: 0,
        lastUpdated: 0,
        status: 'unavailable',
      })
    }

    this.oracleLive = areSettlementRatesReady(
      this.cache.get('ZEC'),
      this.cache.get('SOL'),
      now,
      this.MAX_SETTLEMENT_RATE_AGE_MS
    )
    this.lastFetchTime = now
  }
}

export const ratesService = new RatesService()
