import { NextResponse } from 'next/server'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ success: false, error: 'NOT_FOUND' }, { status: 404 })
  }
  if (!zcashDevtoolService.isAvailable()) {
    return NextResponse.json({
      success: false,
      status: 'unavailable',
      binaryAvailable: false,
      message: 'Zcash Testnet helper binary is not installed.',
    }, { status: 503 })
  }

  try {
    const sync = await zcashDevtoolService.sync()
    let lastSyncedBlock = sync.blockHeight
    if (sync.success && lastSyncedBlock === undefined) {
      const balance = await zcashDevtoolService.getBalance().catch(() => null)
      lastSyncedBlock = balance?.chainHeight
    }
    return NextResponse.json({
      success: sync.success,
      status: sync.success ? 'ok' : 'degraded',
      binaryAvailable: true,
      server: 'zecrocks',
      lastSyncedBlock: lastSyncedBlock ?? null,
      error: sync.success ? undefined : 'Zcash Testnet wallet sync failed.',
    }, { status: sync.success ? 200 : 503 })
  } catch (error: unknown) {
    return NextResponse.json({
      success: false,
      status: 'degraded',
      binaryAvailable: true,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 503 })
  }
}
