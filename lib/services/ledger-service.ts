import { AuraTransaction } from '../types/aura'
import { persistentStore } from './persistent-store'
import { PersistentStore } from './persistent-store'

/**
 * LedgerService
 *
 * Synchronized multi-tenant ledger for Aura transactions.
 * Transactions persist across app restarts and remain strictly isolated
 * by enclave fingerprint / tenant session.
 */
export class LedgerService {
  constructor(private readonly store: PersistentStore = persistentStore) {}

  public getTransactions(tenantId: string = 'default', filter?: string): AuraTransaction[] {
    // No fake seed data — only real transactions appear in the ledger
    // Ledger state may be updated by another server process. Always read a
    // fresh durable snapshot at the service boundary instead of trusting a
    // process-local cache for activity or balance decisions.
    const txs = this.store.loadTransactions(tenantId, [], true)

    if (!filter || filter === 'all') {
      return [...txs]
    }
    return txs.filter((tx) => {
      if (filter === 'deposits') return tx.type === 'deposit'
      if (filter === 'sends') return tx.type === 'send' || tx.type === 'withdraw'
      if (filter === 'received') return tx.type === 'receive'
      if (filter === 'withdrew') return tx.type === 'withdraw'
      return true
    })
  }

  public getTransactionById(id: string, tenantId?: string): AuraTransaction | undefined {
    const targetTenant = tenantId || 'default'
    const txs = this.getTransactions(targetTenant)
    return txs.find((tx) => tx.id === id)
  }

  public listTenantIds(): string[] {
    return this.store.listTenantIds()
  }

  public addTransaction(tx: AuraTransaction, tenantId: string = 'default'): AuraTransaction {
    return this.store.mutateTransactions(tenantId, (txs) => {
      txs.unshift(tx)
      return { transactions: txs, result: tx }
    })
  }

  public updateTransaction(id: string, updates: Partial<AuraTransaction>, tenantId: string = 'default'): AuraTransaction | null {
    return this.store.mutateTransactions(tenantId, (txs) => {
      const idx = txs.findIndex((t) => t.id === id)
      if (idx === -1) return { transactions: txs, result: null }
      txs[idx] = { ...txs[idx], ...updates }
      return { transactions: txs, result: txs[idx] }
    })
  }

  public reserveSpend(
    tenantId: string = 'default',
    tx: AuraTransaction,
    totalRequiredUsd: number,
    bufferMode: string = 'private',
    confirmedChainUsd?: number,
    confirmedChainZec?: number,
    zecUsd?: number,
  ) {
    return this.store.reserveSpend(tenantId, tx, totalRequiredUsd, bufferMode, confirmedChainUsd, confirmedChainZec, zecUsd)
  }

  public releaseReservation(tenantId: string = 'default', txId: string, reason?: string): void {
    this.store.releaseReservation(tenantId, txId, reason)
  }

  public confirmSpend(tenantId: string = 'default', txId: string, updates: Partial<AuraTransaction>): AuraTransaction | null {
    return this.store.confirmSpend(tenantId, txId, updates)
  }

  public getTenantBalance(tenantId: string = 'default') {
    // No fake seed — balance reflects only real transactions
    return this.store.calculateTenantBalance(tenantId, 0, [], undefined, true)
  }

  public resetDemoState(tenantId: string = 'default'): void {
    // Reset to clean state — no fake seed injection
    this.store.resetTenant(tenantId, [])
  }
}

export const ledgerService = new LedgerService()
