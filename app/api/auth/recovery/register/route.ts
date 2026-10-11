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
  const productionBlock = getProductionExecutionBlock('recovery_authority_register')
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
      authPublicKey,
      signature,
      recoveryPublicKey,
      recoverySignature,
      clientTimestamp,
      nonce,
    } = body || {}
    if (
      !validSpki(authPublicKey) || !validSignature(signature) || !validSpki(recoveryPublicKey) || !validSignature(recoverySignature) ||
      !Number.isSafeInteger(clientTimestamp) || Math.abs(Date.now() - clientTimestamp) > 5 * 60 * 1000 ||
      typeof nonce !== 'string' || !/^[a-f0-9]{32}$/i.test(nonce)
    ) {
      return NextResponse.json({ success: false, error: 'INVALID_RECOVERY_REGISTRATION' }, { status: 400 })
    }

    const payload = `${tenantId}:register_recovery:${clientTimestamp}:${nonce}:${recoveryPublicKey}`
    if (!verifyClientEcdsaSignature(authPublicKey, payload, signature)) {
      return NextResponse.json({ success: false, error: 'INVALID_AUTHORIZATION' }, { status: 401 })
    }
    if (!verifyClientEcdsaSignature(recoveryPublicKey, payload, recoverySignature)) {
      return NextResponse.json({ success: false, error: 'INVALID_RECOVERY_PROOF' }, { status: 401 })
    }
    if (tenantId.startsWith('vault_r_') &&
      deriveRecoveryTenantIdFromSpki(recoveryPublicKey) !== tenantId &&
      deriveLegacyRecoveryTenantIdFromSpki(recoveryPublicKey) !== tenantId) {
      return NextResponse.json({ success: false, error: 'RECOVERY_TENANT_MISMATCH' }, { status: 401 })
    }
    if (!persistentStore.claimAuthNonce(tenantId, 'recovery_register', nonce)) {
      return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
    }

    const storedRecoveryKey = persistentStore.getRecoveryKey(tenantId)
    const existingSpendKey = persistentStore.getSpendSigningKey(tenantId)
    if (!storedRecoveryKey && !existingSpendKey && tenantId.startsWith('vault_') && !tenantId.startsWith('vault_r_')) {
      return NextResponse.json({
        success: false,
        error: 'LEGACY_TENANT_NAMESPACE_UNVERIFIED',
        message: 'New tenants must use the recovery-bound namespace. Existing legacy tenants must first enroll from their pinned signer.',
      }, { status: 409 })
    }
    if (existingSpendKey && !storedRecoveryKey && existingSpendKey !== authPublicKey) {
      return NextResponse.json({
        success: false,
        error: 'LEGACY_RECOVERY_ENROLLMENT_REQUIRES_EXISTING_SIGNER',
        message: 'This tenant has no registered recovery authority. Recovery must first be enrolled from the existing signing session.',
      }, { status: 409 })
    }
    if (!storedRecoveryKey && !existingSpendKey) {
      if (!persistentStore.registerInitialAuthKeys(tenantId, recoveryPublicKey, authPublicKey)) {
        return NextResponse.json({ success: false, error: 'INITIAL_AUTH_REGISTRATION_FAILED' }, { status: 409 })
      }
    } else {
      if (!persistentStore.bindRecoveryKey(tenantId, recoveryPublicKey)) {
        return NextResponse.json({ success: false, error: 'RECOVERY_KEY_MISMATCH' }, { status: 409 })
      }
    }
    if (existingSpendKey && existingSpendKey !== authPublicKey) {
      // A valid recovery proof is allowed to recover a tenant from a new
      // browser, but a random browser key can never replace the pinned one.
      if (!persistentStore.rotateSpendSigningKey(tenantId, authPublicKey)) {
        return NextResponse.json({ success: false, error: 'SPEND_KEY_ROTATION_FAILED' }, { status: 500 })
      }
    } else if (!existingSpendKey && (storedRecoveryKey || !persistentStore.getSpendSigningKey(tenantId))) {
      return NextResponse.json({
        success: false,
        error: 'SPEND_KEY_RECOVERY_REQUIRED',
        message: 'This tenant has a recovery authority but no spend key. Restore the account to authorize a new spend key.',
      }, { status: 409 })
    }

    return NextResponse.json({ success: true, tenantId, recoveryRegistered: true }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('Recovery authority registration failed:', error)
    return NextResponse.json({ success: false, error: 'RECOVERY_REGISTRATION_FAILED' }, { status: 500 })
  }
}
