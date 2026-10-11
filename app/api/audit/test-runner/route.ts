import { NextResponse } from 'next/server'
import { runAllAuditTests } from '@/tests/accounting-integrity.test'
import { NextRequest } from 'next/server'
import { InMemoryRateLimiter } from '@/lib/utils/rate-limiter'
import { getTrustedClientId } from '@/lib/services/demo-session-service'

export const dynamic = 'force-dynamic'
export const revalidate = 0
const auditLimiter = new InMemoryRateLimiter(5, 60)

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ success: false, error: 'NOT_FOUND' }, { status: 404 })
  }
  try {
    const identifier = getTrustedClientId(req.headers)
    const limit = auditLimiter.check(identifier)
    if (!limit.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMITED' }, {
        status: 429,
        headers: { 'Retry-After': String(limit.retryAfter || 60) },
      })
    }

    const report = await runAllAuditTests()

    return NextResponse.json({
      success: report.failed === 0,
      timestamp: Date.now(),
      summary: {
        total: report.total,
        passed: report.passed,
        failed: report.failed,
        allPassed: report.failed === 0,
      },
      results: report.results,
    })
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
