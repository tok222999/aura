import { NextRequest, NextResponse } from 'next/server'
import { persistentStore } from '@/lib/services/persistent-store'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { createPaymentPreparationMessage } from '@/lib/crypto/payment-authorization'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { paymentLimiter, globalPaymentLimiter } from '@/lib/utils/rate-limiter'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const productionBlock = getProductionExecutionBlock('payment_request_prepare')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  try {
    const { id } = await params
    const globalLimit = globalPaymentLimiter.check('payment-request-prepare')
    if (!globalLimit.allowed) return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED' }, { status: 429, headers: { 'Retry-After': String(globalLimit.retryAfter || 60) } })
    const durableGlobal = persistentStore.checkSharedRateLimit('payment-request-prepare', 'global', 180, 60)
    if (durableGlobal && !durableGlobal.allowed) return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED' }, { status: 429, headers: { 'Retry-After': String(durableGlobal.retryAfter || 60) } })
    const request = persistentStore.getPaymentRequest(id)
    if (!request) return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_FOUND' }, { status: 404 })
    if (!request.sharedAt) return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_PUBLISHED', message: 'This payment request is still a private draft.' }, { status: 404 })
    if (request.status === 'expired') return NextResponse.json({ success: false, error: 'REQUEST_EXPIRED', message: 'This payment request has expired and cannot accept a new payer.' }, { status: 410 })
    if (request.status !== 'active') return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_ACTIVE' }, { status: 409 })
    if (request.chain !== 'base' || request.asset !== 'USDC') {
      return NextResponse.json({ success: false, error: 'ROUTE_NOT_ENABLED', message: 'Payer preparation is enabled for Base Sepolia USDC only.' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const payerAddress = typeof body.payerAddress === 'string' ? body.payerAddress.trim().toLowerCase() : ''
    const payerSignature = typeof body.payerSignature === 'string' ? body.payerSignature : ''
    if (!/^0x[a-f0-9]{40}$/.test(payerAddress) || !payerSignature) {
      return NextResponse.json({ success: false, error: 'PAYER_AUTHORIZATION_REQUIRED' }, { status: 401 })
    }
    for (const limiterKey of [`request:${id}`, `payer:${payerAddress}`]) {
      const limited = paymentLimiter.check(limiterKey)
      if (!limited.allowed) return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED' }, { status: 429, headers: { 'Retry-After': String(limited.retryAfter || 60) } })
      const durable = persistentStore.checkSharedRateLimit('payment-request-prepare', limiterKey, 20, 60)
      if (durable && !durable.allowed) return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED' }, { status: 429, headers: { 'Retry-After': String(durable.retryAfter || 60) } })
    }

    const minimumAmountCents = Math.round(Number(request.minimumAmount || request.amount || 0) * 100)
    const message = createPaymentPreparationMessage({
      requestId: id,
      minimumAmountCents,
      asset: request.asset,
      chain: request.chain,
      payerAddress,
    })
    if (!(await baseRelayer.verifyWalletSignature(payerAddress, message, payerSignature))) {
      return NextResponse.json({ success: false, error: 'PAYER_SIGNATURE_MISMATCH', message: 'Sign preparation with the wallet that will send this payment.' }, { status: 403 })
    }

    let preparedBlock: number
    try {
      preparedBlock = await baseRelayer.getLatestBlockNumber()
    } catch {
      return NextResponse.json({ success: false, error: 'BASE_RECOVERY_WINDOW_UNAVAILABLE', message: 'Base recovery metadata is temporarily unavailable. Try again.' }, { status: 503 })
    }
    const preparedAt = Date.now()
    const bound = persistentStore.bindPaymentRequestPayer(id, payerAddress, preparedAt, preparedBlock)
    if (!bound) {
      return NextResponse.json({ success: false, error: 'PAYER_ALREADY_BOUND', message: 'This open payment request is already bound to another payer wallet.' }, { status: 409 })
    }
    return NextResponse.json({
      success: true,
      payerBound: true,
      preparedAt: bound.payerPreparedAt,
      preparedBlock: bound.payerPreparedBlock,
      bindingExpiresAt: bound.payerBindingExpiresAt,
    }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } })
  } catch {
    return NextResponse.json({ success: false, error: 'FAILED_TO_PREPARE_PAYMENT' }, { status: 500 })
  }
}
