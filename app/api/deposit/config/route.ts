import { NextRequest, NextResponse } from 'next/server'
import { validateEvmAddress } from '@/lib/utils'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { ratesService } from '@/lib/services/rates-service'
import { canFundShieldedSend, getShieldedSpendableZec, ZCASH_FEE_RESERVE_ZEC } from '@/lib/services/zcash-balance'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { persistentStore } from '@/lib/services/persistent-store'
import { ledgerService } from '@/lib/services/ledger-service'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { getSharedJuryEntitlementUsd, usesSharedJuryZcashSource } from '@/lib/services/jury-zcash-source'
import { canAllocateSharedJuryDeposit, getSharedJuryAvailableCapacityUsd } from '@/lib/services/demo-capacity'

const DEFAULT_VAULT_ADDRESS = '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e'
const DEFAULT_USDC_CONTRACT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

export async function GET(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('deposit_config')
  if (productionBlock) {
    return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  }

  const amount = Number(req.nextUrl.searchParams.get('amount'))
  const asset = req.nextUrl.searchParams.get('asset') || 'USDC'
  const tenantId = req.nextUrl.searchParams.get('tenantId') || ''
  if (
    !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000 ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7 ||
    asset !== 'USDC' || !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId)
  ) {
    return NextResponse.json(
      { success: false, error: 'INVALID_DEPOSIT_PREFLIGHT' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const authTenant = req.headers.get('x-aura-enclave-fingerprint') || ''
  const authTimestamp = Number(req.headers.get('x-aura-auth-timestamp'))
  const authNonce = req.headers.get('x-aura-auth-nonce') || ''
  const authPublicKey = req.headers.get('x-aura-auth-public-key') || ''
  const authSignature = req.headers.get('x-aura-auth-signature') || ''
  if (
    authTenant !== tenantId ||
    !Number.isSafeInteger(authTimestamp) || Math.abs(Date.now() - authTimestamp) > 2 * 60 * 1000 ||
    !/^[a-f0-9]{32}$/i.test(authNonce) || !authPublicKey || !authSignature
  ) {
    return NextResponse.json(
      { success: false, error: 'DEPOSIT_AUTHORIZATION_REQUIRED' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const authPayload = `${tenantId}:deposit_config:${authTimestamp}:${authNonce}`
  if (
    !verifyClientEcdsaSignature(authPublicKey, authPayload, authSignature) ||
    !persistentStore.claimAuthNonce(tenantId, 'deposit_config', authNonce, 2 * 60 * 1000) ||
    !persistentStore.verifySpendSigningKey(tenantId, authPublicKey)
  ) {
    return NextResponse.json(
      { success: false, error: 'INVALID_DEPOSIT_AUTHORIZATION' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const vaultAddress = process.env.VAULT_DEPOSIT_ADDRESS || DEFAULT_VAULT_ADDRESS
  const usdcContract = process.env.BASE_SEPOLIA_USDC_CONTRACT || DEFAULT_USDC_CONTRACT

  if (!validateEvmAddress(vaultAddress) || !validateEvmAddress(usdcContract)) {
    return NextResponse.json(
      { success: false, error: 'INVALID_DEPOSIT_CONFIGURATION' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const sourceRpcReady = await baseRelayer.isBaseSepoliaRpcReady()
  const sharedJuryZcashSource = usesSharedJuryZcashSource(tenantId)
  // The shared inventory can receive confirmed notes while the app process is
  // idle. Refresh its local wallet index before calculating capacity so Add
  // Money never makes a decision from stale spendable state.
  const sharedSourceSync = sharedJuryZcashSource
    ? await zcashDevtoolService.sync().catch(() => ({ success: false }))
    : null
  const sourceSyncReady = !sharedJuryZcashSource || Boolean(sharedSourceSync?.success)

  const [zecRate, zcashAddresses, zcashBalance, tenantAccount] = await Promise.all([
    ratesService.getFreshRate('ZEC'),
    zcashDevtoolService.listAddresses().catch(() => ({} as { unified?: string })),
    zcashDevtoolService.isAvailable()
      ? (sharedJuryZcashSource
        ? zcashDevtoolService.getSharedSourceAccount().then((account) => zcashDevtoolService.getBalance(account.accountId)).catch(() => null)
        : zcashDevtoolService.getBalance().catch(() => null))
      : Promise.resolve(null),
    sharedJuryZcashSource
      ? zcashDevtoolService.getSharedSourceAccount().catch(() => null)
      : zcashDevtoolService.ensureTenantAccount(tenantId).catch(() => null),
  ])
  const ratesReady = Boolean(zecRate)
  const shieldedZec = zecRate ? Number((amount / zecRate.usdPrice).toFixed(6)) : 0
  const shieldedBalanceZec = getShieldedSpendableZec(zcashBalance)
  const sourceCapacityUsd = sharedJuryZcashSource && zecRate
    ? Number(Math.max(0, shieldedBalanceZec - ZCASH_FEE_RESERVE_ZEC).toFixed(6)) * zecRate.usdPrice
    : null
  const existingEntitlementUsd = sharedJuryZcashSource
    ? getSharedJuryEntitlementUsd(ledgerService, persistentStore.listPendingOperations())
    : null
  const availableCapacityUsd = sharedJuryZcashSource && sourceCapacityUsd !== null && existingEntitlementUsd !== null
    ? getSharedJuryAvailableCapacityUsd(sourceCapacityUsd, existingEntitlementUsd)
    : null
  const poolAllocationReady = !sharedJuryZcashSource || (
    canAllocateSharedJuryDeposit(sourceCapacityUsd, existingEntitlementUsd, amount)
  )
  const estimatedFeeZec = !sharedJuryZcashSource && zcashAddresses.unified && zecRate
    ? await zcashDevtoolService.estimateShieldedFeeZec(undefined, tenantAccount?.unified || zcashAddresses.unified, shieldedZec).catch(() => null)
    : null
  const zcashFeeReserveZec = estimatedFeeZec ?? ZCASH_FEE_RESERVE_ZEC
  const zcashWalletReady = Boolean(
    sourceSyncReady && zcashBalance?.available && (sharedJuryZcashSource ? tenantAccount?.accountId : zcashAddresses.unified && tenantAccount?.unified)
  )
  const shieldedPayoutReady = Boolean(
    zcashWalletReady && ratesReady && (sharedJuryZcashSource || estimatedFeeZec !== null) && canFundShieldedSend(zcashBalance, shieldedZec, zcashFeeReserveZec) && poolAllocationReady
  )
  if (!sourceRpcReady || !shieldedPayoutReady) {
    const checks = {
      sourceRpcReady,
      sourceSyncReady,
      ratesReady,
      zcashWalletReady,
      shieldedBalanceZec,
      requiredShieldedZec: shieldedZec,
      feeReserveZec: zcashFeeReserveZec,
      poolCapacityUsd: sourceCapacityUsd,
      existingEntitlementUsd,
      availableCapacityUsd,
      poolAllocationReady,
      shieldedPayoutReady,
    }
    const message = !sourceRpcReady
      ? 'Base Sepolia cannot be checked right now. No wallet transaction was requested or sent.'
      : !ratesReady
        ? 'A live ZEC rate is unavailable. No wallet transaction was requested or sent.'
        : !sourceSyncReady
          ? 'The confirmed private pool is syncing. No wallet transaction was requested or sent. Retry in a moment.'
        : !zcashWalletReady
          ? 'AuraVault or the AURA-operated Zcash private state is unavailable. No wallet transaction was requested or sent.'
          : sharedJuryZcashSource && !poolAllocationReady
            ? availableCapacityUsd && availableCapacityUsd > 0
              ? `This amount exceeds the available private-balance capacity. Up to $${availableCapacityUsd.toFixed(2)} can be added now; no Base transaction was requested or sent.`
              : 'AURA’s confirmed shielded Zcash pool is currently fully allocated. Your Base wallet balance is separate from this private pool, so no Base transaction was requested or sent. Retry after the pool is replenished or capacity is released.'
          : `The AURA Zcash source has ${shieldedBalanceZec.toFixed(8)} spendable ZEC; this deposit needs ${shieldedZec.toFixed(6)} ZEC plus about ${zcashFeeReserveZec.toFixed(5)} ZEC for network fees. You do not need to provide ZEC; the Base transaction has not been sent.`
    return NextResponse.json({
      success: false,
      error: 'DEPOSIT_NOT_READY',
      message,
      checks,
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json(
    {
      success: true,
      ready: true,
      chainId: '0x14a34',
      vaultAddress,
      usdcContract,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
