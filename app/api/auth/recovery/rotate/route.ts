import { NextRequest, NextResponse } from 'next/server'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { deriveRecoveryTenantIdFromSpki, deriveLegacyRecoveryTenantIdFromSpki } from '@/lib/crypto/bip39'
import { persistentStore } from '@/lib/services/persistent-store'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'

function validSpki(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]+$/i.test(value) && value.length <= 1024 && value.length >= 64
}

function validSignature(value: unknown): value is string {
  return typeof value === 'string' && /^sig_0x[a-f0-9]+$/i.test(value) && value.length <= 512
}

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('recovery_authority_rotate')
  if (productionBlock) {
    return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  }

  try {
    const tenantId = req.headers.get('x-aura-enclave-fingerprint') || ''
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId)) {
      return NextResponse.json({ success: false, error: 'INVALID_TENANT' }, { status: 400 })
    }

    const body = await req.json()
    const {
      recoveryPublicKey,
      recoverySignature,
      newAuthPublicKey,
      clientTimestamp,
      nonce,
    } = body || {}
    if (
      !validSpki(recoveryPublicKey) || !validSignature(recoverySignature) || !validSpki(newAuthPublicKey) ||
      !Number.isSafeInteger(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 5 * 60 * 1000 ||
      typeof nonce !== 'string' || !/^[a-f0-9]{32}$/i.test(nonce)
    ) {
      return NextResponse.json({ success: false, error: 'INVALID_RECOVERY_ROTATION' }, { status: 400 })
    }

    const storedRecoveryKey = persistentStore.getRecoveryKey(tenantId)
    if (!storedRecoveryKey) {
      return NextResponse.json({
        success: false,
        error: 'RECOVERY_NOT_REGISTERED',
        message: 'This tenant has no previously registered recovery authority. Open the original signing session once to enroll recovery safely.',
      }, { status: 409 })
    }
    if (storedRecoveryKey !== recoveryPublicKey) {
      return NextResponse.json({
        success: false,
        error: 'RECOVERY_AUTHORITY_MISMATCH',
        message: 'The recovery authority does not belong to this tenant.',
      }, { status: 409 })
    }
    if (tenantId.startsWith('vault_r_') &&
      deriveRecoveryTenantIdFromSpki(recoveryPublicKey) !== tenantId &&
      deriveLegacyRecoveryTenantIdFromSpki(recoveryPublicKey) !== tenantId) {
      return NextResponse.json({
        success: false,
        error: 'RECOVERY_TENANT_MISMATCH',
        message: 'The recovery authority does not cryptographically match this tenant namespace.',
      }, { status: 401 })
    }

    const payload = `${tenantId}:rotate_spend_key:${clientTimestamp}:${nonce}:${newAuthPublicKey}`
    if (!verifyClientEcdsaSignature(recoveryPublicKey, payload, recoverySignature)) {
      return NextResponse.json({ success: false, error: 'INVALID_RECOVERY_PROOF' }, { status: 401 })
    }
    if (!persistentStore.claimAuthNonce(tenantId, 'recovery_rotate', nonce)) {
      return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
    }
    if (!persistentStore.rotateSpendSigningKey(tenantId, newAuthPublicKey)) {
      return NextResponse.json({ success: false, error: 'SPEND_KEY_ROTATION_FAILED' }, { status: 500 })
    }

    return NextResponse.json({ success: true, tenantId, spendKeyRotated: true }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('Recovery spend-key rotation failed:', error)
    return NextResponse.json({ success: false, error: 'RECOVERY_ROTATION_FAILED' }, { status: 500 })
  }
}
