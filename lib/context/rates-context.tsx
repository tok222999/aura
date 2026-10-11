'use client'

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { AssetSymbol, MarketRate } from '@/lib/types/aura'
import { isFreshMarketRate } from '@/lib/utils/market-rates'

interface RatesContextType {
  rates: Record<string, MarketRate>
  isOracleLive: boolean
  oracleStatus: 'live' | 'stale_benchmark' | 'unavailable'
  loading: boolean
  refreshRates: () => Promise<void>
  calculateZec: (usdAmount: number) => number
  calculateUsd: (zecAmount: number) => number
}

const RatesContext = createContext<RatesContextType | undefined>(undefined)

export function RatesProvider({ children }: { children: React.ReactNode }) {
  const unavailableRate = (symbol: AssetSymbol): MarketRate => ({
    symbol,
    usdPrice: 0,
    change24h: 0,
    lastUpdated: 0,
    status: 'unavailable',
  })
  const [rates, setRates] = useState<Record<string, MarketRate>>({
    ZEC: unavailableRate('ZEC'),
    USDC: unavailableRate('USDC'),
    USDT: unavailableRate('USDT'),
    ETH: unavailableRate('ETH'),
    SOL: unavailableRate('SOL'),
  })
  const [isOracleLive, setIsOracleLive] = useState(false)
  const [oracleStatus, setOracleStatus] = useState<'live' | 'stale_benchmark' | 'unavailable'>('unavailable')
  const [loading, setLoading] = useState(false)

  const refreshRates = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/rates')
      const json = await res.json()
      if (json.success && json.data) {
        const hasFreshSettlementRates = isFreshMarketRate(json.data.ZEC) && isFreshMarketRate(json.data.SOL)
        setRates((current) => {
          const hasUsableCurrentRates = isFreshMarketRate(current.ZEC) && isFreshMarketRate(current.SOL)
          return hasFreshSettlementRates || !hasUsableCurrentRates ? json.data : current
        })
        setIsOracleLive(!!json.isLive)
        setOracleStatus(json.oracleStatus || (json.isLive ? 'live' : 'stale_benchmark'))
      }
    } catch (err) {
      console.warn('Rates refresh failed', err)
      setOracleStatus('unavailable')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshRates()
    const interval = setInterval(refreshRates, 10000)
    return () => clearInterval(interval)
  }, [refreshRates])

  const calculateZec = useCallback(
    (usdAmount: number) => {
      const zPrice = rates.ZEC?.usdPrice || 0
      if (zPrice <= 0) return 0
      return Number((usdAmount / zPrice).toFixed(4))
    },
    [rates]
  )

  const calculateUsd = useCallback(
    (zecAmount: number) => {
      const zPrice = rates.ZEC?.usdPrice || 0
      if (zPrice <= 0) return 0
      return Number((zecAmount * zPrice).toFixed(2))
    },
    [rates]
  )

  return (
    <RatesContext.Provider
      value={{
        rates,
        isOracleLive,
        oracleStatus,
        loading,
        refreshRates,
        calculateZec,
        calculateUsd,
      }}
    >
      {children}
    </RatesContext.Provider>
  )
}

export function useRates() {
  const context = useContext(RatesContext)
  if (!context) {
    throw new Error('useRates must be used within a RatesProvider')
  }
  return context
}
