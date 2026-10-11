import { NextRequest, NextResponse } from 'next/server'
import { AssetSymbol, ChainId, PrivacyBufferMode } from '@/lib/types/aura'
import { globalQuoteLimiter, quoteLimiter } from '@/lib/utils/rate-limiter'
import { settlementQuoteService } from '@/lib/services/settlement-quote-service'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { persistentStore } from '@/lib/services/persistent-store'

const NO_CACHE_HEADERS = {
  'Cache-Control': 'private, no-cache, no-store, max-age=0, must-revalidate',
  Pragma: 'no-cache',
}

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('spend_quote')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503, headers: NO_CACHE_HEADERS })
  const globalRateCheck = globalQuoteLimiter.check('global')
  if (!globalRateCheck.allowed) {
    return NextResponse.json(
      { success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many quote requests.' },
      { status: 429, headers: { ...NO_CACHE_HEADERS, 'Retry-After': String(globalRateCheck.retryAfter) } },
    )
  }

  const body = await req.json().catch(() => ({}))
  const headerTenant = req.headers.get('x-aura-enclave-fingerprint')
  const tenantId = typeof body.enclaveFingerprint === 'string' ? body.enclaveFingerprint : headerTenant
  if (!tenantId || !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId) || (headerTenant && headerTenant !== tenantId)) {
    return NextResponse.json({ success: false, error: 'TENANT_REQUIRED' }, { status: 401, headers: NO_CACHE_HEADERS })
  }

  const authTimestamp = Number(req.headers.get('x-aura-auth-timestamp'))
  const authNonce = req.headers.get('x-aura-auth-nonce') || ''
  const authPublicKey = req.headers.get('x-aura-auth-public-key') || ''
  const authSignature = req.headers.get('x-aura-auth-signature') || ''
  if (
    !Number.isSafeInteger(authTimestamp) || Math.abs(Date.now() - authTimestamp) > 2 * 60 * 1000 ||
    !/^[a-f0-9]{32}$/i.test(authNonce) ||
    !/^[a-f0-9]+$/i.test(authPublicKey) || authPublicKey.length < 64 || authPublicKey.length > 1024 ||
    !/^sig_0x[a-f0-9]+$/i.test(authSignature) || authSignature.length > 512
  ) {
    return NextResponse.json({ success: false, error: 'QUOTE_AUTHORIZATION_REQUIRED' }, { status: 401, headers: NO_CACHE_HEADERS })
  }
  const authPayload = `${tenantId}:quote_request:${authTimestamp}:${authNonce}`
  if (!verifyClientEcdsaSignature(authPublicKey, authPayload, authSignature)) {
    return NextResponse.json({ success: false, error: 'INVALID_QUOTE_AUTHORIZATION' }, { status: 401, headers: NO_CACHE_HEADERS })
  }
  if (!persistentStore.verifySpendSigningKey(tenantId, authPublicKey)) {
    return NextResponse.json({ success: false, error: 'SIGNING_KEY_MISMATCH' }, { status: 401, headers: NO_CACHE_HEADERS })
  }
  if (!persistentStore.claimAuthNonce(tenantId, 'quote_request', authNonce, 2 * 60 * 1000)) {
    return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401, headers: NO_CACHE_HEADERS })
  }

  const rateCheck = quoteLimiter.check(quoteLimiter.getIdentifier(req, authPublicKey))
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many quote requests.' },
      { status: 429, headers: { ...NO_CACHE_HEADERS, 'Retry-After': String(rateCheck.retryAfter) } },
    )
  }

  const type = body.type === 'withdraw' ? 'withdraw' : body.type === 'send' ? 'send' : null
  const asset = body.asset as AssetSymbol
  const chain = body.chain as ChainId
  const bufferMode = body.bufferMode as PrivacyBufferMode
  const amountUsd = Number(body.amount)
  if (!type || !Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1_000_000 ||
    Math.abs(amountUsd * 100 - Math.round(amountUsd * 100)) > 1e-7 ||
    !['fast', 'private', 'strong', 'custom'].includes(bufferMode)) {
    return NextResponse.json({ success: false, error: 'INVALID_QUOTE_INPUT' }, { status: 400, headers: NO_CACHE_HEADERS })
  }


  if (((type === 'send' || type === 'withdraw') && chain !== 'solana') || !['base', 'solana'].includes(chain) ||
    (chain === 'base' && asset !== 'USDC') || (chain === 'solana' && asset !== 'SOL')) {
    return NextResponse.json(
      { success: false, error: 'UNSUPPORTED_DEMO_ROUTE', message: 'This demo currently exits on Solana Devnet only. Other destinations are coming next.' },
      { status: 400, headers: NO_CACHE_HEADERS },
    )
  }

  const quote = await settlementQuoteService.issue({
    tenantId,
    amountUsd,
    asset,
    chain,
    transactionType: type,
    bufferMode,
  })
  if ('error' in quote) {
    const status = quote.error === 'RATE_UNAVAILABLE' ? 503 : quote.error === 'ZCASH_BALANCE_UNAVAILABLE' ? 503 : 409
    const messages: Record<typeof quote.error, string> = {
      RATE_UNAVAILABLE: 'A fresh settlement rate is unavailable.',
      ZCASH_BALANCE_UNAVAILABLE: 'The authoritative Zcash balance is temporarily unavailable.',
      INSUFFICIENT_READY_ZEC: "AURA's Zcash Testnet reserve is not sufficient for this payment and network fee. You do not need to provide ZEC.",
      NOT_MATURE: 'The selected Private Balance is not mature enough for this payment policy yet.',
    }
    return NextResponse.json(
      { success: false, error: quote.error, message: messages[quote.error] },
      { status, headers: NO_CACHE_HEADERS },
    )
  }

  return NextResponse.json({
    success: true,
    quote: {
      quoteId: quote.quoteId,
      amountUsd: quote.amountUsd,
      amountZec: quote.amountZec,
      amountSol: quote.amountSol,
      quoteZecUsd: quote.zecUsd,
      quoteSolUsd: quote.solUsd,
      expiresAt: quote.expiresAt,
      privacyRisk: quote.privacyRiskSnapshot,
      privacyRiskHash: quote.privacyRiskSnapshot.hash,
    },
  }, { headers: NO_CACHE_HEADERS })
}
