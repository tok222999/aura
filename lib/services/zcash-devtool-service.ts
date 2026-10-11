import { exec, execFileSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { createHash, randomUUID } from 'crypto'
import { getZcashSettlementSafetyConfirmations } from './zcash-balance'

const PROCESS_INSTANCE_ID = randomUUID()
const WALLET_LOCK_LEASE_MS = 5 * 60 * 1000

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      // `exec` starts the wallet through a Windows shell. Killing only the
      // shell can leave zcash-devtool.exe alive with data.sqlite locked.
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // The process may already have exited between the timeout and cleanup.
  }
}

export interface ZcashWalletStatus {
  initialized: boolean
  network: 'test' | 'main'
  server: string
  walletDir: string
  shieldedAddress?: string
  transparentAddress?: string
  shieldedBalanceZec: number
  transparentBalanceZec: number
  unconfirmedBalanceZec: number
  lastSyncedBlock?: number
}

export interface ZcashShieldResult {
  success: boolean
  broadcastUncertain?: boolean
  txid?: string
  explorerUrl?: string
  error?: string
  amountZec?: number
  feeZats?: number
  memo?: string
}

export type ZcashConfirmationState = 'confirmed' | 'mined' | 'pending' | 'expired' | 'unknown'

export interface ZcashConfirmationResult {
  confirmed: boolean
  state: ZcashConfirmationState
  blockHeight?: number
  expiryHeight?: number
  confirmations?: number
  requiredConfirmations?: number
}

interface ZcashWalletTransactionRecord {
  txid?: unknown
  mined_height?: unknown
  expiry_height?: unknown
  expired_unmined?: unknown
  confirmations?: unknown
}

/**
 * The wallet CLI prints proposal input txids before it prints the txid that
 * was actually broadcast. Only the final standalone 64-character line is
 * authoritative; taking the first hex string can silently attach an older
 * transaction to a new deposit or spend.
 */
export function extractBroadcastTxid(stdout: string): string | undefined {
  const standaloneTxids = [...stdout.matchAll(/(?:^|\r?\n)\s*([a-f0-9]{64})\s*(?=\r?\n|$)/gi)]
    .map((match) => match[1].toLowerCase())
  return standaloneTxids.at(-1)
}

/**
 * The Rust wallet persists the fully built transaction before asking the RPC
 * server to broadcast it. This identity is recoverable even when the RPC
 * response is lost or returns an error after accepting the transaction.
 */
export function extractPreparedTxid(output: string): string | undefined {
  return output.match(/(?:^|\r?\n)\s*Prepared transaction:\s*([a-f0-9]{64})\s*(?=\r?\n|$)/i)?.[1]?.toLowerCase()
}

/**
 * Recovers a broadcast txid when the wallet command reached the network but
 * the process exited before returning its final stdout line. The memo is the
 * operation's durable idempotency key; a txid is accepted only when the wallet
 * itself lists that exact memo, never merely because a recent tx exists.
 */
export function extractTxidForMemo(stdout: string, memo: string): string | undefined {
  if (!memo || memo.length > 512) return undefined
  let currentTxid: string | undefined
  const matches: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const txidLine = line.match(/^\s*([a-f0-9]{64})\s*$/i)
    if (txidLine) {
      currentTxid = txidLine[1].toLowerCase()
      continue
    }
    if (currentTxid && line.includes(`Memo::Text("${memo}")`)) {
      matches.push(currentTxid)
      currentTxid = undefined
    }
  }
  return matches.at(-1)
}

export function parseZcashListTxJson(stdout: string): ZcashWalletTransactionRecord[] {
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed)) throw new Error('Zcash wallet returned an invalid list-tx JSON payload.')
  return parsed.filter((record): record is ZcashWalletTransactionRecord => Boolean(record && typeof record === 'object'))
}

/** Return only one exact transaction's text block; never span into the next tx. */
export function extractExactZcashTransactionText(stdout: string, txid: string): string | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) return undefined
  const lines = stdout.split(/\r?\n/)
  const target = txid.toLowerCase()
  const start = lines.findIndex((line) => line.trim().toLowerCase() === target)
  if (start < 0) return undefined
  const next = lines.slice(start + 1).findIndex((line) => /^[0-9a-f]{64}$/i.test(line.trim()))
  return lines.slice(start, next < 0 ? lines.length : start + 1 + next).join('\n')
}

/**
 * A write may fail over only when the selected lightwalletd was unreachable
 * before the wallet produced a prepared transaction. Timeouts, resets, and
 * any response that mentions broadcast/mempool state remain uncertain and
 * must never be replayed against another endpoint.
 */
export function isSafeZcashWriteRetry(error: unknown): boolean {
  const record = (error && typeof error === 'object' ? error : {}) as {
    code?: unknown
    stdout?: unknown
    stderr?: unknown
    message?: unknown
  }
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : ''
  const output = [record.stderr, record.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  if (extractPreparedTxid(output)) return false
  if (/broadcast|mempool|accepted|prepared transaction|transaction id/i.test(output)) return false
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return true
  return /connection (?:refused|failed)|failed to connect|could not resolve|name or service not known|no route to host|server unavailable/i.test(output)
}

/**
 * ZcashDevtoolService
 *
 * Encapsulates the compiled official Rust `zcash-devtool.exe` binary
 * connected to the public Zcash Testnet (testnet.zec.rocks:443).
 *
 * Provides real:
 * - BIP-39 / Zip-32 key derivation & address generation
 * - Shielded pool balance query (Orchard / Sapling)
 * - Chain sync from testnet.zec.rocks
 * - PCZT-based zero-knowledge proofs and shielded transactions
 */
class ZcashDevtoolService {
  private exePath: string
  private walletDir: string
  private keyFile: string
  private server: string
  private serverFallbacks: string[]
  // Reads can discover that the primary lightwalletd is unavailable. Keep
  // that healthy endpoint for subsequent writes so read and send paths do not
  // disagree about which Zcash server is authoritative.
  private preferredServer: string
  private tenantAccountLockPath: string
  private walletCommandLockPath: string
  private tenantAccountTasks = new Map<string, Promise<{ accountId: string; unified: string }>>()
  // The wallet CLI mutates and reads the same wallet database. Running sync,
  // balance, and transaction commands concurrently can make a healthy wallet
  // look empty or unavailable during preflight.
  private walletCommandQueue: Promise<void> = Promise.resolve()
  private syncInFlight: Promise<{ success: boolean; output: string; blockHeight?: number }> | null = null
  private lastSyncAt = 0
  private lastSyncResult: { success: boolean; output: string; blockHeight?: number } | null = null

  constructor() {
    const defaultBinary = process.platform === 'win32' ? 'zcash-devtool.exe' : 'zcash-devtool'
    this.exePath = process.env.ZCASH_DEVTOOL_PATH || path.resolve(process.cwd(), 'zcash-devtool', 'target', 'release', defaultBinary)
    this.walletDir = process.env.ZCASH_WALLET_DIR || path.resolve(process.cwd(), 'zcash-wallet-data')
    this.keyFile = path.join(this.walletDir, 'dev-key.txt')
    this.server = ZcashDevtoolService.normalizeServer(process.env.ZCASH_SERVER || 'zecrocks') || 'zecrocks'
    this.serverFallbacks = Array.from(new Set(
      String(process.env.ZCASH_SERVER_FALLBACKS || '')
        .split(',')
        .map((value) => ZcashDevtoolService.normalizeServer(value))
        .filter((value): value is string => Boolean(value) && value !== this.server),
    ))
    this.preferredServer = this.server
    this.tenantAccountLockPath = path.join(this.walletDir, '.aura-tenant-account-provision.lock')
    // The wallet database is shared by every Next worker. The in-memory queue
    // below protects one worker, while this durable lock protects the wallet
    // when more than one worker/process is serving requests.
    this.walletCommandLockPath = path.join(this.walletDir, '.aura-zcash-command.lock')
  }

  public isAvailable(): boolean {
    return fs.existsSync(this.exePath)
  }

  private static normalizeServer(value: string): string | null {
    const server = value.trim()
    // The Rust helper accepts named public profiles or host:port. Keep the
    // value constrained because it is interpolated into a CLI command.
    return /^(?:zecrocks|ywallet|[a-zA-Z0-9.-]+:\d{1,5})$/.test(server) ? server : null
  }

  private getReadServers(): string[] {
    return Array.from(new Set([this.preferredServer, this.server, ...this.serverFallbacks]))
  }

  private getWriteServers(): string[] {
    return this.getReadServers()
  }

  private async runReadCommand(commandForServer: (server: string) => string) {
    let lastError: unknown
    for (const server of this.getReadServers()) {
      try {
        const result = await this.runWalletCommand(commandForServer(server))
        this.preferredServer = server
        return result
      } catch (error: unknown) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('All configured Zcash servers failed.')
  }

  private getEnv(): NodeJS.ProcessEnv {
    const extraPaths: string[] = []
    if (process.env.MINGW_BIN) {
      extraPaths.push(process.env.MINGW_BIN)
    }
    const userProfile = process.env.USERPROFILE || process.env.HOME || ''
    if (userProfile) {
      extraPaths.push(path.join(userProfile, '.cargo', 'bin'))
    }
    return {
      ...process.env,
      PATH: extraPaths.length > 0
        ? `${extraPaths.join(path.delimiter)}${path.delimiter}${process.env.PATH || ''}`
        : process.env.PATH,
    }
  }

  private async runWalletCommand(command: string) {
    const previous = this.walletCommandQueue
    let release!: () => void
    this.walletCommandQueue = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    try {
      return await this.withFileLock(this.walletCommandLockPath, () => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        // A stalled lightwalletd/RPC call must not hold the shared wallet
        // lock forever. The caller decides whether the timeout is a safe
        // pre-broadcast failure or an uncertain broadcast.
        const timeoutMs = Math.max(1_000, Math.min(120_000, Number(process.env.AURA_ZCASH_COMMAND_TIMEOUT_MS) || 30_000))
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const child = exec(command, {
          env: this.getEnv(),
          // Timeout is handled below so the entire Windows process tree is
          // terminated, not only the shell spawned by `exec`.
          timeout: 0,
          killSignal: 'SIGTERM',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (error) {
            Object.assign(error, { stdout, stderr })
            reject(error)
          } else {
            resolve({ stdout, stderr })
          }
        })

        timer = setTimeout(() => {
          if (settled) return
          settled = true
          terminateProcessTree(child.pid)
          const timeoutError = Object.assign(
            new Error(`Zcash wallet command timed out after ${timeoutMs}ms.`),
            { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM', stdout: '', stderr: '' },
          )
          reject(timeoutError)
        }, timeoutMs)
      }))
    } finally {
      release()
    }
  }

  /**
   * Serialize access to the mutable Rust wallet database across processes.
   * A PID-backed lock is recoverable after a worker crash, so an abandoned
   * lock cannot leave preflight or Pay permanently stuck.
   */
  private async withFileLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 5 * 60_000
    let acquired = false
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })

    while (!acquired && Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600)
        try {
          const createdAt = Date.now()
          fs.writeFileSync(fd, JSON.stringify({
            pid: process.pid,
            processInstanceId: PROCESS_INSTANCE_ID,
            createdAt,
            leaseUntil: createdAt + WALLET_LOCK_LEASE_MS,
          }), 'utf8')
        } finally {
          fs.closeSync(fd)
        }
        acquired = true
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error

        let stale = false
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown; processInstanceId?: unknown; leaseUntil?: unknown }
          if (typeof lock.pid === 'number') {
            const ownerIsThisProcess = lock.processInstanceId === PROCESS_INSTANCE_ID
            const leaseExpired = typeof lock.leaseUntil === 'number' && lock.leaseUntil <= Date.now()
            const legacyLeaseExpired = typeof lock.leaseUntil !== 'number' && Date.now() - fs.statSync(lockPath).mtimeMs >= WALLET_LOCK_LEASE_MS
            let ownerAlive = true
            try {
              process.kill(lock.pid, 0)
            } catch (probeError: unknown) {
              ownerAlive = (probeError as NodeJS.ErrnoException)?.code !== 'ESRCH'
            }
            // Wallet access may include an external broadcast. Never steal a
            // live process's lock on lease expiry; only a reused PID belonging
            // to this new process can be recovered by instance id + lease.
            stale = !ownerAlive || (!ownerIsThisProcess && (leaseExpired || legacyLeaseExpired) && lock.pid === process.pid)
          } else {
            stale = Date.now() - fs.statSync(lockPath).mtimeMs > 5 * 60_000
          }
        } catch (readError: unknown) {
          stale = (readError as NodeJS.ErrnoException)?.code === 'ENOENT'
        }

        if (stale) {
          try { fs.unlinkSync(lockPath) } catch {}
          continue
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    if (!acquired) {
      throw new Error('Timed out waiting for the shared Zcash wallet command lock.')
    }

    try {
      return await work()
    } finally {
      try { fs.unlinkSync(lockPath) } catch {}
    }
  }

  private async withTenantAccountLock<T>(work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 30_000
    let acquired = false
    while (!acquired && Date.now() < deadline) {
      try {
        const fd = fs.openSync(this.tenantAccountLockPath, 'wx', 0o600)
        try {
          const createdAt = Date.now()
          fs.writeFileSync(fd, JSON.stringify({
            pid: process.pid,
            processInstanceId: PROCESS_INSTANCE_ID,
            createdAt,
            leaseUntil: createdAt + 30_000,
          }), 'utf8')
        } finally {
          fs.closeSync(fd)
        }
        acquired = true
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        let stale = false
        try {
          const lock = JSON.parse(fs.readFileSync(this.tenantAccountLockPath, 'utf8')) as { pid?: unknown; processInstanceId?: unknown; leaseUntil?: unknown }
          if (typeof lock.pid === 'number') {
            const ownerIsThisProcess = lock.processInstanceId === PROCESS_INSTANCE_ID
            const leaseExpired = typeof lock.leaseUntil === 'number' && lock.leaseUntil <= Date.now()
            const legacyLeaseExpired = typeof lock.leaseUntil !== 'number' && Date.now() - fs.statSync(this.tenantAccountLockPath).mtimeMs >= 30_000
            let ownerAlive = true
            try {
              process.kill(lock.pid, 0)
            } catch (probeError: unknown) {
              ownerAlive = (probeError as NodeJS.ErrnoException)?.code !== 'ESRCH'
            }
            stale = !ownerAlive || (!ownerIsThisProcess && (leaseExpired || legacyLeaseExpired) && lock.pid === process.pid)
          } else {
            stale = Date.now() - fs.statSync(this.tenantAccountLockPath).mtimeMs > 30_000
          }
        } catch (readError: unknown) {
          stale = (readError as NodeJS.ErrnoException)?.code === 'ENOENT'
        }
        if (stale) {
          try { fs.unlinkSync(this.tenantAccountLockPath) } catch {}
          continue
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (!acquired) throw new Error('Timed out waiting for the Zcash tenant-account provisioning lock.')
    try {
      return await work()
    } finally {
      try { fs.unlinkSync(this.tenantAccountLockPath) } catch {}
    }
  }

  /** Resolve AuraVault instead of relying on the CLI's implicit account choice. */
  private async resolveDefaultAccountId(): Promise<string> {
    const { stdout, stderr } = await this.runWalletCommand(
      `"${this.exePath}" wallet -w "${this.walletDir}" list-accounts`,
    )
    const output = [stdout, stderr].filter(Boolean).join('\n')
    const accounts = output.split(/(?=^Account )/m).flatMap((block) => {
      const id = block.match(/^Account\s+([0-9a-f-]{36})\b/im)?.[1]
      const name = block.match(/^\s+Name:\s+(.+)$/im)?.[1]?.trim()
      return id ? [{ id, name }] : []
    })
    const treasury = accounts.find((account) => account.name === 'AuraVault')
    if (treasury) return treasury.id
    if (accounts.length === 1) return accounts[0].id
    if (accounts.length === 0) throw new Error('No Zcash Testnet wallet account is available.')
    throw new Error('AuraVault treasury account was not found; refusing ambiguous Zcash account selection.')
  }

  /**
   * Initializes the Zcash Testnet wallet if it does not exist.
   */
  public async ensureWallet(): Promise<{ success: boolean; address?: string; error?: string }> {
    try {
      if (!fs.existsSync(this.walletDir)) {
        fs.mkdirSync(this.walletDir, { recursive: true })
      }

      const keysToml = path.join(this.walletDir, 'keys.toml')
      if (!fs.existsSync(keysToml)) {
        const cmd = `"${this.exePath}" wallet -w "${this.walletDir}" init --name "AuraVault" -i "${this.keyFile}" -n test -s ${this.preferredServer}`
        await this.runWalletCommand(`echo "" | ${cmd}`)
      }

      const addresses = await this.listAddresses()
      return { success: true, address: addresses.unified }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Retrieves the real unified shielded address (utest1...).
   */
  public async listAddresses(accountId?: string): Promise<{ unified?: string; raw?: string }> {
    try {
      if (accountId && !/^[0-9a-f-]{36}$/i.test(accountId)) return {}
      const selectedAccountId = accountId || await this.resolveDefaultAccountId()
      const accountArg = ` ${selectedAccountId}`
      const cmd = `"${this.exePath}" wallet -w "${this.walletDir}" list-addresses${accountArg}`
      const { stdout, stderr } = await this.runWalletCommand(cmd)
      const output = [stdout, stderr].filter(Boolean).join('\n')

      const match = output.match(/(utest1[a-z0-9]+)/i)
      return {
        unified: match ? match[1] : undefined,
        raw: output,
      }
    } catch {
      return {}
    }
  }

  /**
   * Return the explicitly configured shared AuraVault used by the hackathon
   * jury inventory. This keeps account selection in one place and never
   * exposes the wallet identity to the browser.
   */
  public async getSharedSourceAccount(): Promise<{ accountId: string; unified: string }> {
    if (!this.isAvailable()) throw new Error('Zcash Testnet wallet binary is unavailable.')
    const accountId = await this.resolveDefaultAccountId()
    const addresses = await this.listAddresses(accountId)
    if (!addresses.unified) throw new Error('The shared Zcash source account has no unified shielded address.')
    return { accountId, unified: addresses.unified }
  }

  /**
   * Resolve a stable Zcash Testnet account for one Aura tenant when
   * tenant-isolated mode is explicitly enabled. Jury mode uses the shared,
   * pre-funded AURA-operated source and keeps tenant authorization in the
   * server ledger.
   */
  public async ensureTenantAccount(tenantId: string): Promise<{ accountId: string; unified: string }> {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId)) {
      throw new Error('Invalid Aura tenant identifier.')
    }
    const existingTask = this.tenantAccountTasks.get(tenantId)
    if (existingTask) return existingTask

    const task = this.resolveTenantAccount(tenantId)
    this.tenantAccountTasks.set(tenantId, task)
    try {
      return await task
    } catch (error) {
      this.tenantAccountTasks.delete(tenantId)
      throw error
    }
  }

  private async resolveTenantAccount(tenantId: string): Promise<{ accountId: string; unified: string }> {
    if (!this.isAvailable()) throw new Error('Zcash Testnet wallet binary is unavailable.')
    fs.mkdirSync(this.walletDir, { recursive: true })
    return this.withTenantAccountLock(async () => {
      const accountName = `Aura_${createHash('sha256').update(tenantId).digest('hex')}`
      const listAccounts = async () => {
        try {
          const { stdout, stderr } = await this.runWalletCommand(
            `"${this.exePath}" wallet -w "${this.walletDir}" list-accounts`,
          )
          const output = [stdout, stderr].filter(Boolean).join('\n')
          for (const block of output.split(/(?=^Account )/m)) {
            const id = block.match(/^Account\s+([0-9a-f-]{36})\b/im)?.[1]
            const name = block.match(/^\s+Name:\s+(.+)$/im)?.[1]?.trim()
            if (id && name === accountName) return id
          }
        } catch {
          // A temporary wallet read failure should not make us create a second
          // account. The caller will re-check after the provision attempt.
        }
        return undefined
      }

      let accountId = await listAccounts()
      if (!accountId) {
        const createCommand = `"${this.exePath}" wallet -w "${this.walletDir}" generate-account --name "${accountName}" -i "${this.keyFile}" -s ${this.preferredServer}`
        let lastCreateError: unknown = null
        for (let attempt = 0; attempt < 3 && !accountId; attempt += 1) {
          try {
            await this.runWalletCommand(createCommand)
            lastCreateError = null
          } catch (error) {
            lastCreateError = error
          }

          // The command may have committed the account before its network
          // response was lost. Always reconcile locally before retrying.
          accountId = await listAccounts()
          if (accountId) break
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
        if (!accountId && lastCreateError instanceof Error) {
          throw new Error(`Could not create the tenant Zcash Testnet account: ${lastCreateError.message}`)
        }
      }
      if (!accountId) throw new Error('Could not create or find the tenant Zcash Testnet account.')

      const addresses = await this.listAddresses(accountId)
      if (!addresses.unified) throw new Error('The tenant Zcash Testnet account has no unified shielded address.')
      return { accountId, unified: addresses.unified }
    })
  }

  /** Generate and persist the wallet's next genuine diversified testnet address. */
  public async generateFreshAddress(accountId?: string): Promise<string> {
    if (!this.isAvailable()) throw new Error('Zcash wallet binary is unavailable.')
    if (accountId && !/^[0-9a-f-]{36}$/i.test(accountId)) {
      throw new Error('Invalid Zcash account identifier.')
    }
    const accountArg = accountId ? ` ${accountId}` : ''
    const cmd = `"${this.exePath}" wallet -w "${this.walletDir}" generate-address${accountArg}`
    const { stdout, stderr } = await this.runWalletCommand(cmd)
    const output = [stdout, stderr].filter(Boolean).join('\n')
    const match = output.match(/Address:\s*(utest1[a-z0-9]+)/i)
    if (!match) throw new Error('Zcash wallet did not return a valid testnet address.')
    return match[1]
  }

  /**
   * Scans and syncs blocks live from testnet.zec.rocks:443.
   */
  public async sync(force = false): Promise<{ success: boolean; output: string; blockHeight?: number }> {
    if (this.syncInFlight) return this.syncInFlight
    if (!force && this.lastSyncResult && Date.now() - this.lastSyncAt < 15_000) return this.lastSyncResult

    const task = this.performSync()
    this.syncInFlight = task
    try {
      const result = await task
      this.lastSyncAt = Date.now()
      this.lastSyncResult = result
      return result
    } finally {
      if (this.syncInFlight === task) this.syncInFlight = null
    }
  }

  private async performSync(): Promise<{ success: boolean; output: string; blockHeight?: number }> {
    try {
      const { stdout, stderr } = await this.runReadCommand((server) =>
        `"${this.exePath}" wallet -w "${this.walletDir}" sync -s ${server}`,
      )
      // The Rust helper may send tracing output to stderr even when the sync
      // succeeds. Keep both streams so health/preflight can report the real
      // scanned tip instead of showing a misleading null block height.
      const output = [stdout, stderr].filter(Boolean).join('\n')
      const heightMatch = output.match(/Latest block height is (\d+)/i)
      const blockHeight = heightMatch ? parseInt(heightMatch[1], 10) : undefined
      return { success: true, output, blockHeight }
    } catch (err: unknown) {
      return { success: false, output: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Retrieves verified shielded and transparent balance on Zcash Testnet.
   */
  public async getBalance(accountId?: string, minConfirmations = 1): Promise<{
    available: boolean
    orchardSpendable: number
    saplingSpendable: number
    ironwoodSpendable: number
    unshieldedSpendable: number
    totalSpendable: number
    poolBreakdownAvailable: boolean
    chainHeight?: number
  }> {
    try {
      if (accountId && !/^[0-9a-f-]{36}$/i.test(accountId)) return {
        available: false,
        orchardSpendable: 0, saplingSpendable: 0, ironwoodSpendable: 0,
        unshieldedSpendable: 0, totalSpendable: 0, poolBreakdownAvailable: false,
      }
      if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 1_000_000) return {
        available: false,
        orchardSpendable: 0, saplingSpendable: 0, ironwoodSpendable: 0,
        unshieldedSpendable: 0, totalSpendable: 0, poolBreakdownAvailable: false,
      }
      const selectedAccountId = accountId || await this.resolveDefaultAccountId()
      const accountArg = ` ${selectedAccountId}`
      const cmd = `"${this.exePath}" wallet -w "${this.walletDir}" balance${accountArg} --min-confirmations ${minConfirmations} --json`
      const { stdout } = await this.runWalletCommand(cmd)
      const balance = JSON.parse(stdout) as {
        orchard_spendable?: unknown
        sapling_spendable?: unknown
        ironwood_spendable?: unknown
        transparent_spendable?: unknown
        /** Older/newer devtool builds may expose the aggregate spendable value only. */
        total?: unknown
        chain_tip_height?: unknown
      }
      const parseZats = (value: unknown): number => {
        if (value === undefined) return 0
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
          throw new Error('Zcash wallet returned an invalid spendable balance.')
        }
        return value as number
      }
      const orchardSpendable = parseZats(balance.orchard_spendable) / 1e8
      const saplingSpendable = parseZats(balance.sapling_spendable) / 1e8
      const ironwoodSpendable = parseZats(balance.ironwood_spendable) / 1e8
      const unshieldedSpendable = parseZats(balance.transparent_spendable) / 1e8
      const aggregateSpendable = balance.total === undefined ? 0 : parseZats(balance.total) / 1e8
      // Some devtool builds always emit the pool keys as zero even when the
      // only authoritative value is the aggregate `total`. Treat that shape
      // as aggregate-only; a positive transparent pool must never be counted
      // as shielded spendable.
      const hasPositivePoolValue = [
        orchardSpendable,
        saplingSpendable,
        ironwoodSpendable,
        unshieldedSpendable,
      ].some((value) => value > 0)
      const hasPoolBreakdown = balance.total === undefined || hasPositivePoolValue
      if (balance.chain_tip_height !== undefined &&
        (!Number.isSafeInteger(balance.chain_tip_height) || (balance.chain_tip_height as number) < 0)) {
        throw new Error('Zcash wallet returned an invalid chain tip height.')
      }
      const chainHeight = balance.chain_tip_height as number | undefined

      const totalSpendable = Number((hasPoolBreakdown
        ? orchardSpendable + saplingSpendable + ironwoodSpendable + unshieldedSpendable
        : aggregateSpendable).toFixed(8))

      return {
        available: true,
        orchardSpendable,
        saplingSpendable,
        ironwoodSpendable,
        unshieldedSpendable,
        totalSpendable,
        poolBreakdownAvailable: hasPoolBreakdown,
        chainHeight,
      }
    } catch {
      return {
        available: false,
        orchardSpendable: 0,
        saplingSpendable: 0,
        ironwoodSpendable: 0,
        unshieldedSpendable: 0,
        totalSpendable: 0,
        poolBreakdownAvailable: false,
      }
    }
  }

  /**
   * Ask the same wallet proposal builder used by `wallet send` for the exact
   * ZIP-317 fee for this account/recipient/amount. Fixed reserves are not
   * sufficient when input selection or change splitting changes the action
   * count.
   */
  public async estimateShieldedFeeZec(
    accountId: string | undefined,
    recipientAddress: string,
    amountZec: number,
    minConfirmations = 1,
  ): Promise<number | null> {
    if ((accountId && !/^[0-9a-f-]{36}$/i.test(accountId)) || !/^(?:utest1|u1)[a-z0-9]{30,350}$/.test(recipientAddress)) return null
    if (!Number.isFinite(amountZec) || amountZec <= 0 || !Number.isSafeInteger(minConfirmations) || minConfirmations < 1) return null
    try {
      const value = Math.round(amountZec * 1e8)
      const selectedAccountId = accountId || await this.resolveDefaultAccountId()
      // `wallet propose` is a read-only fee preview. The bundled devtool's
      // propose subcommand uses its standard confirmation policy and does not
      // accept the send command's `--min-confirmations` flag. Passing it here
      // makes every proposal fail before fee parsing, which falsely blocks the
      // demo route as unavailable.
      const cmd = `"${this.exePath}" wallet -w "${this.walletDir}" propose ${selectedAccountId} --address "${recipientAddress}" --value ${value}`
      const { stdout, stderr } = await this.runWalletCommand(cmd)
      const output = [stdout, stderr].filter(Boolean).join('\n')
      // zcash-devtool labels testnet values as TAZ (the same ZEC-denominated
      // unit). Mainnet-style output may use ZEC, so accept both formats.
      const match = output.match(/\bFee:\s*([0-9]+(?:\.[0-9]+)?)\s*(?:ZEC|TAZ)\b/i)
      const fee = match ? Number(match[1]) : NaN
      return Number.isFinite(fee) && fee >= 0 ? fee : null
    } catch {
      return null
    }
  }

  /**
   * Broadcast a shielded spend through the same ordered server pool used by
   * reads. A second endpoint is tried only after a clearly pre-broadcast
   * connection failure; uncertain wallet/network responses are never replayed.
   */
  private async runShieldedSendWithFallback(
    commandForServer: (server: string) => string,
    memo: string,
  ): Promise<{ stdout?: string; recoveredTxid?: string }> {
    const servers = this.getWriteServers()
    let lastError: unknown
    for (let index = 0; index < servers.length; index += 1) {
      const server = servers[index]
      try {
        const result = await this.runWalletCommand(commandForServer(server))
        this.preferredServer = server
        return { stdout: result.stdout }
      } catch (error: unknown) {
        lastError = error
        // A response can be lost after the wallet accepted the transaction.
        // Reconcile the exact memo before considering another endpoint.
        const recoveredTxid = await this.findBroadcastTxidByMemo(memo)
        if (recoveredTxid) return { recoveredTxid }
        if (index >= servers.length - 1 || !isSafeZcashWriteRetry(error)) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('All configured Zcash write servers failed.')
  }

  /**
   * Executes a real shielded Zcash transaction using PCZT creation, ZK-proving (Halo2/Groth16),
   * signing and broadcasting to testnet.zec.rocks:443.
   */
  public async sendShielded(
    recipientAddress: string,
    amountZec: number,
    memo = 'Aura Shielded Settlement',
    beforeBroadcast?: () => void | Promise<void>,
    senderAccountId?: string,
    minConfirmations = 1,
  ): Promise<ZcashShieldResult> {
    let broadcastAttempted = false
    let temporaryDirectory: string | undefined
    try {
      // Prevent shell metacharacters from reaching the command assembled below.
      if (!/^(?:utest1|u1)[a-z0-9]{30,350}$/.test(recipientAddress)) {
        return { success: false, error: 'Invalid Zcash unified receiver address' }
      }
      if (senderAccountId && !/^[0-9a-f-]{36}$/i.test(senderAccountId)) {
        return { success: false, error: 'Invalid Zcash sender account identifier' }
      }
      if (!Number.isSafeInteger(minConfirmations) || minConfirmations < 1 || minConfirmations > 1_000_000) {
        return { success: false, error: 'Invalid Zcash minimum confirmations' }
      }
      if (!Number.isFinite(amountZec) || amountZec <= 0 || !Number.isSafeInteger(Math.round(amountZec * 1e8))) {
        return { success: false, error: 'Invalid Zcash amount' }
      }
      if (typeof memo !== 'string' || memo.length > 512 || !/^[a-zA-Z0-9 .,:_-]*$/.test(memo)) {
        return { success: false, error: 'Invalid Zcash memo' }
      }
      const amountZats = Math.round(amountZec * 1e8)
      const selectedSenderAccountId = senderAccountId || await this.resolveDefaultAccountId()
      const senderAccountArg = ` ${selectedSenderAccountId}`

      // The devtool derives the transaction expiry from the wallet's current
      // chain tip. A cached/stale tip can create a transaction that is already
      // expired when it reaches lightwalletd, especially during recovery
      // retries. Force a fresh sync immediately before every real broadcast;
      // if the current tip cannot be established, do not spend or guess.
      const freshSync = await this.sync(true)
      if (!freshSync.success || !Number.isSafeInteger(freshSync.blockHeight)) {
        return {
          success: false,
          error: 'Zcash wallet could not refresh its chain tip before broadcast.',
          amountZec,
          memo,
        }
      }

      await beforeBroadcast?.()
      broadcastAttempted = true

      const { stdout = '', recoveredTxid } = await this.runShieldedSendWithFallback(
        (server) => `"${this.exePath}" wallet -w "${this.walletDir}" send --identity "${this.keyFile}" --address "${recipientAddress}" --value ${amountZats} --memo "${memo}" --min-confirmations ${minConfirmations} -s ${server}${senderAccountArg}`,
        memo,
      )

      if (recoveredTxid) {
        return {
          success: true,
          txid: recoveredTxid,
          explorerUrl: `https://testnet.cipherscan.app/tx/${recoveredTxid}`,
          amountZec,
          memo,
        }
      }

      const txid = extractBroadcastTxid(stdout)

      if (txid) {
        return {
          success: true,
          txid,
          explorerUrl: `https://testnet.cipherscan.app/tx/${txid}`,
          amountZec,
          memo,
        }
      }

      const preparedTxid = extractPreparedTxid(stdout)
      if (preparedTxid) {
        return {
          success: false,
          broadcastUncertain: true,
          txid: preparedTxid,
          explorerUrl: `https://testnet.cipherscan.app/tx/${preparedTxid}`,
          error: 'The prepared Zcash transaction has an uncertain broadcast result.',
          amountZec,
          memo,
        }
      }

      // A lost CLI response is recoverable without broadcasting again: the
      // wallet records the exact operation memo once the network accepted it.
      const recordedTxid = await this.findBroadcastTxidByMemo(memo)
      if (recordedTxid) {
        return {
          success: true,
          txid: recordedTxid,
          explorerUrl: `https://testnet.cipherscan.app/tx/${recordedTxid}`,
          amountZec,
          memo,
        }
      }

      return {
        success: false,
        broadcastUncertain: true,
        error: stdout || 'Failed to extract transaction ID from Zcash network broadcast.',
      }
    } catch (err: unknown) {
      const error = err as Error & { killed?: boolean; signal?: string | null }
      const message = error instanceof Error ? error.message : String(err)
      const commandOutput = [
        typeof (error as unknown as { stdout?: unknown }).stdout === 'string' ? (error as unknown as { stdout: string }).stdout : '',
        typeof (error as unknown as { stderr?: unknown }).stderr === 'string' ? (error as unknown as { stderr: string }).stderr : '',
      ].filter(Boolean).join('\n')
      const preparedTxid = extractPreparedTxid(commandOutput)
      const isDefinitePreBroadcastFailure = !preparedTxid && isSafeZcashWriteRetry(error)
      const broadcastUncertain = !isDefinitePreBroadcastFailure && (
        Boolean(preparedTxid) || (broadcastAttempted && this.isBroadcastUncertainError(`${message}\n${commandOutput}`, error))
      )
      return {
        success: false,
        broadcastUncertain,
        txid: preparedTxid,
        explorerUrl: preparedTxid ? `https://testnet.cipherscan.app/tx/${preparedTxid}` : undefined,
        error: message,
        amountZec,
        memo,
      }
    } finally {
      if (temporaryDirectory) {
        try {
          fs.rmSync(temporaryDirectory, { recursive: true, force: true })
        } catch (cleanupError) {
          console.error('Could not remove temporary Zcash transaction files:', cleanupError)
        }
      }
    }
  }

  private isBroadcastUncertainError(message: string, error?: { killed?: boolean; signal?: string | null }): boolean {
    if (error?.killed || error?.signal) return true
    return /timeout|timed out|network|rpc|connection|transport|broken pipe|eof|reset|aborted|lightwalletd|broadcast|send transaction/i.test(message)
  }

  /** Looks up an exact operation memo in the durable wallet transaction list. */
  public async findBroadcastTxidByMemo(memo: string): Promise<string | undefined> {
    if (!memo || memo.length > 512 || !this.isAvailable()) return undefined
    try {
      const { stdout } = await this.runReadCommand(() =>
        `"${this.exePath}" wallet -w "${this.walletDir}" list-tx`,
      )
      return extractTxidForMemo(stdout, memo)
    } catch {
      return undefined
    }
  }

  private async listWalletTransactionsJson(): Promise<ZcashWalletTransactionRecord[]> {
    const { stdout } = await this.runWalletCommand(
      `"${this.exePath}" wallet -w "${this.walletDir}" list-tx --json`,
    )
    return parseZcashListTxJson(stdout)
  }

  private async getExactWalletTransactionText(txid: string): Promise<string | undefined> {
    const { stdout } = await this.runWalletCommand(
      `"${this.exePath}" wallet -w "${this.walletDir}" list-tx`,
    )
    return extractExactZcashTransactionText(stdout, txid)
  }

  /**
   * Verifies on-chain confirmation on Zcash Testnet Explorer.
   */
  public async verifyConfirmation(txid: string, requiredConfirmations = getZcashSettlementSafetyConfirmations()): Promise<ZcashConfirmationResult> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) return { confirmed: false, state: 'unknown' }
    const required = Number.isSafeInteger(requiredConfirmations) && requiredConfirmations >= 1 ? requiredConfirmations : getZcashSettlementSafetyConfirmations()
    try {
      // 1. Check the exact txid in the wallet's machine-readable history.
      // Never search from one txid to the next: that can attach another
      // transaction's mined block to an unmined target.
      try {
        const records = await this.listWalletTransactionsJson()
        const record = records.find((candidate) => typeof candidate.txid === 'string' && candidate.txid.toLowerCase() === txid.toLowerCase())
        if (record) {
          if (typeof record.mined_height === 'number' && Number.isSafeInteger(record.mined_height) && record.mined_height > 0) {
            const explicitConfirmations = typeof record.confirmations === 'number' && Number.isSafeInteger(record.confirmations)
              ? record.confirmations
              : undefined
            let chainTip: number | undefined
            if (explicitConfirmations === undefined) {
              // Some bundled zcash-devtool builds complete sync successfully
              // but emit no human-readable height line. Fall back to the
              // machine-readable balance response instead of turning a mined
              // transaction into a permanent zero-confirmation state.
              chainTip = (await this.sync()).blockHeight
              if (chainTip === undefined) {
                chainTip = (await this.getBalance()).chainHeight
              }
            }
            const confirmations = explicitConfirmations ?? (chainTip !== undefined ? Math.max(0, chainTip - record.mined_height + 1) : 0)
            return {
              confirmed: confirmations >= required,
              state: confirmations >= required ? 'confirmed' : 'mined',
              blockHeight: record.mined_height,
              confirmations,
              requiredConfirmations: required,
            }
          }
          if (record.expired_unmined === true) {
            return {
              confirmed: false,
              state: 'expired',
              expiryHeight: typeof record.expiry_height === 'number' ? record.expiry_height : undefined,
            }
          }

          // Some lightwalletd/devtool combinations keep the transaction in
          // history with `expired_unmined: false` even after the expiry
          // height has passed. Do not leave the durable reconciler waiting
          // forever on that stale flag: an unmined transaction whose expiry
          // height is below the current chain tip is definitively expired.
          const expiryHeight = typeof record.expiry_height === 'number' && Number.isSafeInteger(record.expiry_height)
            ? record.expiry_height
            : undefined
          if (record.mined_height == null && expiryHeight !== undefined) {
            const sync = await this.sync().catch(() => ({ success: false, blockHeight: undefined }))
            if (sync.success && typeof sync.blockHeight === 'number' && sync.blockHeight > expiryHeight) {
              return { confirmed: false, state: 'expired', expiryHeight }
            }
          }

          // Older bundled binaries may omit expiry metadata from --json. Use
          // only this transaction's text block as a compatibility fallback.
          const exactText = await this.getExactWalletTransactionText(txid).catch(() => undefined)
          if (exactText && /\bExpired\b/i.test(exactText)) {
            const expiry = exactText.match(/expiry height:\s*(\d+)/i)?.[1]
            return { confirmed: false, state: 'expired', expiryHeight: expiry ? Number(expiry) : undefined }
          }
          return { confirmed: false, state: 'pending' }
        }
      } catch {}

      // 2. Check remote explorers only when the wallet does not know the tx.
      // One public explorer going down must not turn a real transaction into
      // a false failure, so try the live CipherScan API before the legacy
      // zec.rocks endpoint.
      const remoteEndpoints = [
        `https://api.testnet.cipherscan.app/api/tx/${txid}`,
        `https://explorer.testnet.zec.rocks/api/tx/${txid}`,
      ]
      let sawPendingRemoteTransaction = false
      for (const endpoint of remoteEndpoints) {
        try {
          const res = await fetch(endpoint, { signal: AbortSignal.timeout(4000) })
          if (!res.ok) continue
          const data = await res.json()
          const confirmations = [
            data?.confirmations,
            data?.confirmationCount,
            data?.confirmation_count,
          ].find((value) => Number.isSafeInteger(value) && value > 0)
          const blockHeight = [
            data?.blockheight,
            data?.blockHeight,
            data?.block_height,
            data?.block?.height,
          ].find((value) => Number.isSafeInteger(value) && value > 0)
          if (Number.isSafeInteger(confirmations) && confirmations > 0) {
            return {
              confirmed: confirmations >= required,
              state: confirmations >= required ? 'confirmed' : 'mined',
              blockHeight: Number.isSafeInteger(blockHeight) ? blockHeight : undefined,
              confirmations,
              requiredConfirmations: required,
            }
          }
          sawPendingRemoteTransaction = true
        } catch {}
      }
      return sawPendingRemoteTransaction
        ? { confirmed: false, state: 'pending' }
        : { confirmed: false, state: 'unknown' }
    } catch {
      return { confirmed: false, state: 'unknown' }
    }
  }
}

export const zcashDevtoolService = new ZcashDevtoolService()
