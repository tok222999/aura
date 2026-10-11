#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

// Node 24 can load the local development file without printing its values.
// Hosted deployments should inject environment variables through the runtime.
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local')
} catch {
  // A missing local file is fine when the host injects the environment.
}

const strict = process.argv.includes('--strict') || process.env.AURA_REQUIRE_DURABLE_RUNTIME === '1'
const root = process.cwd()
const errors = []
const warnings = []

function configured(name) {
  return Boolean(String(process.env[name] || '').trim())
}

function report(label, ok, detail, level = 'error') {
  const mark = ok ? 'OK' : level === 'warning' ? 'WARN' : 'FAIL'
  console.log(`[${mark}] ${label}: ${detail}`)
  if (!ok && level === 'warning') warnings.push(label)
  if (!ok && level === 'error') errors.push(label)
}

const runtimeMode = String(process.env.AURA_RUNTIME_MODE || 'hackathon-testnet').trim().toLowerCase()
report('runtime mode', runtimeMode !== 'production', runtimeMode === 'production' ? 'production mode is intentionally blocked for this build' : runtimeMode)

for (const name of [
  'DEMO_WALLET_BASE_PRIVATE_KEY',
  'DEMO_WALLET_SOLANA_PRIVATE_KEY',
  'DEMO_WALLET_ADDRESS',
  'VAULT_DEPOSIT_ADDRESS',
  'BASE_SEPOLIA_USDC_CONTRACT',
]) {
  report(name, configured(name), configured(name) ? 'configured' : 'missing')
}

const binaryName = process.platform === 'win32' ? 'zcash-devtool.exe' : 'zcash-devtool'
const configuredBinary = String(process.env.ZCASH_DEVTOOL_PATH || '').trim()
const binaryPath = path.resolve(root, configuredBinary || path.join('zcash-devtool', 'target', 'release', binaryName))
report('Zcash devtool', fs.existsSync(binaryPath), fs.existsSync(binaryPath) ? 'binary found' : `missing at ${binaryPath}`)

const dataDirValue = String(process.env.AURA_DATA_DIR || '.aura-data').trim()
const walletDirValue = String(process.env.ZCASH_WALLET_DIR || 'zcash-wallet-data').trim()
const dataDir = path.resolve(root, dataDirValue)
const walletDir = path.resolve(root, walletDirValue)

const dataExists = fs.existsSync(dataDir)
const walletExists = fs.existsSync(walletDir)
const dataWritable = dataExists && (() => {
  try { fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK); return true } catch { return false }
})()
const walletReadable = walletExists && (() => {
  try { fs.accessSync(walletDir, fs.constants.R_OK); return true } catch { return false }
})()

if (strict) {
  report('AURA_DATA_DIR', path.isAbsolute(dataDirValue) && dataExists && dataWritable, path.isAbsolute(dataDirValue) && dataExists && dataWritable ? 'absolute durable directory is readable/writable' : 'strict mode requires an existing absolute readable/writable directory')
  report('ZCASH_WALLET_DIR', path.isAbsolute(walletDirValue) && walletExists && walletReadable, path.isAbsolute(walletDirValue) && walletExists && walletReadable ? 'absolute wallet directory is readable' : 'strict mode requires an existing absolute readable wallet directory')
} else {
  report('AURA_DATA_DIR', dataWritable, dataWritable ? 'local directory is readable/writable' : 'local directory is unavailable', 'warning')
  report('ZCASH_WALLET_DIR', walletReadable, walletReadable ? 'local wallet directory is readable' : 'local wallet directory is unavailable', 'warning')
  if (!path.isAbsolute(dataDirValue) || !path.isAbsolute(walletDirValue)) {
    console.log('[WARN] deployment paths: use absolute paths and run `pnpm runtime:check:strict` on a hosted deployment')
  }
}

if (errors.length > 0) {
  console.error(`Runtime check failed: ${errors.length} blocking issue(s). Values are intentionally not printed.`)
  process.exitCode = 1
} else {
  console.log(`Runtime check passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`)
}
