import fs from 'node:fs'
import path from 'node:path'

export interface RuntimeStorageReadiness {
  strict: boolean
  readyForExecution: boolean
  status: 'ready' | 'warning'
  dataDir: { configured: boolean; absolute: boolean; readable: boolean; writable: boolean }
  walletDir: { configured: boolean; absolute: boolean; readable: boolean }
  blockers: string[]
}

function access(directory: string, mode: number): boolean {
  try {
    fs.accessSync(directory, mode)
    return true
  } catch {
    return false
  }
}

/**
 * Hosted deployments can opt into a hard persistence gate. Local development
 * keeps using the repository-relative defaults, but preflight exposes the
 * weaker boundary instead of pretending it is a durable deployment.
 */
export function getRuntimeStorageReadiness(): RuntimeStorageReadiness {
  const dataValue = String(process.env.AURA_DATA_DIR || '.aura-data').trim()
  const walletValue = String(process.env.ZCASH_WALLET_DIR || 'zcash-wallet-data').trim()
  const dataDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), dataValue)
  const walletDir = path.resolve(/* turbopackIgnore: true */ process.cwd(), walletValue)
  const strict = process.env.AURA_REQUIRE_DURABLE_RUNTIME === '1' ||
    String(process.env.AURA_RUNTIME_MODE || '').trim().toLowerCase() === 'production'
  const data = {
    configured: Boolean(process.env.AURA_DATA_DIR?.trim()),
    absolute: path.isAbsolute(dataValue),
    readable: access(dataDir, fs.constants.R_OK),
    writable: access(dataDir, fs.constants.W_OK),
  }
  const wallet = {
    configured: Boolean(process.env.ZCASH_WALLET_DIR?.trim()),
    absolute: path.isAbsolute(walletValue),
    readable: access(walletDir, fs.constants.R_OK),
  }
  const blockers: string[] = []
  if (strict && (!data.configured || !data.absolute || !data.readable || !data.writable)) {
    blockers.push('AURA_DATA_DIR must be an existing absolute readable/writable durable directory')
  }
  if (strict && (!wallet.configured || !wallet.absolute || !wallet.readable)) {
    blockers.push('ZCASH_WALLET_DIR must be an existing absolute readable wallet directory')
  }
  return {
    strict,
    readyForExecution: blockers.length === 0,
    status: blockers.length === 0 ? 'ready' : 'warning',
    dataDir: data,
    walletDir: wallet,
    blockers,
  }
}
