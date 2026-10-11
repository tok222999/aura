import { NextRequest, NextResponse } from 'next/server'
import { persistentStore, StoredPaymentRequest } from '@/lib/services/persistent-store'
import { AssetSymbol, ChainId, PrivacyBufferMode } from '@/lib/types/aura'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { globalRequestCreationLimiter, requestCreationLimiter } from '@/lib/utils/rate-limiter'
import { generateSecureId } from '@/lib/utils'
import { sha256Hex } from '@/lib/crypto/ecdsa-auth'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { isWorkingDemoEntryRoute, WORKING_DEMO_ROUTE_MESSAGE } from '@/lib/services/demo-route'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { canonicalizePaymentRequestIntent } from '@/lib/crypto/request-authorization'
import { baseRelayer } from '@/lib/crypto/base-relayer'

export async function GET(req: NextRequest) {
  try {
    const fingerprint = req.headers.get('x-aura-enclave-fingerprint') || ''
    const authPublicKey = req.headers.get('x-aura-auth-public-key') || ''
    const signature = req.headers.get('x-aura-auth-signature') || ''
    const timestamp = Number(req.headers.get('x-aura-auth-timestamp') || '')
    const nonce = req.headers.get('x-aura-auth-nonce') || ''
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(fingerprint) ||
      !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 2 * 60 * 1000 ||
      !/^[a-f0-9]{32}$/i.test(nonce) || !authPublicKey || !signature) {
      return NextResponse.json({ success: false, error: 'REQUEST_AUTHORIZATION_REQUIRED' }, { status: 401 })
    }
    const payload = `${fingerprint}:list_requests:${timestamp}:${nonce}`
    if (!verifyClientEcdsaSignature(authPublicKey, payload, signature) ||
      !persistentStore.verifySpendSigningKey(fingerprint, authPublicKey) ||
      !persistentStore.claimAuthNonce(fingerprint, 'list_requests', nonce, 2 * 60 * 1000)) {
      return NextResponse.json({ success: false, error: 'INVALID_REQUEST_AUTHORIZATION' }, { status: 401 })
    }
    const requests = persistentStore.listPaymentRequestsForTenant(fingerprint).map((request) => {
      const {
        ownerTokenHash: _ownerTokenHash,
        enclaveFingerprint: _enclaveFingerprint,
        shieldedReceiver: _shieldedReceiver,
        zcashAccountId: _zcashAccountId,
        sourceStartBlock: _sourceStartBlock,
        ...publicRequest
      } = request
      return publicRequest
    })
    return NextResponse.json({ success: true, requests }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    })
  } catch {
    return NextResponse.json({ success: false, error: 'FAILED_TO_LIST_PAYMENT_REQUESTS' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('payment_request_create')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  try {
    // Section 14: Rate limiting enforcement
    const globalRateCheck = globalRequestCreationLimiter.check('global')
    if (!globalRateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Too many payment request creation calls. Please retry in ${globalRateCheck.retryAfter} seconds.`,
        },
        { status: 429, headers: { 'Retry-After': String(globalRateCheck.retryAfter) } }
      )
    }

    const body = await req.json().catch(() => ({}))
    const {
      amount,
      asset = 'USDC',
      chain = 'base',
      expiryHours = 24,
      bufferMode = 'private',
      enclaveFingerprint,
      authPublicKey,
      signature,
      clientTimestamp,
      nonce,
    } = body

    const headerFingerprint = req.headers.get('x-aura-enclave-fingerprint')
    if (
      (enclaveFingerprint !== undefined && typeof enclaveFingerprint !== 'string') ||
      (headerFingerprint && enclaveFingerprint && headerFingerprint !== enclaveFingerprint)
    ) {
      return NextResponse.json({ success: false, error: 'TENANT_MISMATCH' }, { status: 400 })
    }
    const tenantFingerprint = enclaveFingerprint || headerFingerprint
    if (!tenantFingerprint || !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantFingerprint)) {
      return NextResponse.json({ success: false, error: 'TENANT_REQUIRED' }, { status: 401 })
    }
    if (
      typeof authPublicKey !== 'string' || !/^[a-f0-9]+$/i.test(authPublicKey) || authPublicKey.length < 64 || authPublicKey.length > 1024 ||
      typeof signature !== 'string' || !/^sig_0x[a-f0-9]+$/i.test(signature) || signature.length > 512 ||
      !Number.isSafeInteger(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 2 * 60 * 1000 ||
      typeof nonce !== 'string' || !/^[a-f0-9]{32}$/i.test(nonce)
    ) {
      return NextResponse.json({ success: false, error: 'REQUEST_AUTHORIZATION_REQUIRED' }, { status: 401 })
    }
    const expiry = Number(expiryHours)
    if (!Number.isFinite(expiry) || expiry < 1 || expiry > 168) {
      return NextResponse.json({ success: false, error: 'INVALID_EXPIRY' }, { status: 400 })
    }
    if (!['fast', 'private', 'strong', 'custom'].includes(bufferMode)) {
      return NextResponse.json({ success: false, error: 'INVALID_PRIVACY_POLICY' }, { status: 400 })
    }

    // Open amount support: omitted, null, or empty amounts create an open-amount invoice.
    let numAmount: number | undefined = undefined
    if (amount !== undefined && amount !== null && amount !== '') {
      numAmount = Number(amount)
      if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 1_000_000) {
        return NextResponse.json({ success: false, error: 'INVALID_AMOUNT' }, { status: 400 })
      }
      if (Math.abs(numAmount * 100 - Math.round(numAmount * 100)) > 1e-7) {
        return NextResponse.json({ success: false, error: 'INVALID_AMOUNT_PRECISION' }, { status: 400 })
      }
    }

    if (!isWorkingDemoEntryRoute(chain, asset)) {
      return NextResponse.json({
        success: false,
        error: 'ROUTE_NOT_ENABLED',
        message: WORKING_DEMO_ROUTE_MESSAGE,
      }, { status: 400 })
    }

    const signedPayload = `${tenantFingerprint}:create_request:${clientTimestamp}:${nonce}:${canonicalizePaymentRequestIntent({ amount: numAmount, asset, chain, expiryHours: expiry, bufferMode: bufferMode as PrivacyBufferMode })}`
    if (!verifyClientEcdsaSignature(authPublicKey, signedPayload, signature)) {
      return NextResponse.json({ success: false, error: 'INVALID_REQUEST_AUTHORIZATION' }, { status: 401 })
    }
    if (!persistentStore.claimAuthNonce(tenantFingerprint, 'create_request', nonce, 2 * 60 * 1000)) {
      return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
    }
    if (!persistentStore.verifySpendSigningKey(tenantFingerprint, authPublicKey)) {
      return NextResponse.json({ success: false, error: 'SIGNING_KEY_MISMATCH' }, { status: 401 })
    }
    const rateCheck = requestCreationLimiter.check(requestCreationLimiter.getIdentifier(req, authPublicKey))
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'RATE_LIMIT_EXCEEDED', message: `Too many payment request creation calls. Please retry in ${rateCheck.retryAfter} seconds.` },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } },
      )
    }

    // Cryptographically secure request ID (Section 13)
    const id = generateSecureId('req')

    const now = Date.now()
    const expiresAt = now + expiry * 3600 * 1000
    let sourceStartBlock: number | undefined
    if (chain === 'base') {
      // This is a recovery lower-bound only; the actual transfer still needs
      // receipt, canonical block, finality and timestamp verification.
      try {
        sourceStartBlock = await baseRelayer.getLatestBlockNumber()
      } catch {
        return NextResponse.json({
          success: false,
          error: 'BASE_RECOVERY_WINDOW_UNAVAILABLE',
          message: 'Base recovery metadata is temporarily unavailable; no payment request was created.',
        }, { status: 503 })
      }
    }
    const ownerToken = generateSecureId('owner')
    const rateUsdAtCreation = undefined
    const openRequestMinimum = Number(process.env.AURA_OPEN_REQUEST_MIN_USD || 0.10)
    const minimumAmount = numAmount === undefined
      ? Number.isFinite(openRequestMinimum) && openRequestMinimum > 0 ? Number(openRequestMinimum.toFixed(2)) : 0.10
      : undefined

    // Never invent an address: generate it inside the same AURA-operated
    // Zcash source account selected for this tenant. A wallet-level/default
    // receiver would make the ledger say one tenant while the spendable note
    // belongs to another account.
    let freshReceiver: string
    let zcashAccountId: string
    try {
      const tenantAccount = await zcashDevtoolService.ensureTenantAccount(tenantFingerprint)
      zcashAccountId = tenantAccount.accountId
      freshReceiver = await zcashDevtoolService.generateFreshAddress(tenantAccount.accountId)
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error('[requests] Zcash receiver generation failed:', reason)
      return NextResponse.json(
        {
          success: false,
          error: 'ZCASH_WALLET_UNAVAILABLE',
          message: 'Private request is temporarily unavailable while the Zcash Testnet wallet syncs. No request was created; try again.',
        },
        { status: 503 }
      )
    }

    const newRequest: StoredPaymentRequest = {
      id,
      amount: numAmount,
      rateUsdAtCreation,
      minimumAmount,
      asset: asset as AssetSymbol,
      chain: chain as ChainId,
      shieldedReceiver: freshReceiver,
      status: 'active',
      createdAt: now,
      expiresAt,
      sourceStartBlock,
      enclaveFingerprint: tenantFingerprint,
      zcashAccountId,
      bufferMode: bufferMode as PrivacyBufferMode,
      ownerTokenHash: sha256Hex(ownerToken),
    }

    // A tenant has one live Receive request at a time. Revoke any previous
    // bearer link atomically with publishing this new request.
    persistentStore.createPaymentRequestReplacingActive(newRequest)

    const { ownerTokenHash: _ownerTokenHash, zcashAccountId: _zcashAccountId, sourceStartBlock: _sourceStartBlock, ...publicRequest } = newRequest
    return NextResponse.json({
      success: true,
      request: publicRequest,
      ownerToken,
      rateUsdAtCreation,
      url: `/pay/${id}`,
      id,
      freshReceiver,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'SERVER_ERROR', message: 'Failed to create payment request' },
      { status: 500 }
    )
  }
}
