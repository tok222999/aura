export interface ProductionBoundaryReport {
  mode: 'hackathon-demo' | 'production'
  status: 'demo-only' | 'not-ready'
  demoReady: boolean
  productionReady: false
  productionQuoteOutboxConfigured: boolean
  productionRetentionConfigured: boolean
  blockers: string[]
}

export interface ProductionExecutionBlock {
  error: 'PRODUCTION_BOUNDARY_NOT_READY'
  operation: string
  message: string
  blockers: string[]
}

export type AuraRuntimeMode = 'hackathon-testnet' | 'production'

/**
 * Product execution mode is deliberately independent from NODE_ENV.
 * Hosted Next.js builds normally set NODE_ENV=production even when the
 * deployed app is still the public hackathon testnet demo.
 */
export function getAuraRuntimeMode(value = process.env.AURA_RUNTIME_MODE): AuraRuntimeMode {
  return value?.trim().toLowerCase() === 'production' ? 'production' : 'hackathon-testnet'
}

/**
 * Keep the competition demo and the future custody product explicitly
 * separate. The current build has durable demo storage and testnet relayers,
 * but it is not a production custody boundary.
 */
export function getProductionBoundaryReport(environment = process.env.AURA_RUNTIME_MODE): ProductionBoundaryReport {
  const isProduction = getAuraRuntimeMode(environment) === 'production'
  const productionQuoteOutboxConfigured = isProduction && Boolean(process.env.AURA_PRODUCTION_DB_PATH?.trim())
  const retentionDays = Number(process.env.AURA_DATA_RETENTION_DAYS)
  const productionRetentionConfigured = !isProduction ||
    (Number.isFinite(retentionDays) && retentionDays > 0 && retentionDays <= 3650)
  return {
    mode: isProduction ? 'production' : 'hackathon-demo',
    status: isProduction ? 'not-ready' : 'demo-only',
    demoReady: !isProduction,
    productionReady: false,
    productionQuoteOutboxConfigured,
    productionRetentionConfigured,
    blockers: [
      productionQuoteOutboxConfigured
        ? 'transactional database/outbox still needs to cover the complete ledger and idempotency pipeline'
        : 'configure the transactional quote/outbox adapter with AURA_PRODUCTION_DB_PATH',
      ...(productionRetentionConfigured ? [] : ['AURA_DATA_RETENTION_DAYS must be a finite positive retention window in production']),
      'audited production signing/custody backend required',
      'self-custodial Zcash engine and secure device unlock required',
    ],
  }
}

/**
 * Sensitive write routes fail closed only when the operator explicitly opts
 * into AURA_RUNTIME_MODE=production. NODE_ENV alone is not a product-mode
 * switch because hosted hackathon builds also use NODE_ENV=production.
 */
export function getProductionExecutionBlock(operation: string, environment = process.env.AURA_RUNTIME_MODE): ProductionExecutionBlock | null {
  const report = getProductionBoundaryReport(environment)
  if (report.mode !== 'production' || report.productionReady) return null
  return {
    error: 'PRODUCTION_BOUNDARY_NOT_READY',
    operation,
    message: 'AURA production execution is disabled until the transactional database, audited custody/signing, and self-custodial Zcash boundary are configured.',
    blockers: report.blockers,
  }
}
