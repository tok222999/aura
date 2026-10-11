#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local')
} catch {
  // CI/hosted runners may inject the values directly.
}

const baseUrl = String(process.env.AURA_OPERATOR_BASE_URL || '').trim().replace(/\/$/, '')
const juryUrl = String(process.env.AURA_JURY_DEMO_URL || '').trim()

if (!baseUrl) {
  console.error('LAUNCH CHECK FAILED: AURA_OPERATOR_BASE_URL is required.')
  console.error('Set it to the exact deployed jury origin, not the local fallback.')
  process.exit(1)
}

let base
let jury
try {
  base = new URL(baseUrl)
  jury = new URL(juryUrl)
} catch {
  console.error('LAUNCH CHECK FAILED: AURA_OPERATOR_BASE_URL and AURA_JURY_DEMO_URL must be valid URLs.')
  process.exit(1)
}

if (!['https:', 'http:'].includes(base.protocol) || (base.hostname !== 'localhost' && base.hostname !== '127.0.0.1' && base.protocol !== 'https:')) {
  console.error('LAUNCH CHECK FAILED: hosted jury origin must use HTTPS.')
  process.exit(1)
}
if (jury.origin !== base.origin || jury.pathname !== '/balance' || jury.searchParams.get('tour') !== '1') {
  console.error('LAUNCH CHECK FAILED: AURA_JURY_DEMO_URL must be the same-origin /balance?tour=1 invite URL.')
  process.exit(1)
}

console.log(`Checking deployed jury origin: ${base.origin}`)
try {
  const response = await fetch(`${base.origin}/`, { redirect: 'manual' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  console.log('✓ deployed public page responds')
} catch (error) {
  console.error(`LAUNCH CHECK FAILED: deployed origin did not respond: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const operator = spawnSync(process.execPath, ['scripts/operator-check.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: { ...process.env, AURA_OPERATOR_BASE_URL: base.origin },
})
if (operator.error || operator.status !== 0) {
  console.error('LAUNCH CHECK FAILED: remote operator preflight did not pass for every jury tenant.')
  process.exit(operator.status || 1)
}

console.log('LAUNCH CHECK PASSED: deployed origin, jury invite shape, and remote Quick preflight are ready.')
console.log('Manual final step: open the invite URL in a clean browser and run Quick Jury Demo at least twice.')
