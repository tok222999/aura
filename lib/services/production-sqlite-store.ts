import type { StoredSettlementQuote } from './persistent-store'
import { getAuraRuntimeMode } from './production-boundary'

type SqliteStatement = {
  run: (...params: unknown[]) => unknown
  get: (...params: unknown[]) => Record<string, unknown> | undefined
  all: (...params: unknown[]) => Array<Record<string, unknown>>
}

type SqliteDatabase = {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

type NodeSqliteModule = {
  DatabaseSync: new (path: string) => SqliteDatabase
}

function loadNodeSqlite(): NodeSqliteModule | null {
  if (typeof window !== 'undefined') return null
  try {
    // Keep this server-only and dependency-free. Node 24 ships node:sqlite;
    // older runtimes fail closed through the production boundary instead of
    // silently falling back to the demo JSON store.
    const requireFn = eval('require') as (id: string) => NodeSqliteModule
    return requireFn('node:sqlite')
  } catch {
    return null
  }
}

function loadNodeFs(): { mkdirSync: (path: string, options: { recursive: boolean }) => void } | null {
  if (typeof window !== 'undefined') return null
  try {
    const requireFn = eval('require') as (id: string) => { mkdirSync: (path: string, options: { recursive: boolean }) => void }
    return requireFn('node:fs')
  } catch {
    return null
  }
}

function loadNodePath(): { dirname: (path: string) => string } | null {
  if (typeof window !== 'undefined') return null
  try {
    const requireFn = eval('require') as (id: string) => { dirname: (path: string) => string }
    return requireFn('node:path')
  } catch {
    return null
  }
}

function createEventId(): string {
  try {
    const requireFn = eval('require') as (id: string) => { randomUUID: () => string }
    return requireFn('node:crypto').randomUUID()
  } catch {
    throw new Error('Production cryptographic randomness is unavailable')
  }
}

export interface ProductionOutboxEvent {
  id: string
  tenantId: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: Record<string, unknown>
  status: 'pending' | 'processing' | 'sent' | 'failed'
  attempts: number
  availableAt: number
  createdAt: number
  sentAt?: number
  lastError?: string
}

/**
 * Production-only transactional persistence for settlement quotes and the
 * outbox. It is deliberately opt-in: the hackathon demo continues to use its
 * tested JSON store, while production refuses to start without this backend.
 */
export class ProductionSqliteStore {
  private readonly db: SqliteDatabase

  constructor(path: string) {
    if (!path.trim()) throw new Error('AURA_PRODUCTION_DB_PATH is required')
    const fs = loadNodeFs()
    const nodePath = loadNodePath()
    const sqlite = loadNodeSqlite()
    if (!fs || !nodePath || !sqlite) throw new Error('Production SQLite runtime is unavailable')
    fs.mkdirSync(nodePath.dirname(path), { recursive: true })
    this.db = new sqlite.DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settlement_quotes (
        quote_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS settlement_quotes_expiry_idx
        ON settlement_quotes (expires_at);
      CREATE TABLE IF NOT EXISTS production_outbox (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS production_outbox_ready_idx
        ON production_outbox (status, available_at, created_at);
    `)
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  public close(): void {
    this.db.close()
  }

  public pruneSettlementQuotes(now = Date.now()): void {
    this.db.prepare('DELETE FROM settlement_quotes WHERE expires_at <= ? OR used_at IS NOT NULL').run(now)
  }

  public getSettlementQuote(quoteId: string): StoredSettlementQuote | null {
    const row = this.db.prepare(
      'SELECT payload_json FROM settlement_quotes WHERE quote_id = ? AND used_at IS NULL AND expires_at > ?',
    ).get(quoteId, Date.now())
    if (!row || typeof row.payload_json !== 'string') return null
    try {
      return JSON.parse(row.payload_json) as StoredSettlementQuote
    } catch {
      return null
    }
  }

  public saveSettlementQuote(quote: StoredSettlementQuote): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO settlement_quotes (quote_id, tenant_id, payload_json, issued_at, expires_at, used_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(quote.quoteId, quote.tenantId, JSON.stringify(quote), quote.issuedAt, quote.expiresAt)

      this.enqueueOutboxInTransaction({
        tenantId: quote.tenantId,
        aggregateType: 'settlement_quote',
        aggregateId: quote.quoteId,
        eventType: 'settlement_quote.issued',
        payload: { quoteId: quote.quoteId, expiresAt: quote.expiresAt },
      })
    })
  }

  public consumeSettlementQuote(quoteId: string, tenantId: string, now = Date.now()): boolean {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE settlement_quotes
        SET used_at = ?
        WHERE quote_id = ? AND tenant_id = ? AND used_at IS NULL AND expires_at > ?
      `).run(now, quoteId, tenantId, now) as { changes?: number }
      if (result.changes !== 1) return false
      this.enqueueOutboxInTransaction({
        tenantId,
        aggregateType: 'settlement_quote',
        aggregateId: quoteId,
        eventType: 'settlement_quote.consumed',
        payload: { quoteId, consumedAt: now },
      })
      return true
    })
  }

  private enqueueOutboxInTransaction(input: Omit<ProductionOutboxEvent, 'id' | 'status' | 'attempts' | 'availableAt' | 'createdAt' | 'sentAt' | 'lastError'>): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO production_outbox
        (id, tenant_id, aggregate_type, aggregate_id, event_type, payload_json, status, attempts, available_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(
      createEventId(),
      input.tenantId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      JSON.stringify(input.payload),
      now,
      now,
    )
  }

  public claimOutbox(limit = 25, now = Date.now()): ProductionOutboxEvent[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM production_outbox
        WHERE status IN ('pending', 'failed') AND available_at <= ?
        ORDER BY created_at ASC
        LIMIT ?
      `).all(now, Math.max(1, Math.min(100, Math.floor(limit))))
      const events: ProductionOutboxEvent[] = []
      const mark = this.db.prepare(`
        UPDATE production_outbox
        SET status = 'processing', attempts = attempts + 1
        WHERE id = ? AND status IN ('pending', 'failed')
      `)
      for (const row of rows) {
        if (typeof row.id !== 'string') continue
        mark.run(row.id)
        let payload: Record<string, unknown> = {}
        try { payload = JSON.parse(String(row.payload_json)) as Record<string, unknown> } catch {}
        events.push({
          id: row.id,
          tenantId: String(row.tenant_id),
          aggregateType: String(row.aggregate_type),
          aggregateId: String(row.aggregate_id),
          eventType: String(row.event_type),
          payload,
          status: 'processing',
          attempts: Number(row.attempts || 0) + 1,
          availableAt: Number(row.available_at),
          createdAt: Number(row.created_at),
        })
      }
      return events
    })
  }

  public markOutboxSent(id: string, sentAt = Date.now()): void {
    this.db.prepare(`
      UPDATE production_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?
    `).run(sentAt, id)
  }

  public markOutboxFailed(id: string, error: string, retryAt = Date.now() + 5_000): void {
    this.db.prepare(`
      UPDATE production_outbox SET status = 'failed', available_at = ?, last_error = ? WHERE id = ?
    `).run(retryAt, error.slice(0, 1000), id)
  }
}

let productionStore: ProductionSqliteStore | null | undefined

/** Returns a production adapter only when explicitly configured. */
export function getProductionSqliteStore(): ProductionSqliteStore | null {
  if (getAuraRuntimeMode() !== 'production') return null
  if (productionStore !== undefined) return productionStore
  const path = process.env.AURA_PRODUCTION_DB_PATH?.trim()
  if (!path) {
    productionStore = null
    return null
  }
  try {
    productionStore = new ProductionSqliteStore(path)
  } catch {
    productionStore = null
  }
  return productionStore
}

