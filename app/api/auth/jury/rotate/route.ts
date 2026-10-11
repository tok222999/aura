import { NextRequest, NextResponse } from 'next/server'
import { getTrustedClientId, getJurySessionInfo, hasJuryAccess, verifyDemoSession } from '@/lib/services/demo-session-service'
import { persistentStore } from '@/lib/services/persistent-store'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('jury_key_rotation')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })

  const juryCookie = req.cookies.get('aura_jury_session')?.value || ''
  if (!hasJuryAccess(req.headers, juryCookie)) {
    return NextResponse.json({ success: false, error: 'JURY_CAPABILITY_REQUIRED' }, { status: 403 })
  }

  const demoToken = req.cookies.get('aura_demo_session')?.value || ''
  const clientId = getTrustedClientId(req.headers, { useClientFingerprint: false })
  if (!verifyDemoSession(demoToken, baseRelayer.getAddress(), clientId)) {
    return NextResponse.json({ success: false, error: 'DEMO_SESSION_REQUIRED' }, { status: 401 })
  }

  const jurySession = getJurySessionInfo(juryCookie)
  const juryTenantId = jurySession?.tenantId || null
  if (!juryTenantId) return NextResponse.json({ success: false, error: 'JURY_SESSION_REQUIRED' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const tenantId = typeof body?.tenantId === 'string' ? body.tenantId.trim() : ''
  const authPublicKey = typeof body?.authPublicKey === 'string' ? body.authPublicKey.trim().toLowerCase() : ''
  if (tenantId !== juryTenantId) {
    return NextResponse.json({ success: false, error: 'JURY_TENANT_MISMATCH' }, { status: 403 })
  }
  if (!/^[a-f0-9]{100,1024}$/.test(authPublicKey)) {
    return NextResponse.json({ success: false, error: 'INVALID_AUTH_PUBLIC_KEY' }, { status: 400 })
  }

  const rotated = persistentStore.rotateSpendSigningKey(tenantId, authPublicKey)
  if (!rotated) {
    return NextResponse.json({ success: false, error: 'JURY_TENANT_RECOVERY_AUTHORITY_MISSING' }, { status: 409 })
  }
  return NextResponse.json({ success: true, tenantId }, { headers: { 'Cache-Control': 'no-store' } })
}
