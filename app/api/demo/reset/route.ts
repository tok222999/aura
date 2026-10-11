import { NextRequest, NextResponse } from 'next/server'
import { ledgerService } from '@/lib/services/ledger-service'
import { persistentStore } from '@/lib/services/persistent-store'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('demo_reset')
  if (productionBlock) {
    return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const { enclaveFingerprint: tenantId, clientTimestamp, nonce, authPublicKey, signature } = body
    if (
      typeof tenantId !== 'string' || typeof clientTimestamp !== 'number' ||
      typeof nonce !== 'string' || !/^[a-f0-9]{32}$/i.test(nonce) ||
      typeof authPublicKey !== 'string' || typeof signature !== 'string' ||
      Math.abs(Date.now() - clientTimestamp) > 2 * 60 * 1000
    ) {
      return NextResponse.json({ success: false, error: 'INVALID_RESET_AUTHORIZATION' }, { status: 401 })
    }
    const payload = `${tenantId}:reset_vault:${clientTimestamp}:${nonce}`
    if (!verifyClientEcdsaSignature(authPublicKey, payload, signature)) {
      return NextResponse.json({ success: false, error: 'INVALID_RESET_SIGNATURE' }, { status: 401 })
    }
    if (!persistentStore.claimAuthNonce(tenantId, 'reset_vault', nonce, 2 * 60 * 1000)) {
      return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
    }
    if (!persistentStore.verifySpendSigningKey(tenantId, authPublicKey)) {
      return NextResponse.json({ success: false, error: 'SIGNING_KEY_MISMATCH' }, { status: 401 })
    }

    // A ledger reset must never erase the local receipt of a real chain action.
    // The chain state cannot be rolled back by this endpoint, so refuse the
    // reset until the tenant has no live notes or chain receipts to orphan.
    const tenantTransactions = ledgerService.getTransactions(tenantId, 'all')
    const hasChainState = tenantTransactions.some((tx) => Boolean(
      tx.legs?.deposit?.txHash ||
      tx.legs?.shielded?.txHash ||
      tx.legs?.delivery?.txHash ||
      tx.legs?.shielded?.status === 'pending' ||
      tx.legs?.shielded?.status === 'broadcasting' ||
      tx.legs?.delivery?.status === 'pending' ||
      tx.legs?.delivery?.status === 'broadcasting'
    ))
    if (hasChainState) {
      return NextResponse.json({
        success: false,
        error: 'RESET_BLOCKED_CHAIN_STATE',
        message: 'Cannot clear the ledger: this tenant still has blockchain receipts or an active operation. Funds and history were not deleted.',
      }, { status: 409 })
    }

    if (zcashDevtoolService.isAvailable()) {
      const account = await zcashDevtoolService.ensureTenantAccount(tenantId).catch(() => null)
      if (account) {
        const balance = await zcashDevtoolService.getBalance(account.accountId)
        if (!balance.available) {
          return NextResponse.json({
            success: false,
            error: 'ZCASH_BALANCE_UNAVAILABLE',
            message: 'Cannot reset the tenant while its confirmed Zcash balance is unavailable. Funds and history were not deleted.',
          }, { status: 503 })
        }
        if (balance.totalSpendable > 0) {
          return NextResponse.json({
            success: false,
            error: 'RESET_BLOCKED_FUNDED_TENANT',
            message: 'Cannot clear the ledger: the tenant Zcash account still has spendable funds. Complete its settlement first.',
          }, { status: 409 })
        }
      }
    }

    // Reset must not leave a copied Receive link alive against the cleared
    // tenant. Expired links are already materialized by this listing; only
    // still-active requests are revoked.
    const activeRequests = persistentStore
      .listPaymentRequestsForTenant(tenantId)
      .filter((request) => request.status === 'active')
    for (const request of activeRequests) {
      persistentStore.revokePaymentRequest(request.id)
    }

    // Reset only an empty ledger controlled by the signed, pinned enclave key.
    ledgerService.resetDemoState(tenantId)

    return NextResponse.json({
      success: true,
      message: `Vault state for session (${tenantId}) reset to initial baseline`,
      tenantId,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to reset demo state' },
      { status: 500 }
    )
  }
}
