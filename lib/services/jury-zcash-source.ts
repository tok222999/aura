import { getAuraRuntimeMode } from '@/lib/services/production-boundary'
import { getJuryTenantPool } from '@/lib/services/demo-session-service'

type TenantBalanceReader = {
  listTenantIds(): string[]
  getTenantBalance(tenantId: string): { totalUsd: number; pendingOutboundUsd?: number }
}

type PendingBacking = {
  id: string
  kind: string
  status: string
  tenantId: string
  amountUsd?: number
}

/**
 * The hackathon inventory is a server-operated shared Zcash source. Jury
 * tenants still keep separate ledger history and signing authorities, but the
 * live testnet inventory is pooled so a browser lease does not strand funds in
 * one provisioned account. Production never uses this path.
 */
export function usesSharedJuryZcashSource(tenantId?: string): boolean {
  const configured = getJuryTenantPool()
  return Boolean(
    tenantId &&
    getAuraRuntimeMode() === 'hackathon-testnet' &&
    // The backing calculation counts these tenants. Never let an excluded
    // historical/recovery tenant spend the same pool without being counted.
    (configured.length === 0 || configured.includes(tenantId)) &&
    process.env.AURA_JURY_USE_SHARED_ZCASH_SOURCE !== 'false',
  )
}

/**
 * Capacity accounting for the hosted jury pool must use only the explicitly
 * configured jury tenants. The durable ledger also contains historical test
 * and audit tenants from local verification; counting those rows would make
 * a live pool look over-allocated even though they cannot spend in the jury
 * session.
 */
export function getSharedJuryEntitlementUsd(
  reader: TenantBalanceReader,
  pendingOperations: PendingBacking[] = [],
  excludeOperationId?: string,
): number {
  const configured = getJuryTenantPool()
  const tenantIds = configured.length ? configured : reader.listTenantIds()
  const balanceTotal = tenantIds.reduce((total: number, tenantId: string) => {
    const balance = reader.getTenantBalance(tenantId)
    return total + balance.totalUsd + (balance.pendingOutboundUsd || 0)
  }, 0)
  const pendingBackingTotal = pendingOperations.reduce((total, operation) => {
    if (operation.id === excludeOperationId || operation.kind !== 'deposit_backing' || operation.status === 'confirmed') return total
    if (!tenantIds.includes(operation.tenantId)) return total
    const amountUsd = Number(operation.amountUsd || 0)
    return Number.isFinite(amountUsd) && amountUsd > 0 ? total + amountUsd : total
  }, 0)
  return balanceTotal + pendingBackingTotal
}
