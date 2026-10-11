import { NextRequest, NextResponse } from 'next/server'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { isFinalizedSolanaSignatureStatus, solanaRelayer } from '@/lib/crypto/solana-relayer'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { InMemoryRateLimiter } from '@/lib/utils/rate-limiter'
import { ratesService } from '@/lib/services/rates-service'
import { getMinimumConfirmationsForBuffer, getShieldedSpendableZec } from '@/lib/services/zcash-balance'
import { isBaseSepoliaChainId } from '@/lib/crypto/base-relayer'
import { persistentStore } from '@/lib/services/persistent-store'
import { fetchRpcResultAcrossPool, uniqueRpcUrls } from '@/lib/services/rpc-fallback'
import { getJurySessionInfo, getJuryTenantPool, getTrustedClientId } from '@/lib/services/demo-session-service'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { ZCASH_FEE_RESERVE_ZEC } from '@/lib/services/zcash-balance'
import { reconcilePendingDemoBudget } from '@/lib/services/demo-budget-reconciler'
import { getProductionBoundaryReport } from '@/lib/services/production-boundary'
import { canAllocateSharedJuryDeposit, DEMO_DEPOSIT_AMOUNT_USD, DEMO_PAYOUT_AMOUNT_USD, DEMO_RUN_TARGET, getSharedJuryAvailableCapacityUsd } from '@/lib/services/demo-capacity'
import { ledgerService } from '@/lib/services/ledger-service'
import { reconcileLedgerBalanceWithShieldedChain } from '@/lib/services/authoritative-balance'
import { getRuntimeStorageReadiness } from '@/lib/services/runtime-storage'
import { calculatePrivacyRiskSnapshot } from '@/lib/utils/privacy-risk'
import type { AuraTransaction } from '@/lib/types/aura'
import { getSharedJuryEntitlementUsd, usesSharedJuryZcashSource } from '@/lib/services/jury-zcash-source'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const DEMO_WALLET_ADDRESS = baseRelayer.getAddress()
const productionBoundary = getProductionBoundaryReport()
const runtimeStorage = getRuntimeStorageReadiness()
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org'
const SOLANA_DEVNET_RPC = process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com'
const BASE_SEPOLIA_RPCS = uniqueRpcUrls(BASE_SEPOLIA_RPC, [
  ...(process.env.BASE_SEPOLIA_RPC_FALLBACKS || '').split(','),
  'https://base-sepolia-rpc.publicnode.com',
  'https://sepolia.base.org',
])
const BASE_SEPOLIA_RPC_HOST = (() => {
  try {
    return new URL(BASE_SEPOLIA_RPC).host
  } catch {
    return 'Configured Base Sepolia RPC'
  }
})()
const SOLANA_DEVNET_RPC_HOST = (() => {
  try {
    return new URL(SOLANA_DEVNET_RPC).host
  } catch {
    return 'Configured Solana Devnet RPC'
  }
})()
const preflightLimiter = new InMemoryRateLimiter(6, 60)
// A caller-controlled fingerprint must not be able to multiply expensive
// RPC/Zcash work by presenting a new identifier on every request.
const globalPreflightLimiter = new InMemoryRateLimiter(30, 60)
let reconciliationInFlight: Promise<void> | null = null
const SOLANA_FEE_RESERVE_SOL = 0.01
const PREFLIGHT_CACHE_TTL_MS = 5_000
const preflightResponseCache = new Map<string, { expiresAt: number; value: unknown }>()

function reconcileOnce(): Promise<void> {
  if (!reconciliationInFlight) {
    reconciliationInFlight = Promise.all([
      reconcilePendingDemoBudget(),
    ]).then(() => undefined).finally(() => {
      reconciliationInFlight = null
    })
  }
  return reconciliationInFlight
}

export async function GET(req: NextRequest) {
  const operatorProbeTenant = req.headers.get('x-aura-operator-tenant')?.trim() || ''
  const operatorProbeCapability = req.headers.get('x-aura-jury-capability')?.trim() || ''
  const probeJurySession = getJurySessionInfo(req.cookies.get('aura_jury_session')?.value || '')
  const operatorProbeAuthorized = Boolean(
    /^[a-zA-Z0-9._-]{1,128}$/.test(operatorProbeTenant) &&
    getJuryTenantPool().includes(operatorProbeTenant) &&
    ((probeJurySession?.tenantId === operatorProbeTenant) || (
      process.env.AURA_DEMO_JURY_CAPABILITY?.trim() &&
      operatorProbeCapability === process.env.AURA_DEMO_JURY_CAPABILITY.trim()
    )),
  )
  const identifier = getTrustedClientId(req.headers)
  if (!operatorProbeAuthorized) {
    const globalRate = persistentStore.checkSharedRateLimit('preflight-global', 'global', 30, 60)
      || globalPreflightLimiter.check('global')
    if (!globalRate.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMITED' }, {
        status: 429,
        headers: { 'Retry-After': String(globalRate.retryAfter || 60) },
      })
    }
    const rate = persistentStore.checkSharedRateLimit('preflight-client', identifier, 6, 60)
      || preflightLimiter.check(identifier)
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMITED' }, {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfter || 60) },
      })
    }
  }
  const startTime = Date.now()
  const jurySession = probeJurySession
  const juryAuthorized = jurySession !== null
  const configuredJuryCapability = process.env.AURA_DEMO_JURY_CAPABILITY?.trim() || ''
  const operatorCapability = req.headers.get('x-aura-jury-capability')?.trim() || ''
  const operatorTenantHeader = req.headers.get('x-aura-operator-tenant')?.trim() || ''
  const operatorTenantId = /^[a-zA-Z0-9._-]{1,128}$/.test(operatorTenantHeader) ? operatorTenantHeader : undefined
  const operatorAuthorized = Boolean(
    operatorTenantId &&
    getJuryTenantPool().includes(operatorTenantId) &&
    ((jurySession?.tenantId === operatorTenantId) || (configuredJuryCapability && operatorCapability === configuredJuryCapability)),
  )
  if (operatorTenantHeader && (!operatorAuthorized || !operatorTenantId)) {
    return NextResponse.json({ success: false, error: 'OPERATOR_TENANT_ACCESS_REQUIRED' }, { status: 403 })
  }
  const requestedTenant = req.headers.get('x-aura-enclave-fingerprint')?.trim() || ''
  const headerTenantId = /^[a-zA-Z0-9._-]{1,128}$/.test(requestedTenant) ? requestedTenant : undefined
  const tenantId = headerTenantId || operatorTenantId || jurySession?.tenantId
  // The signed jury cookie is authoritative for this read-only health check.
  // A stale browser fingerprint must not hide the assigned tenant's readiness.
  const authTimestamp = Number(req.headers.get('x-aura-auth-timestamp'))
  const authNonce = req.headers.get('x-aura-auth-nonce') || ''
  const authPublicKey = req.headers.get('x-aura-auth-public-key') || ''
  const authSignature = req.headers.get('x-aura-auth-signature') || ''
  if (requestedTenant && (
    !tenantId || !Number.isSafeInteger(authTimestamp) || Math.abs(Date.now() - authTimestamp) > 2 * 60 * 1000 ||
    !/^[a-f0-9]{32}$/i.test(authNonce) || !authPublicKey || !authSignature
  )) {
    return NextResponse.json({ success: false, error: 'AUTHORIZATION_REQUIRED' }, { status: 401 })
  }
  // A server-signed jury session may read its assigned tenant's preflight
  // directly. Browser clients still send the enclave signature for all
  // mutating flows; this exception only removes a reviewer-facing read-only
  // friction point from the preflight endpoint.
  if (headerTenantId) {
    const signedPayload = `${headerTenantId}:read_preflight:${authTimestamp}:${authNonce}`
    if (!verifyClientEcdsaSignature(authPublicKey, signedPayload, authSignature)) {
      return NextResponse.json({ success: false, error: 'INVALID_AUTHORIZATION' }, { status: 401 })
    }
    if (!persistentStore.claimAuthNonce(headerTenantId, 'preflight', authNonce, 2 * 60 * 1000)) {
      return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
    }
    if (!persistentStore.verifySpendSigningKey(headerTenantId, authPublicKey)) {
      return NextResponse.json({ success: false, error: 'SIGNING_KEY_MISMATCH' }, { status: 401 })
    }
  }
  const requestedAmountRaw = req.nextUrl.searchParams.get('amountUsd')
  const requestedAmountUsd = requestedAmountRaw === null ? null : Number(requestedAmountRaw)
  const demoMode = req.nextUrl.searchParams.get('demo') === 'quick' ? 'quick' : 'fresh'
  // Quick Demo uses the already-confirmed jury inventory. If the caller does
  // not specify a policy, keep this read aligned with that demo instead of
  // silently falling back to the 24-hour private subset and reporting $0.
  const requestedBufferRaw = req.nextUrl.searchParams.get('bufferMode') || (demoMode === 'quick' ? 'fast' : 'private')
  const bufferMode = requestedBufferRaw === 'fast' || requestedBufferRaw === 'strong' || requestedBufferRaw === 'custom'
    ? requestedBufferRaw
    : 'private'
  const minimumConfirmations = getMinimumConfirmationsForBuffer(bufferMode)
  const amountRequestValid = requestedAmountRaw === null || (
    requestedAmountUsd !== null && Number.isFinite(requestedAmountUsd) && requestedAmountUsd > 0 && requestedAmountUsd <= 1_000_000
  )
  const privilegedTenantRead = juryAuthorized || operatorAuthorized
  const cacheControl = tenantId || privilegedTenantRead
    ? 'private, max-age=5'
    : 'public, max-age=5, s-maxage=5, stale-while-revalidate=15'
  const cacheKey = `${tenantId || jurySession?.tenantId || 'shared'}:${requestedAmountRaw || 'none'}:${bufferMode}:${privilegedTenantRead ? 'jury' : 'public'}`
  const cached = preflightResponseCache.get(cacheKey)
  const durableCached = persistentStore.getSharedCache<unknown>('preflight-response', cacheKey, PREFLIGHT_CACHE_TTL_MS)
  const cachedValue = cached && cached.expiresAt > Date.now() ? cached.value : durableCached
  if (cachedValue) {
    return NextResponse.json(cachedValue, {
      headers: {
        'Cache-Control': cacheControl,
        'Referrer-Policy': 'no-referrer',
        'X-Aura-Preflight-Cache': 'hit',
      },
    })
  }
  if (cached) preflightResponseCache.delete(cacheKey)
  // Unauthenticated public probes never trigger chain/RPC work. They receive
  // only a coarse degraded snapshot until a jury/operator session has warmed
  // the shared health snapshot; this removes the expensive public DoS path.
  if (!tenantId && !privilegedTenantRead) {
    const publicFallback = {
      success: true,
      timestamp: Date.now(),
      durationMs: 0,
      allReady: false,
      readyForRequestedRun: false,
      readyForFreshDemo: false,
      readyForQuickDemo: false,
      demoMode,
      scope: 'shared-relayer' as const,
      requestedAmountUsd,
      bufferMode,
      payoutAmountUsd: requestedAmountUsd === null ? null : Math.min(requestedAmountUsd, DEMO_PAYOUT_AMOUNT_USD),
      baseAmountReady: false,
      amountReady: false,
      readyForAddMoney: false,
      tenantPayReady: false,
      privacyScenarioReady: false,
      demoPayMode: 'mature-balance-required' as const,
      tenantBalance: null,
      checks: {
        baseSepolia: { status: 'degraded' as const, network: 'Base Sepolia Testnet (EVM)' },
        zcashTestnet: { status: 'degraded' as const, network: 'Zcash Testnet (NU6.3 / Ironwood)' },
        solanaDevnet: { status: 'degraded' as const, network: 'Solana Devnet (SVM)' },
        settlementRates: { status: 'degraded' as const },
        routingArchitecture: { status: 'degraded' as const },
      },
    }
    preflightResponseCache.set(cacheKey, { expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS, value: publicFallback })
    persistentStore.setSharedCache('preflight-response', cacheKey, publicFallback, PREFLIGHT_CACHE_TTL_MS)
    return NextResponse.json(publicFallback, {
      headers: {
        'Cache-Control': cacheControl,
        'Referrer-Policy': 'no-referrer',
        'X-Aura-Preflight-Cache': 'miss-public-coarse',
      },
    })
  }
  // Do not create a Zcash account merely because an unauthenticated caller
  // supplied a tenant label. A tenant is active only after its recovery
  // authority or existing spend authority is durably registered.
  const activeTenantId = tenantId && (
    persistentStore.getRecoveryKey(tenantId) || persistentStore.getSpendSigningKey(tenantId)
  ) ? tenantId : undefined

  // A restart or an interrupted read can leave a real, already-mined Zcash
  // spend marked as `broadcasting`. That stale state must not make Fast
  // balance look like zero forever. Reconcile only exact persisted txids and
  // only promote them after the chain confirms them; never infer a balance.
  let activeTenantTransactions: AuraTransaction[] = activeTenantId
    ? ledgerService.getTransactions(activeTenantId)
    : []
  if (activeTenantId) {
    const applyReconciliation = (transactionId: string, updates: Partial<AuraTransaction>) => {
      activeTenantTransactions = activeTenantTransactions.map((transaction) =>
        transaction.id === transactionId ? { ...transaction, ...updates } : transaction,
      )
      if (!operatorAuthorized) {
        ledgerService.updateTransaction(transactionId, updates, activeTenantId)
      }
    }

    for (const transaction of activeTenantTransactions) {
      const shieldedTxid = transaction.legs?.shielded?.txHash || ''
      if (
        (transaction.type === 'deposit' || transaction.type === 'receive') &&
        transaction.status !== 'completed' &&
        transaction.legs?.shielded?.status !== 'confirmed' &&
        /^[a-f0-9]{64}$/i.test(shieldedTxid)
      ) {
        const confirmation = await zcashDevtoolService.verifyConfirmation(shieldedTxid).catch(() => null)
        if (confirmation?.confirmed) {
          const balanceBeforeUsd = operatorAuthorized
            ? undefined
            : ledgerService.getTenantBalance(activeTenantId).totalUsd
          const balanceAfterUsd = balanceBeforeUsd === undefined
            ? undefined
            : Number((balanceBeforeUsd + transaction.toAmount).toFixed(2))
          applyReconciliation(transaction.id, {
            status: 'completed',
            completedAt: transaction.completedAt || Date.now(),
            ...(transaction.balanceCheckpoint || balanceBeforeUsd === undefined || balanceAfterUsd === undefined
              ? {}
              : {
                balanceCheckpoint: {
                  beforeUsd: balanceBeforeUsd,
                  afterUsd: balanceAfterUsd,
                  deltaUsd: transaction.toAmount,
                  capturedAt: Date.now(),
                },
              }),
            legs: {
              ...transaction.legs,
              shielded: {
                ...transaction.legs.shielded,
                chain: transaction.legs.shielded?.chain || 'zcash',
                status: 'confirmed',
                confirmationStatus: 'confirmed',
                description: `Shielded deposit confirmed on Zcash Testnet (Block #${confirmation.blockHeight || 'testnet'}, Tx #${shieldedTxid.slice(0, 16)}...).`,
              },
            },
          })
        }
      }
      if (
        transaction.type !== 'send' && transaction.type !== 'withdraw' ||
        transaction.legs?.shielded?.status === 'confirmed' ||
        !/^[a-f0-9]{64}$/i.test(shieldedTxid)
      ) continue
      const confirmation = await zcashDevtoolService.verifyConfirmation(shieldedTxid).catch(() => null)
      if (!confirmation?.confirmed) continue
      let deliveryFinalized = false
      let delivery = transaction.legs?.delivery
      if (transaction.toChain === 'solana' && delivery?.txHash) {
        const deliveryStatus = await solanaRelayer.getSignatureStatus(delivery.txHash).catch(() => null)
        deliveryFinalized = isFinalizedSolanaSignatureStatus(deliveryStatus)
        if (deliveryFinalized) {
          delivery = {
            ...delivery,
            status: 'confirmed',
            confirmationStatus: 'finalized',
            description: 'Solana payout finalized after exact Zcash spend reconciliation.',
          }
        }
      } else if (transaction.toChain !== 'solana') {
        deliveryFinalized = true
      }
      applyReconciliation(transaction.id, {
        status: deliveryFinalized ? 'completed' : 'routing_shielded',
        completedAt: deliveryFinalized ? (transaction.completedAt || Date.now()) : undefined,
        legs: {
          ...transaction.legs,
          shielded: {
            ...transaction.legs.shielded,
            chain: transaction.legs.shielded?.chain || 'zcash',
            status: 'confirmed',
            description: `Shielded transaction confirmed on Zcash Testnet (Block #${confirmation.blockHeight || 'testnet'}, Tx #${shieldedTxid.slice(0, 16)}...).`,
          },
          delivery,
        },
      })
    }
  }

  // 1. BASE SEPOLIA TESTNET AUDIT
  const baseStart = Date.now()
  let baseBlock: number | null = null
  let baseUsdc: number | null = null
  let baseEth: number | null = null
  let baseRpcOk = false

  try {
    const [blockResult, rpcChainId, balances] = await Promise.all([
      fetchRpcResultAcrossPool<string>(BASE_SEPOLIA_RPCS, {
        jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [],
      }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)).then(({ result }) => result),
      baseRelayer.getRpcChainId(),
      baseRelayer.getBalances(),
    ])
    if (/^0x[0-9a-f]+$/i.test(String(blockResult || '')) && isBaseSepoliaChainId(rpcChainId)) {
      baseBlock = parseInt(String(blockResult), 16)
      baseRpcOk = Number.isSafeInteger(baseBlock)
    }
    baseEth = balances.ethBalance
    baseUsdc = balances.usdcBalance
  } catch (err) {
    console.warn('Base Sepolia preflight ping error', err)
    baseRpcOk = false
  }
  const baseLatency = Date.now() - baseStart

  // 2. ZCASH TESTNET VAULT AUDIT
  const zcashStart = Date.now()
  let zcashUnifiedAddr = ''
  let zcashShieldedZec: number | null = null
  let zcashSpendableZec: number | null = null
  let zcashTotalSpendableZec: number | null = null
  let zcashSynced = false
  let zcashChainHeight: number | undefined
  let tenantShieldedZec: number | null = null
  let tenantSpendableZec: number | null = null
  let tenantPolicyEligibleZec: number | null = null
  let tenantBalanceAvailable = false
  let tenantAccountId: string | undefined
  const sharedJuryZcashSource = usesSharedJuryZcashSource(activeTenantId)
  const sharedJuryAllocatedUsd = sharedJuryZcashSource
    ? getSharedJuryEntitlementUsd(ledgerService, persistentStore.listPendingOperations())
    : null
  const zcashBinaryAvailable = zcashDevtoolService.isAvailable()

  try {
    const sync = await zcashDevtoolService.sync()
    if (!sync.success) throw new Error('The Zcash testnet wallet could not sync.')
    const tenantAccount = activeTenantId
      ? (sharedJuryZcashSource
        ? await zcashDevtoolService.getSharedSourceAccount().catch(() => null)
        : await zcashDevtoolService.ensureTenantAccount(activeTenantId).catch(() => null))
      : null
    tenantAccountId = tenantAccount?.accountId
    if (activeTenantId && !tenantAccount) {
      throw new Error('The authenticated tenant Zcash account is unavailable.')
    }
    const addresses = tenantAccount
      ? { unified: tenantAccount.unified }
      : await zcashDevtoolService.listAddresses().catch(() => ({ unified: undefined }))
    if (addresses?.unified) {
      zcashUnifiedAddr = addresses.unified
    }
    // The relayer's default account supplies each new deposit. A tenant's
    // existing account balance is separate and must never stand in for this
    // source reserve when estimating complete demo-run capacity.
    const sourceBalance = await zcashDevtoolService.getBalance().catch(() => null)
    if (sourceBalance?.available && sourceBalance.chainHeight !== undefined) {
      zcashShieldedZec = getShieldedSpendableZec(sourceBalance)
      // Transparent funds are deliberately excluded from the PCZT sender's
      // spendable amount. Readiness must match the exact spend policy.
      zcashSpendableZec = zcashShieldedZec
      zcashTotalSpendableZec = sourceBalance.totalSpendable
      zcashChainHeight = sourceBalance.chainHeight
      zcashSynced = true
    }
    if (tenantAccount) {
      const tenantBalance = await zcashDevtoolService.getBalance(tenantAccount.accountId).catch(() => null)
      const tenantPolicyBalance = await zcashDevtoolService.getBalance(
        tenantAccount.accountId,
        minimumConfirmations,
      ).catch(() => null)
      if (tenantBalance?.available && tenantBalance.chainHeight !== undefined) {
        tenantShieldedZec = getShieldedSpendableZec(tenantBalance)
        tenantSpendableZec = tenantShieldedZec
      }
      if (tenantPolicyBalance?.available && tenantPolicyBalance.chainHeight !== undefined) {
        tenantPolicyEligibleZec = getShieldedSpendableZec(tenantPolicyBalance)
      }
      tenantBalanceAvailable = tenantSpendableZec !== null && tenantPolicyEligibleZec !== null
    }
  } catch (err) {
    console.warn('Zcash testnet preflight check', err)
  }
  const zcashLatency = Date.now() - zcashStart

  // 3. SOLANA DEVNET RELAYER AUDIT
  const solStart = Date.now()
  const solPubkey = solanaRelayer.getPublicKey() || ''
  const solanaDemoRecipient = solanaRelayer.getDemoRecipientPublicKey() || ''
  const solanaDemoRecipientReady = Boolean(solanaDemoRecipient && solanaDemoRecipient !== solPubkey)
  let solBalance: number | null = null
  let solRpcOk = false

  try {
    const fetchedBal = await solanaRelayer.getBalance().catch(() => null)
    if (fetchedBal !== null && !isNaN(fetchedBal)) {
      solBalance = fetchedBal
      solRpcOk = true
    }
  } catch (err) {
    console.warn('Solana Devnet preflight check', err)
  }
  const solLatency = Date.now() - solStart

  // A funded chain is not enough: deposit/spend pricing fails closed unless
  // the rates used for the Zcash leg and Solana output are fresh.
  const ratesStart = Date.now()
  const [zecRate, solRate] = await Promise.all([
    ratesService.getFreshRate('ZEC'),
    ratesService.getFreshRate('SOL'),
  ])
  const ratesReady = Boolean(zecRate && solRate)
  const ratesLatency = Date.now() - ratesStart

  const baseKeyConfigured = baseRelayer.hasConfiguredKey()
  const solanaKeyConfigured = solanaRelayer.hasConfiguredKey()
  const baseReady = baseRpcOk && baseKeyConfigured && baseEth !== null && baseEth > 0.0001 && baseUsdc !== null && baseUsdc > 0
  const shieldedPoolReady = zcashSynced && zcashShieldedZec !== null && zcashSpendableZec !== null && zcashShieldedZec >= ZCASH_FEE_RESERVE_ZEC && zcashSpendableZec >= ZCASH_FEE_RESERVE_ZEC
  const zcashReady = zcashBinaryAvailable && zcashSynced && !!zcashUnifiedAddr && shieldedPoolReady &&
    (!activeTenantId || tenantBalanceAvailable)
  const solanaReady = solRpcOk && solanaKeyConfigured && solanaDemoRecipientReady && solBalance !== null && solBalance >= SOLANA_FEE_RESERVE_SOL
  const requiredZec = amountRequestValid && requestedAmountUsd !== null && zecRate
    ? Number((requestedAmountUsd / zecRate.usdPrice).toFixed(6))
    : null
  // This check is for the new Base -> Zcash shielding leg. Its sender is the
  // shared demo relayer, even when the read is scoped to a jury tenant. Using
  // the tenant account here made Fresh readiness depend on the wrong wallet
  // and reported `amountReady: false` despite a funded source relayer.
  const actualFeeZec = requiredZec !== null && zcashUnifiedAddr
    ? await zcashDevtoolService.estimateShieldedFeeZec(undefined, zcashUnifiedAddr, requiredZec, minimumConfirmations).catch(() => null)
    : null
  const feeReserveForRequest = actualFeeZec ?? ZCASH_FEE_RESERVE_ZEC
  const sharedJurySourceCapacityUsd = sharedJuryZcashSource && zcashSpendableZec !== null && zecRate
    ? Math.max(0, zcashSpendableZec - ZCASH_FEE_RESERVE_ZEC) * zecRate.usdPrice
    : null
  const sharedJuryAvailableCapacityUsd = sharedJuryZcashSource
    ? getSharedJuryAvailableCapacityUsd(sharedJurySourceCapacityUsd, sharedJuryAllocatedUsd)
    : null
  const sharedJuryAllocationReady = !sharedJuryZcashSource || canAllocateSharedJuryDeposit(
    sharedJurySourceCapacityUsd,
    sharedJuryAllocatedUsd,
    requestedAmountUsd,
  )
  const requiredZecWithFee = requiredZec === null ? null : Number((requiredZec + feeReserveForRequest).toFixed(8))
  const payoutAmountUsd = requestedAmountUsd === null ? null : Math.min(requestedAmountUsd, DEMO_PAYOUT_AMOUNT_USD)
  const requiredSol = amountRequestValid && payoutAmountUsd !== null && solRate
    ? Number((payoutAmountUsd / solRate.usdPrice).toFixed(5))
    : null
  const requiredSolWithFee = requiredSol === null ? null : Number((requiredSol + SOLANA_FEE_RESERVE_SOL).toFixed(5))
  const requiredBaseUsdc = amountRequestValid && requestedAmountUsd !== null
    ? requestedAmountUsd
    : null
  const baseAmountReady = amountRequestValid && (
    requiredBaseUsdc === null || (baseUsdc !== null && baseUsdc >= requiredBaseUsdc)
  )
  const amountReady = amountRequestValid && (
    requestedAmountUsd === null ||
      (requiredZecWithFee !== null && actualFeeZec !== null && requiredSolWithFee !== null && baseAmountReady &&
      zcashSpendableZec !== null && solBalance !== null && zcashSpendableZec >= requiredZecWithFee && solBalance >= requiredSolWithFee && sharedJuryAllocationReady)
  )
  // A live relayer can be fully funded while a newly authenticated jury
  // tenant still has no mature balance. The jury flow must not turn a fresh
  // deposit into an immediate public exit just to make the demo convenient.
  let tenantPrivateReadyUsd: number | null = null
  let tenantFastAvailableUsd: number | null = null
  let tenantPayReady = Boolean(activeTenantId)
  let privacyScenarioReady = false
  let privacyRiskCodes: string[] = []
  let privacyScenarioHasFunding = false
  let privacyScenarioSource: 'active-tenant' | null = null
  if (activeTenantId && tenantSpendableZec !== null && tenantPolicyEligibleZec !== null && zecRate) {
    const tenantFeeReserveZec = actualFeeZec ?? ZCASH_FEE_RESERVE_ZEC
    const tenantChainZec = Math.max(0, tenantSpendableZec - tenantFeeReserveZec)
    const tenantPolicyChainZec = Math.max(0, tenantPolicyEligibleZec - tenantFeeReserveZec)
    const tenantChainUsd = Number((tenantChainZec * zecRate.usdPrice).toFixed(2))
    const tenantLedger = ledgerService.getTenantBalance(activeTenantId)
    const maxEntitlementUsd = sharedJuryZcashSource ? tenantLedger.totalUsd : null
    const tenantReconciled = reconcileLedgerBalanceWithShieldedChain(
      tenantLedger,
      tenantChainUsd,
      tenantChainZec,
      zecRate.usdPrice,
      tenantPolicyChainZec,
      maxEntitlementUsd,
    )
    tenantPrivateReadyUsd = tenantReconciled.readyToSpendUsd
    tenantFastAvailableUsd = tenantReconciled.fastAvailableToSendUsd
    const policyReadyUsd = bufferMode === 'fast'
      ? tenantFastAvailableUsd
      : tenantPrivateReadyUsd
    tenantPayReady = payoutAmountUsd !== null && policyReadyUsd !== null && policyReadyUsd >= payoutAmountUsd
    const privacyRisk = calculatePrivacyRiskSnapshot({
      transactions: activeTenantTransactions,
      totalBalanceUsd: tenantReconciled.totalUsd,
      amountUsd: payoutAmountUsd ?? DEMO_PAYOUT_AMOUNT_USD,
      policy: bufferMode,
      zecUsd: zecRate.usdPrice,
    })
    privacyRiskCodes = privacyRisk.riskCodes
    privacyScenarioHasFunding = activeTenantTransactions.some((transaction) =>
      (transaction.type === 'deposit' || transaction.type === 'receive') && transaction.status === 'completed',
    )
    if (privacyRiskCodes.length > 0 && privacyScenarioHasFunding) {
      privacyScenarioSource = 'active-tenant'
    }
    // Quick Demo is deterministic only when it can show a real correlation
    // signal from confirmed funding history of the active tenant.
    privacyScenarioReady = tenantPayReady && privacyScenarioHasFunding && privacyRiskCodes.length > 0 && privacyScenarioSource === 'active-tenant'
  }
  const demoRequiredZecPerRun = zecRate
    ? Number((DEMO_DEPOSIT_AMOUNT_USD / zecRate.usdPrice + ZCASH_FEE_RESERVE_ZEC).toFixed(8))
    : null
  const demoRequiredSolPerRun = solRate
    ? Number((DEMO_PAYOUT_AMOUNT_USD / solRate.usdPrice + SOLANA_FEE_RESERVE_SOL).toFixed(5))
    : null
  const demoRunsByBase = baseUsdc === null ? 0 : Math.floor(baseUsdc / DEMO_DEPOSIT_AMOUNT_USD)
  const demoRunsByZcash = zcashSpendableZec === null || demoRequiredZecPerRun === null
    ? 0
    : Math.floor(zcashSpendableZec / demoRequiredZecPerRun)
  const demoRunsBySolana = solBalance === null || demoRequiredSolPerRun === null
    ? 0
    : Math.floor(solBalance / demoRequiredSolPerRun)
  // Capacity must use the same policy that gates this request. Quick Demo
  // intentionally uses the already-confirmed fast balance; Fresh Demo uses
  // the private maturity buffer. Reporting private capacity for a fast Quick
  // request made a funded jury tenant look like it had zero demo runs left.
  const tenantReadyRunsUsd = bufferMode === 'fast' ? tenantFastAvailableUsd : tenantPrivateReadyUsd
  const tenantMatureRuns = tenantReadyRunsUsd === null
    ? 0
    : Math.floor(tenantReadyRunsUsd / DEMO_PAYOUT_AMOUNT_USD)
  const quickRunsAvailable = Math.max(0, Math.min(tenantMatureRuns, demoRunsBySolana))
  const demoRunsAvailable = Math.max(0, Math.min(demoRunsByBase, demoRunsByZcash, demoRunsBySolana, tenantMatureRuns))
  const readyForThreeFullDemoRuns = demoRunsAvailable >= DEMO_RUN_TARGET
  const infrastructureReady = baseReady && zcashReady && solanaReady && ratesReady
  // The current custody, storage, and Zcash engine are explicitly demo-only.
  // Even if every testnet RPC is healthy, production must never advertise a
  // runnable flow until the production boundary has been replaced.
  const executionBoundaryReady = productionBoundary.demoReady && runtimeStorage.readyForExecution
  const readyForAddMoney = executionBoundaryReady && infrastructureReady && amountReady
  // Fresh Add Money has its own gate. It proves the new Base entry can be
  // started and carried through the live testnet route; it must not depend on
  // an already-mature tenant balance that is only needed for Quick Pay.
  const readyForFreshDemo = readyForAddMoney && requestedAmountUsd !== null && requestedAmountUsd >= DEMO_DEPOSIT_AMOUNT_USD
  const readyForRequestedRun = readyForAddMoney && requestedAmountUsd !== null && tenantPayReady
  const readyForQuickDemo = executionBoundaryReady && zcashReady && solanaReady && ratesReady && tenantPayReady && privacyScenarioReady
  const allReady = demoMode === 'quick'
    ? readyForQuickDemo
    : readyForAddMoney && (requestedAmountUsd !== null || readyForThreeFullDemoRuns) && tenantPayReady

  const detailedResponse = {
    success: true,
    timestamp: Date.now(),
    durationMs: Date.now() - startTime,
    allReady,
    readyForRequestedRun,
    readyForFreshDemo,
    readyForQuickDemo,
    privacyScenarioReady,
    privacyScenario: {
      status: privacyScenarioReady ? 'ready' : 'missing-warning-pattern',
      hasConfirmedFunding: privacyScenarioHasFunding,
      warningCodes: privacyRiskCodes,
      source: privacyScenarioSource,
    },
    demoMode,
    scope: activeTenantId ? 'active-tenant' : 'shared-relayer',
    tenantId: activeTenantId || null,
    requestedAmountUsd,
    bufferMode,
    payoutAmountUsd,
    requiredBaseUsdc,
    requiredZec,
    requiredZecWithFee,
    requiredSol,
    requiredSolWithFee,
    baseAmountReady,
    amountReady,
      sharedJuryInventory: sharedJuryZcashSource ? {
        sourceCapacityUsd: sharedJurySourceCapacityUsd,
        allocatedUsd: sharedJuryAllocatedUsd,
        availableCapacityUsd: sharedJuryAvailableCapacityUsd,
        allocationReady: sharedJuryAllocationReady,
      } : null,
    readyForAddMoney,
    tenantPayReady,
    demoPayMode: activeTenantId && tenantPayReady ? 'selected-policy' : 'mature-balance-required',
    tenantBalance: activeTenantId ? {
      policy: bufferMode,
      minimumConfirmations,
      privateReadyUsd: tenantPrivateReadyUsd,
      fastAvailableUsd: tenantFastAvailableUsd,
      requiredPayoutUsd: payoutAmountUsd,
      privateReadyForPayout: tenantPrivateReadyUsd !== null && payoutAmountUsd !== null && tenantPrivateReadyUsd >= payoutAmountUsd,
      fastReadyForPayout: tenantFastAvailableUsd !== null && payoutAmountUsd !== null && tenantFastAvailableUsd >= payoutAmountUsd,
    } : null,
      demoCapacity: {
        status: readyForThreeFullDemoRuns ? 'ready' : 'insufficient',
        readyForThreeFullDemoRuns,
        runsAvailable: demoRunsAvailable,
        tenantMatureRuns,
        quickRunsAvailable,
        targetRuns: DEMO_RUN_TARGET,
        perRun: {
          depositUsd: DEMO_DEPOSIT_AMOUNT_USD,
          payoutUsd: DEMO_PAYOUT_AMOUNT_USD,
          requiredZecWithFee: demoRequiredZecPerRun,
          requiredSolWithFee: demoRequiredSolPerRun,
        },
        limitingResources: {
          baseRuns: demoRunsByBase,
          zcashRuns: demoRunsByZcash,
          solanaRuns: demoRunsBySolana,
          tenantMatureRuns,
        },
      },
      checks: {
      baseSepolia: {
        status: baseReady ? 'ready' : 'warning',
        rpcAvailable: baseRpcOk,
        network: 'Base Sepolia Testnet (EVM)',
        // Publish only the host; a configured RPC URL may contain an API key.
        rpc: BASE_SEPOLIA_RPC_HOST,
        blockNumber: baseBlock,
        latencyMs: baseLatency,
        demoWallet: {
          address: DEMO_WALLET_ADDRESS,
          relayerKeyConfigured: baseKeyConfigured,
          usdcBalance: baseUsdc,
          ethBalance: baseEth,
          hasFunds: baseUsdc !== null && baseUsdc > 0,
          hasGas: baseEth !== null && baseEth > 0.0001,
          explorerUrl: `https://sepolia.basescan.org/address/${DEMO_WALLET_ADDRESS}`,
        },
      },
      zcashTestnet: {
        status: zcashReady ? 'ready' : 'warning',
        network: 'Zcash Testnet (NU6.3 / Ironwood)',
        server: 'testnet.zec.rocks:443',
        binaryAvailable: zcashBinaryAvailable,
        unifiedAddress: activeTenantId ? zcashUnifiedAddr : undefined,
        chainHeight: zcashChainHeight,
        shieldedPoolReady,
        balanceScope: activeTenantId ? 'active-tenant' : 'shared-relayer',
        balanceSource: activeTenantId
          ? (sharedJuryZcashSource ? 'shared-jury-source' : 'tenant-isolated-source')
          : 'shared-relayer',
        balanceAvailable: activeTenantId ? tenantBalanceAvailable : zcashSynced,
        shieldedBalanceZec: activeTenantId ? tenantShieldedZec : null,
        spendableBalanceZec: activeTenantId ? tenantSpendableZec : null,
        policyEligibleBalanceZec: activeTenantId ? tenantPolicyEligibleZec : null,
        policyMinimumConfirmations: activeTenantId ? minimumConfirmations : null,
        totalSpendableZec: activeTenantId && tenantBalanceAvailable ? tenantSpendableZec : null,
        sourceBalanceAvailable: zcashSynced,
        sourceSpendableZec: zcashSpendableZec,
        sourceTotalSpendableZec: zcashTotalSpendableZec,
        feeReserveZec: ZCASH_FEE_RESERVE_ZEC,
        latencyMs: zcashLatency,
        explorerUrl: zcashUnifiedAddr ? `https://testnet.zcashblockexplorer.com/address/${zcashUnifiedAddr}` : undefined,
      },
      solanaDevnet: {
        status: solanaReady ? 'ready' : 'warning',
        rpcAvailable: solRpcOk,
        network: 'Solana Devnet (SVM)',
        rpc: SOLANA_DEVNET_RPC_HOST,
        relayerPublicKey: solPubkey,
        relayerKeyConfigured: solanaKeyConfigured,
        demoRecipientPublicKey: solanaDemoRecipient || null,
        demoRecipientReady: solanaDemoRecipientReady,
        solBalance: solRpcOk ? solBalance : null,
        hasGas: solRpcOk && solBalance !== null && solBalance >= SOLANA_FEE_RESERVE_SOL,
        requiredSol: activeTenantId ? requiredSol : null,
        requiredSolWithFee: activeTenantId ? requiredSolWithFee : null,
        hasGasForRequestedAmount: activeTenantId && requiredSolWithFee !== null
          ? solRpcOk && solBalance !== null && solBalance >= requiredSolWithFee
          : solRpcOk && solBalance !== null && solBalance >= SOLANA_FEE_RESERVE_SOL,
        latencyMs: solLatency,
        explorerUrl: `https://solscan.io/account/${solPubkey}?cluster=devnet`,
      },
      settlementRates: {
        status: ratesReady ? 'ready' : 'warning',
        zecUsd: zecRate?.usdPrice ?? null,
        solUsd: solRate?.usdPrice ?? null,
        lastUpdated: zecRate && solRate
          ? Math.min(zecRate.lastUpdated, solRate.lastUpdated)
          : null,
        latencyMs: ratesLatency,
      },
      routingArchitecture: {
        status: allReady ? 'ready' : 'degraded',
        demoRoutingLayer: 'AURA TEST ROUTE (Testnet Orchestration)',
        productionArchitecture: 'NEAR Confidential Intents (future routing/execution layer)',
        privacyEngine: activeTenantId && sharedJuryZcashSource
          ? 'AURA-operated pre-funded Zcash Testnet jury inventory + tenant-scoped server ledger and authorization; per-user unlinkability is not verified'
          : 'AURA-operated Zcash Testnet private state + server-side demo ledger and tenant-scoped authorization; per-user unlinkability is not verified',
        productionBoundary,
        runtimeStorage,
      },
    },
  }
  // A public health check needs only state, not treasury intelligence. Exact
  // balances, addresses, capacity, and policy amounts are reserved for the
  // short-lived jury/operator session.
  const publicResponseBody = {
    success: detailedResponse.success,
    timestamp: detailedResponse.timestamp,
    durationMs: detailedResponse.durationMs,
    allReady: detailedResponse.allReady,
    readyForRequestedRun: detailedResponse.readyForRequestedRun,
    readyForFreshDemo: detailedResponse.readyForFreshDemo,
    readyForQuickDemo: detailedResponse.readyForQuickDemo,
    demoMode: detailedResponse.demoMode,
    scope: 'shared-relayer' as const,
    requestedAmountUsd: detailedResponse.requestedAmountUsd,
    bufferMode: detailedResponse.bufferMode,
    payoutAmountUsd: detailedResponse.payoutAmountUsd,
    baseAmountReady: detailedResponse.baseAmountReady,
    amountReady: detailedResponse.amountReady,
    readyForAddMoney: detailedResponse.readyForAddMoney,
    tenantPayReady: detailedResponse.tenantPayReady,
    privacyScenarioReady: detailedResponse.privacyScenarioReady,
    demoPayMode: detailedResponse.demoPayMode,
    tenantBalance: detailedResponse.tenantBalance ? {
      policy: detailedResponse.tenantBalance.policy,
      privateReadyForPayout: detailedResponse.tenantBalance.privateReadyForPayout,
      fastReadyForPayout: detailedResponse.tenantBalance.fastReadyForPayout,
    } : null,
    checks: {
      baseSepolia: { status: detailedResponse.checks.baseSepolia.status, network: detailedResponse.checks.baseSepolia.network },
      zcashTestnet: { status: detailedResponse.checks.zcashTestnet.status, network: detailedResponse.checks.zcashTestnet.network },
      solanaDevnet: { status: detailedResponse.checks.solanaDevnet.status, network: detailedResponse.checks.solanaDevnet.network },
      settlementRates: { status: detailedResponse.checks.settlementRates.status },
      routingArchitecture: { status: detailedResponse.checks.routingArchitecture.status },
    },
  }
  // A verified tenant-signed preflight is also authorized to receive its
  // tenant-scoped result. Previously only the jury cookie unlocked the
  // detailed body, so a recovered fresh-browser signer was reported as the
  // public shared-relayer scope even though the tenant balance was checked.
  const responseBody = privilegedTenantRead || Boolean(headerTenantId) ? detailedResponse : publicResponseBody
  preflightResponseCache.set(cacheKey, { expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS, value: responseBody })
  persistentStore.setSharedCache('preflight-response', cacheKey, responseBody, PREFLIGHT_CACHE_TTL_MS)
  if (privilegedTenantRead) {
    const publicCacheKey = `shared:${requestedAmountRaw || 'none'}:${bufferMode}:public`
    preflightResponseCache.set(publicCacheKey, { expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS, value: publicResponseBody })
    persistentStore.setSharedCache('preflight-response', publicCacheKey, publicResponseBody, PREFLIGHT_CACHE_TTL_MS)
  }
  return NextResponse.json(responseBody, {
    headers: {
      'Cache-Control': cacheControl,
      'Referrer-Policy': 'no-referrer',
      'X-Aura-Preflight-Cache': 'miss',
    },
  })
}
