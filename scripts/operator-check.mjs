#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local')
} catch {
  // Hosted runners may inject the same variables through the environment.
}

const runtime = spawnSync(process.execPath, ['scripts/verify-runtime-config.mjs', '--strict'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: process.env,
})
if (runtime.error || runtime.status !== 0) {
  console.error('\nOPERATOR CHECK FAILED')
  console.error('მიზეზი: გაშვების გარემო, შენახვის გზა ან Zcash-ის ხელსაწყო მზად არ არის.')
  process.exit(1)
}

const failures = []
const report = (label, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

const capability = String(process.env.AURA_DEMO_JURY_CAPABILITY || '').trim()
const localBootstrap = process.env.AURA_DEMO_LOCAL_BOOTSTRAP === 'true' &&
  String(process.env.AURA_RUNTIME_MODE || 'hackathon-testnet').trim().toLowerCase() !== 'production'
report('jury access', capability.length >= 16 || localBootstrap,
  capability ? 'operator capability configured' : localBootstrap ? 'local bootstrap enabled' : 'missing operator capability')

const tenantIds = Array.from(new Set([
  ...String(process.env.AURA_JURY_TENANT_IDS || '').split(','),
  String(process.env.AURA_JURY_TENANT_ID || ''),
].map((value) => value.trim()).filter(Boolean)))
let validTenantIds = tenantIds.filter((tenantId) => /^vault_r_[a-zA-Z0-9._-]{8,120}$/.test(tenantId))
report('jury tenant list', validTenantIds.length > 0 && validTenantIds.length === tenantIds.length,
  validTenantIds.length ? `${validTenantIds.length} configured tenant(s)` : 'missing or invalid tenant list')

const dataDir = path.resolve(process.cwd(), String(process.env.AURA_DATA_DIR || '.aura-data'))
const readJson = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')) } catch { return null }
}
const recoveryKeys = readJson('recovery-keys.json')
const spendKeys = readJson('spend-keys.json')
const tenantsWithAuthority = validTenantIds.filter((tenantId) =>
  typeof recoveryKeys?.[tenantId] === 'string' && recoveryKeys[tenantId].length > 0 &&
  typeof spendKeys?.[tenantId] === 'string' && spendKeys[tenantId].length > 0,
)
report('tenant authorities', tenantsWithAuthority.length === validTenantIds.length,
  `${tenantsWithAuthority.length}/${validTenantIds.length} tenant(s) have recovery + spend authority`)

const baseUrl = String(process.env.AURA_OPERATOR_BASE_URL || 'http://localhost:4173').replace(/\/$/, '')
let localBootstrapCookie = ''
let localBootstrapTenant = ''

async function startLocalBootstrapSession() {
  const sessionResponse = await fetch(`${baseUrl}/api/wallet/demo/jury-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })
  const sessionPayload = await sessionResponse.json().catch(() => ({}))
  if (!sessionResponse.ok || !sessionPayload.success) {
    throw new Error(`jury session bootstrap failed (HTTP ${sessionResponse.status})`)
  }
  const setCookie = sessionResponse.headers.get('set-cookie') || ''
  const cookieMatch = setCookie.match(/(?:^|,\s*)aura_jury_session=([^;]+)/)
  if (!cookieMatch?.[1]) throw new Error('jury session response did not include a session cookie')
  localBootstrapCookie = `aura_jury_session=${cookieMatch[1]}`

  const walletResponse = await fetch(`${baseUrl}/api/wallet/demo`, {
    headers: { Cookie: localBootstrapCookie },
    cache: 'no-store',
  })
  const walletPayload = await walletResponse.json().catch(() => ({}))
  if (!walletResponse.ok || !walletPayload.success || typeof walletPayload.tenantId !== 'string') {
    throw new Error(`jury tenant bootstrap failed (HTTP ${walletResponse.status})`)
  }
  localBootstrapTenant = walletPayload.tenantId
  if (!validTenantIds.includes(localBootstrapTenant)) {
    throw new Error('bootstrapped tenant is not in the configured jury tenant list')
  }
  // Local bootstrap leases one tenant at a time. The capability path below
  // remains the only path used for a full configured-pool sweep.
  validTenantIds = [localBootstrapTenant]
  report('local jury session', true, `temporary session assigned to ${localBootstrapTenant}`)
}

if (localBootstrap && !capability) {
  try {
    await startLocalBootstrapSession()
  } catch (error) {
    report('local jury session', false, error instanceof Error ? error.message : 'session bootstrap failed')
  }
}

const checkTenant = async (tenantId, index) => {
  const prefix = `tenant ${index}/${validTenantIds.length} ${tenantId}`
  if (!tenantsWithAuthority.includes(tenantId)) {
    console.log(`\n${prefix}`)
    report(`${prefix} authority`, false, 'recovery or spend authority is missing')
    return false
  }

  let response
  let payload
  try {
    response = await fetch(`${baseUrl}/api/preflight?demo=quick&amountUsd=0.50&bufferMode=fast&operator=1`, {
      headers: {
        ...(capability ? { 'x-aura-jury-capability': capability } : {}),
        ...(localBootstrapCookie ? { Cookie: localBootstrapCookie } : {}),
        'x-aura-operator-tenant': tenantId,
      },
    })
    payload = await response.json().catch(() => ({}))
  } catch (error) {
    console.log(`\n${prefix}`)
    report(`${prefix} live check`, false, error instanceof Error ? error.message : 'server did not answer')
    return false
  }

  const accountReady = payload.checks?.zcashTestnet?.balanceAvailable === true &&
    typeof payload.checks?.zcashTestnet?.spendableBalanceZec === 'number'
  const quickReady = payload.readyForQuickDemo === true && payload.tenantPayReady === true
  const warningCodes = Array.isArray(payload.privacyScenario?.warningCodes)
    ? payload.privacyScenario.warningCodes
    : []
  const privacyReady = payload.privacyScenarioReady === true &&
    warningCodes.length > 0
  const readyUsd = payload.bufferMode === 'fast'
    ? payload.tenantBalance?.fastAvailableUsd
    : payload.tenantBalance?.privateReadyUsd
  const requiredUsd = payload.tenantBalance?.requiredPayoutUsd
  const passed = response.ok && payload.success === true && payload.scope === 'active-tenant' &&
    payload.tenantId === tenantId && accountReady && quickReady && privacyReady

  console.log(`\n${prefix}`)
  report(`${prefix} account`, accountReady, accountReady
    ? `Zcash account ready · ${Number(payload.checks.zcashTestnet.spendableBalanceZec).toFixed(6)} ZEC spendable`
    : 'Zcash account or spendable balance is not ready')
  report(`${prefix} Quick Demo`, quickReady, quickReady ? 'ready to pay from the mature balance' :
    typeof readyUsd === 'number' && typeof requiredUsd === 'number'
      ? `blocked: $${readyUsd.toFixed(2)} ready, $${requiredUsd.toFixed(2)} required`
      : payload.readyForQuickDemo === false ? 'blocked: mature balance or infrastructure is not ready' : 'preflight failed')
  report(`${prefix} Privacy Check`, privacyReady, privacyReady
    ? `real warning available (${warningCodes.join(', ')})`
    : warningCodes.length > 0
      ? `warning exists (${warningCodes.join(', ')}), but Pay balance is not ready`
      : 'no confirmed funding pattern produces a visible warning')
  report(`${prefix} result`, passed, passed ? 'PASS' : `FAIL · HTTP ${response.status}`)
  return passed
}

const results = []
for (let index = 0; index < validTenantIds.length; index += 1) {
  results.push(await checkTenant(validTenantIds[index], index + 1))
}

const readyCount = results.filter(Boolean).length
const blockedCount = Math.max(0, results.length - readyCount)
console.log(`\nSUMMARY: ${readyCount}/${results.length} tenant(s) ready · ${blockedCount} blocked.`)

if (localBootstrapCookie) {
  await fetch(`${baseUrl}/api/wallet/demo/jury-session`, {
    method: 'DELETE',
    headers: { Cookie: localBootstrapCookie },
    cache: 'no-store',
  }).catch(() => undefined)
  console.log('temporary local jury session released')
}

if (results.length === 0 || results.some((passed) => !passed)) {
  console.error(`\nOPERATOR CHECK FAILED: ${failures.length || 1} blocking issue(s).`)
  console.error('შემოწმებამ არცერთი browser lease არ შექმნა და არცერთი tenant არ შეცვალა.')
  process.exitCode = 1
} else {
  console.log('\nOPERATOR CHECK PASSED')
  console.log(`ყველა ${results.length} tenant მზად არის: recovery, Zcash balance, Quick Demo და Privacy Check.`)
  console.log(localBootstrapCookie
    ? 'შემოწმებამ დროებითი local jury session შექმნა, შემდეგ კი lease გაათავისუფლა.'
    : 'ეს შემოწმება read-only არის — jury session/lease არ იქმნება.')
}
