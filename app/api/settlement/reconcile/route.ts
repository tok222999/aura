import { NextRequest, NextResponse } from 'next/server'
import { InMemoryRateLimiter } from '@/lib/utils/rate-limiter'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { persistentStore } from '@/lib/services/persistent-store'
import { ledgerService } from '@/lib/services/ledger-service'
import { resumeConfirmedShieldedPayout } from '@/lib/services/settlement-reconciler'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { reconcilePendingOperations } from '@/lib/services/pending-operation-reconciler'

const reconcileLimiter = new InMemoryRateLimiter(20, 60)

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('settlement_reconcile')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  const rate = reconcileLimiter.check(reconcileLimiter.getIdentifier(req))
  if (!rate.allowed) return NextResponse.json({ success: false, error: 'RATE_LIMITED' }, { status: 429 })

  const tenantId = req.headers.get('x-aura-enclave-fingerprint') || ''
  const timestamp = Number(req.headers.get('x-aura-auth-timestamp'))
  const nonce = req.headers.get('x-aura-auth-nonce') || ''
  const publicKey = req.headers.get('x-aura-auth-public-key') || ''
  const signature = req.headers.get('x-aura-auth-signature') || ''
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId) || !Number.isSafeInteger(timestamp) ||
    Math.abs(Date.now() - timestamp) > 2 * 60 * 1000 || !/^[a-f0-9]{32}$/i.test(nonce) || !publicKey || !signature) {
    return NextResponse.json({ success: false, error: 'AUTHORIZATION_REQUIRED' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const txId = typeof body.txId === 'string' ? body.txId : ''
  if (!txId || !/^[a-zA-Z0-9._-]{1,160}$/.test(txId)) {
    return NextResponse.json({ success: false, error: 'INVALID_TRANSACTION' }, { status: 400 })
  }
  const signedPayload = `${tenantId}:reconcile_settlement:${timestamp}:${nonce}:${txId}`
  if (!verifyClientEcdsaSignature(publicKey, signedPayload, signature)) {
    return NextResponse.json({ success: false, error: 'INVALID_AUTHORIZATION' }, { status: 401 })
  }
  if (!persistentStore.claimAuthNonce(tenantId, 'settlement_reconcile', nonce, 2 * 60 * 1000)) {
    return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
  }
  if (!persistentStore.verifySpendSigningKey(tenantId, publicKey)) {
    return NextResponse.json({ success: false, error: 'SIGNING_KEY_MISMATCH' }, { status: 401 })
  }

  await reconcilePendingOperations()

  const tx = ledgerService.getTransactionById(txId, tenantId)
  if (!tx) return NextResponse.json({ success: false, error: 'TRANSACTION_NOT_FOUND' }, { status: 404 })
  const reconciled = await resumeConfirmedShieldedPayout(tx, tenantId)
  return NextResponse.json({ success: true, data: reconciled }, { headers: { 'Cache-Control': 'private, no-store' } })
}
