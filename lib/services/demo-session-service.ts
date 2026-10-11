import fs from 'fs'
import path from 'path'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { getAuraRuntimeMode } from './production-boundary'
import { persistentStore } from './persistent-store'

const SESSION_TTL_MS = 10 * 60 * 1000
export const RATE_LIMIT_COOKIE_NAME = 'aura_rl_id'

const JURY_TENANT_PATTERN = /^vault_r_[a-zA-Z0-9._-]{8,120}$/

/** The jury flow receives an isolated, explicitly provisioned tenant per session. */
export function getJuryTenantPool(): string[] {
  const configuredPool = String(process.env.AURA_JURY_TENANT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => JURY_TENANT_PATTERN.test(value))
  if (configuredPool.length) return Array.from(new Set(configuredPool))
  const legacyTenant = String(process.env.AURA_JURY_TENANT_ID || '').trim()
  return JURY_TENANT_PATTERN.test(legacyTenant) ? [legacyTenant] : []
}

/** Backward-compatible helper for code that needs the first configured tenant. */
export function getJuryTenantId(): string | null {
  return getJuryTenantPool()[0] || null
}
// Keep leases short enough that a stale review session cannot exhaust the pool
// for the rest of the day. The operator can tune this between 30 and 60 min.
function getJurySessionTtlMs(): number {
  const configuredMinutes = Number(process.env.AURA_JURY_SESSION_TTL_MINUTES || 45)
  const minutes = Number.isFinite(configuredMinutes)
    ? Math.min(60, Math.max(30, Math.floor(configuredMinutes)))
    : 45
  return minutes * 60 * 1000
}
let cachedSecret: Buffer | null = null

function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret
  const configured = process.env.AURA_DEMO_SESSION_SECRET?.trim()
  if (configured) {
    cachedSecret = createHash('sha256').update(configured).digest()
    return cachedSecret
  }

  // Keep the default path statically scoped so Next's server trace does not
  // accidentally include the whole project. AURA_DATA_DIR remains supported
  // for deployments that explicitly provide an absolute or working-dir path.
  const dataDir = process.env.AURA_DATA_DIR || path.join(process.cwd(), '.aura-data')
  const secretPath = path.join(dataDir, 'demo-session-secret')
  fs.mkdirSync(dataDir, { recursive: true })
  try {
    const existing = fs.readFileSync(secretPath)
    if (existing.length >= 32) {
      cachedSecret = existing
      return cachedSecret
    }
  } catch {}

  const generated = randomBytes(32)
  try {
    // wx makes first-time initialization exclusive across server processes.
    // Never cache a secret that lost a race with another process.
    const fd = fs.openSync(secretPath, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, generated)
    } finally {
      fs.closeSync(fd)
    }
    cachedSecret = generated
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    const existing = fs.readFileSync(secretPath)
    if (existing.length < 32) throw new Error('Demo session secret is invalid.')
    cachedSecret = existing
  }
  return cachedSecret
}

function clientBinding(clientId: string): string {
  return createHash('sha256').update(clientId || 'anonymous').digest('hex')
}

/** Only trust forwarded client IP headers when the deployment explicitly sits behind a trusted proxy. */
export function getTrustedClientId(
  headers: Headers,
  options: { sessionToken?: string; useClientFingerprint?: boolean } = {},
): string {
  if (options.sessionToken?.trim()) return `session:${clientBinding(options.sessionToken.trim())}`
  if (process.env.AURA_TRUST_PROXY === 'true') {
    return headers.get('x-real-ip') || headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'proxy-unknown'
  }
  // A client-supplied tenant/fingerprint is not an authenticated identity.
  // Callers that have already verified a tenant may pass its authenticated
  // session/key identity explicitly, but never derive a limiter bucket from
  // this header alone.
  if (options.useClientFingerprint === true) {
    const fingerprint = headers.get('x-aura-enclave-fingerprint')?.trim() || ''
    if (/^[a-zA-Z0-9._-]{1,128}$/.test(fingerprint)) return `tenant:${fingerprint}`
  }
  // A server-issued browser bucket prevents ordinary users from sharing one
  // global limiter while deliberately avoiding trust in client-supplied IP or
  // tenant headers. The cookie is a fairness mechanism, not an auth token;
  // the global limiter remains the abuse backstop when it is absent.
  const cookieHeader = headers.get('cookie') || ''
  const cookieMatch = cookieHeader.match(new RegExp(`(?:^|;\\s*)${RATE_LIMIT_COOKIE_NAME}=([^;]+)`))
  const browserBucket = cookieMatch?.[1]?.trim() || ''
  if (/^[a-f0-9-]{32,64}$/i.test(browserBucket)) {
    return `browser:${clientBinding(browserBucket)}`
  }
  return 'direct-client'
}

/** A short-lived demo limiter identity derived from the server-signed session. */
export function getDemoSessionClientId(sessionToken: string): string {
  return `session:${clientBinding(sessionToken.trim())}`
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', getSecret()).update(encodedPayload).digest('base64url')
}

export function issueDemoSession(address: string, clientId: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + SESSION_TTL_MS
  const payload = encode(JSON.stringify({
    address: address.toLowerCase(),
    client: clientBinding(clientId),
    expiresAt,
    nonce: randomBytes(16).toString('hex'),
  }))
  return { token: `${payload}.${sign(payload)}`, expiresAt }
}

export function verifyDemoSession(token: string, address: string, clientId: string): boolean {
  try {
    const [payload, suppliedSignature] = token.split('.')
    if (!payload || !suppliedSignature) return false
    const expectedSignature = sign(payload)
    const expected = Buffer.from(expectedSignature)
    const supplied = Buffer.from(suppliedSignature)
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      address?: unknown
      client?: unknown
      expiresAt?: unknown
      nonce?: unknown
    }
    return parsed.address === address.toLowerCase() &&
      parsed.client === clientBinding(clientId) &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt > Date.now() &&
      typeof parsed.nonce === 'string' && parsed.nonce.length >= 16
  } catch {
    return false
  }
}

function jurySignature(payload: string): string {
  return createHmac('sha256', getSecret()).update(`jury:${payload}`).digest('base64url')
}

export function issueJurySession(): { token: string; expiresAt: number } | null {
  if (getAuraRuntimeMode() === 'production' && !process.env.AURA_DEMO_JURY_CAPABILITY?.trim()) return null
  const sessionId = randomBytes(18).toString('hex')
  const tenantId = persistentStore.assignJuryTenant(sessionId, getJuryTenantPool(), getJurySessionTtlMs())
  if (!tenantId) return null
  const expiresAt = Date.now() + getJurySessionTtlMs()
  const payload = encode(JSON.stringify({
    expiresAt,
    nonce: randomBytes(16).toString('hex'),
    sessionId,
    tenantId,
  }))
  return { token: `${payload}.${jurySignature(payload)}`, expiresAt }
}

export interface JurySessionInfo {
  sessionId: string
  tenantId: string
  expiresAt: number
}

export function getJurySessionInfo(token: string): JurySessionInfo | null {
  try {
    const [payload, suppliedSignature] = token.split('.')
    if (!payload || !suppliedSignature) return null
    const expectedSignature = jurySignature(payload)
    const expected = Buffer.from(expectedSignature)
    const supplied = Buffer.from(suppliedSignature)
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      expiresAt?: unknown
      nonce?: unknown
      sessionId?: unknown
      tenantId?: unknown
    }
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now() ||
      typeof parsed.nonce !== 'string' || parsed.nonce.length < 16 ||
      typeof parsed.sessionId !== 'string' || parsed.sessionId.length < 16 ||
      typeof parsed.tenantId !== 'string' || !JURY_TENANT_PATTERN.test(parsed.tenantId)) return null
    const assignment = persistentStore.getAssignedJuryTenant(parsed.sessionId)
    if (!assignment || assignment.tenantId !== parsed.tenantId || assignment.expiresAt < parsed.expiresAt - 1000) return null
    return { sessionId: parsed.sessionId, tenantId: parsed.tenantId, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

export function verifyJurySession(token: string): boolean {
  return getJurySessionInfo(token) !== null
}

export function hasJuryAccess(headers: Headers, juryCookie = ''): boolean {
  const requiredCapability = process.env.AURA_DEMO_JURY_CAPABILITY?.trim()
  if (requiredCapability && headers.get('x-aura-jury-capability') === requiredCapability) return true
  // Local hackathon mode still uses the signed HttpOnly jury session. This
  // prevents an unauthenticated caller from draining the shared test wallet.
  return Boolean(juryCookie && verifyJurySession(juryCookie))
}

/**
 * Jury access is tenant-scoped. Being listed in the configured tenant pool is
 * not an authorization decision: the caller must also present the assigned
 * signed session or the explicitly configured reviewer capability.
 */
export function hasJuryAccessForTenant(
  tenantId: string,
  headers: Headers,
  juryCookie = '',
): boolean {
  if (!getJuryTenantPool().includes(tenantId)) return false
  const session = juryCookie ? getJurySessionInfo(juryCookie) : null
  if (session?.tenantId === tenantId) return true
  const requiredCapability = process.env.AURA_DEMO_JURY_CAPABILITY?.trim()
  return Boolean(requiredCapability && headers.get('x-aura-jury-capability') === requiredCapability)
}
