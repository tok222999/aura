import { NextRequest, NextResponse } from 'next/server'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { solanaRelayer } from '@/lib/crypto/solana-relayer'
import { getTrustedClientId, getJurySessionInfo, hasJuryAccess, issueDemoSession } from '@/lib/services/demo-session-service'
import { reconcilePendingDemoBudget } from '@/lib/services/demo-budget-reconciler'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { persistentStore } from '@/lib/services/persistent-store'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('demo_wallet')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  if (!hasJuryAccess(req.headers, req.cookies.get('aura_jury_session')?.value || '')) {
    return NextResponse.json({ success: false, error: 'JURY_CAPABILITY_REQUIRED' }, { status: 403 })
  }
  const jurySession = getJurySessionInfo(req.cookies.get('aura_jury_session')?.value || '')
  const juryTenantId = jurySession?.tenantId || null
  if (!juryTenantId) {
    return NextResponse.json({ success: false, error: 'JURY_SESSION_REQUIRED' }, { status: 401 })
  }
  if (!persistentStore.getRecoveryKey(juryTenantId) || !persistentStore.getSpendSigningKey(juryTenantId)) {
    return NextResponse.json({ success: false, error: 'JURY_TENANT_NOT_READY' }, { status: 503 })
  }
  const clientId = getTrustedClientId(req.headers, { useClientFingerprint: false })
  await reconcilePendingDemoBudget()
  const address = baseRelayer.getAddress()
  let rpcAvailable = false
  let usdcBalance: number | null = null
  let ethBalance: number | null = null

  try {
    const [rpcReady, balances] = await Promise.all([
      baseRelayer.isBaseSepoliaRpcReady(),
      baseRelayer.getBalances(),
    ])
    rpcAvailable = rpcReady
    if (rpcAvailable) {
      usdcBalance = balances.usdcBalance
      ethBalance = balances.ethBalance
    }
  } catch {
    rpcAvailable = false
  }

  let solana: { publicKey: string; solBalance: number | null; network: string; explorerUrl: string }
  try {
    const publicKey = solanaRelayer.getPublicKey()
    const solBalance = await solanaRelayer.getBalance()
    solana = {
      publicKey,
      solBalance,
      network: 'Solana Devnet',
      explorerUrl: `https://explorer.solana.com/address/${publicKey}?cluster=devnet`,
    }
  } catch {
    const publicKey = solanaRelayer.getPublicKey()
    solana = {
      publicKey,
      solBalance: null,
      network: 'Solana Devnet',
      explorerUrl: `https://explorer.solana.com/address/${publicKey}?cluster=devnet`,
    }
  }

  const demoSession = issueDemoSession(address, clientId)
  const response = NextResponse.json({
    success: true,
    tenantId: juryTenantId,
    address,
    network: 'Base Sepolia',
    chainId: 84532,
    usdcBalance,
    ethBalance,
    rpcAvailable,
    canSend: baseRelayer.hasConfiguredKey(),
    demoSessionExpiresAt: demoSession.expiresAt,
    explorerUrl: `https://sepolia.basescan.org/address/${address}`,
    solana,
  }, { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  response.cookies.set('aura_demo_session', demoSession.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 10 * 60,
  })
  return response
}
