import { NextResponse } from 'next/server'
import { isFreshSettlementRate, ratesService } from '@/lib/services/rates-service'

const MAX_BENCHMARK_AGE_MS = 5 * 60 * 1000

export async function GET() {
  try {
    const { rates, isLive } = await ratesService.getRates()
    const hasFreshBenchmark = Object.values(rates).some((rate) =>
      isFreshSettlementRate(rate, Date.now(), MAX_BENCHMARK_AGE_MS)
    )
    return NextResponse.json({
      success: true,
      data: rates,
      isLive,
      oracleStatus: isLive ? 'live' : hasFreshBenchmark ? 'stale_benchmark' : 'unavailable',
      timestamp: Date.now(),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve rates' },
      { status: 500 }
    )
  }
}
