import { NextRequest, NextResponse } from 'next/server'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { InMemoryRateLimiter } from '@/lib/utils/rate-limiter'
import { validateEvmAddress } from '@/lib/utils'
import { getDemoSessionClientId, getTrustedClientId, getJurySessionInfo, hasJuryAccess, verifyDemoSession } from '@/lib/services/demo-session-service'
import { persistentStore } from '@/lib/services/persistent-store'
import { reconcilePendingDemoBudget } from '@/lib/services/demo-budget-reconciler'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'

const globalDemoDepositLimiter = new InMemoryRateLimiter(5, 60)
const clientDemoDepositLimiter = new InMemoryRateLimiter(1, 300)

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('demo_deposit')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  if (!hasJuryAccess(req.headers, req.cookies.get('aura_jury_session')?.value || '')) {
    return NextResponse.json({ success: false, error: 'JURY_CAPABILITY_REQUIRED' }, { status: 403 })
  }
  // The demo session is intentionally HttpOnly. Never accept the signer token
  // through JSON, localStorage, or a client-controlled authorization header.
  const sessionToken = req.cookies.get('aura_demo_session')?.value || ''
  const clientId = getTrustedClientId(req.headers, { useClientFingerprint: false })
  if (!baseRelayer.hasConfiguredKey()) {
    return NextResponse.json(
      { success: false, error: 'DEMO_WALLET_NOT_READY', message: 'Try Demo cannot send test USDC right now. Connect your own Base Sepolia wallet instead.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const body = await req.json().catch(() => ({}))
  const amount = Number(body?.amount)
  const tenantId = typeof body?.tenantId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(body.tenantId)
    ? body.tenantId
    : ''
  if (!tenantId) {
    return NextResponse.json({ success: false, error: 'TENANT_REQUIRED' }, { status: 401 })
  }
  if (getJurySessionInfo(req.cookies.get('aura_jury_session')?.value || '')?.tenantId !== tenantId) {
    return NextResponse.json({ success: false, error: 'DEMO_TENANT_CHANGED', message: 'Your demo session changed. Refresh your Private Balance before adding money; no transfer was sent.' }, { status: 409 })
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    return NextResponse.json(
      { success: false, error: 'INVALID_DEMO_AMOUNT', message: 'Enter a valid transfer amount.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const senderAddress = baseRelayer.getAddress()
  const depositAddress = process.env.VAULT_DEPOSIT_ADDRESS || '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e'
  if (!validateEvmAddress(senderAddress) || !validateEvmAddress(depositAddress)) {
    return NextResponse.json(
      { success: false, error: 'DEMO_WALLET_CONFIGURATION_INVALID', message: 'Try Demo is not configured correctly; no transfer was sent.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  if (typeof body?.expectedAddress !== 'string' || body.expectedAddress.toLowerCase() !== senderAddress.toLowerCase()) {
    return NextResponse.json(
      { success: false, error: 'DEMO_WALLET_CHANGED', message: 'The demo wallet address changed. Refresh its balance before sending; no transfer was sent.' },
      { status: 409, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  if (!verifyDemoSession(sessionToken, senderAddress, clientId)) {
    return NextResponse.json(
      { success: false, error: 'DEMO_SESSION_REQUIRED', message: 'Refresh the demo wallet session before requesting a sponsored transfer.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const limiterClientId = getDemoSessionClientId(sessionToken)

  const clientLimit = clientDemoDepositLimiter.check(limiterClientId)
  if (!clientLimit.allowed) {
    return NextResponse.json(
      { success: false, error: 'DEMO_RATE_LIMITED', message: `Try Demo is temporarily limited. Retry in ${clientLimit.retryAfter} seconds.` },
      { status: 429, headers: { 'Retry-After': String(clientLimit.retryAfter || 300), 'Cache-Control': 'no-store' } },
    )
  }
  const globalLimit = globalDemoDepositLimiter.check('all')
  if (!globalLimit.allowed) {
    return NextResponse.json(
      { success: false, error: 'DEMO_RATE_LIMITED', message: `Try Demo is temporarily busy. Retry in ${globalLimit.retryAfter} seconds.` },
      { status: 429, headers: { 'Retry-After': String(globalLimit.retryAfter || 60), 'Cache-Control': 'no-store' } },
    )
  }

  const budgetLimit = Number(process.env.AURA_DEMO_GLOBAL_USDC_BUDGET || 10000)
  await reconcilePendingDemoBudget()
  if (!persistentStore.reserveDemoBudget(amount, Number.isFinite(budgetLimit) && budgetLimit > 0 ? budgetLimit : 10000)) {
    return NextResponse.json(
      { success: false, error: 'DEMO_BUDGET_EXHAUSTED', message: 'The shared demo sponsorship budget is exhausted. Use your own Base Sepolia wallet instead.' },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  let transfer
  let pendingHash: string | undefined
  try {
    transfer = await baseRelayer.sendUsdc(depositAddress, amount, ({ txHash, nonce, senderAddress: sender }) => {
      // Persist the predicted identity before the first RPC broadcast. A lost
      // response or process crash can then be reconciled without a second send.
      persistentStore.recordPendingDemoBudget(txHash, amount, nonce, sender)
      persistentStore.bindDemoDeposit(txHash, tenantId, amount, sender, limiterClientId)
      pendingHash = txHash
    })
  } catch (error) {
    if (pendingHash) {
      return NextResponse.json(
        { success: false, pending: true, error: 'DEMO_TRANSFER_UNCERTAIN', txHash: pendingHash, senderAddress,
          explorerUrl: `https://sepolia.basescan.org/tx/${pendingHash}`,
          message: 'The network result is unclear. The existing signed transfer will be reconciled before any retry.' },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    persistentStore.releaseDemoBudget(amount)
    throw error
  }
  if (transfer.broadcastUncertain && (transfer.txHash || pendingHash)) {
    const txHash = transfer.txHash || pendingHash!
    if (!pendingHash) {
      persistentStore.recordPendingDemoBudget(txHash, amount)
      persistentStore.bindDemoDeposit(txHash, tenantId, amount, senderAddress, limiterClientId)
    }
    return NextResponse.json(
      {
        success: false,
        pending: true,
        error: 'DEMO_TRANSFER_UNCERTAIN',
        txHash,
        senderAddress,
        explorerUrl: transfer.explorerUrl || `https://sepolia.basescan.org/tx/${txHash}`,
        message: 'The network response was unclear. Check this transaction before trying again; no second transfer was sent.',
      },
      { status: 202, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  if (!transfer.success || !transfer.txHash) {
    if (pendingHash) {
      return NextResponse.json(
        { success: false, pending: true, error: 'DEMO_TRANSFER_UNCERTAIN', txHash: pendingHash, senderAddress,
          explorerUrl: `https://sepolia.basescan.org/tx/${pendingHash}`,
          message: 'The signed transfer result is unclear. Its budget remains reserved until chain reconciliation.' },
        { status: 202, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    persistentStore.releaseDemoBudget(amount)
    return NextResponse.json(
      { success: false, error: transfer.error || 'DEMO_TRANSFER_FAILED', message: transfer.message || 'Try Demo could not send test USDC.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // A successful RPC response proves only that the transaction was accepted
  // for broadcast. Keep the reservation pending until the reconciler sees a
  // finalized receipt; otherwise a dropped or reverted transfer permanently
  // consumes the shared demo budget.
  if (!pendingHash) {
    persistentStore.recordPendingDemoBudget(transfer.txHash, amount)
    persistentStore.bindDemoDeposit(transfer.txHash, tenantId, amount, senderAddress, limiterClientId)
  }

  return NextResponse.json(
    {
      success: true,
      pending: true,
      finalized: false,
      txHash: transfer.txHash,
      senderAddress,
      explorerUrl: transfer.explorerUrl,
      network: 'Base Sepolia',
      amount,
    },
    { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  )
}
