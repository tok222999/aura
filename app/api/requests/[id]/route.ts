import { NextRequest, NextResponse } from 'next/server'
import { persistentStore } from '@/lib/services/persistent-store'
import { sha256Hex } from '@/lib/crypto/ecdsa-auth'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { timingSafeEqual } from 'crypto'
import { solanaRelayer } from '@/lib/crypto/solana-relayer'
import { validateEvmAddress, validateSolanaAddress } from '@/lib/utils'
import { ledgerService } from '@/lib/services/ledger-service'
import { isWorkingDemoEntryRoute, WORKING_DEMO_ROUTE_MESSAGE } from '@/lib/services/demo-route'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { PrivacyBufferMode } from '@/lib/types/aura'
import { canonicalizePaymentRequestUpdate } from '@/lib/crypto/request-authorization'

function ownerTokenMatches(request: { ownerTokenHash?: string }, ownerToken: unknown): boolean {
  if (typeof ownerToken !== 'string' || !request.ownerTokenHash) return false
  const expected = Buffer.from(request.ownerTokenHash, 'hex')
  const actual = Buffer.from(sha256Hex(ownerToken), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function managementSignatureMatches(
  request: { id: string; enclaveFingerprint?: string },
  body: Record<string, unknown>,
  action: 'share' | 'update' | 'revoke' | 'rebind',
  signedPayload?: string,
): boolean {
  if (action === 'update' && !signedPayload) return false
  const fingerprint = typeof body.enclaveFingerprint === 'string' ? body.enclaveFingerprint : ''
  const authPublicKey = typeof body.authPublicKey === 'string' ? body.authPublicKey : ''
  const signature = typeof body.signature === 'string' ? body.signature : ''
  const clientTimestamp = body.clientTimestamp
  const nonce = typeof body.nonce === 'string' ? body.nonce : ''
  if (!request.enclaveFingerprint || fingerprint !== request.enclaveFingerprint ||
    typeof clientTimestamp !== 'number' || !Number.isSafeInteger(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 2 * 60 * 1000 ||
    !/^[a-f0-9]{32}$/i.test(nonce) || !authPublicKey || !signature) return false
  const payload = `${fingerprint}:manage_request:${clientTimestamp}:${nonce}:${signedPayload || `${request.id}:${action}`}`
  if (!verifyClientEcdsaSignature(authPublicKey, payload, signature)) return false
  if (!persistentStore.verifySpendSigningKey(fingerprint, authPublicKey)) return false
  return persistentStore.claimAuthNonce(fingerprint, 'manage_request', nonce, 2 * 60 * 1000)
}

function getSignedUpdateTerms(request: { id: string }, body: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'amount') ||
    !Object.prototype.hasOwnProperty.call(body, 'asset') ||
    !Object.prototype.hasOwnProperty.call(body, 'chain') ||
    !Object.prototype.hasOwnProperty.call(body, 'expiryHours') ||
    !Object.prototype.hasOwnProperty.call(body, 'bufferMode')) return null
  const amount = body.amount === '' ? null : body.amount === undefined ? undefined : body.amount as number | null
  const expiryHours = Number(body.expiryHours)
  if (!Number.isFinite(expiryHours)) return null
  if (typeof body.asset !== 'string' || typeof body.chain !== 'string' || typeof body.bufferMode !== 'string') return null
  return `${request.id}:update:${canonicalizePaymentRequestUpdate({
    amount,
    asset: body.asset,
    chain: body.chain,
    expiryHours,
    bufferMode: body.bufferMode as PrivacyBufferMode,
  })}`
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    // A public page must stop accepting a new payment after the deadline.
    // Consume/recovery has its own narrow before-expiry proof path for a
    // transfer that was already made, so this read can safely materialize the
    // expired state for new visitors.
    const request = persistentStore.getPaymentRequest(id)

    if (!request) {
      return NextResponse.json(
        {
          success: false,
          error: 'PAYMENT_REQUEST_NOT_FOUND',
          message: 'Payment request does not exist or has expired.',
        },
        {
          status: 404,
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Referrer-Policy': 'no-referrer',
          },
        }
      )
    }

    if (!isWorkingDemoEntryRoute(request.chain, request.asset)) {
      return NextResponse.json({
        success: false,
        error: 'ROUTE_NOT_ENABLED',
        message: WORKING_DEMO_ROUTE_MESSAGE,
      }, { status: 409 })
    }

    // A request is not a public payment instrument until its owner explicitly
    // publishes it. This keeps a mutable draft from being usable by anyone
    // who guesses or receives the draft id before the owner clicks Publish.
    if (request.status === 'active' && !request.sharedAt) {
      return NextResponse.json({
        success: false,
        error: 'PAYMENT_REQUEST_NOT_PUBLISHED',
        message: 'This payment request has not been published yet.',
      }, {
        status: 404,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Referrer-Policy': 'no-referrer',
        },
      })
    }

    // The invoice is a public bearer link. Its one-time Zcash payout receiver
    // is only needed by the server and must not be exposed to link viewers.
    const {
      enclaveFingerprint: _privateFingerprint,
      ownerTokenHash: _ownerTokenHash,
      shieldedReceiver: _shieldedReceiver,
      zcashAccountId: _zcashAccountId,
      txHash: _sourceTxHash,
      clientProof: _clientProof,
      sourceStartBlock: _sourceStartBlock,
      payerAddress: _payerAddress,
      payerPreparedAt: _payerPreparedAt,
      payerPreparedBlock: _payerPreparedBlock,
      ...publicRequest
    } = request
    const paymentAddress = request.chain === 'solana'
      ? process.env.SOLANA_VAULT_ADDRESS || solanaRelayer.getPublicKey()
      : process.env.VAULT_DEPOSIT_ADDRESS || '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e'
    const tokenAddress = request.chain === 'base'
      ? process.env.BASE_SEPOLIA_USDC_CONTRACT || '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
      : undefined
    if (
      !paymentAddress ||
      (request.chain === 'base' && (!validateEvmAddress(paymentAddress) || !validateEvmAddress(tokenAddress || ''))) ||
      (request.chain === 'solana' && !validateSolanaAddress(paymentAddress))
    ) {
      return NextResponse.json({ success: false, error: 'PAYMENT_DESTINATION_UNAVAILABLE' }, { status: 503 })
    }
    let settlementStatus: 'pending' | 'completed' | 'failed' | undefined
    if (request.status === 'consumed' && request.txHash) {
      const receiveTransaction = request.enclaveFingerprint
        ? ledgerService.getTransactions(request.enclaveFingerprint).find((tx) =>
            tx.type === 'receive' && (request.chain === 'base'
              ? tx.legs?.deposit?.txHash?.toLowerCase() === request.txHash?.toLowerCase()
              : tx.legs?.deposit?.txHash === request.txHash)
          )
        : undefined
      settlementStatus = receiveTransaction?.status === 'completed'
        ? 'completed'
        : receiveTransaction?.status === 'failed' ? 'failed' : 'pending'
    }
    const publicData = request.status === 'consumed'
      ? {
          id: publicRequest.id,
          status: publicRequest.status,
          amount: publicRequest.amount,
          asset: publicRequest.asset,
          chain: publicRequest.chain,
          createdAt: publicRequest.createdAt,
          expiresAt: publicRequest.expiresAt,
          consumedAt: publicRequest.consumedAt,
          paymentAddress,
          tokenAddress,
          settlementStatus,
          payerBound: Boolean(request.payerAddress),
        }
      : { ...publicRequest, paymentAddress, tokenAddress, settlementStatus, payerBound: Boolean(request.payerAddress) }
    return NextResponse.json(
      {
        success: true,
        data: publicData,
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Referrer-Policy': 'no-referrer',
        },
      }
    )
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve payment request' },
      { status: 500 }
    )
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const productionBlock = getProductionExecutionBlock('payment_request_share')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  try {
    const { id } = await params
    const request = persistentStore.getRequest(id)
    if (!request) return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_FOUND' }, { status: 404 })
    if (!request.ownerTokenHash || request.status !== 'active') {
      return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_ACTIVE' }, { status: 409 })
    }
    const body = await req.json().catch(() => ({}))
    if (body.action === 'clear_payer_binding') {
      if (!ownerTokenMatches(request, body.ownerToken) && !managementSignatureMatches(request, body, 'rebind')) {
        return NextResponse.json({ success: false, error: 'INVALID_OWNER_TOKEN' }, { status: 401 })
      }
      const cleared = persistentStore.clearPaymentRequestPayer(id)
      if (!cleared) return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_BUSY' }, { status: 409 })
      return NextResponse.json({ success: true, payerBound: false }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (!ownerTokenMatches(request, body.ownerToken) && !managementSignatureMatches(request, body, 'share')) {
      return NextResponse.json({ success: false, error: 'INVALID_OWNER_TOKEN' }, { status: 401 })
    }
    const shared = persistentStore.markPaymentRequestShared(id)
    return NextResponse.json({ success: true, sharedAt: shared?.sharedAt }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    })
  } catch {
    return NextResponse.json({ success: false, error: 'FAILED_TO_SHARE_PAYMENT_REQUEST' }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const productionBlock = getProductionExecutionBlock('payment_request_revoke')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  try {
    const { id } = await params
    const request = persistentStore.getRequest(id)
    if (!request) return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_FOUND' }, { status: 404 })
    const body = await req.json().catch(() => ({}))
    if (!ownerTokenMatches(request, body.ownerToken) && !managementSignatureMatches(request, body, 'revoke')) {
      return NextResponse.json({ success: false, error: 'INVALID_OWNER_TOKEN' }, { status: 401 })
    }
    if (request.status !== 'active') {
      return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_ACTIVE' }, { status: 409 })
    }
    const revoked = persistentStore.revokePaymentRequest(id)
    if (!revoked) return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_BUSY' }, { status: 409 })
    return NextResponse.json({ success: true, status: revoked.status, revokedAt: revoked.revokedAt }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    })
  } catch {
    return NextResponse.json({ success: false, error: 'FAILED_TO_REVOKE_PAYMENT_REQUEST' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const productionBlock = getProductionExecutionBlock('payment_request_update')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  try {
    const { id } = await params
    const request = persistentStore.getRequest(id)
    if (!request) return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_FOUND' }, { status: 404 })
    if (request.status !== 'active' || Date.now() >= request.expiresAt) {
      return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_NOT_ACTIVE' }, { status: 409 })
    }
    if (request.sharedAt) {
      return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_IMMUTABLE', message: 'Shared payment requests cannot change amount, network, asset, or expiry.' }, { status: 409 })
    }

    const body = await req.json().catch(() => ({}))
    const signedUpdateTerms = getSignedUpdateTerms(request, body)
    if (!ownerTokenMatches(request, body.ownerToken) && !managementSignatureMatches(request, body, 'update', signedUpdateTerms || undefined)) {
      return NextResponse.json({ success: false, error: 'INVALID_OWNER_TOKEN' }, { status: 401 })
    }

    // Invoice edits must not race with a payment that has passed verification
    // and is about to broadcast its irreversible shielded payout.
    if (!persistentStore.claimPaymentRequestProcessing(id)) {
      return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_BUSY' }, { status: 409 })
    }

    try {
    const amount = body.amount === null || body.amount === ''
      ? undefined
      : body.amount === undefined ? request.amount : Number(body.amount)
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)) {
      return NextResponse.json({ success: false, error: 'INVALID_AMOUNT' }, { status: 400 })
    }
    if (amount !== undefined && Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
      return NextResponse.json({ success: false, error: 'INVALID_AMOUNT_PRECISION' }, { status: 400 })
    }
    const asset = body.asset === undefined ? request.asset : body.asset
    const chain = body.chain === undefined ? request.chain : body.chain
    const bufferMode = body.bufferMode === undefined ? (request.bufferMode || 'private') : body.bufferMode
    if (!['fast', 'private', 'strong', 'custom'].includes(bufferMode)) {
      return NextResponse.json({ success: false, error: 'INVALID_PRIVACY_POLICY' }, { status: 400 })
    }
    if (!isWorkingDemoEntryRoute(chain, asset)) {
      return NextResponse.json({
        success: false,
        error: 'ROUTE_NOT_ENABLED',
        message: WORKING_DEMO_ROUTE_MESSAGE,
      }, { status: 400 })
    }

    let expiresAt = request.expiresAt
    if (body.expiryHours !== undefined) {
      const expiryHours = Number(body.expiryHours)
      if (!Number.isFinite(expiryHours) || expiryHours < 1 || expiryHours > 168) {
        return NextResponse.json({ success: false, error: 'INVALID_EXPIRY' }, { status: 400 })
      }
      expiresAt = Date.now() + expiryHours * 3_600_000
    }

    const rateUsdAtCreation = undefined
    const updated = persistentStore.updatePaymentRequest(id, {
      amount: amount === undefined ? null : amount,
      minimumAmount: amount === undefined ? (request.minimumAmount || 0.10) : null,
      asset,
      chain,
      bufferMode: bufferMode as PrivacyBufferMode,
      expiresAt,
      rateUsdAtCreation,
    })
    if (!updated) {
      return NextResponse.json({ success: false, error: 'PAYMENT_REQUEST_IMMUTABLE', message: 'Shared payment requests cannot change amount, network, asset, or expiry.' }, { status: 409 })
    }
    const {
      enclaveFingerprint: _privateFingerprint,
      ownerTokenHash: _ownerTokenHash,
      zcashAccountId: _zcashAccountId,
      ...publicRequest
    } = updated
    return NextResponse.json({ success: true, data: publicRequest }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    })
    } finally {
      persistentStore.releasePaymentRequestProcessing(id)
    }
  } catch {
    return NextResponse.json({ success: false, error: 'Failed to update payment request' }, { status: 500 })
  }
}
