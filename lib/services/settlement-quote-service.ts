import { AssetSymbol, ChainId, PrivacyBufferMode } from '@/lib/types/aura'
import { generateSecureId } from '@/lib/utils'
import { ratesService } from '@/lib/services/rates-service'
import { persistentStore, StoredSettlementQuote } from '@/lib/services/persistent-store'
import { getProductionSqliteStore } from '@/lib/services/production-sqlite-store'
import { ledgerService } from '@/lib/services/ledger-service'
import { calculatePrivacyRiskSnapshot } from '@/lib/utils/privacy-risk'
import { reconcileLedgerBalanceWithShieldedChain } from '@/lib/services/authoritative-balance'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { getMinimumConfirmationsForBuffer, getShieldedSpendableZec, ZCASH_FEE_RESERVE_ZEC } from '@/lib/services/zcash-balance'
import { usesSharedJuryZcashSource } from '@/lib/services/jury-zcash-source'

export const SETTLEMENT_QUOTE_TTL_MS = 90_000

export type SettlementQuote = Omit<StoredSettlementQuote, 'bufferMode'> & {
  bufferMode: PrivacyBufferMode
}

export interface SettlementQuoteRequest {
  tenantId: string
  amountUsd: number
  asset: AssetSymbol
  chain: ChainId
  transactionType: 'send' | 'withdraw'
  bufferMode: PrivacyBufferMode
}

export type SettlementQuoteIssueError =
  | 'RATE_UNAVAILABLE'
  | 'ZCASH_BALANCE_UNAVAILABLE'
  | 'INSUFFICIENT_READY_ZEC'
  | 'NOT_MATURE'

export type SettlementQuoteIssueResult = SettlementQuote | { error: SettlementQuoteIssueError }

export function calculateSettlementAmounts(amountUsd: number, zecUsd: number, solUsd?: number): {
  amountZec: number
  amountSol?: number
} {
  return {
    amountZec: Number((amountUsd / zecUsd).toFixed(6)),
    amountSol: solUsd === undefined ? undefined : Number((amountUsd / solUsd).toFixed(5)),
  }
}

type QuoteVerification =
  | { ok: true; quote: SettlementQuote }
  | { ok: false; error: 'QUOTE_NOT_FOUND' | 'QUOTE_EXPIRED' | 'QUOTE_ALREADY_USED' | 'QUOTE_MISMATCH' }

/**
 * A short-lived, tenant-bound settlement quote. The client signs the exact
 * quote returned here; the spend route never re-prices the same request from
 * a second live oracle read.
 *
 * The hackathon implementation persists quotes in the local `.aura-data`
 * store and protects issuance/consumption with a durable lock. A production
 * deployment must move quote issuance and consumption into the same
 * transactional database/outbox as the spend nonce/idempotency record.
 */
class SettlementQuoteService {
  private getStore(): Pick<typeof persistentStore, 'pruneSettlementQuotes' | 'getSettlementQuote' | 'saveSettlementQuote' | 'consumeSettlementQuote'> {
    // Production must use the transactional SQLite quote/outbox adapter when
    // configured. The demo intentionally keeps its existing JSON store so the
    // hackathon proof remains reproducible and isolated from this backend.
    return getProductionSqliteStore() || persistentStore
  }

  private prune(now = Date.now()): void {
    this.getStore().pruneSettlementQuotes(now)
  }

  public async issue(input: SettlementQuoteRequest): Promise<SettlementQuoteIssueResult> {
    this.prune()
    const [zecRate, solRate] = await Promise.all([
      ratesService.getFreshRate('ZEC'),
      input.chain === 'solana' ? ratesService.getFreshRate('SOL') : Promise.resolve(null),
    ])
    if (!zecRate || (input.chain === 'solana' && !solRate)) return { error: 'RATE_UNAVAILABLE' }

    const issuedAt = Date.now()
    const calculated = calculateSettlementAmounts(input.amountUsd, zecRate.usdPrice, solRate?.usdPrice)
    // Quote the same authoritative ZEC snapshot that the final reservation
    // will use. Jury Pay spends from AURA's pooled, pre-funded source; using a
    // fresh tenant account here would make the quote disagree with /spend and
    // falsely report $0 or an unavailable ZEC fee reserve.
    const usesSharedSource = usesSharedJuryZcashSource(input.tenantId)
    const settlementAccount = usesSharedSource
      ? await zcashDevtoolService.getSharedSourceAccount().catch(() => null)
      : await zcashDevtoolService.ensureTenantAccount(input.tenantId).catch(() => null)
    const tenantBalance = settlementAccount
      ? await zcashDevtoolService.getBalance(settlementAccount.accountId).catch(() => null)
      : null
    if (!settlementAccount || !tenantBalance?.available) return { error: 'ZCASH_BALANCE_UNAVAILABLE' }
    const eligibleTenantBalance = settlementAccount
      ? await zcashDevtoolService.getBalance(
        settlementAccount.accountId,
        getMinimumConfirmationsForBuffer(input.bufferMode),
      ).catch(() => null)
      : null
    if (!eligibleTenantBalance?.available) return { error: 'ZCASH_BALANCE_UNAVAILABLE' }
    // Jury inventory is already confirmed backing; issuing a quote must not
    // create a fresh shielded destination or wait for a new Zcash send.
    const feeDestination = usesSharedSource ? undefined : settlementAccount.unified
    let actualFeeZec = feeDestination
      ? await zcashDevtoolService.estimateShieldedFeeZec(settlementAccount.accountId, feeDestination, calculated.amountZec, getMinimumConfirmationsForBuffer(input.bufferMode))
      : null
    // The read-only proposal can briefly fail while the wallet is syncing,
    // even when the authoritative balance read succeeded. Retry once after a
    // sync; if the preview is still unavailable, use only the documented
    // ZIP-317 minimum reserve. The final send performs its own exact fee and
    // input check, so this never invents spendable balance or bypasses policy.
    if (actualFeeZec === null && !usesSharedSource && zcashDevtoolService.isAvailable()) {
      const syncResult = await zcashDevtoolService.sync().catch(() => ({ success: false }))
      if (syncResult.success && feeDestination) {
        actualFeeZec = await zcashDevtoolService.estimateShieldedFeeZec(
          settlementAccount.accountId,
          feeDestination,
          calculated.amountZec,
          getMinimumConfirmationsForBuffer(input.bufferMode),
        )
      }
    }
    const feeReserveZec = actualFeeZec ?? ZCASH_FEE_RESERVE_ZEC
    const spendableZec = Math.max(0, getShieldedSpendableZec(tenantBalance) - feeReserveZec)
    const eligibleSpendableZec = Math.max(0, getShieldedSpendableZec(eligibleTenantBalance) - feeReserveZec)
    if (spendableZec < calculated.amountZec) return { error: 'INSUFFICIENT_READY_ZEC' }
    if (eligibleSpendableZec < calculated.amountZec) return { error: 'NOT_MATURE' }
    const tenantLedger = ledgerService.getTenantBalance(input.tenantId)
    const maxEntitlementUsd = usesSharedJuryZcashSource(input.tenantId)
      ? tenantLedger.totalUsd
      : null
    const reconciledBalance = reconcileLedgerBalanceWithShieldedChain(
      tenantLedger,
      Number((spendableZec * zecRate.usdPrice).toFixed(2)),
      spendableZec,
      zecRate.usdPrice,
      eligibleSpendableZec,
      maxEntitlementUsd,
    )
    if (reconciledBalance.readyToSpendUsd < input.amountUsd) return { error: 'INSUFFICIENT_READY_ZEC' }
    const privacyRiskSnapshot = calculatePrivacyRiskSnapshot({
      transactions: ledgerService.getTransactions(input.tenantId),
      totalBalanceUsd: reconciledBalance.totalUsd,
      amountUsd: input.amountUsd,
      policy: input.bufferMode,
      zecUsd: zecRate.usdPrice,
      now: issuedAt,
    })
    const quote: SettlementQuote = {
      quoteId: generateSecureId('quote'),
      tenantId: input.tenantId,
      amountUsd: input.amountUsd,
      amountZec: calculated.amountZec,
      amountSol: calculated.amountSol,
      asset: input.asset,
      chain: input.chain,
      transactionType: input.transactionType,
      bufferMode: input.bufferMode,
      zecUsd: zecRate.usdPrice,
      solUsd: solRate?.usdPrice,
      issuedAt,
      expiresAt: issuedAt + SETTLEMENT_QUOTE_TTL_MS,
      privacyRiskSnapshot,
    }
    this.getStore().saveSettlementQuote(quote)
    return { ...quote }
  }

  public verify(input: {
    quoteId: unknown
    tenantId: string
    amountUsd: number
    amountZec: number
    asset: string
    chain: string
    transactionType: string
    bufferMode: string
    quoteZecUsd: number
    quoteSolUsd?: number
    quoteExpiresAt: number
    privacyRiskHash: string
  }): QuoteVerification {
    this.prune()
    if (typeof input.quoteId !== 'string' || !input.quoteId) return { ok: false, error: 'QUOTE_NOT_FOUND' }
    const quote = this.getStore().getSettlementQuote(input.quoteId)
    if (!quote) return { ok: false, error: 'QUOTE_NOT_FOUND' }
    if (quote.usedAt) return { ok: false, error: 'QUOTE_ALREADY_USED' }
    if (quote.expiresAt <= Date.now() || input.quoteExpiresAt !== quote.expiresAt) {
      return { ok: false, error: 'QUOTE_EXPIRED' }
    }
    const typedQuote = quote as SettlementQuote
    if (!typedQuote.privacyRiskSnapshot?.hash || typedQuote.privacyRiskSnapshot.schemaVersion !== 'aura-privacy-risk-v1') {
      return { ok: false, error: 'QUOTE_MISMATCH' }
    }
    const sameSolRate = typedQuote.solUsd === undefined
      ? input.quoteSolUsd === undefined
      : input.quoteSolUsd === typedQuote.solUsd
    const matches = typedQuote.tenantId === input.tenantId &&
      typedQuote.amountUsd === input.amountUsd &&
      typedQuote.amountZec === Number(input.amountZec.toFixed(6)) &&
      typedQuote.asset === input.asset &&
      typedQuote.chain === input.chain &&
      typedQuote.transactionType === input.transactionType &&
      typedQuote.bufferMode === input.bufferMode &&
      typedQuote.zecUsd === input.quoteZecUsd &&
      typedQuote.privacyRiskSnapshot.hash === input.privacyRiskHash &&
      sameSolRate
    if (!matches) return { ok: false, error: 'QUOTE_MISMATCH' }
    return { ok: true, quote: { ...typedQuote } }
  }

  public consume(quoteId: string, tenantId: string): boolean {
    return this.getStore().consumeSettlementQuote(quoteId, tenantId)
  }
}

export const settlementQuoteService = new SettlementQuoteService()
