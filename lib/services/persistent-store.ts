/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

// Safe dynamic resolution so client bundles don't fail when imported across boundaries
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeFs: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodePath: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nodeCrypto: any = null

if (typeof window === 'undefined') {
  try {
    nodeFs = eval('require')('fs')
    nodePath = eval('require')('path')
    nodeCrypto = eval('require')('crypto')
  } catch {
    nodeFs = null
    nodePath = null
  }
}

import { AuraTransaction, AssetSymbol, ChainId, PrivacyBufferMode, PrivacyRiskSnapshot } from '../types/aura'
import { reconcileLedgerBalanceWithShieldedChain } from './authoritative-balance'
import { hasCompletedDestinationDelivery, hasConfirmedShieldedSource } from '../utils/transaction-finality'

const PROCESS_INSTANCE_ID = nodeCrypto
  ? (typeof nodeCrypto.randomUUID === 'function'
    ? nodeCrypto.randomUUID()
    : nodeCrypto.randomBytes(16).toString('hex'))
  : 'browser-process'
const DURABLE_LOCK_LEASE_MS = 2 * 60 * 1000

export interface SharedRateLimitResult {
  allowed: boolean
  remaining: number
  retryAfter?: number
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Write JSON to a private temp file, flush it, then publish it atomically. */
function writeJsonAtomicallyDurable(filePath: string, value: unknown): void {
  if (!nodeFs || !nodeCrypto) throw new Error('Durable filesystem storage is unavailable.')
  const tempPath = `${filePath}.tmp.${nodeCrypto.randomBytes(8).toString('hex')}`
  let fd: number | undefined
  try {
    fd = nodeFs.openSync(tempPath, 'wx', 0o600)
    nodeFs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8')
    nodeFs.fsyncSync(fd)
    nodeFs.closeSync(fd)
    fd = undefined
    nodeFs.renameSync(tempPath, filePath)
  } catch (error) {
    if (fd !== undefined) {
      try { nodeFs.closeSync(fd) } catch {}
    }
    try { if (nodeFs.existsSync(tempPath)) nodeFs.unlinkSync(tempPath) } catch {}
    throw error
  }
}

export interface StoredPaymentRequest {
  id: string
  amount?: number
  /** USD price frozen when the invoice was created, used for SOL amount verification. */
  rateUsdAtCreation?: number
  /** Minimum amount for bearer-style open requests; fixed requests do not use it. */
  minimumAmount?: number
  asset?: AssetSymbol
  chain?: ChainId
  status: 'active' | 'consumed' | 'expired'
  createdAt: number
  expiresAt: number
  /** Set when the public payment page is opened or the owner explicitly shares the link. */
  sharedAt?: number
  /** Base block captured when the invoice was created; bounds crash recovery scans. */
  sourceStartBlock?: number
  /** Optional payer binding for open-amount requests. */
  payerAddress?: string
  payerPreparedAt?: number
  payerPreparedBlock?: number
  /** Open-amount payer binding lease; it prevents a permanent first-visitor lock. */
  payerBindingExpiresAt?: number
  revokedAt?: number
  consumedAt?: number
  txHash?: string
  clientProof?: string
  merchantName?: string
  itemDescription?: string
  enclaveFingerprint?: string
  ownerTokenHash?: string
  shieldedReceiver: string
  /** Zcash account selected for the receiver; prevents cross-tenant credits. */
  zcashAccountId?: string
  /** Policy selected by the request owner; receive maturity must use the same policy. */
  bufferMode?: PrivacyBufferMode
}

/**
 * A short-lived settlement quote must survive a worker restart long enough
 * for the client to submit its signed spend. It contains no secret material;
 * it is only the server's signed-input binding and its expiry/consumption
 * state.
 */
export interface StoredSettlementQuote {
  quoteId: string
  tenantId: string
  amountUsd: number
  amountZec: number
  amountSol?: number
  asset: AssetSymbol
  chain: ChainId
  transactionType: 'send' | 'withdraw'
  bufferMode: string
  zecUsd: number
  solUsd?: number
  issuedAt: number
  expiresAt: number
  privacyRiskSnapshot: PrivacyRiskSnapshot
  usedAt?: number
}

export type DurableOperationKind = 'deposit_shield' | 'invoice_shield' | 'spend_shield' | 'destination_payout' | 'deposit_backing'
export type DurableOperationStatus = 'prepared' | 'broadcasting' | 'broadcasted' | 'confirmed' | 'recovery_required'

/**
 * Durable intent for an external effect. It is written before a chain call so
 * a process crash cannot leave a real broadcast without the fields needed to
 * recover it. The transaction is a draft until the corresponding chain id is
 * attached; it contains no secret material.
 */
export interface StoredDurableOperation {
  id: string
  kind: DurableOperationKind
  status: DurableOperationStatus
  tenantId: string
  txId: string
  createdAt: number
  updatedAt: number
  transaction: AuraTransaction
  requestId?: string
  sourceTxHash?: string
  paymentTxHash?: string
  memo?: string
  amountUsd?: number
  amountZec?: number
  recipientAddress?: string
  destinationChain?: ChainId
  zcashTxid?: string
  expectedSignature?: string
  expectedTxHash?: string
  expectedNonce?: string
  senderAddress?: string
  recentBlockhash?: string
  /** Account that funds the external Zcash send; needed for restart recovery. */
  senderAccountId?: string
  /** Monotonic retry identity prevents an expired attempt from matching a new one. */
  attemptNumber?: number
  attemptId?: string
}

export interface DemoDepositBinding {
  tenantId: string
  amountUsd: number
  senderAddress: string
  clientId: string
  createdAt: number
}

interface JurySessionAssignment {
  tenantId: string
  expiresAt: number
}

export type ConsumeResult =
  | { success: true; request: StoredPaymentRequest }
  | { success: false; error: 'NOT_FOUND' | 'ALREADY_CONSUMED' | 'EXPIRED' | 'AMOUNT_MISMATCH' | 'ASSET_MISMATCH' | 'CHAIN_MISMATCH' | 'TX_ALREADY_USED'; request?: StoredPaymentRequest }

function normalizePaymentTxHash(txHash: string): string {
  const trimmed = txHash.trim()
  // EVM hashes are case-insensitive hex; Solana signatures are case-sensitive base58.
  return /^0x[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code !== 'ESRCH' && code !== 'EINVAL'
  }
}

export class PersistentStore {
  private dataDir: string
  private ledgerFilePath: string
  private requestsFilePath: string
  private spendKeysFilePath: string
  private recoveryKeysFilePath: string
  private authKeysLockPath: string
  private authNoncesDirectoryPath: string
  private paymentTxClaimsDirectoryPath: string
  private paymentRequestClaimsDirectoryPath: string
  private settlementClaimsDirectoryPath: string
  private ledgerWriteLockPath: string
  private externalBroadcastLockPath: string
  private requestsWriteLockPath: string
  private demoBudgetFilePath: string
  private demoBudgetLockPath: string
  private jurySessionAssignmentsFilePath: string
  private jurySessionAssignmentsLockPath: string
  private demoDepositBindingsFilePath: string
  private settlementQuotesFilePath: string
  private settlementQuotesWriteLockPath: string
  private pendingOperationsFilePath: string
  private pendingOperationsWriteLockPath: string
  private sharedRateLimitsFilePath: string
  private sharedRateLimitsLockPath: string
  private sharedCacheFilePath: string
  private sharedCacheLockPath: string

  private memoryLedgerCache: Record<string, AuraTransaction[]> | null = null
  private memoryRequestsCache: Record<string, StoredPaymentRequest> | null = null
  private memorySettlementQuotesCache: Record<string, StoredSettlementQuote> | null = null
  private memoryPendingOperationsCache: Record<string, StoredDurableOperation> | null = null
  private consumingIds = new Set<string>()
  private processingPaymentRequestIds = new Set<string>()
  private processingPaymentTxHashes = new Set<string>()
  private processingSettlementKeys = new Set<string>()

  /**
   * Acquire an exclusive durable claim. If the previous owner process has
   * exited, recover its claim so a restart can resume pending work. A live
   * owner is never displaced, which keeps concurrent settlement at-most-once.
   */
  private acquireDurableClaim(claimPath: string, claimData: Record<string, unknown>): boolean {
    const acquire = () => {
      const fd = nodeFs.openSync(claimPath, 'wx', 0o600)
      try {
        const createdAt = Date.now()
        nodeFs.writeFileSync(fd, JSON.stringify({
          ...claimData,
          pid: process.pid,
          processInstanceId: PROCESS_INSTANCE_ID,
          createdAt,
          leaseUntil: createdAt + DURABLE_LOCK_LEASE_MS,
        }), 'utf-8')
      } finally {
        nodeFs.closeSync(fd)
      }
    }

    try {
      acquire()
      return true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        console.error('Failed to acquire durable operation claim:', error)
        return false
      }
    }

    let canRecover = false
    try {
      const raw = nodeFs.readFileSync(claimPath, 'utf-8')
      const existing = JSON.parse(raw) as {
        pid?: unknown
        processInstanceId?: unknown
        leaseUntil?: unknown
        externalEffectMayHaveStarted?: unknown
      }
      // Once a chain broadcast might have started, a dead process is not proof
      // that nothing was sent. Keep this claim fail-closed to prevent a retry
      // from broadcasting a duplicate payout.
      if (existing.externalEffectMayHaveStarted === true) return false
      if (typeof existing.pid === 'number' && Number.isSafeInteger(existing.pid)) {
        const ownerAlive = isProcessAlive(existing.pid)
        const ownerIsThisProcess = existing.processInstanceId === PROCESS_INSTANCE_ID
        const leaseExpired = typeof existing.leaseUntil === 'number' && existing.leaseUntil <= Date.now()
        const legacyLeaseExpired = typeof existing.leaseUntil !== 'number' && Date.now() - nodeFs.statSync(claimPath).mtimeMs >= DURABLE_LOCK_LEASE_MS
        // A PID can be reused after a container restart. The instance id and
        // lease prevent the new process from mistaking that reused PID for
        // the old owner. External-effect claims remain fail-closed above.
        canRecover = !ownerAlive || (!ownerIsThisProcess && (leaseExpired || legacyLeaseExpired))
      } else {
        // Compatibility with pre-owner or malformed claim files: only recover
        // after a conservative grace period so a partial write is not stolen.
        canRecover = Date.now() - nodeFs.statSync(claimPath).mtimeMs >= 10 * 60 * 1000
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        canRecover = true
      } else {
        try {
          canRecover = Date.now() - nodeFs.statSync(claimPath).mtimeMs >= 10 * 60 * 1000
        } catch (statError: unknown) {
          if ((statError as NodeJS.ErrnoException)?.code === 'ENOENT') canRecover = true
        }
      }
    }
    if (!canRecover) return false
    try {
      nodeFs.unlinkSync(claimPath)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return false
    }

    try {
      acquire()
      return true
    } catch {
      // Another process won the claim after stale-lock recovery.
      return false
    }
  }

  private withDurableLock<T>(lockPath: string, operation: () => T): T | undefined {
    if (!nodeFs || !this.acquireDurableClaim(lockPath, { operation: 'pinned_auth_update' })) return undefined
    try {
      return operation()
    } finally {
      try { nodeFs.unlinkSync(lockPath) } catch {}
    }
  }

  /** Cross-process lock for nonce allocation through broadcast persistence. */
  public async withExternalBroadcastLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!nodeFs) return operation()
    const deadline = Date.now() + 30_000
    while (!this.acquireDurableClaim(this.externalBroadcastLockPath, { operation: 'external_broadcast' })) {
      if (Date.now() >= deadline) throw new Error('EXTERNAL_BROADCAST_LOCK_BUSY')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    try {
      return await operation()
    } finally {
      try { nodeFs.unlinkSync(this.externalBroadcastLockPath) } catch {}
    }
  }

  /**
   * Serialize every ledger read-modify-write operation across server
   * processes. Reserving a spend alone is not enough: a concurrent status
   * update or rollback must not write an older ledger snapshot over it.
   */
  private withLedgerWriteLock<T>(operation: () => T): T {
    if (!nodeFs) return operation()
    if (!this.acquireDurableClaim(this.ledgerWriteLockPath, { operation: 'ledger_write' })) {
      throw new Error('LEDGER_BUSY')
    }
    try {
      return operation()
    } finally {
      try { nodeFs.unlinkSync(this.ledgerWriteLockPath) } catch {}
    }
  }

  /**
   * Serialize payment-request read/modify/write transactions across server
   * processes. Per-invoice claims prevent duplicate settlement, but they do
   * not stop two different invoices from overwriting each other's snapshot.
   */
  private withRequestsWriteLock<T>(operation: () => T): T {
    if (!nodeFs) return operation()
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = this.withDurableLock(this.requestsWriteLockPath, () => {
        // Never use a snapshot read before the cross-process lock is held.
        this.memoryRequestsCache = null
        return operation()
      })
      if (result !== undefined) return result
      Atomics.wait(waitBuffer, 0, 0, 5)
    }
    throw new Error('REQUEST_STORE_BUSY')
  }

  constructor(storageDirectory?: string) {
    const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '.'
    const configuredDataDir = typeof process !== 'undefined' ? process.env.AURA_DATA_DIR : undefined
    this.dataDir = storageDirectory || (
      nodePath
        ? nodePath.resolve(configuredDataDir || nodePath.join(cwd, '.aura-data'))
        : '.aura-data'
    )
    this.ledgerFilePath = nodePath ? nodePath.join(this.dataDir, 'ledger.json') : '.aura-data/ledger.json'
    this.requestsFilePath = nodePath ? nodePath.join(this.dataDir, 'requests.json') : '.aura-data/requests.json'
    this.spendKeysFilePath = nodePath ? nodePath.join(this.dataDir, 'spend-keys.json') : '.aura-data/spend-keys.json'
    this.recoveryKeysFilePath = nodePath ? nodePath.join(this.dataDir, 'recovery-keys.json') : '.aura-data/recovery-keys.json'
    this.authKeysLockPath = nodePath ? nodePath.join(this.dataDir, 'auth-keys.lock') : '.aura-data/auth-keys.lock'
    this.authNoncesDirectoryPath = nodePath ? nodePath.join(this.dataDir, 'auth-nonces') : '.aura-data/auth-nonces'
    this.paymentTxClaimsDirectoryPath = nodePath ? nodePath.join(this.dataDir, 'payment-tx-claims') : '.aura-data/payment-tx-claims'
    this.paymentRequestClaimsDirectoryPath = nodePath ? nodePath.join(this.dataDir, 'payment-request-claims') : '.aura-data/payment-request-claims'
    this.settlementClaimsDirectoryPath = nodePath ? nodePath.join(this.dataDir, 'settlement-claims') : '.aura-data/settlement-claims'
    this.ledgerWriteLockPath = nodePath ? nodePath.join(this.dataDir, 'ledger-write.lock') : '.aura-data/ledger-write.lock'
    this.externalBroadcastLockPath = nodePath ? nodePath.join(this.dataDir, 'external-broadcast.lock') : '.aura-data/external-broadcast.lock'
    this.requestsWriteLockPath = nodePath ? nodePath.join(this.dataDir, 'requests-write.lock') : '.aura-data/requests-write.lock'
    this.demoBudgetFilePath = nodePath ? nodePath.join(this.dataDir, 'demo-budget.json') : '.aura-data/demo-budget.json'
    this.demoBudgetLockPath = nodePath ? nodePath.join(this.dataDir, 'demo-budget.lock') : '.aura-data/demo-budget.lock'
    this.jurySessionAssignmentsFilePath = nodePath ? nodePath.join(this.dataDir, 'jury-session-assignments.json') : '.aura-data/jury-session-assignments.json'
    this.jurySessionAssignmentsLockPath = nodePath ? nodePath.join(this.dataDir, 'jury-session-assignments.lock') : '.aura-data/jury-session-assignments.lock'
    this.demoDepositBindingsFilePath = nodePath ? nodePath.join(this.dataDir, 'demo-deposit-bindings.json') : '.aura-data/demo-deposit-bindings.json'
    this.settlementQuotesFilePath = nodePath ? nodePath.join(this.dataDir, 'settlement-quotes.json') : '.aura-data/settlement-quotes.json'
    this.settlementQuotesWriteLockPath = nodePath ? nodePath.join(this.dataDir, 'settlement-quotes-write.lock') : '.aura-data/settlement-quotes-write.lock'
    this.pendingOperationsFilePath = nodePath ? nodePath.join(this.dataDir, 'pending-operations.json') : '.aura-data/pending-operations.json'
    this.pendingOperationsWriteLockPath = nodePath ? nodePath.join(this.dataDir, 'pending-operations-write.lock') : '.aura-data/pending-operations-write.lock'
    this.sharedRateLimitsFilePath = nodePath ? nodePath.join(this.dataDir, 'shared-rate-limits.json') : '.aura-data/shared-rate-limits.json'
    this.sharedRateLimitsLockPath = nodePath ? nodePath.join(this.dataDir, 'shared-rate-limits.lock') : '.aura-data/shared-rate-limits.lock'
    this.sharedCacheFilePath = nodePath ? nodePath.join(this.dataDir, 'shared-cache.json') : '.aura-data/shared-cache.json'
    this.sharedCacheLockPath = nodePath ? nodePath.join(this.dataDir, 'shared-cache.lock') : '.aura-data/shared-cache.lock'
    this.ensureInitialized()
  }

  private ensureInitialized() {
    if (!nodeFs) return
    try {
      if (!nodeFs.existsSync(this.dataDir)) {
        nodeFs.mkdirSync(this.dataDir, { recursive: true })
      }
      if (!nodeFs.existsSync(this.ledgerFilePath)) {
        nodeFs.writeFileSync(this.ledgerFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.requestsFilePath)) {
        nodeFs.writeFileSync(this.requestsFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.spendKeysFilePath)) {
        nodeFs.writeFileSync(this.spendKeysFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.recoveryKeysFilePath)) {
        nodeFs.writeFileSync(this.recoveryKeysFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.demoBudgetFilePath)) {
        nodeFs.writeFileSync(this.demoBudgetFilePath, JSON.stringify({ spentUsd: 0 }, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.jurySessionAssignmentsFilePath)) {
        nodeFs.writeFileSync(this.jurySessionAssignmentsFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.demoDepositBindingsFilePath)) {
        nodeFs.writeFileSync(this.demoDepositBindingsFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.settlementQuotesFilePath)) {
        nodeFs.writeFileSync(this.settlementQuotesFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.pendingOperationsFilePath)) {
        nodeFs.writeFileSync(this.pendingOperationsFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.sharedRateLimitsFilePath)) {
        nodeFs.writeFileSync(this.sharedRateLimitsFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      if (!nodeFs.existsSync(this.sharedCacheFilePath)) {
        nodeFs.writeFileSync(this.sharedCacheFilePath, JSON.stringify({}, null, 2), 'utf-8')
      }
      nodeFs.mkdirSync(this.authNoncesDirectoryPath, { recursive: true })
      nodeFs.mkdirSync(this.paymentTxClaimsDirectoryPath, { recursive: true })
      nodeFs.mkdirSync(this.paymentRequestClaimsDirectoryPath, { recursive: true })
      nodeFs.mkdirSync(this.settlementClaimsDirectoryPath, { recursive: true })
      this.pruneConfiguredSensitiveData()
    } catch (err) {
      console.error('Failed to initialize .aura-data store directory:', err)
    }
  }

  /**
   * Cross-process token bucket for cheap public health endpoints. The in-memory
   * limiter is still useful as a fast local guard, but it cannot coordinate
   * serverless instances. This durable fallback shares the bucket whenever the
   * configured AURA_DATA_DIR is on shared storage; hosted deployments should
   * still put an edge/Redis limiter in front of the route.
   */
  public checkSharedRateLimit(
    bucket: string,
    identifier: string,
    maxRequests = 30,
    windowSeconds = 60,
  ): SharedRateLimitResult | null {
    if (!nodeFs || !nodePath || !nodeCrypto || !bucket || !identifier || maxRequests < 1 || windowSeconds < 1) return null
    const key = nodeCrypto.createHash('sha256').update(`${bucket}:${identifier}`).digest('hex')
    const now = Date.now()
    const windowMs = windowSeconds * 1000
    const result = this.withDurableLock(this.sharedRateLimitsLockPath, () => {
      let records: Record<string, { count?: unknown; windowStartedAt?: unknown }> = {}
      try {
        records = JSON.parse(nodeFs.readFileSync(this.sharedRateLimitsFilePath, 'utf-8')) as typeof records
      } catch {
        records = {}
      }
      for (const [recordKey, record] of Object.entries(records)) {
        const startedAt = typeof record.windowStartedAt === 'number' ? record.windowStartedAt : 0
        if (now - startedAt >= windowMs || now - startedAt < 0) delete records[recordKey]
      }
      const current = records[key]
      const startedAt = typeof current?.windowStartedAt === 'number' ? current.windowStartedAt : now
      const count = typeof current?.count === 'number' && Number.isFinite(current.count) ? current.count : 0
      if (count >= maxRequests && now - startedAt < windowMs) {
        writeJsonAtomicallyDurable(this.sharedRateLimitsFilePath, records)
        return {
          allowed: false,
          remaining: 0,
          retryAfter: Math.max(1, Math.ceil((windowMs - (now - startedAt)) / 1000)),
        }
      }
      records[key] = { count: count + 1, windowStartedAt: startedAt }
      writeJsonAtomicallyDurable(this.sharedRateLimitsFilePath, records)
      return { allowed: true, remaining: Math.max(0, maxRequests - count - 1) }
    })
    // A lock failure must fail closed for this expensive endpoint. Returning
    // null is reserved for runtimes without durable filesystem support, where
    // the route will use its process-local emergency limiter.
    return result || { allowed: false, remaining: 0, retryAfter: 1 }
  }

  /** Small cross-process cache for redacted health snapshots. */
  public getSharedCache<T>(bucket: string, identifier: string, maxAgeMs: number): T | null {
    if (!nodeFs || !nodeCrypto || !bucket || !identifier || maxAgeMs < 0) return null
    const key = nodeCrypto.createHash('sha256').update(`${bucket}:${identifier}`).digest('hex')
    try {
      const records = JSON.parse(nodeFs.readFileSync(this.sharedCacheFilePath, 'utf-8')) as Record<string, { expiresAt?: unknown; value?: unknown }>
      const record = records[key]
      if (typeof record?.expiresAt === 'number' && record.expiresAt > Date.now()) return record.value as T
    } catch {}
    return null
  }

  public setSharedCache(bucket: string, identifier: string, value: unknown, maxAgeMs: number): void {
    if (!nodeFs || !nodeCrypto || !bucket || !identifier || maxAgeMs <= 0) return
    const key = nodeCrypto.createHash('sha256').update(`${bucket}:${identifier}`).digest('hex')
    this.withDurableLock(this.sharedCacheLockPath, () => {
      let records: Record<string, { expiresAt?: unknown; value?: unknown }> = {}
      try {
        records = JSON.parse(nodeFs.readFileSync(this.sharedCacheFilePath, 'utf-8')) as typeof records
      } catch {}
      const now = Date.now()
      for (const [recordKey, record] of Object.entries(records)) {
        if (typeof record.expiresAt !== 'number' || record.expiresAt <= now) delete records[recordKey]
      }
      records[key] = { expiresAt: now + maxAgeMs, value }
      writeJsonAtomicallyDurable(this.sharedCacheFilePath, records)
    })
  }

  /**
   * Production deployments may configure a finite retention window for old
   * terminal records. The hackathon demo intentionally leaves this unset so
   * the jury can inspect the full live proof. When enabled, retain only the
   * accounting/settlement facts needed for reconciliation and remove direct
   * recipient and local proof metadata that would otherwise form a permanent
   * source-to-recipient graph.
   */
  private pruneConfiguredSensitiveData(): void {
    if (!nodeFs || !nodePath) return
    const configuredDays = Number(process.env.AURA_DATA_RETENTION_DAYS)
    if (!Number.isFinite(configuredDays) || configuredDays <= 0) return

    const retentionMs = Math.min(configuredDays, 3650) * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - retentionMs
    let redactedTransactions = 0
    let deletedRequests = 0

    try {
      this.withLedgerWriteLock(() => {
        const all = this.readRawLedger(true)
        let changed = false
        for (const [tenantId, transactions] of Object.entries(all)) {
          all[tenantId] = transactions.map((tx) => {
            const terminal = tx.status === 'completed' || tx.status === 'failed'
            if (!terminal || tx.createdAt > cutoff) return tx

            const redacted = cloneJson(tx)
            delete redacted.recipientAddress
            delete redacted.toAddress
            delete redacted.zkData
            for (const leg of Object.values(redacted.legs)) {
              if (!leg) continue
              delete leg.destinationAddress
              delete leg.explorerUrl
              delete (leg as unknown as Record<string, unknown>).description
            }
            redactedTransactions += 1
            changed = true
            return redacted
          })
        }
        if (changed) this.writeRawLedger(all)
      })

      this.withRequestsWriteLock(() => {
        const all = this.loadRequests()
        let changed = false
        for (const [id, request] of Object.entries(all)) {
          const terminalAt = request.consumedAt ?? request.expiresAt
          if ((request.status === 'consumed' || request.status === 'expired') && terminalAt <= cutoff) {
            delete all[id]
            deletedRequests += 1
            changed = true
          }
        }
        if (changed) this.saveRequests(all)
      })

      if (redactedTransactions || deletedRequests) {
        console.info(`Production retention applied: redacted ${redactedTransactions} transaction record(s), deleted ${deletedRequests} expired request(s).`)
      }
    } catch (error) {
      // Retention must never turn an unavailable store into an apparent empty
      // ledger or interrupt an in-flight demo operation.
      console.warn('Production retention pass skipped:', error instanceof Error ? error.message : String(error))
    }
  }

  // --- MULTI-TENANT LEDGER TRANSACTIONS ---

  /**
   * Bind a spend key that is already registered. New bindings must go through
   * registerInitialAuthKeys() or rotateSpendSigningKey(); a recovery record
   * by itself is never enough to claim a missing spend key.
   */
  public bindSpendSigningKey(tenantId: string, publicKeySpkiHex: string): boolean {
    try {
      if (!nodeFs || !tenantId || !publicKeySpkiHex) return false
      // A browser key is never allowed to claim a tenant by itself. The
      // deterministic recovery authority must be registered first; otherwise
      // an attacker who learns a tenant label could squat it with a new key.
      const recoveryKeys: Record<string, string> = nodeFs.existsSync(this.recoveryKeysFilePath)
        ? JSON.parse(nodeFs.readFileSync(this.recoveryKeysFilePath, 'utf-8'))
        : {}
      if (!recoveryKeys[tenantId]) return false
      const result = this.withDurableLock(this.authKeysLockPath, () => {
        // Auth state must be reread while holding the lock. A second server
        // process may have rotated this tenant's key since this instance ran.
        const keys: Record<string, string> = nodeFs.existsSync(this.spendKeysFilePath)
          ? JSON.parse(nodeFs.readFileSync(this.spendKeysFilePath, 'utf-8'))
          : {}
        const existing = keys[tenantId]
        if (existing) return existing === publicKeySpkiHex
        return false
      })
      return result === true
    } catch (err) {
      console.error('Failed to bind spend signing key:', err)
      return false
    }
  }

  public getSpendSigningKey(tenantId: string): string | null {
    try {
      if (!nodeFs || !tenantId) return null
      const keys = nodeFs.existsSync(this.spendKeysFilePath)
        ? JSON.parse(nodeFs.readFileSync(this.spendKeysFilePath, 'utf-8'))
        : {}
      return keys[tenantId] || null
    } catch (err) {
      console.error('Failed to read spend signing key:', err)
      return null
    }
  }

  /** Verify an already-bound spend key without ever creating a new binding. */
  public verifySpendSigningKey(tenantId: string, publicKeySpkiHex: string): boolean {
    if (!tenantId || !publicKeySpkiHex) return false
    return this.getSpendSigningKey(tenantId) === publicKeySpkiHex
  }

  /** Pin the deterministic recovery authority to a tenant. */
  public bindRecoveryKey(tenantId: string, recoveryPublicKeySpkiHex: string): boolean {
    try {
      if (!nodeFs || !tenantId || !recoveryPublicKeySpkiHex) return false
      const result = this.withDurableLock(this.authKeysLockPath, () => {
        // Keep recovery authority shared across server restarts and processes.
        const keys: Record<string, string> = nodeFs.existsSync(this.recoveryKeysFilePath)
          ? JSON.parse(nodeFs.readFileSync(this.recoveryKeysFilePath, 'utf-8'))
          : {}
        const existing = keys[tenantId]
        if (existing) return existing === recoveryPublicKeySpkiHex
        const updated = { ...keys, [tenantId]: recoveryPublicKeySpkiHex }
        const tempPath = `${this.recoveryKeysFilePath}.tmp.${process.pid}.${Date.now()}`
        nodeFs.writeFileSync(tempPath, JSON.stringify(updated, null, 2), 'utf-8')
        nodeFs.renameSync(tempPath, this.recoveryKeysFilePath)
        return true
      })
      return result === true
    } catch (err) {
      console.error('Failed to bind recovery key:', err)
      return false
    }
  }

  /**
   * Register the first recovery authority and browser spend key together.
   * This is the only path that may create a new spend-key binding. If a
   * recovery record already exists without a spend key, fail closed and force
   * the caller through recovery-authorized rotation instead of accepting the
   * first key from a fresh browser.
   */
  public registerInitialAuthKeys(
    tenantId: string,
    recoveryPublicKeySpkiHex: string,
    spendPublicKeySpkiHex: string,
  ): boolean {
    try {
      if (!nodeFs || !tenantId || !recoveryPublicKeySpkiHex || !spendPublicKeySpkiHex) return false
      const result = this.withDurableLock(this.authKeysLockPath, () => {
        const recoveryKeys: Record<string, string> = nodeFs.existsSync(this.recoveryKeysFilePath)
          ? JSON.parse(nodeFs.readFileSync(this.recoveryKeysFilePath, 'utf-8'))
          : {}
        const spendKeys: Record<string, string> = nodeFs.existsSync(this.spendKeysFilePath)
          ? JSON.parse(nodeFs.readFileSync(this.spendKeysFilePath, 'utf-8'))
          : {}
        const existingRecovery = recoveryKeys[tenantId]
        const existingSpend = spendKeys[tenantId]

        if (existingRecovery || existingSpend) {
          return existingRecovery === recoveryPublicKeySpkiHex && existingSpend === spendPublicKeySpkiHex
        }

        const nextRecovery = { ...recoveryKeys, [tenantId]: recoveryPublicKeySpkiHex }
        const nextSpend = { ...spendKeys, [tenantId]: spendPublicKeySpkiHex }
        const stamp = `${process.pid}.${Date.now()}`
        const recoveryTempPath = `${this.recoveryKeysFilePath}.tmp.${stamp}`
        const spendTempPath = `${this.spendKeysFilePath}.tmp.${stamp}`
        nodeFs.writeFileSync(recoveryTempPath, JSON.stringify(nextRecovery, null, 2), 'utf-8')
        nodeFs.writeFileSync(spendTempPath, JSON.stringify(nextSpend, null, 2), 'utf-8')
        nodeFs.renameSync(recoveryTempPath, this.recoveryKeysFilePath)
        nodeFs.renameSync(spendTempPath, this.spendKeysFilePath)
        return true
      })
      return result === true
    } catch (err) {
      console.error('Failed to register initial auth keys:', err)
      return false
    }
  }

  public getRecoveryKey(tenantId: string): string | null {
    try {
      if (!nodeFs || !tenantId) return null
      const keys = nodeFs.existsSync(this.recoveryKeysFilePath)
        ? JSON.parse(nodeFs.readFileSync(this.recoveryKeysFilePath, 'utf-8'))
        : {}
      return keys[tenantId] || null
    } catch (err) {
      console.error('Failed to read recovery key:', err)
      return null
    }
  }

  /** Replace a tenant's browser spend key only after recovery authority proof. */
  public rotateSpendSigningKey(tenantId: string, newPublicKeySpkiHex: string): boolean {
    try {
      if (!nodeFs || !tenantId || !newPublicKeySpkiHex) return false
      const result = this.withDurableLock(this.authKeysLockPath, () => {
        const recoveryKeys: Record<string, string> = nodeFs.existsSync(this.recoveryKeysFilePath)
          ? JSON.parse(nodeFs.readFileSync(this.recoveryKeysFilePath, 'utf-8'))
          : {}
        if (!recoveryKeys[tenantId]) return false
        const keys: Record<string, string> = nodeFs.existsSync(this.spendKeysFilePath)
          ? JSON.parse(nodeFs.readFileSync(this.spendKeysFilePath, 'utf-8'))
          : {}
        const updated = { ...keys, [tenantId]: newPublicKeySpkiHex }
        const tempPath = `${this.spendKeysFilePath}.tmp.${process.pid}.${Date.now()}`
        nodeFs.writeFileSync(tempPath, JSON.stringify(updated, null, 2), 'utf-8')
        nodeFs.renameSync(tempPath, this.spendKeysFilePath)
        return true
      })
      return result === true
    } catch (err) {
      console.error('Failed to rotate spend signing key:', err)
      return false
    }
  }

  /** Atomically claim a short-lived authorization nonce on the local filesystem. */
  public claimAuthNonce(tenantId: string, action: string, nonce: string, maxAgeMs = 5 * 60 * 1000): boolean {
    if (
      !nodeFs || !tenantId || !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId) ||
      !/^[a-z_]{3,40}$/.test(action) || !/^[a-f0-9]{32}$/i.test(nonce)
    ) return false

    try {
      const now = Date.now()
      // Keep every consumed nonce longer than the widest accepted signature
      // window. Routes use different windows (2m and 5m), so cleanup based on
      // the current route's shorter window could delete another route's still
      // replayable nonce before its signed timestamp expires.
      const retentionMs = Math.max(maxAgeMs, 10 * 60 * 1000)
      for (const entry of nodeFs.readdirSync(this.authNoncesDirectoryPath)) {
        if (!entry.endsWith('.nonce')) continue
        const filePath = nodePath.join(this.authNoncesDirectoryPath, entry)
        try {
          if (now - nodeFs.statSync(filePath).mtimeMs > retentionMs) nodeFs.unlinkSync(filePath)
        } catch {}
      }

      const filePath = nodePath.join(this.authNoncesDirectoryPath, `${tenantId}.${action}.${nonce.toLowerCase()}.nonce`)
      const fd = nodeFs.openSync(filePath, 'wx', 0o600)
      try {
        nodeFs.writeFileSync(fd, String(now), 'utf-8')
      } finally {
        nodeFs.closeSync(fd)
      }
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false
      console.error('Failed to claim authorization nonce:', err)
      return false
    }
  }

  public readRawLedger(forceReload = false): Record<string, AuraTransaction[]> {
    if (!forceReload && this.memoryLedgerCache) {
      return cloneJson(this.memoryLedgerCache)
    }
    try {
      if (!nodeFs || !nodeFs.existsSync(this.ledgerFilePath)) return {}
      const raw = nodeFs.readFileSync(this.ledgerFilePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Transaction ledger root must be an object')
      }
      // Sanitize legacy mock relics. Do not infer that a spend was never
      // broadcast from its age: a process may have crashed after the chain
      // accepted it but before its transaction hash reached the ledger.
      let modified = false
      for (const tenant of Object.keys(parsed)) {
        if (Array.isArray(parsed[tenant])) {
          const originalLen = parsed[tenant].length
          parsed[tenant] = parsed[tenant].filter((tx: any) =>
            tx && tx.id && !tx.zkData?.zkProofType?.includes('Halo2')
          )
          if (parsed[tenant].length !== originalLen) modified = true
        }
      }
      if (modified) {
        this.writeRawLedger(parsed)
      }
      this.memoryLedgerCache = parsed
      return cloneJson(parsed)
    } catch (err) {
      console.error('Failed to read raw ledger file:', err)
      throw new Error(`Failed to safely read transaction ledger: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Enumerate durable tenants so settlement recovery does not depend on a browser request. */
  public listTenantIds(): string[] {
    return Object.keys(this.readRawLedger(true)).filter((tenantId) => /^[a-zA-Z0-9._-]{1,128}$/.test(tenantId))
  }

  public clearCache(): void {
    this.memoryLedgerCache = null
    this.memoryRequestsCache = null
  }

  public writeRawLedger(data: Record<string, AuraTransaction[]>): void {
    if (!nodeFs) {
      this.memoryLedgerCache = cloneJson(data)
      return
    }
    try {
      writeJsonAtomicallyDurable(this.ledgerFilePath, data)
    } catch (err) {
      throw new Error(`Failed to durably write transaction ledger: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.memoryLedgerCache = cloneJson(data)
  }

  public loadTransactions(tenantId: string = 'default', defaultSeed: AuraTransaction[] = [], forceReload = false): AuraTransaction[] {
    const all = this.readRawLedger(forceReload)
    let tenantTxs = all[tenantId]
    if (!Array.isArray(tenantTxs) || tenantTxs.length === 0) {
      if (defaultSeed.length > 0) {
        const initial = [...defaultSeed]
        all[tenantId] = initial
        this.writeRawLedger(all)
        return initial
      }
      return []
    }

    return tenantTxs
  }

  public saveTransactions(tenantId: string = 'default', transactions: AuraTransaction[]): void {
    this.withLedgerWriteLock(() => {
      const all = this.readRawLedger(true)
      all[tenantId] = cloneJson(transactions)
      this.writeRawLedger(all)
    })
  }

  /**
   * Atomically mutate one tenant's transaction list from a fresh disk
   * snapshot. Callers that need a result can return it without exposing a
   * stale read-modify-write window to another process.
   */
  public mutateTransactions<T>(
    tenantId: string,
    mutator: (transactions: AuraTransaction[]) => { transactions: AuraTransaction[]; result: T },
  ): T {
    return this.withLedgerWriteLock(() => {
      const all = this.readRawLedger(true)
      const current = Array.isArray(all[tenantId]) ? cloneJson(all[tenantId]) : []
      const outcome = mutator(current)
      all[tenantId] = cloneJson(outcome.transactions)
      this.writeRawLedger(all)
      return outcome.result
    })
  }

  /**
   * Atomically mutate the complete tenant ledger from one durable snapshot.
   * Shared-pool allocations use this boundary so capacity is checked and the
   * entitlement is written under the same cross-process lock.
   */
  public mutateLedger<T>(
    mutator: (ledger: Record<string, AuraTransaction[]>) => { ledger: Record<string, AuraTransaction[]>; result: T },
  ): T {
    return this.withLedgerWriteLock(() => {
      const current = this.readRawLedger(true)
      const outcome = mutator(cloneJson(current))
      this.writeRawLedger(outcome.ledger)
      return outcome.result
    })
  }

  public calculateTenantBalance(
    tenantId: string = 'default',
    initialUsd: number = 0,
    defaultSeed: AuraTransaction[] = [],
    requiredBufferMode?: string,
    forceReload = false,
  ): {
    totalUsd: number
    readyToSpendUsd: number
    unconfirmedUsd: number
    onChainZecBackedUsd: number
    enclaveBackedUsd: number
    pendingOutboundUsd?: number
    pendingOutboundZec?: number
    hasUnpricedPendingOutbound?: boolean
    immatureBufferedZec?: number
  } {
    const txs = this.loadTransactions(tenantId, defaultSeed, forceReload)
    let balance = initialUsd
    let unconfirmed = 0
    // Legacy rows may predate exact backingZec persistence. Keep this only as
    // a compatibility fallback; live rows use immatureBufferedZec below.
    let legacyImmatureBufferedUsd = 0
    let onChainZecBackedUsd = 0
    let enclaveBackedUsd = 0
    let pendingOutboundUsd = 0
    let pendingOutboundZec = 0
    let hasUnpricedPendingOutbound = false
    let immatureBufferedZec = 0
    const now = Date.now()

    const bufferDurations: Record<string, number> = {
      fast: 0,
      private: 86400 * 1000,
      strong: 259200 * 1000,
      custom: 604800 * 1000,
    }

    // Compute balance adjustments based on transactions
    for (const tx of txs) {
      // A persisted Solana `completed` label is not finality. Treat it as a
      // reserved outbound spend until the delivery leg is actually finalized.
      const isCompleted = tx.toChain === 'solana'
        ? hasCompletedDestinationDelivery(tx)
        : tx.status === 'completed'
      if (isCompleted) {
        if (tx.type === 'deposit' || tx.type === 'receive') {
          balance += tx.toAmount
          
          if (tx.legs?.shielded?.status === 'confirmed') {
            onChainZecBackedUsd += tx.toAmount
          } else {
            enclaveBackedUsd += tx.toAmount
          }

          // Start the optional timing wait only after the shielded deposit is
          // confirmed. A long confirmation delay must not consume a user's
          // selected privacy wait before funds are actually available.
          const maturityMode = requiredBufferMode || tx.bufferMode || 'private'
          const duration = bufferDurations[maturityMode] ?? bufferDurations.private
          const maturityStart = tx.completedAt ?? tx.createdAt
          if (now < maturityStart + duration) {
            legacyImmatureBufferedUsd += tx.toAmount
            if (typeof tx.backingZec === 'number' && Number.isFinite(tx.backingZec) && tx.backingZec > 0) {
              immatureBufferedZec += tx.backingZec
            }
          }
        } else if (tx.type === 'send' || tx.type === 'withdraw') {
          // Old demo builds stored a percentage estimate as feeUsd even though
          // no provider fee was charged to the tenant. Only debit the value
          // actually routed; testnet gas is paid by Aura's relayer.
          balance -= tx.fromAmount
        }
      } else if (
        tx.status === 'shielded' ||
        tx.status === 'initiated' ||
        tx.status === 'locking_base' ||
        tx.status === 'routing_near' ||
        tx.status === 'processing' ||
        tx.status === 'routing_shielded' ||
        tx.status === 'settling_destination' ||
        (tx.status === 'completed' && tx.toChain === 'solana')
      ) {
        if (tx.type === 'send' || tx.type === 'withdraw') {
          // A reservation is released only after a verified pre-broadcast
          // failure or an explicit recovery action. Age alone cannot prove that
          // either the Zcash source spend or destination payout was not sent.
          balance -= tx.fromAmount
          // Once the source Zcash spend has an authoritative confirmation and
          // txid, the live chain balance already reflects the debit. Keep the
          // ledger debit for fallback display, but do not subtract the same
          // amount again while only the destination payout remains pending.
          const sourceSpendConfirmed = hasConfirmedShieldedSource(tx)
          // A finalized Solana destination is also a durable settlement
          // invariant: Aura only creates it after the Zcash source spend was
          // confirmed. Treat an old stale Zcash label as terminal here so a
          // restart cannot strand the whole Fast balance at zero. A send with
          // no finalized destination still fails closed below.
          const destinationFinalized = tx.toChain === 'solana' &&
            tx.legs?.delivery?.status === 'confirmed' &&
            tx.legs.delivery.confirmationStatus === 'finalized' &&
            Boolean(tx.legs.delivery.txHash)
          if (!sourceSpendConfirmed && !destinationFinalized) {
            pendingOutboundUsd += tx.fromAmount
            if (typeof tx.reservedZec === 'number' && Number.isFinite(tx.reservedZec) && tx.reservedZec > 0) {
              pendingOutboundZec += tx.reservedZec
            } else {
              // Do not guess a ZEC quantity from an old USD-only record. The
              // live reservation path will fail closed until that operation
              // reaches a terminal state or is explicitly reconciled.
              hasUnpricedPendingOutbound = true
            }
          }
        } else {
          unconfirmed += tx.toAmount
        }
      }
    }

    const cleanBalance = Math.max(0, Number(balance.toFixed(2)))
    // A USD ready value cannot be calculated safely without the current ZEC
    // rate. Live callers reconcile `immatureBufferedZec` against that rate;
    // fail closed here instead of subtracting a historical USD mark that can
    // be wrong after a price move.
    const readyToSpend = immatureBufferedZec > 0
      ? 0
      : Math.max(0, Number((cleanBalance - legacyImmatureBufferedUsd).toFixed(2)))

    return {
      totalUsd: cleanBalance,
      readyToSpendUsd: readyToSpend,
      unconfirmedUsd: unconfirmed,
      onChainZecBackedUsd: Math.max(0, Number(onChainZecBackedUsd.toFixed(2))),
      enclaveBackedUsd: Math.max(0, Number(enclaveBackedUsd.toFixed(2))),
      pendingOutboundUsd: Math.max(0, Number(pendingOutboundUsd.toFixed(2))),
      pendingOutboundZec: Math.max(0, Number(pendingOutboundZec.toFixed(8))),
      hasUnpricedPendingOutbound,
      immatureBufferedZec: Math.max(0, Number(immatureBufferedZec.toFixed(8))),
    }
  }

  /**
   * Atomically reserves vault balance for a pending spend transaction.
   * Runs synchronously to prevent concurrent double-spend race conditions.
   */
  public reserveSpend(
    tenantId: string = 'default',
    tx: AuraTransaction,
    totalRequiredUsd: number,
    bufferMode: string = 'private',
    confirmedChainUsd?: number,
    confirmedChainZec?: number,
    zecUsd?: number,
  ): { success: boolean; error?: string; availableBalance?: number } {
    if (nodeFs && !this.acquireDurableClaim(this.ledgerWriteLockPath, {
      operation: 'reserve_spend',
      tenantId,
    })) {
      return { success: false, error: 'LEDGER_BUSY' }
    }

    try {
      // Re-read from disk while holding the cross-process lock. The in-memory
      // cache is intentionally bypassed here; otherwise two server processes
      // could both approve the same spend from an old snapshot.
      const ledgerBalance = this.calculateTenantBalance(tenantId, 0, [], bufferMode, true)
      let current = ledgerBalance
      if (typeof confirmedChainUsd === 'number' && Number.isFinite(confirmedChainUsd)) {
        const hasTrackedCredit = ledgerBalance.onChainZecBackedUsd > 0 || ledgerBalance.enclaveBackedUsd > 0
        const hasLiveZecPricing = typeof confirmedChainZec === 'number' && Number.isFinite(confirmedChainZec) &&
          typeof zecUsd === 'number' && Number.isFinite(zecUsd) && zecUsd > 0
        // If recovery restored real notes before the old ledger row, seed the
        // balance calculation with the live chain amount. Existing pending
        // spends are then subtracted before this reservation is admitted.
        current = !hasLiveZecPricing && !hasTrackedCredit && ledgerBalance.totalUsd === 0
          ? this.calculateTenantBalance(tenantId, Math.max(0, confirmedChainUsd), [], bufferMode, true)
          : reconcileLedgerBalanceWithShieldedChain(ledgerBalance, confirmedChainUsd, confirmedChainZec, zecUsd)
      }
      const effectiveAvailable = bufferMode === 'fast'
        ? current.totalUsd
        : current.readyToSpendUsd

      if (totalRequiredUsd > effectiveAvailable) {
        return {
          success: false,
          error: 'INSUFFICIENT_FUNDS',
          availableBalance: effectiveAvailable,
        }
      }

      const txs = this.loadTransactions(tenantId, [], true)
      txs.unshift(tx)
      // reserveSpend already owns the ledger lock; do not re-enter it.
      const all = this.readRawLedger(true)
      all[tenantId] = txs
      this.writeRawLedger(all)
      return { success: true }
    } finally {
      if (nodeFs) {
        try { nodeFs.unlinkSync(this.ledgerWriteLockPath) } catch {}
      }
    }
  }

  /**
   * Releases a reserved spend transaction if execution failed.
   */
  public releaseReservation(tenantId: string = 'default', txId: string, reason?: string): void {
    this.mutateTransactions(tenantId, (txs) => {
      const tx = txs.find((t) => t.id === txId)
      if (tx) {
        tx.status = 'failed'
        if (tx.legs?.delivery) {
          tx.legs.delivery.status = 'failed'
          tx.legs.delivery.description = reason || 'Spend failed before on-chain execution'
        }
      }
      return { transactions: txs, result: undefined }
    })
  }

  /**
   * Confirms a reserved spend transaction.
   */
  public confirmSpend(tenantId: string = 'default', txId: string, updates: Partial<AuraTransaction>): AuraTransaction | null {
    return this.mutateTransactions(tenantId, (txs) => {
      const idx = txs.findIndex((t) => t.id === txId)
      if (idx === -1) return { transactions: txs, result: null }
      txs[idx] = { ...txs[idx], ...updates }
      return { transactions: txs, result: txs[idx] }
    })
  }

  // --- ATOMIC PAYMENT REQUESTS & REPLAY PROTECTION ---

  public loadRequests(): Record<string, StoredPaymentRequest> {
    if (this.memoryRequestsCache) {
      return cloneJson(this.memoryRequestsCache)
    }
    try {
      if (!nodeFs || !nodeFs.existsSync(this.requestsFilePath)) return {}
      const raw = nodeFs.readFileSync(this.requestsFilePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Payment request root must be an object')
      }
      this.memoryRequestsCache = parsed
      return cloneJson(parsed)
    } catch (err) {
      console.error('Failed to read requests file:', err)
      throw new Error(`Failed to safely read payment requests: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  public saveRequests(data: Record<string, StoredPaymentRequest>): void {
    if (!nodeFs) {
      this.memoryRequestsCache = cloneJson(data)
      return
    }
    try {
      writeJsonAtomicallyDurable(this.requestsFilePath, data)
    } catch (err) {
      throw new Error(`Failed to durably write payment requests: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.memoryRequestsCache = cloneJson(data)
  }

  private withSettlementQuotesWriteLock<T>(operation: () => T): T {
    if (!nodeFs) return operation()
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 120; attempt++) {
      // Wrap the callback result so a successful `void` operation is not
      // confused with `withDurableLock` returning undefined because it could
      // not acquire the lock.
      const result = this.withDurableLock(this.settlementQuotesWriteLockPath, () => {
        this.memorySettlementQuotesCache = null
        return { value: operation() }
      })
      if (result !== undefined) return result.value
      Atomics.wait(waitBuffer, 0, 0, 5)
    }
    throw new Error('SETTLEMENT_QUOTE_STORE_BUSY')
  }

  private loadSettlementQuotes(): Record<string, StoredSettlementQuote> {
    if (this.memorySettlementQuotesCache) return cloneJson(this.memorySettlementQuotesCache)
    try {
      if (!nodeFs || !nodeFs.existsSync(this.settlementQuotesFilePath)) return {}
      const raw = nodeFs.readFileSync(this.settlementQuotesFilePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Settlement quote root must be an object')
      }
      this.memorySettlementQuotesCache = parsed
      return cloneJson(parsed)
    } catch (err) {
      console.error('Failed to read settlement quotes file:', err)
      throw new Error(`Failed to safely read settlement quotes: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private saveSettlementQuotes(data: Record<string, StoredSettlementQuote>): void {
    if (!nodeFs) {
      this.memorySettlementQuotesCache = cloneJson(data)
      return
    }
    try {
      writeJsonAtomicallyDurable(this.settlementQuotesFilePath, data)
    } catch (err) {
      throw new Error(`Failed to durably write settlement quotes: ${err instanceof Error ? err.message : String(err)}`)
    }
    this.memorySettlementQuotesCache = cloneJson(data)
  }

  private withPendingOperationsWriteLock<T>(operation: () => T): T {
    if (!nodeFs) return operation()
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = this.withDurableLock(this.pendingOperationsWriteLockPath, () => {
        this.memoryPendingOperationsCache = null
        return { value: operation() }
      })
      if (result !== undefined) return result.value
      Atomics.wait(waitBuffer, 0, 0, 5)
    }
    throw new Error('PENDING_OPERATION_STORE_BUSY')
  }

  private loadPendingOperations(): Record<string, StoredDurableOperation> {
    if (this.memoryPendingOperationsCache) return cloneJson(this.memoryPendingOperationsCache)
    try {
      if (!nodeFs || !nodeFs.existsSync(this.pendingOperationsFilePath)) return {}
      const raw = nodeFs.readFileSync(this.pendingOperationsFilePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Pending operation root must be an object')
      }
      this.memoryPendingOperationsCache = parsed
      return cloneJson(parsed)
    } catch (err) {
      console.error('Failed to read pending operation store:', err)
      throw new Error(`Failed to safely read pending operations: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private savePendingOperations(data: Record<string, StoredDurableOperation>): void {
    if (!nodeFs) {
      this.memoryPendingOperationsCache = cloneJson(data)
      return
    }
    writeJsonAtomicallyDurable(this.pendingOperationsFilePath, data)
    this.memoryPendingOperationsCache = cloneJson(data)
  }

  public listPendingOperations(): StoredDurableOperation[] {
    // Pending operations are specifically the cross-process crash boundary;
    // never answer this read from a stale worker-local snapshot.
    this.memoryPendingOperationsCache = null
    return Object.values(this.loadPendingOperations()).map((operation) => cloneJson(operation))
  }

  public getPendingOperation(id: string): StoredDurableOperation | null {
    if (!id) return null
    this.memoryPendingOperationsCache = null
    const operation = this.loadPendingOperations()[id]
    return operation ? cloneJson(operation) : null
  }

  /** Persist an external-effect intent before invoking a chain client. */
  public savePendingOperation(operation: StoredDurableOperation): StoredDurableOperation {
    return this.withPendingOperationsWriteLock(() => {
      const all = this.loadPendingOperations()
      const now = Date.now()
      const saved = { ...cloneJson(operation), createdAt: operation.createdAt || now, updatedAt: now }
      all[operation.id] = saved
      this.savePendingOperations(all)
      return cloneJson(saved)
    })
  }

  public updatePendingOperation(
    id: string,
    updates: Partial<Omit<StoredDurableOperation, 'id' | 'createdAt'>>,
  ): StoredDurableOperation | null {
    return this.withPendingOperationsWriteLock(() => {
      const all = this.loadPendingOperations()
      const current = all[id]
      if (!current) return null
      const updated = { ...current, ...cloneJson(updates), id, updatedAt: Date.now() }
      all[id] = updated
      this.savePendingOperations(all)
      return cloneJson(updated)
    })
  }

  public deletePendingOperation(id: string): void {
    if (!id) return
    this.withPendingOperationsWriteLock(() => {
      const all = this.loadPendingOperations()
      if (all[id]) {
        delete all[id]
        this.savePendingOperations(all)
      }
      return true
    })
  }

  public pruneSettlementQuotes(now = Date.now()): void {
    this.withSettlementQuotesWriteLock(() => {
      const all = this.loadSettlementQuotes()
      let changed = false
      for (const [quoteId, quote] of Object.entries(all)) {
        if (quote.expiresAt <= now || quote.usedAt) {
          delete all[quoteId]
          changed = true
        }
      }
      if (changed) this.saveSettlementQuotes(all)
    })
  }

  public getSettlementQuote(quoteId: string): StoredSettlementQuote | null {
    if (!quoteId) return null
    const quote = this.loadSettlementQuotes()[quoteId]
    return quote ? cloneJson(quote) : null
  }

  public saveSettlementQuote(quote: StoredSettlementQuote): void {
    this.withSettlementQuotesWriteLock(() => {
      const all = this.loadSettlementQuotes()
      all[quote.quoteId] = cloneJson(quote)
      this.saveSettlementQuotes(all)
    })
  }

  public consumeSettlementQuote(quoteId: string, tenantId: string, now = Date.now()): boolean {
    return this.withSettlementQuotesWriteLock(() => {
      const all = this.loadSettlementQuotes()
      const quote = all[quoteId]
      if (!quote || quote.usedAt || quote.tenantId !== tenantId || quote.expiresAt <= now) return false
      all[quoteId] = { ...quote, usedAt: now }
      this.saveSettlementQuotes(all)
      return true
    })
  }

  public getPaymentRequest(id: string, options: { preserveActive?: boolean } = {}): StoredPaymentRequest | null {
    const all = this.loadRequests()
    const req = all[id]
    if (!req) return null

    // Check expiration on read
    if (req.status === 'active' && !options.preserveActive && Date.now() > req.expiresAt) {
      return this.withRequestsWriteLock(() => {
        const fresh = this.loadRequests()
        const current = fresh[id]
        if (current && current.status === 'active' && Date.now() > current.expiresAt) {
          current.status = 'expired'
          fresh[id] = current
          this.saveRequests(fresh)
        }
        return fresh[id] || req
      })
    }
    return req
  }

  public getRequest(id: string): StoredPaymentRequest | null {
    return this.getPaymentRequest(id)
  }

  /** Lists a tenant's durable requests without exposing owner bearer tokens. */
  public listPaymentRequestsForTenant(tenantId: string): StoredPaymentRequest[] {
    if (!tenantId) return []
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const now = Date.now()
      let changed = false
      for (const request of Object.values(all)) {
        if (request.enclaveFingerprint === tenantId && request.status === 'active' && now > request.expiresAt) {
          request.status = 'expired'
          all[request.id] = request
          changed = true
        }
      }
      if (changed) this.saveRequests(all)
      return Object.values(all)
        .filter((request) => request.enclaveFingerprint === tenantId)
        .map((request) => cloneJson(request))
        .sort((a, b) => b.createdAt - a.createdAt)
    })
  }

  /** Bind an open invoice to a payer before that payer sends funds. */
  public bindPaymentRequestPayer(
    id: string,
    payerAddress: string,
    preparedAt: number,
    preparedBlock: number,
  ): StoredPaymentRequest | null {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const request = all[id]
      if (!request || request.status !== 'active' || !/^0x[a-f0-9]{40}$/i.test(payerAddress) ||
        !Number.isSafeInteger(preparedAt) || !Number.isSafeInteger(preparedBlock)) return null
      const leaseMs = 10 * 60 * 1000
      // Expiry permits the same payer to refresh preparation, not an
      // arbitrary wallet to hijack the invoice. Only the invoice owner can
      // explicitly clear/rebind it.
      if (request.payerAddress && request.payerAddress.toLowerCase() !== payerAddress.toLowerCase()) return null
      request.payerAddress = payerAddress.toLowerCase()
      request.payerPreparedAt = preparedAt
      request.payerPreparedBlock = preparedBlock
      request.payerBindingExpiresAt = preparedAt + leaseMs
      all[id] = request
      this.saveRequests(all)
      return cloneJson(request)
    })
  }

  public clearPaymentRequestPayer(id: string): StoredPaymentRequest | null {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const request = all[id]
      if (!request || request.status !== 'active') return null
      delete request.payerAddress
      delete request.payerPreparedAt
      delete request.payerPreparedBlock
      delete request.payerBindingExpiresAt
      all[id] = request
      this.saveRequests(all)
      return cloneJson(request)
    })
  }

  /**
   * Freeze invoice terms once the bearer link has been shared. The operation
   * is idempotent and durable so a restart cannot reopen a mutable invoice.
   */
  public markPaymentRequestShared(id: string, sharedAt = Date.now()): StoredPaymentRequest | null {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const request = all[id]
      if (!request) return null
      if (!request.sharedAt) {
        request.sharedAt = sharedAt
        all[id] = request
        this.saveRequests(all)
      }
      return cloneJson(request)
    })
  }

  /** Revoke an active bearer request without ever reactivating a spent one. */
  public revokePaymentRequest(id: string, revokedAt = Date.now()): StoredPaymentRequest | null {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const request = all[id]
      if (!request || request.status !== 'active') return null
      request.status = 'expired'
      request.revokedAt = revokedAt
      all[id] = request
      this.saveRequests(all)
      return cloneJson(request)
    })
  }

  public claimPaymentRequestProcessing(id: string, options: { allowExpired?: boolean } = {}): boolean {
    if (!id || !nodeFs || !nodeCrypto || this.processingPaymentRequestIds.has(id)) return false
    const req = this.getPaymentRequest(id, { preserveActive: options.allowExpired === true })
    if (!req || req.status !== 'active' || (Date.now() > req.expiresAt && options.allowExpired !== true)) return false

    try {
      const claimName = nodeCrypto.createHash('sha256').update(id).digest('hex') + '.claim'
      const claimPath = nodePath.join(this.paymentRequestClaimsDirectoryPath, claimName)
      if (!this.acquireDurableClaim(claimPath, { requestId: id })) return false
      this.processingPaymentRequestIds.add(id)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        console.error('Failed to claim payment request:', err)
      }
      return false
    }
  }

  public releasePaymentRequestProcessing(id: string): void {
    this.processingPaymentRequestIds.delete(id)
    if (!nodeFs || !nodeCrypto || !id) return
    try {
      const claimName = nodeCrypto.createHash('sha256').update(id).digest('hex') + '.claim'
      nodeFs.unlinkSync(nodePath.join(this.paymentRequestClaimsDirectoryPath, claimName))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('Failed to release payment request claim:', err)
      }
    }
  }

  public claimPaymentTxHash(txHash: string): boolean {
    const key = normalizePaymentTxHash(txHash)
    if (!key || !nodeFs || !nodeCrypto || this.processingPaymentTxHashes.has(key)) return false

    // Refresh the ledger snapshot before checking permanent usage. Then acquire
    // an exclusive filesystem claim so parallel server instances cannot both
    // credit the same on-chain payment.
    this.memoryLedgerCache = null
    this.memoryRequestsCache = null
    if (this.hasUsedPaymentTxHash(key)) return false

    try {
      const claimName = nodeCrypto.createHash('sha256').update(key).digest('hex') + '.claim'
      const claimPath = nodePath.join(this.paymentTxClaimsDirectoryPath, claimName)
      if (!this.acquireDurableClaim(claimPath, { paymentTxHash: key })) return false
      this.processingPaymentTxHashes.add(key)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        console.error('Failed to claim payment transaction hash:', err)
      }
      return false
    }
  }

  public releasePaymentTxHash(txHash: string): void {
    const key = normalizePaymentTxHash(txHash)
    this.processingPaymentTxHashes.delete(key)
    if (!nodeFs || !nodeCrypto || !key) return
    try {
      const claimName = nodeCrypto.createHash('sha256').update(key).digest('hex') + '.claim'
      nodeFs.unlinkSync(nodePath.join(this.paymentTxClaimsDirectoryPath, claimName))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('Failed to release payment transaction hash claim:', err)
      }
    }
  }

  private markOwnedClaimExternalEffectMayHaveStarted(
    claimPath: string,
    ownerField: 'paymentTxHash' | 'requestId' | 'settlementKey',
    ownerKey: string,
    isClaimed: boolean
  ): boolean {
    if (!ownerKey || !nodeFs || !nodeCrypto || !isClaimed) return false
    try {
      const claim = JSON.parse(nodeFs.readFileSync(claimPath, 'utf-8')) as {
        paymentTxHash?: unknown
        requestId?: unknown
        settlementKey?: unknown
        pid?: unknown
        processInstanceId?: unknown
        externalEffectMayHaveStarted?: unknown
      }
      if (claim[ownerField] !== ownerKey || claim.pid !== process.pid || claim.processInstanceId !== PROCESS_INSTANCE_ID) return false
      if (claim.externalEffectMayHaveStarted === true) return true

      const tempPath = `${claimPath}.tmp.${process.pid}.${nodeCrypto.randomBytes(8).toString('hex')}`
      try {
        nodeFs.writeFileSync(tempPath, JSON.stringify({
          ...claim,
          externalEffectMayHaveStarted: true,
          updatedAt: Date.now(),
        }), { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
        nodeFs.renameSync(tempPath, claimPath)
      } catch (error) {
        try { if (nodeFs.existsSync(tempPath)) nodeFs.unlinkSync(tempPath) } catch {}
        throw error
      }
      return true
    } catch (error) {
      console.error('Failed to persist payment broadcast intent:', error)
      return false
    }
  }

  public markPaymentTxHashExternalEffectMayHaveStarted(txHash: string): boolean {
    const key = normalizePaymentTxHash(txHash)
    if (!key || !nodeFs || !nodeCrypto) return false
    const claimName = nodeCrypto.createHash('sha256').update(key).digest('hex') + '.claim'
    return this.markOwnedClaimExternalEffectMayHaveStarted(
      nodePath.join(this.paymentTxClaimsDirectoryPath, claimName),
      'paymentTxHash',
      key,
      this.processingPaymentTxHashes.has(key)
    )
  }

  public markPaymentRequestExternalEffectMayHaveStarted(id: string): boolean {
    if (!id || !nodeFs || !nodeCrypto) return false
    const claimName = nodeCrypto.createHash('sha256').update(id).digest('hex') + '.claim'
    return this.markOwnedClaimExternalEffectMayHaveStarted(
      nodePath.join(this.paymentRequestClaimsDirectoryPath, claimName),
      'requestId',
      id,
      this.processingPaymentRequestIds.has(id)
    )
  }

  public claimTransactionSettlement(tenantId: string, txId: string): boolean {
    if (!tenantId || !txId || !nodeFs || !nodeCrypto) return false
    const key = `${tenantId}:${txId}`
    if (this.processingSettlementKeys.has(key)) return false
    try {
      const claimName = nodeCrypto.createHash('sha256').update(key).digest('hex') + '.claim'
      const claimPath = nodePath.join(this.settlementClaimsDirectoryPath, claimName)
      if (!this.acquireDurableClaim(claimPath, { settlementKey: key })) return false
      this.processingSettlementKeys.add(key)
      return true
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        console.error('Failed to claim pending transaction settlement:', err)
      }
      return false
    }
  }

  public markTransactionSettlementExternalEffectMayHaveStarted(tenantId: string, txId: string): boolean {
    if (!tenantId || !txId || !nodeFs || !nodeCrypto) return false
    const key = `${tenantId}:${txId}`
    const claimName = nodeCrypto.createHash('sha256').update(key).digest('hex') + '.claim'
    return this.markOwnedClaimExternalEffectMayHaveStarted(
      nodePath.join(this.settlementClaimsDirectoryPath, claimName),
      'settlementKey',
      key,
      this.processingSettlementKeys.has(key)
    )
  }

  public transactionSettlementExternalEffectMayHaveStarted(tenantId: string, txId: string): boolean {
    if (!tenantId || !txId || !nodeFs || !nodeCrypto) return false
    const key = `${tenantId}:${txId}`
    const claimName = nodeCrypto.createHash('sha256').update(key).digest('hex') + '.claim'
    try {
      const claim = JSON.parse(nodeFs.readFileSync(
        nodePath.join(this.settlementClaimsDirectoryPath, claimName),
        'utf-8',
      )) as { settlementKey?: unknown; externalEffectMayHaveStarted?: unknown }
      return claim.settlementKey === key && claim.externalEffectMayHaveStarted === true
    } catch {
      return false
    }
  }

  public releaseTransactionSettlement(tenantId: string, txId: string): void {
    const key = `${tenantId}:${txId}`
    this.processingSettlementKeys.delete(key)
    if (!nodeFs || !nodeCrypto || !tenantId || !txId) return
    try {
      const claimName = nodeCrypto.createHash('sha256').update(key).digest('hex') + '.claim'
      nodeFs.unlinkSync(nodePath.join(this.settlementClaimsDirectoryPath, claimName))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error('Failed to release pending transaction settlement:', err)
      }
    }
  }

  public createPaymentRequest(request: StoredPaymentRequest): StoredPaymentRequest {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      all[request.id] = request
      this.saveRequests(all)
      return request
    })
  }

  /** Publish a new Receive request while revoking the tenant's old live links in one durable write. */
  public createPaymentRequestReplacingActive(request: StoredPaymentRequest): StoredPaymentRequest {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const now = Date.now()
      for (const existing of Object.values(all)) {
        if (existing.enclaveFingerprint === request.enclaveFingerprint && existing.status === 'active' && existing.id !== request.id) {
          existing.status = 'expired'
          existing.revokedAt = now
          all[existing.id] = existing
        }
      }
      all[request.id] = request
      this.saveRequests(all)
      return request
    })
  }

  public saveRequest(request: StoredPaymentRequest): StoredPaymentRequest {
    return this.createPaymentRequest(request)
  }

  public deleteRequest(id: string): void {
    this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      if (all[id]) {
        delete all[id]
        this.saveRequests(all)
      }
      return true
    })
  }

  public hasUsedPaymentTxHash(txHash: string, exceptRequestId?: string): boolean {
    const target = normalizePaymentTxHash(txHash)
    if (!target) return false
    this.memoryLedgerCache = null
    this.memoryRequestsCache = null
    const requests = this.loadRequests()
    if (Object.values(requests).some((req) => req.id !== exceptRequestId && req.status === 'consumed' && req.txHash && normalizePaymentTxHash(req.txHash) === target)) {
      return true
    }
    const ledger = this.readRawLedger()
    return Object.values(ledger).some((transactions) => transactions.some((tx) =>
      tx.status !== 'failed' &&
      [tx.legs?.deposit?.txHash, tx.legs?.delivery?.txHash, tx.legs?.shielded?.txHash]
        .some((hash) => hash && normalizePaymentTxHash(hash) === target)
    ))
  }

  public updatePaymentRequest(
    id: string,
    updates: Partial<Pick<StoredPaymentRequest, 'asset' | 'chain' | 'expiresAt' | 'shieldedReceiver' | 'bufferMode' | 'rateUsdAtCreation'>> & {
      amount?: number | null
      minimumAmount?: number | null
    }
  ): StoredPaymentRequest | null {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const req = all[id]
      if (!req || req.status !== 'active' || req.sharedAt) return null
      if ('amount' in updates) {
        if (updates.amount === null || updates.amount === undefined) delete req.amount
        else req.amount = updates.amount
      }
      if (updates.asset !== undefined) req.asset = updates.asset
      if (updates.chain !== undefined) req.chain = updates.chain
      if (updates.expiresAt !== undefined) req.expiresAt = updates.expiresAt
      if (updates.shieldedReceiver !== undefined) req.shieldedReceiver = updates.shieldedReceiver
      if (updates.bufferMode !== undefined) req.bufferMode = updates.bufferMode
      if ('minimumAmount' in updates) {
        if (updates.minimumAmount === null || updates.minimumAmount === undefined) delete req.minimumAmount
        else req.minimumAmount = updates.minimumAmount
      }
      if (updates.rateUsdAtCreation !== undefined) req.rateUsdAtCreation = updates.rateUsdAtCreation
      all[id] = req
      this.saveRequests(all)
      return req
    })
  }

  /**
   * Reserve one funded jury tenant for a signed browser session. The lease is
   * durable and cross-process, so two concurrent jury browsers cannot silently
   * rotate the same tenant's spend key or mix their demo history.
   */
  public assignJuryTenant(sessionId: string, tenantIds: string[], ttlMs: number): string | null {
    if (!nodeFs || !sessionId || !Number.isFinite(ttlMs) || ttlMs <= 0) return null
    const pool = Array.from(new Set(tenantIds.filter((tenantId) => /^[a-zA-Z0-9._-]{1,128}$/.test(tenantId))))
    if (!pool.length) return null
    const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = this.withDurableLock(this.jurySessionAssignmentsLockPath, () => {
        const now = Date.now()
        let assignments: Record<string, JurySessionAssignment> = {}
        try {
          assignments = JSON.parse(nodeFs.readFileSync(this.jurySessionAssignmentsFilePath, 'utf-8')) as Record<string, JurySessionAssignment>
        } catch {
          assignments = {}
        }

        for (const [id, assignment] of Object.entries(assignments)) {
          if (!assignment || typeof assignment.tenantId !== 'string' || !pool.includes(assignment.tenantId) ||
            typeof assignment.expiresAt !== 'number' || assignment.expiresAt <= now) {
            delete assignments[id]
          }
        }

        const existing = assignments[sessionId]
        if (existing) return existing.tenantId

        const activeCounts = new Map<string, number>()
        for (const assignment of Object.values(assignments)) {
          activeCounts.set(assignment.tenantId, (activeCounts.get(assignment.tenantId) || 0) + 1)
        }
        const tenantId = pool.find((candidate) => (activeCounts.get(candidate) || 0) === 0)
        if (!tenantId) {
          writeJsonAtomicallyDurable(this.jurySessionAssignmentsFilePath, assignments)
          return null
        }
        assignments[sessionId] = { tenantId, expiresAt: now + ttlMs }
        writeJsonAtomicallyDurable(this.jurySessionAssignmentsFilePath, assignments)
        return tenantId
      })
      if (result !== undefined) return result
      Atomics.wait(waitBuffer, 0, 0, 5)
    }
    return null
  }

  /** Return the current tenant lease for a signed session, if it is still live. */
  public getAssignedJuryTenant(sessionId: string): JurySessionAssignment | null {
    if (!nodeFs || !sessionId) return null
    try {
      const assignments = JSON.parse(nodeFs.readFileSync(this.jurySessionAssignmentsFilePath, 'utf-8')) as Record<string, JurySessionAssignment>
      const assignment = assignments[sessionId]
      if (!assignment || typeof assignment.tenantId !== 'string' || typeof assignment.expiresAt !== 'number' || assignment.expiresAt <= Date.now()) return null
      return assignment
    } catch {
      return null
    }
  }

  /** Release one jury tenant lease when the owning session is explicitly closed. */
  public releaseJuryTenant(sessionId: string): boolean {
    if (!nodeFs || !sessionId) return false
    const result = this.withDurableLock(this.jurySessionAssignmentsLockPath, () => {
      let assignments: Record<string, JurySessionAssignment> = {}
      try {
        assignments = JSON.parse(nodeFs.readFileSync(this.jurySessionAssignmentsFilePath, 'utf-8')) as Record<string, JurySessionAssignment>
      } catch {
        return false
      }
      if (!assignments[sessionId]) return false
      delete assignments[sessionId]
      writeJsonAtomicallyDurable(this.jurySessionAssignmentsFilePath, assignments)
      return true
    })
    return result === true
  }

  /** Bind a sponsored Base transfer to the tenant/session that requested it. */
  public bindDemoDeposit(
    txHash: string,
    tenantId: string,
    amountUsd: number,
    senderAddress: string,
    clientId: string,
  ): void {
    const normalizedHash = normalizePaymentTxHash(txHash)
    if (
      !/^0x[0-9a-f]{64}$/.test(normalizedHash) ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId) ||
      !Number.isFinite(amountUsd) || amountUsd <= 0 ||
      !/^0x[0-9a-f]{40}$/i.test(senderAddress) || !clientId
    ) throw new Error('Invalid sponsored deposit binding.')
    const recorded = this.withDurableLock(this.demoBudgetLockPath, () => {
      let bindings: Record<string, DemoDepositBinding> = {}
      try { bindings = JSON.parse(nodeFs.readFileSync(this.demoDepositBindingsFilePath, 'utf-8')) } catch {}
      bindings[normalizedHash] = { tenantId, amountUsd, senderAddress: senderAddress.toLowerCase(), clientId, createdAt: Date.now() }
      const tempPath = `${this.demoDepositBindingsFilePath}.tmp.${process.pid}.${Date.now()}`
      nodeFs.writeFileSync(tempPath, JSON.stringify(bindings, null, 2), { encoding: 'utf-8', mode: 0o600 })
      nodeFs.renameSync(tempPath, this.demoDepositBindingsFilePath)
      return true
    })
    if (recorded !== true) throw new Error('Sponsored deposit binding store is busy.')
  }

  public getDemoDepositBinding(txHash: string): DemoDepositBinding | undefined {
    const normalizedHash = normalizePaymentTxHash(txHash)
    if (!/^0x[0-9a-f]{64}$/.test(normalizedHash) || !nodeFs) return undefined
    try {
      const bindings = JSON.parse(nodeFs.readFileSync(this.demoDepositBindingsFilePath, 'utf-8')) as Record<string, DemoDepositBinding>
      const binding = bindings[normalizedHash]
      if (!binding || Date.now() - binding.createdAt > 7 * 24 * 60 * 60 * 1000) return undefined
      return binding
    } catch { return undefined }
  }

  public consumeDemoDepositBinding(txHash: string): void {
    const normalizedHash = normalizePaymentTxHash(txHash)
    if (!/^0x[0-9a-f]{64}$/.test(normalizedHash) || !nodeFs) return
    this.withDurableLock(this.demoBudgetLockPath, () => {
      let bindings: Record<string, DemoDepositBinding> = {}
      try { bindings = JSON.parse(nodeFs.readFileSync(this.demoDepositBindingsFilePath, 'utf-8')) } catch {}
      if (!bindings[normalizedHash]) return
      delete bindings[normalizedHash]
      const tempPath = `${this.demoDepositBindingsFilePath}.tmp.${process.pid}.${Date.now()}`
      nodeFs.writeFileSync(tempPath, JSON.stringify(bindings, null, 2), { encoding: 'utf-8', mode: 0o600 })
      nodeFs.renameSync(tempPath, this.demoDepositBindingsFilePath)
    })
  }

  /** Reserve a durable aggregate sponsorship budget for the public demo wallet. */
  public reserveDemoBudget(amountUsd: number, limitUsd = 100): boolean {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !nodeFs) return Boolean(!nodeFs)
    const result = this.withDurableLock(this.demoBudgetLockPath, () => {
      let spentUsd = 0
      try {
        const parsed = JSON.parse(nodeFs.readFileSync(this.demoBudgetFilePath, 'utf-8')) as { spentUsd?: unknown }
        if (typeof parsed.spentUsd === 'number' && Number.isFinite(parsed.spentUsd) && parsed.spentUsd >= 0) spentUsd = parsed.spentUsd
      } catch {}
      if (spentUsd + amountUsd > limitUsd) return false
      const parsed = (() => {
        try { return JSON.parse(nodeFs.readFileSync(this.demoBudgetFilePath, 'utf-8')) as Record<string, unknown> } catch { return {} }
      })()
      const next = {
        ...parsed,
        spentUsd: Number((spentUsd + amountUsd).toFixed(2)),
        updatedAt: Date.now(),
      }
      const tempPath = `${this.demoBudgetFilePath}.tmp.${process.pid}.${Date.now()}`
      nodeFs.writeFileSync(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
      nodeFs.renameSync(tempPath, this.demoBudgetFilePath)
      return true
    })
    return result === true
  }

  /** Release a reservation only when a broadcast definitely did not start. */
  public releaseDemoBudget(amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !nodeFs) return
    this.withDurableLock(this.demoBudgetLockPath, () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(nodeFs.readFileSync(this.demoBudgetFilePath, 'utf-8')) as Record<string, unknown>
      } catch {}
      const spentUsd = typeof parsed.spentUsd === 'number' && Number.isFinite(parsed.spentUsd) && parsed.spentUsd >= 0 ? parsed.spentUsd : 0
      const next = {
        ...parsed,
        spentUsd: Math.max(0, Number((spentUsd - amountUsd).toFixed(2))),
        updatedAt: Date.now(),
      }
      const tempPath = `${this.demoBudgetFilePath}.tmp.${process.pid}.${Date.now()}`
      nodeFs.writeFileSync(tempPath, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
      nodeFs.renameSync(tempPath, this.demoBudgetFilePath)
      return true
    })
  }

  /** Durably record the signed transfer identity before any RPC broadcast. */
  public recordPendingDemoBudget(txHash: string, amountUsd: number, nonce?: string, senderAddress?: string): void {
    const normalizedHash = normalizePaymentTxHash(txHash)
    if (!/^0x[0-9a-f]{64}$/.test(normalizedHash) || !Number.isFinite(amountUsd) || amountUsd <= 0 || !nodeFs) {
      throw new Error('Invalid pending demo budget reservation.')
    }
    if ((nonce && !/^0x[0-9a-f]+$/i.test(nonce)) || (senderAddress && !/^0x[0-9a-f]{40}$/i.test(senderAddress))) {
      throw new Error('Invalid pending demo transfer identity.')
    }
    const recorded = this.withDurableLock(this.demoBudgetLockPath, () => {
      let parsed: { spentUsd?: unknown; pendingReservations?: Record<string, { amountUsd?: unknown; createdAt?: unknown; nonce?: unknown; senderAddress?: unknown }> } = {}
      try { parsed = JSON.parse(nodeFs.readFileSync(this.demoBudgetFilePath, 'utf-8')) } catch {}
      const pendingReservations = parsed.pendingReservations && typeof parsed.pendingReservations === 'object'
        ? parsed.pendingReservations
        : {}
      pendingReservations[normalizedHash] = { amountUsd, createdAt: Date.now(), nonce, senderAddress }
      const tempPath = `${this.demoBudgetFilePath}.tmp.${process.pid}.${Date.now()}`
      nodeFs.writeFileSync(tempPath, JSON.stringify({
        spentUsd: typeof parsed.spentUsd === 'number' && Number.isFinite(parsed.spentUsd) ? parsed.spentUsd : 0,
        pendingReservations,
        updatedAt: Date.now(),
      }, null, 2), { encoding: 'utf-8', mode: 0o600 })
      nodeFs.renameSync(tempPath, this.demoBudgetFilePath)
      return true
    })
    if (recorded !== true) throw new Error('Demo budget is busy; signed transfer was not broadcast.')
  }

  public getPendingDemoBudgetReservations(): Array<{ txHash: string; amountUsd: number; nonce?: string; senderAddress?: string }> {
    if (!nodeFs) return []
    try {
      const parsed = JSON.parse(nodeFs.readFileSync(this.demoBudgetFilePath, 'utf-8')) as {
        pendingReservations?: Record<string, { amountUsd?: unknown; nonce?: unknown; senderAddress?: unknown }>
      }
      return Object.entries(parsed.pendingReservations || {}).flatMap(([txHash, reservation]) =>
        typeof reservation?.amountUsd === 'number' && Number.isFinite(reservation.amountUsd) && reservation.amountUsd > 0
          ? [{
              txHash,
              amountUsd: reservation.amountUsd,
              nonce: typeof reservation.nonce === 'string' && /^0x[0-9a-f]+$/i.test(reservation.nonce) ? reservation.nonce : undefined,
              senderAddress: typeof reservation.senderAddress === 'string' && /^0x[0-9a-f]{40}$/i.test(reservation.senderAddress)
                ? reservation.senderAddress : undefined,
            }]
          : [],
      )
    } catch {
      return []
    }
  }

  /** Resolve a pending budget reservation after the chain receipt is known. */
  public resolvePendingDemoBudget(txHash: string, outcome: 'confirmed' | 'reverted' | 'absent'): void {
    const normalizedHash = normalizePaymentTxHash(txHash)
    if (!normalizedHash || !nodeFs) return
    this.withDurableLock(this.demoBudgetLockPath, () => {
      let parsed: { spentUsd?: unknown; pendingReservations?: Record<string, { amountUsd?: unknown }>; [key: string]: unknown } = {}
      try { parsed = JSON.parse(nodeFs.readFileSync(this.demoBudgetFilePath, 'utf-8')) } catch {}
      const pendingReservations = parsed.pendingReservations && typeof parsed.pendingReservations === 'object'
        ? { ...parsed.pendingReservations }
        : {}
      const reservation = pendingReservations[normalizedHash]
      if (!reservation) return
      delete pendingReservations[normalizedHash]
      const spentUsd = typeof parsed.spentUsd === 'number' && Number.isFinite(parsed.spentUsd) ? parsed.spentUsd : 0
      const nextSpent = outcome === 'reverted' || outcome === 'absent'
        ? Math.max(0, Number((spentUsd - (typeof reservation.amountUsd === 'number' ? reservation.amountUsd : 0)).toFixed(2)))
        : spentUsd
      const tempPath = `${this.demoBudgetFilePath}.tmp.${process.pid}.${Date.now()}`
      nodeFs.writeFileSync(tempPath, JSON.stringify({
        ...parsed,
        spentUsd: nextSpent,
        pendingReservations,
        updatedAt: Date.now(),
      }, null, 2), { encoding: 'utf-8', mode: 0o600 })
      nodeFs.renameSync(tempPath, this.demoBudgetFilePath)
    })
  }



  /**
   * Atomic Compare-and-Swap Payment Request Consumption
   * Enforces:
   * 1. Concurrency isolation (locks ID against simultaneous race conditions)
   * 2. ID exists
   * 3. Status is currently 'active' (replay rejection)
   * 4. Expiration threshold
   * 5. Strict amount match (prevents payer underpaying fixed invoice)
   * 6. Strict asset match
   * 7. Strict chain match (if specified)
   * 8. Atomic disk write before returning
   */
  public atomicConsumePaymentRequest(
    id: string,
    paymentData: {
      payAmount: number
      payAsset: AssetSymbol
      payChain: ChainId
      txHash: string
      clientProof?: string
    }
  ): ConsumeResult {
    return this.withRequestsWriteLock(() => {
      // Concurrency guard against simultaneous race conditions on the same invoice ID
      if (this.consumingIds.has(id)) {
        return { success: false, error: 'ALREADY_CONSUMED' as const }
      }
      this.consumingIds.add(id)

      try {
        const all = this.loadRequests()
        const req = all[id]

        if (!req) {
          return { success: false, error: 'NOT_FOUND' as const }
        }

        if (req.status === 'consumed') {
          return { success: false, error: 'ALREADY_CONSUMED' as const, request: req }
        }

      // An invoice is claimed only after its source-chain payment has been
      // verified while the request is active. Its recipient settlement may
      // take longer than the invoice lifetime, so the active in-flight claim
      // must be allowed to finish instead of stranding an already-paid invoice.
        const hasActiveProcessingClaim = this.processingPaymentRequestIds.has(id)
        if ((req.status === 'expired' || Date.now() > req.expiresAt) && !hasActiveProcessingClaim) {
          req.status = 'expired'
          all[id] = req
          this.saveRequests(all)
          return { success: false, error: 'EXPIRED' as const, request: req }
        }

        if (this.hasUsedPaymentTxHash(paymentData.txHash, id)) {
          return { success: false, error: 'TX_ALREADY_USED' as const, request: req }
        }

      // Invoice Amount Integrity: If invoice has a fixed amount, payAmount must match exactly
        if (req.amount && req.amount > 0) {
          if (Math.round(paymentData.payAmount * 100) !== Math.round(req.amount * 100)) {
            return { success: false, error: 'AMOUNT_MISMATCH' as const, request: req }
          }
        }

      // Invoice Asset Integrity: If invoice specified an asset, payAsset must match
        if (req.asset && paymentData.payAsset !== req.asset) {
          return { success: false, error: 'ASSET_MISMATCH' as const, request: req }
        }

      // Strict chain integrity validation
        if (req.chain && paymentData.payChain && paymentData.payChain !== req.chain) {
          return { success: false, error: 'CHAIN_MISMATCH' as const, request: req }
        }

      // Atomic state update
        req.status = 'consumed'
        req.consumedAt = Date.now()
        req.txHash = paymentData.txHash
        if (paymentData.clientProof) {
          req.clientProof = paymentData.clientProof
        }
        all[id] = req
        this.saveRequests(all)

        return { success: true as const, request: req }
      } finally {
        this.consumingIds.delete(id)
      }
    })
  }

  /**
   * Resume an invoice consumption from a durable external-operation record.
   * This is intentionally separate from the normal CAS path: the source
   * payment was already verified before the shielded broadcast, so a restart
   * must be able to finish the same invoice even if its display expiry passed
   * while the process was down. The payment hash is still checked against all
   * other consumed requests and ledger rows before the state is written.
   */
  public recoverPaymentRequestConsumption(
    id: string,
    paymentData: {
      payAmount: number
      payAsset: AssetSymbol
      payChain: ChainId
      txHash: string
      clientProof?: string
    },
  ): ConsumeResult {
    return this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const req = all[id]
      if (!req) return { success: false, error: 'NOT_FOUND' as const }
      if (req.status === 'consumed') {
        return req.txHash && normalizePaymentTxHash(req.txHash) === normalizePaymentTxHash(paymentData.txHash)
          ? { success: true as const, request: req }
          : { success: false, error: 'ALREADY_CONSUMED' as const, request: req }
      }
      if (this.hasUsedPaymentTxHash(paymentData.txHash, id)) {
        return { success: false, error: 'TX_ALREADY_USED' as const, request: req }
      }
      if (req.amount && Math.round(paymentData.payAmount * 100) !== Math.round(req.amount * 100)) {
        return { success: false, error: 'AMOUNT_MISMATCH' as const, request: req }
      }
      if (req.asset && paymentData.payAsset !== req.asset) {
        return { success: false, error: 'ASSET_MISMATCH' as const, request: req }
      }
      if (req.chain && paymentData.payChain !== req.chain) {
        return { success: false, error: 'CHAIN_MISMATCH' as const, request: req }
      }

      req.status = 'consumed'
      req.consumedAt = req.consumedAt || Date.now()
      req.txHash = paymentData.txHash
      if (paymentData.clientProof) req.clientProof = paymentData.clientProof
      all[id] = req
      this.saveRequests(all)
      return { success: true as const, request: req }
    })
  }

  public revertPaymentRequestConsumption(id: string): void {
    this.withRequestsWriteLock(() => {
      const all = this.loadRequests()
      const req = all[id]
      if (req && req.status === 'consumed') {
        req.status = 'active'
        delete req.consumedAt
        delete req.txHash
        delete req.clientProof
        all[id] = req
        this.saveRequests(all)
      }
      return true
    })
  }

  public resetTenant(tenantId: string = 'default', defaultSeed: AuraTransaction[]): void {
    this.withLedgerWriteLock(() => {
      const all = this.readRawLedger(true)
      all[tenantId] = cloneJson(defaultSeed)
      this.writeRawLedger(all)
    })
  }
}

export const persistentStore = new PersistentStore()
