import { NextRequest, NextResponse } from 'next/server'
import { AssetSymbol, PrivacyBufferMode } from '@/lib/types/aura'
import { globalQuoteLimiter, isSharedUnauthenticatedIdentifier, quoteLimiter } from '@/lib/utils/rate-limiter'

const ASSETS: AssetSymbol[] = ['USDC', 'USDT', 'ETH', 'SOL', 'ZEC']
const BUFFER_MODES: PrivacyBufferMode[] = ['fast', 'private', 'strong', 'custom']

function validateQuoteInput(fromAsset: unknown, toAsset: unknown, amount: unknown, bufferMode: unknown) {
  const parsedAmount = typeof amount === 'number' ? amount : Number(amount)
  if (
    typeof fromAsset !== 'string' || !ASSETS.includes(fromAsset as AssetSymbol) ||
    typeof toAsset !== 'string' || !ASSETS.includes(toAsset as AssetSymbol) ||
    !Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 1_000_000 ||
    (bufferMode !== undefined && !BUFFER_MODES.includes(bufferMode as PrivacyBufferMode))
  ) return null
  return { fromAsset: fromAsset as AssetSymbol, toAsset: toAsset as AssetSymbol, amount: parsedAmount, bufferMode: (bufferMode || 'private') as PrivacyBufferMode }
}

export async function GET(req: NextRequest) {
  try {
    // Section 14: Rate limiting
    const globalRate = globalQuoteLimiter.check('public-quote-global')
    if (!globalRate.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many quote requests' }, { status: 429, headers: { 'Retry-After': String(globalRate.retryAfter || 60) } })
    }
    const identifier = quoteLimiter.getIdentifier(req)
    const rateCheck = quoteLimiter.check(identifier)
    if (!isSharedUnauthenticatedIdentifier(identifier) && !rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many quote requests' },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } }
      )
    }

    const { searchParams } = req.nextUrl
    const fromAsset = searchParams.get('fromAsset')
    const toAsset = searchParams.get('toAsset')
    const amount = searchParams.get('amount') || searchParams.get('fromAmount')
    const bufferMode = searchParams.get('bufferMode') || 'private'

    const quoteInput = validateQuoteInput(fromAsset, toAsset, amount, bufferMode)
    if (!quoteInput) {
      return NextResponse.json(
        { success: false, error: 'Invalid quote parameters' },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { success: false, error: 'TEST_ROUTE_NO_PROVIDER_QUOTE', message: 'The hackathon test route does not execute a swap or have a live provider quote. No estimated output or provider fee is being invented.' },
      {
        status: 501,
        headers: {
          'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to generate swap quote' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const globalRate = globalQuoteLimiter.check('public-quote-global')
    if (!globalRate.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many quote requests' }, { status: 429, headers: { 'Retry-After': String(globalRate.retryAfter || 60) } })
    }
    const identifier = quoteLimiter.getIdentifier(req)
    const rateCheck = quoteLimiter.check(identifier)
    if (!isSharedUnauthenticatedIdentifier(identifier) && !rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many quote requests' },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } }
      )
    }

    const body = await req.json().catch(() => ({}))
    const { fromAsset, toAsset, amount, bufferMode } = body

    const quoteInput = validateQuoteInput(fromAsset, toAsset, amount, bufferMode)
    if (!quoteInput) {
      return NextResponse.json(
        { success: false, error: 'Invalid quote parameters' },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { success: false, error: 'TEST_ROUTE_NO_PROVIDER_QUOTE', message: 'The hackathon test route does not execute a swap or have a live provider quote. No estimated output or provider fee is being invented.' },
      {
        status: 501,
        headers: {
          'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate',
          Pragma: 'no-cache',
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to generate swap quote' },
      { status: 500 }
    )
  }
}
