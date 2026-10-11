import { NextRequest, NextResponse } from 'next/server'
import { getJurySessionInfo, issueJurySession } from '@/lib/services/demo-session-service'
import { getAuraRuntimeMode } from '@/lib/services/production-boundary'
import { persistentStore } from '@/lib/services/persistent-store'

export const dynamic = 'force-dynamic'

/** Exchange the operator-only capability for a short-lived HttpOnly browser session. */
export async function POST(req: NextRequest) {
  const configured = process.env.AURA_DEMO_JURY_CAPABILITY?.trim()
  // Host is request-controlled and must never grant a capability. Local
  // bootstrap is an explicit operator setting and is disabled in production.
  const localDevelopmentBootstrap = process.env.AURA_DEMO_LOCAL_BOOTSTRAP === 'true' && getAuraRuntimeMode() !== 'production'
  const body = await req.json().catch(() => ({})) as { passcode?: unknown }
  const suppliedCapability = req.headers.get('x-aura-jury-capability') ||
    (typeof body.passcode === 'string' ? body.passcode.trim() : '')
  const existingSession = req.cookies.get('aura_jury_session')?.value || ''
  const existingSessionInfo = existingSession ? getJurySessionInfo(existingSession) : null
  const existingSessionIsValid = existingSessionInfo !== null
  // On a hosted hackathon deployment the browser must not mint its own jury
  // cookie. Local development remains frictionless; hosted access requires a
  // capability supplied out-of-band to the operator.
  if (!existingSessionIsValid && !localDevelopmentBootstrap && !configured) {
    return NextResponse.json(
      { success: false, error: 'JURY_CAPABILITY_NOT_CONFIGURED' },
      { status: 503 },
    )
  }
  if (!existingSessionIsValid && !localDevelopmentBootstrap && suppliedCapability !== configured) {
    return NextResponse.json({ success: false, error: 'JURY_CAPABILITY_REQUIRED' }, { status: 403 })
  }
  if (existingSessionInfo) {
    return NextResponse.json({ success: true, reused: true, expiresAt: existingSessionInfo.expiresAt }, {
      headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    })
  }
  const session = issueJurySession()
  if (!session) return NextResponse.json({ success: false, error: 'JURY_TENANT_POOL_UNAVAILABLE' }, { status: 503 })
  const response = NextResponse.json({ success: true, expiresAt: session.expiresAt }, {
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  const isSecureRequest = req.nextUrl.protocol === 'https:' || forwardedProto === 'https'
  response.cookies.set('aura_jury_session', session.token, {
    httpOnly: true,
    sameSite: 'lax',
    // `next start` on localhost is a production build served over HTTP. Keep
    // the cookie usable there, while preserving Secure behind HTTPS/proxies.
    secure: isSecureRequest,
    path: '/',
    maxAge: Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000)),
  })
  return response
}

/** Explicitly close a jury session and release its tenant lease. */
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get('aura_jury_session')?.value || ''
  const session = token ? getJurySessionInfo(token) : null
  if (!session) {
    return NextResponse.json({ success: false, error: 'JURY_SESSION_REQUIRED' }, { status: 401 })
  }
  const released = persistentStore.releaseJuryTenant(session.sessionId)
  const response = NextResponse.json({ success: true, released }, {
    headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
  response.cookies.set('aura_jury_session', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 0,
  })
  return response
}
