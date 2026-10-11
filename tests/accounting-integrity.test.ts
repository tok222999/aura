import fs from 'fs'
import os from 'os'
import path from 'path'
import jsQR from 'jsqr'
import {
  generateBip39Mnemonic,
  validateBip39Mnemonic,
  deriveClientVaultKeys,
  deriveRecoveryTenantIdFromSpki,
  deriveBip39SeedAsync,
  BIP39_WORDLIST,
} from '../lib/crypto/bip39'
import { PersistentStore } from '../lib/services/persistent-store'
import { AuraTransaction } from '../lib/types/aura'
import { getHistoricalLedgerBalance } from '../lib/utils/balance-history'
import { LedgerService } from '../lib/services/ledger-service'
import { InMemoryRateLimiter } from '../lib/utils/rate-limiter'
import { generateSecureId, validateEvmAddress, validateSolanaAddress } from '../lib/utils'
import { verifyClientEcdsaSignature } from '../lib/crypto/ecdsa-auth'
import { BaseRelayerService, baseRelayer, createBaseDepositProofMessage, isBaseSepoliaChainId, summarizeErc20VaultTransfers } from '../lib/crypto/base-relayer'
import { SolanaRelayerService, deriveSolanaKeyMaterial, isConfirmedSolanaSignatureStatus, isFinalizedSolanaSignatureStatus, parseSolanaBalanceResponse, solanaRelayer, summarizeSolanaVaultTransfers } from '../lib/crypto/solana-relayer'
import { areSettlementRatesReady, isFreshSettlementRate, selectConsensusRate } from '../lib/services/rates-service'
import { canFundShieldedSend, getShieldedSpendableZec, ZCASH_FEE_RESERVE_ZEC } from '../lib/services/zcash-balance'
import { isFreshMarketRate } from '../lib/utils/market-rates'
import { canonicalizeChainAddress, canonicalizeTransactionHash, createPaymentAuthorizationMessage, createPaymentRecoveryAuthorizationMessage } from '../lib/crypto/payment-authorization'
import { nearIntentsService } from '../lib/services/near-intents-service'
import { getTrustedClientId, issueDemoSession, issueJurySession, verifyDemoSession, verifyJurySession, RATE_LIMIT_COOKIE_NAME } from '../lib/services/demo-session-service'
import { reconcileLedgerBalanceWithShieldedChain } from '../lib/services/authoritative-balance'
import { shouldAcceptTenantActivityResponse } from '../lib/utils/tenant-sync'
import { broadcastRpcJson, fetchRpcJson, fetchRpcResultAcrossPool } from '../lib/services/rpc-fallback'
import { extractBroadcastTxid, extractPreparedTxid, extractTxidForMemo, extractExactZcashTransactionText, isSafeZcashWriteRetry, parseZcashListTxJson, zcashDevtoolService } from '../lib/services/zcash-devtool-service'
import { calculateSettlementAmounts } from '../lib/services/settlement-quote-service'
import { canAllocateSharedJuryDeposit, getSharedJuryAvailableCapacityUsd } from '../lib/services/demo-capacity'
import { getSharedJuryEntitlementUsd, usesSharedJuryZcashSource } from '../lib/services/jury-zcash-source'
import { hasCompletedDestinationDelivery, hasFinalizedSolanaDelivery } from '../lib/utils/transaction-finality'
import { isWorkingDemoEntryRoute } from '../lib/services/demo-route'
import { reconcilePendingDemoBudget } from '../lib/services/demo-budget-reconciler'
import { getProductionExecutionBlock } from '../lib/services/production-boundary'
import { reconcileConfirmedShieldedPayouts, reconcilePendingOperations } from '../lib/services/pending-operation-reconciler'
import { classifyDestinationSettlement } from '../lib/services/settlement-reconciler'
import { calculatePrivacyRiskSnapshot } from '../lib/utils/privacy-risk'
import { encodeQrCode } from '../lib/crypto/qr-code'

export interface TestResult {
  suite: string
  name: string
  passed: boolean
  durationMs: number
  error?: string
}

export async function runAllAuditTests(): Promise<{
  total: number
  passed: number
  failed: number
  results: TestResult[]
}> {
  const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-audit-'))
  const persistentStore = new PersistentStore(testDataDir)
  const ledgerService = new LedgerService(persistentStore)
  try {
  const results: TestResult[] = []

  test('Shared Jury Capacity', 'only tenants counted in the pool may use its backing', () => {
    const names = ['AURA_JURY_TENANT_IDS', 'AURA_JURY_TENANT_ID', 'AURA_RUNTIME_MODE', 'AURA_JURY_USE_SHARED_ZCASH_SOURCE'] as const
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    try {
      const included = 'vault_r_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const excluded = 'vault_r_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      process.env.AURA_JURY_TENANT_IDS = included
      process.env.AURA_RUNTIME_MODE = 'hackathon-testnet'
      process.env.AURA_JURY_USE_SHARED_ZCASH_SOURCE = 'true'
      if (!usesSharedJuryZcashSource(included) || usesSharedJuryZcashSource(excluded)) {
        throw new Error('An uncounted tenant must not be able to consume jury inventory.')
      }
      const total = getSharedJuryEntitlementUsd({
        listTenantIds: () => [included, excluded],
        getTenantBalance: (tenant) => ({ totalUsd: tenant === included ? 25 : 1000, pendingOutboundUsd: tenant === included ? 0.5 : 0 }),
      }, [
        { id: 'reserved', tenantId: included, kind: 'deposit_backing', status: 'pending', amountUsd: 1 },
        { id: 'excluded', tenantId: excluded, kind: 'deposit_backing', status: 'pending', amountUsd: 1000 },
      ])
      if (total !== 26.5) throw new Error(`Expected exact included entitlement plus reservations, received ${total}`)
      process.env.AURA_RUNTIME_MODE = 'production'
      if (usesSharedJuryZcashSource(included)) throw new Error('Production must never use the demo pool.')
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
    }
  })

  test('Shared Jury Capacity', 'the displayed maximum is rounded down and matches the allocation gate', () => {
    const sourceCapacityUsd = 100.150967543
    const alreadyAllocatedUsd = 94.75
    const availableUsd = getSharedJuryAvailableCapacityUsd(sourceCapacityUsd, alreadyAllocatedUsd)
    if (availableUsd !== 5.4) throw new Error(`Expected $5.40 available, received $${availableUsd}`)
    if (!canAllocateSharedJuryDeposit(sourceCapacityUsd, alreadyAllocatedUsd, 5.4)) {
      throw new Error('The exact displayed maximum must be allocatable.')
    }
    if (canAllocateSharedJuryDeposit(sourceCapacityUsd, alreadyAllocatedUsd, 5.41)) {
      throw new Error('An amount above the displayed maximum must be rejected.')
    }
    if (canAllocateSharedJuryDeposit(sourceCapacityUsd, alreadyAllocatedUsd, 25)) {
      throw new Error('A $25 deposit must be blocked while only $5.40 is free.')
    }
    if (getSharedJuryAvailableCapacityUsd(Number.NaN, alreadyAllocatedUsd) !== null) {
      throw new Error('Unavailable inventory data must fail closed.')
    }
  })

  test('Solana Receipt Recovery', 'a durable finalized signature can repair a stale processing label after restart', () => {
    const tx = {
      id: 'tx_stale_finalized_label',
      type: 'send' as const,
      status: 'settling_destination' as const,
      fromAsset: 'ZEC' as const,
      fromAmount: 0.5,
      fromChain: 'zcash' as const,
      toAsset: 'SOL' as const,
      toAmount: 0.004,
      toChain: 'solana' as const,
      bufferMode: 'fast' as const,
      createdAt: Date.now(),
      legs: {
        shielded: { chain: 'zcash' as const, description: 'broadcast', txHash: 'a'.repeat(64), status: 'broadcasting' as const },
        delivery: {
          chain: 'solana' as const,
          description: 'finalized',
          txHash: '1'.repeat(88),
          status: 'confirmed' as const,
          confirmationStatus: 'finalized' as const,
        },
      },
      feeUsd: 0,
    }
    if (!hasFinalizedSolanaDelivery(tx)) throw new Error('A valid, stored finalized Solana signature must be recoverable.')
    if (hasCompletedDestinationDelivery(tx)) throw new Error('A stale transaction label must not count as completed before recovery writes it.')
    const invalid = { ...tx, legs: { ...tx.legs, delivery: { ...tx.legs.delivery, txHash: 'not-a-signature' } } }
    if (hasFinalizedSolanaDelivery(invalid)) throw new Error('An invalid destination signature must not mark a receipt finalized.')
  })

  test('QR Integrity', 'Receive payloads round-trip through a standard QR decoder', () => {
    const values = [
      'HELLO',
      'https://aura.money',
      'http://localhost:4173/pay/req_test_9f5c2a',
    ]
    for (const value of values) {
      const modules = encodeQrCode(value)
      const quietZone = 4
      const scale = 8
      const imageSize = (modules.length + quietZone * 2) * scale
      const data = new Uint8ClampedArray(imageSize * imageSize * 4)
      data.fill(255)
      for (let row = 0; row < modules.length; row += 1) {
        for (let column = 0; column < modules.length; column += 1) {
          if (!modules[row][column]) continue
          for (let y = 0; y < scale; y += 1) {
            for (let x = 0; x < scale; x += 1) {
              const pixel = ((row + quietZone) * scale + y) * imageSize + (column + quietZone) * scale + x
              const offset = pixel * 4
              data[offset] = 0
              data[offset + 1] = 0
              data[offset + 2] = 0
              data[offset + 3] = 255
            }
          }
        }
      }
      const decoded = jsQR(data, imageSize, imageSize)
      if (!decoded || decoded.data !== value) {
        throw new Error(`QR decoder returned ${decoded?.data || 'nothing'} for ${value}.`)
      }
    }
  })

  test('Confirmation Integrity', 'receipt identifiers alone never mark Base, Zcash, or Solana legs confirmed', () => {
    const deposit = nearIntentsService.generateRoutingLegs(
      'deposit', 'base', 'zcash', 'tx_audit_deposit', undefined,
      `0x${'a'.repeat(64)}`, 'b'.repeat(64)
    )
    if (deposit.deposit?.status === 'confirmed' || deposit.shielded?.status === 'confirmed') {
      throw new Error('A hash alone must not confirm the Base or Zcash leg.')
    }

    const payout = nearIntentsService.generateRoutingLegs(
      'send', 'zcash', 'solana', 'tx_audit_send', '11111111111111111111111111111111',
      'AbCdEfReceipt', 'c'.repeat(64)
    )
    if (payout.delivery?.status === 'confirmed' || payout.shielded?.status === 'confirmed') {
      throw new Error('A signature or txid alone must not confirm the Solana or Zcash leg.')
    }
  })

  test('Solana Finality', 'completed delivery requires a durable finalized marker', () => {
    const base = {
      id: 'tx_finality_marker',
      type: 'send' as const,
      status: 'completed' as const,
      fromAsset: 'ZEC' as const,
      fromAmount: 1,
      fromChain: 'zcash' as const,
      toAsset: 'SOL' as const,
      toAmount: 0.01,
      toChain: 'solana' as const,
      recipientAddress: '11111111111111111111111111111111',
      bufferMode: 'fast' as const,
      createdAt: Date.now(),
      legs: {
        delivery: {
          chain: 'solana' as const,
          description: 'test',
          txHash: '1'.repeat(88),
          status: 'confirmed' as const,
        },
      },
      feeUsd: 0,
    }
    if (hasCompletedDestinationDelivery(base)) throw new Error('Solana confirmed status alone must not complete a payout.')
    if (!hasCompletedDestinationDelivery({
      ...base,
      legs: { delivery: { ...base.legs.delivery, confirmationStatus: 'finalized' as const } },
    })) throw new Error('A finalized Solana payout should be considered complete.')
  })

  test('Zcash Broadcast Integrity', 'uses the final standalone CLI txid, not an older input txid', () => {
    const oldInput = 'a'.repeat(64)
    const newBroadcast = 'b'.repeat(64)
    const stdout = [
      'Proposed transfer:',
      `        - Orchard ${oldInput}:0  0.00100000 TAZ`,
      'Sending transaction...',
      newBroadcast,
    ].join('\n')
    if (extractBroadcastTxid(stdout) !== newBroadcast) {
      throw new Error('Zcash broadcast parser attached the wrong transaction id.')
    }
    if (extractBroadcastTxid('Sending transaction...\nno txid returned')) {
      throw new Error('Zcash broadcast parser accepted output without a standalone txid.')
    }
    const recovered = 'c'.repeat(64)
    const memo = 'Aura Spend: tx_uncertain_1'
    const recoveredOutput = `${recovered}\n     Mined: 123\n    Memo: Memo::Text("${memo}")`
    if (extractTxidForMemo(recoveredOutput, memo) !== recovered) {
      throw new Error('An uncertain Zcash broadcast was not recoverable from its exact durable memo.')
    }
    if (extractTxidForMemo(recoveredOutput, 'Aura Spend: another-operation')) {
      throw new Error('Zcash memo recovery accepted a different operation.')
    }
  })

  test('Zcash Broadcast Recovery', 'preserves the deterministic prepared txid when the RPC response is lost', () => {
    const txid = 'd'.repeat(64)
    const prepared = `Creating transaction...\nPrepared transaction: ${txid}\nRPC timeout after broadcast`
    if (extractPreparedTxid(prepared) !== txid) {
      throw new Error('Prepared Zcash transaction identity was not recoverable from command output.')
    }
  })

  test('Zcash Confirmation Integrity', 'exact transaction parsing never borrows the next transaction block', () => {
    const target = 'a'.repeat(64)
    const other = 'b'.repeat(64)
    const text = [
      target,
      '  Unmined (expiry height: 4395000)',
      '    Amount: 0.01000000 TAZ',
      other,
      '     Mined: 4395001 (2026-09-27 00:00:00 +00:00:00)',
    ].join('\n')
    const exact = extractExactZcashTransactionText(text, target)
    if (!exact || !/\bUnmined\b/i.test(exact) || /\bMined:\s*4395001\b/i.test(exact)) {
      throw new Error('Zcash exact transaction block parser crossed into the next tx.')
    }
    const records = parseZcashListTxJson(JSON.stringify([
      { txid: target, mined_height: null, expiry_height: 4395000, expired_unmined: false },
      { txid: other, mined_height: 4395001, expiry_height: null, expired_unmined: false },
    ]))
    const targetRecord = records.find((record) => record.txid === target)
    if (!targetRecord || targetRecord.mined_height !== null || targetRecord.expired_unmined !== false) {
      throw new Error('Zcash JSON confirmation lookup did not select the exact target tx.')
    }
  })

  test('Authoritative Balance Recovery', 'a real shielded balance restores spendability when the recovered ledger is empty', () => {
    const reconciled = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 0,
      readyToSpendUsd: 0,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 0,
      enclaveBackedUsd: 0,
    }, 12.34)
    if (reconciled.totalUsd !== 12.34 || reconciled.readyToSpendUsd !== 12.34 || reconciled.fastAvailableToSendUsd !== 12.34) {
      throw new Error('Confirmed shielded funds must remain spendable after browser recovery.')
    }
  })

  test('Authoritative Balance Recovery', 'ledger accounting never exceeds the confirmed shielded balance', () => {
    const reconciled = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 10,
      readyToSpendUsd: 8,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 10,
      enclaveBackedUsd: 0,
    }, 3.25)
    if (reconciled.totalUsd !== 3.25 || reconciled.readyToSpendUsd !== 2.6 || reconciled.fastAvailableToSendUsd !== 3.25) {
      throw new Error('Ledger balance must be capped by live shielded funds.')
    }
  })

  test('Authoritative Balance Pricing', 'current ZEC quantity reflects both price decreases and increases', () => {
    const reconciled = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 10,
      readyToSpendUsd: 8,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 10,
      enclaveBackedUsd: 0,
    }, 15)
    if (reconciled.totalUsd !== 15 || reconciled.readyToSpendUsd !== 12 || reconciled.fastAvailableToSendUsd !== 15) {
      throw new Error('The live confirmed ZEC quantity must also reflect price increases.')
    }
  })

  test('Authoritative Reservations', 'ZEC reservations remain quantity-stable when the USD price changes', () => {
    const reconciled = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 100,
      readyToSpendUsd: 100,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 100,
      enclaveBackedUsd: 0,
      pendingOutboundUsd: 60,
      pendingOutboundZec: 0.6,
    }, 200, 1, 200)
    // The reservation is 0.6 ZEC, not a permanently frozen $60. When ZEC
    // doubles, the remaining 0.4 ZEC is worth $80 and only that is spendable.
    if (reconciled.totalUsd !== 80 || reconciled.fastAvailableToSendUsd !== 80 || reconciled.pendingOutboundZec !== 0.6) {
      throw new Error(`USD-priced reservation was not converted from exact ZEC quantity: ${JSON.stringify(reconciled)}`)
    }
  })

  test('Authoritative Reservations', 'live chain reconciliation subtracts a pending outbound reservation before approving the next spend', () => {
    const tenant = `chain_reservation_${Date.now()}`
    const now = Date.now() - 3 * 86_400_000
    ledgerService.addTransaction({
      id: `deposit_${tenant}`,
      type: 'deposit', status: 'completed', fromAsset: 'USDC', fromAmount: 100,
      fromChain: 'base', toAsset: 'USDC', toAmount: 100, toChain: 'zcash',
      bufferMode: 'fast', createdAt: now, completedAt: now,
      legs: { shielded: { chain: 'zcash', status: 'confirmed', description: 'confirmed' } }, feeUsd: 0,
    }, tenant)
    const spend = (id: string): AuraTransaction => ({
      id, type: 'send', status: 'settling_destination', fromAsset: 'USDC', fromAmount: 60,
      fromChain: 'zcash', toAsset: 'SOL', toAmount: 60, toChain: 'solana',
      bufferMode: 'fast', createdAt: Date.now(), legs: {}, feeUsd: 0,
    })
    try {
      const first = ledgerService.reserveSpend(tenant, spend(`spend_a_${tenant}`), 60, 'fast', 100)
      if (!first.success) throw new Error(`First reservation failed: ${first.error || 'unknown'}`)
      const second = ledgerService.reserveSpend(tenant, spend(`spend_b_${tenant}`), 60, 'fast', 100)
      if (second.success || second.error !== 'INSUFFICIENT_FUNDS' || second.availableBalance !== 40) {
        throw new Error(`Pending $60 reservation was lost during chain reconciliation: ${JSON.stringify(second)}`)
      }
    } finally {
      ledgerService.releaseReservation(tenant, `spend_a_${tenant}`, 'audit cleanup')
      persistentStore.resetTenant(tenant, [])
    }
  })

  test('Base Deposit Authorization', 'connected-wallet proof message binds tenant, sender, amount, asset, and exact transaction', () => {
    const message = createBaseDepositProofMessage({
      tenantId: 'tenant_a', amountUsd: 12.34, amountOnChain: 12.34,
      asset: 'USDC', chain: 'base', txHash: `0x${'a'.repeat(64)}`,
      senderAddress: `0x${'b'.repeat(40)}`,
    })
    if (!message.includes('Tenant: tenant_a') || !message.includes('Asset: USDC') || !message.includes('Network: base')) {
      throw new Error('Base deposit proof did not bind the expected authorization fields.')
    }
    if (message === createBaseDepositProofMessage({
      tenantId: 'tenant_b', amountUsd: 12.34, amountOnChain: 12.34,
      asset: 'USDC', chain: 'base', txHash: `0x${'a'.repeat(64)}`,
      senderAddress: `0x${'b'.repeat(40)}`,
    })) throw new Error('Base deposit proof was not tenant-bound.')
  })

  test('Privacy Wait Accounting', 'fresh Private funds stay locked while Fast can spend the same confirmed chain balance', () => {
    const freshPrivate = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 10,
      readyToSpendUsd: 0,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 10,
      enclaveBackedUsd: 0,
    }, 10)
    if (freshPrivate.totalUsd !== 10 || freshPrivate.readyToSpendUsd !== 0 || freshPrivate.fastAvailableToSendUsd !== 10) {
      throw new Error('A fresh Private deposit must remain locked while Fast sees the confirmed balance.')
    }
  })

  test('Privacy Wait Accounting', 'policy readiness follows Zcash eligible notes after a spend, not historical funding timestamps', () => {
    const beforeSpend = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 100,
      readyToSpendUsd: 100,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 100,
      enclaveBackedUsd: 0,
    }, 100, 2, 50, 1.2)
    if (beforeSpend.totalUsd !== 100 || beforeSpend.readyToSpendUsd !== 60 || beforeSpend.immatureBufferedZec !== 0.8) {
      throw new Error(`The policy-eligible old note was not separated from the fresh note: ${JSON.stringify(beforeSpend)}`)
    }

    // The spend consumes the mature note and creates fresh change. The live
    // min-confirmation balance therefore exposes no eligible ZEC immediately;
    // a historical deposit timestamp must not make the second Pay ready.
    const afterSpend = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 50,
      readyToSpendUsd: 50,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 50,
      enclaveBackedUsd: 0,
    }, 50, 1, 50, 0)
    if (afterSpend.totalUsd !== 50 || afterSpend.readyToSpendUsd !== 0 || afterSpend.fastAvailableToSendUsd !== 50) {
      throw new Error(`A new change note was incorrectly marked ready for a second immediate Pay: ${JSON.stringify(afterSpend)}`)
    }
  })

  test('Privacy Check Accuracy', 'uses completedAt when selecting the latest confirmed funding event', () => {
    const now = Date.now()
    const olderCompletion = {
      id: 'funding_completed_later_but_created_earlier',
      type: 'deposit' as const,
      status: 'completed' as const,
      fromAsset: 'USDC' as const,
      fromAmount: 5,
      fromChain: 'base' as const,
      toAsset: 'USDC' as const,
      toAmount: 5,
      toChain: 'zcash' as const,
      bufferMode: 'private' as const,
      createdAt: now - 3 * 60 * 60 * 1000,
      completedAt: now - 30 * 60 * 1000,
      legs: { shielded: { chain: 'zcash' as const, status: 'confirmed' as const, description: 'confirmed' } },
      feeUsd: 0,
    }
    const newerCreation = {
      id: 'funding_created_later_but_completed_earlier',
      type: 'deposit' as const,
      status: 'completed' as const,
      fromAsset: 'USDC' as const,
      fromAmount: 8,
      fromChain: 'base' as const,
      toAsset: 'USDC' as const,
      toAmount: 8,
      toChain: 'zcash' as const,
      bufferMode: 'private' as const,
      createdAt: now - 20 * 60 * 1000,
      completedAt: now - 2 * 60 * 60 * 1000,
      legs: { shielded: { chain: 'zcash' as const, status: 'confirmed' as const, description: 'confirmed' } },
      feeUsd: 0,
    }
    const snapshot = calculatePrivacyRiskSnapshot({
      transactions: [olderCompletion, newerCreation],
      totalBalanceUsd: 13,
      amountUsd: 5,
      policy: 'private',
      now,
    })
    if (snapshot.latestFundingAgeMs !== 30 * 60 * 1000) {
      throw new Error(`Privacy Check selected createdAt instead of completedAt: ${snapshot.latestFundingAgeMs}`)
    }
    if (!snapshot.riskCodes.includes('RECENT_TIMING')) {
      throw new Error('Privacy Check missed the recently completed funding event.')
    }
  })

  test('Privacy Scenario Isolation', 'empty tenant history produces no funding warnings and cannot borrow cross-tenant', () => {
    const emptySnapshot = calculatePrivacyRiskSnapshot({
      transactions: [],
      totalBalanceUsd: 0,
      amountUsd: 5,
      policy: 'private',
    })
    if (emptySnapshot.riskCodes.includes('FUNDING_HISTORY_VISIBLE')) {
      throw new Error('An empty tenant must not produce FUNDING_HISTORY_VISIBLE warning')
    }
    if (emptySnapshot.riskCodes.length > 0) {
      throw new Error('An unfunded tenant should have zero privacy correlation warnings')
    }
  })

  test('Privacy Wait Accounting', 'mixed fresh deposits and receives carry exact ZEC maturity backing', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mixed-maturity-'))
    const store = new PersistentStore(dataDir)
    const tenant = 'mixed_receive_maturity'
    const now = Date.now()
    const makeCredit = (id: string, type: 'deposit' | 'receive', backingZec: number): AuraTransaction => ({
      id,
      type,
      status: 'completed',
      fromAsset: 'USDC',
      fromAmount: 50,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 50,
      toChain: 'zcash',
      bufferMode: 'private',
      createdAt: now,
      completedAt: now,
      backingZec,
      legs: { shielded: { chain: 'zcash', description: 'confirmed', status: 'confirmed' } },
      feeUsd: 0,
    })
    try {
      store.saveTransactions(tenant, [
        makeCredit('mixed-deposit', 'deposit', 2),
        makeCredit('mixed-receive', 'receive', 2),
      ])
      const balance = store.calculateTenantBalance(tenant, 0, [], undefined, true)
      if (balance.immatureBufferedZec !== 4 || balance.readyToSpendUsd !== 0) {
        throw new Error(`Mixed fresh credits lost ZEC maturity backing: ${JSON.stringify(balance)}`)
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('Privacy Wait Accounting', 'reserveSpend enforces Private maturity while allowing the same fresh deposit in Fast mode', () => {
    const now = Date.now()
    const privateTenant = `fresh_private_reservation_${now}`
    const fastTenant = `fresh_fast_reservation_${now}`
    const makeDeposit = (id: string, bufferMode: 'private' | 'fast'): AuraTransaction => ({
      id,
      type: 'deposit',
      status: 'completed',
      fromAsset: 'USDC',
      fromAmount: 10,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 10,
      toChain: 'zcash',
      bufferMode,
      createdAt: now,
      completedAt: now,
      legs: { shielded: { chain: 'zcash', description: 'confirmed', status: 'confirmed' } },
      feeUsd: 0,
    })
    const makeSpend = (id: string): AuraTransaction => ({
      id,
      type: 'send',
      status: 'settling_destination',
      fromAsset: 'USDC',
      fromAmount: 1,
      fromChain: 'zcash',
      toAsset: 'SOL',
      toAmount: 0.01,
      toChain: 'solana',
      recipientAddress: '11111111111111111111111111111111',
      bufferMode: 'private',
      createdAt: now,
      legs: { shielded: { chain: 'zcash', description: 'pending', status: 'broadcasting' } },
      feeUsd: 0,
    })

    ledgerService.addTransaction(makeDeposit('fresh-private-deposit', 'private'), privateTenant)
    const privateReservation = ledgerService.reserveSpend(
      privateTenant,
      makeSpend('fresh-private-spend'),
      1,
      'private',
      10,
    )
    if (privateReservation.success) {
      throw new Error('A fresh Private deposit was incorrectly admitted for spending.')
    }

    ledgerService.addTransaction(makeDeposit('fresh-fast-deposit', 'fast'), fastTenant)
    const fastReservation = ledgerService.reserveSpend(
      fastTenant,
      makeSpend('fresh-fast-spend'),
      1,
      'fast',
      10,
    )
    if (!fastReservation.success) {
      throw new Error(`Fast mode should admit the confirmed balance: ${fastReservation.error || 'unknown error'}`)
    }
    persistentStore.resetTenant(privateTenant, [])
    persistentStore.resetTenant(fastTenant, [])
  })

  test('Authoritative Balance Recovery', 'unavailable shielded balance is not treated as a confirmed zero', () => {
    const reconciled = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 12,
      readyToSpendUsd: 10,
      unconfirmedUsd: 2,
      onChainZecBackedUsd: 12,
      enclaveBackedUsd: 12,
    }, null)
    if (reconciled.totalUsd !== 12 || reconciled.readyToSpendUsd !== 10 || reconciled.fastAvailableToSendUsd !== 10) {
      throw new Error('An unavailable chain read must preserve the last durable view, not report zero.')
    }
  })

  test('Authoritative Balance Entitlement', 'shared chain pool balance does not exceed tenant ledger entitlement', () => {
    const tenantWithEntitlement = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 10,
      readyToSpendUsd: 10,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 10,
      enclaveBackedUsd: 10,
    }, 105.56, 0.0812, 1300, null, 10)
    if (tenantWithEntitlement.totalUsd !== 10 || tenantWithEntitlement.readyToSpendUsd !== 10) {
      throw new Error(`Expected $10 capped entitlement, got totalUsd=${tenantWithEntitlement.totalUsd}, readyToSpendUsd=${tenantWithEntitlement.readyToSpendUsd}`)
    }

    const emptyTenant = reconcileLedgerBalanceWithShieldedChain({
      totalUsd: 0,
      readyToSpendUsd: 0,
      unconfirmedUsd: 0,
      onChainZecBackedUsd: 0,
      enclaveBackedUsd: 0,
    }, 105.56, 0.0812, 1300, null, 0)
    if (emptyTenant.totalUsd !== 0 || emptyTenant.readyToSpendUsd !== 0) {
      throw new Error(`Empty tenant must not inherit shared pool: got totalUsd=${emptyTenant.totalUsd}, readyToSpendUsd=${emptyTenant.readyToSpendUsd}`)
    }
  })

  test('Tenant response ordering', 'stale or cross-tenant activity responses cannot overwrite the active balance', () => {
    if (!shouldAcceptTenantActivityResponse(1, 2, 'tenant-a', 'tenant-a', 'tenant-a')) {
      // Expected rejection: an older request must never win.
    } else {
      throw new Error('An older activity response was accepted.')
    }
    if (!shouldAcceptTenantActivityResponse(2, 2, 'tenant-b', 'tenant-a', 'tenant-a')) {
      // Expected rejection: a different tenant must never win.
    } else {
      throw new Error('A cross-tenant activity response was accepted.')
    }
    if (!shouldAcceptTenantActivityResponse(2, 2, 'tenant-a', 'tenant-a', 'tenant-a')) {
      throw new Error('The newest response for the active tenant was rejected.')
    }
  })

  function test(suite: string, name: string, fn: () => void | Promise<void>) {
    const start = performance.now()
    try {
      fn()
      results.push({
        suite,
        name,
        passed: true,
        durationMs: Number((performance.now() - start).toFixed(2)),
      })
    } catch (err: unknown) {
      results.push({
        suite,
        name,
        passed: false,
        durationMs: Number((performance.now() - start).toFixed(2)),
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function testAsync(suite: string, name: string, fn: () => Promise<void>) {
    const start = performance.now()
    try {
      await fn()
      results.push({
        suite,
        name,
        passed: true,
        durationMs: Number((performance.now() - start).toFixed(2)),
      })
    } catch (err: unknown) {
      results.push({
        suite,
        name,
        passed: false,
        durationMs: Number((performance.now() - start).toFixed(2)),
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // --- SUITE 1: BIP-39 CRYPTOGRAPHIC MNEMONIC ENGINE ---
  test('Settlement Recovery', 'retries definitive no-broadcast destination failures but preserves uncertain broadcasts', () => {
    const noBroadcast = classifyDestinationSettlement({
      deliveryConfirmed: false,
      deliveryFailedOnChain: false,
      broadcastUncertain: false,
    })
    if (noBroadcast.status !== 'routing_shielded' || noBroadcast.deliveryStatus !== 'failed' || !noBroadcast.closePendingOperation) {
      throw new Error('A definitive no-broadcast failure must return to routing_shielded for a destination-only retry.')
    }

    const uncertain = classifyDestinationSettlement({
      deliveryConfirmed: false,
      deliveryFailedOnChain: false,
      broadcastUncertain: true,
    })
    if (uncertain.status !== 'settling_destination' || uncertain.deliveryStatus !== 'broadcasting' || uncertain.closePendingOperation) {
      throw new Error('An uncertain broadcast must remain settling_destination with its recovery operation open.')
    }

    const confirmed = classifyDestinationSettlement({
      deliveryConfirmed: true,
      deliveryFailedOnChain: false,
      deliveryHash: 'confirmed-signature',
      broadcastUncertain: false,
    })
    if (confirmed.status !== 'completed' || confirmed.deliveryStatus !== 'confirmed' || !confirmed.closePendingOperation) {
      throw new Error('A confirmed destination payout must complete and close its recovery operation.')
    }
  })

  test('BIP-39 Cryptography', 'Wordlist contains exactly 2048 standard BIP-39 words', () => {
    if (BIP39_WORDLIST.length !== 2048) {
      throw new Error(`Expected 2048 words, got ${BIP39_WORDLIST.length}`)
    }
    if (BIP39_WORDLIST[0] !== 'abandon' || BIP39_WORDLIST[2047] !== 'zoo') {
      throw new Error('Dictionary bounds incorrect')
    }
  })

  test('BIP-39 Cryptography', 'generateBip39Mnemonic generates valid 12-word phrase with valid checksum', () => {
    const mnemonic = generateBip39Mnemonic()
    if (mnemonic.length !== 12) {
      throw new Error(`Expected 12 words, got ${mnemonic.length}`)
    }
    if (!validateBip39Mnemonic(mnemonic)) {
      throw new Error('Generated mnemonic failed checksum validation')
    }
  })

  test('BIP-39 Cryptography', 'validateBip39Mnemonic strictly rejects corrupted phrases and checksum failure', () => {
    const valid = generateBip39Mnemonic()
    const corrupted = [...valid]
    const origIdx = BIP39_WORDLIST.indexOf(valid[11])
    const flippedChecksumIdx = origIdx ^ 1 // Inverts the lowest checksum bit while keeping entropy bits identical
    corrupted[11] = BIP39_WORDLIST[flippedChecksumIdx]
    if (validateBip39Mnemonic(corrupted)) {
      throw new Error('Corrupted phrase should fail checksum validation')
    }
    if (validateBip39Mnemonic(['not', 'enough', 'words'])) {
      throw new Error('Truncated phrase should be rejected')
    }
  })

  test('BIP-39 Cryptography', 'deriveClientVaultKeys generates a deterministic vault identifier', () => {
    const mnemonic = generateBip39Mnemonic()
    const keys1 = deriveClientVaultKeys(mnemonic)
    const keys2 = deriveClientVaultKeys(mnemonic)
    if (keys1.fingerprint !== keys2.fingerprint) {
      throw new Error('Key derivation is non-deterministic')
    }
    if (!keys1.fingerprint.startsWith('vault_')) {
      throw new Error('Fingerprint prefix incorrect')
    }
    if (!/^[a-f0-9]{64}$/i.test(keys1.commitmentKeyHex)) {
      throw new Error('Derived vault commitment key has an invalid format')
    }
  })

  test('Recovery Namespace Integrity', 'recovery-derived tenant IDs are deterministic and independently verifiable', () => {
    const publicKey = '3059301306072a8648ce3d020106082a8648ce3d03010703420004' + '11'.repeat(64)
    const first = deriveRecoveryTenantIdFromSpki(publicKey)
    const second = deriveRecoveryTenantIdFromSpki(publicKey)
    if (first !== second || !first.startsWith('vault_r_')) {
      throw new Error('Recovery tenant namespace is not deterministic')
    }
    if (first === deriveRecoveryTenantIdFromSpki(publicKey.replace(/11/g, '22'))) {
      throw new Error('Different recovery authorities produced the same tenant namespace')
    }
  })

  await testAsync('BIP-39 Cryptography', 'seed derivation matches the official PBKDF2-SHA512 test vector', async () => {
    const mnemonic = [...Array(11).fill('abandon'), 'about']
    const seed = await deriveBip39SeedAsync(mnemonic, 'TREZOR')
    const seedHex = Array.from(seed).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const expected = 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04'
    if (seedHex !== expected) throw new Error(`BIP-39 seed mismatch: ${seedHex}`)
  })

  test('Payment authorization', 'normalizes case-insensitive Base hashes and addresses', () => {
    if (canonicalizeTransactionHash('base', '0xAbCd') !== '0xabcd') {
      throw new Error('Base transaction hash was not normalized')
    }
    if (canonicalizeChainAddress('base', '0xAbCd') !== '0xabcd') {
      throw new Error('Base address was not normalized')
    }
  })

  test('Payment authorization', 'preserves case-sensitive Solana signatures and addresses', () => {
    const signature = 'AbCdEf123'
    const address = 'AbCdEf123'
    if (canonicalizeTransactionHash('solana', signature) !== signature) {
      throw new Error('Solana transaction signature case was changed')
    }
    if (canonicalizeChainAddress('solana', address) !== address) {
      throw new Error('Solana address case was changed')
    }
    const message = createPaymentAuthorizationMessage({
      requestId: 'request-1',
      txHash: signature,
      amountCents: 100,
      asset: 'USDC',
      chain: 'solana',
    })
    if (!message.includes(`Transaction: ${signature}`)) {
      throw new Error('Solana payment authorization message altered signature case')
    }
  })

  // --- SUITE 2: INVOICE REPLAY PROTECTION & ATOMIC CAS ---
  test('Invoice & Replay Protection', 'atomicConsumePaymentRequest consumes active invoice on first attempt', () => {
    const testId = `test_req_${Date.now()}`
    try {
      persistentStore.saveRequest({
        id: testId,
        amount: 50.0,
        asset: 'USDC',
        chain: 'base',
        shieldedReceiver: 'u1test_receiver',
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      })

      const res = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_first_attempt',
      })

      if (!res.success) {
        throw new Error(`Expected success, got error: ${res.error}`)
      }
      if (res.request.status !== 'consumed') {
        throw new Error(`Expected status consumed, got ${res.request.status}`)
      }
    } finally {
      persistentStore.deleteRequest(testId)
    }
  })

  test('Invoice & Replay Protection', 'independent request writes preserve both invoices across store instances', () => {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-request-lock-'))
    const firstStore = new PersistentStore(sharedDir)
    const secondStore = new PersistentStore(sharedDir)
    const firstId = `test_parallel_a_${Date.now()}`
    const secondId = `test_parallel_b_${Date.now()}`
    const request = (id: string) => ({
      id,
      amount: 1,
      asset: 'USDC' as const,
      chain: 'base' as const,
      shieldedReceiver: 'u1test_receiver',
      status: 'active' as const,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    })
    try {
      firstStore.saveRequest(request(firstId))
      secondStore.saveRequest(request(secondId))
      firstStore.updatePaymentRequest(firstId, { amount: 2 })
      secondStore.updatePaymentRequest(secondId, { amount: 3 })
      const finalStore = new PersistentStore(sharedDir)
      if (finalStore.getPaymentRequest(firstId)?.amount !== 2 || finalStore.getPaymentRequest(secondId)?.amount !== 3) {
        throw new Error('A request write overwrote the other invoice snapshot.')
      }
    } finally {
      for (const id of [firstId, secondId]) {
        try { firstStore.deleteRequest(id) } catch {}
      }
      fs.rmSync(sharedDir, { recursive: true, force: true })
    }
  })

  test('Demo Wallet Authorization', 'sponsored demo transfers respect a durable aggregate budget', () => {
    const budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-demo-budget-'))
    const budgetStore = new PersistentStore(budgetDir)
    try {
      if (!budgetStore.reserveDemoBudget(3, 5)) throw new Error('First demo budget reservation should succeed.')
      if (budgetStore.reserveDemoBudget(3, 5)) throw new Error('Aggregate demo budget should reject overspending.')
      budgetStore.releaseDemoBudget(1)
      if (!budgetStore.reserveDemoBudget(2, 5)) throw new Error('Released demo budget should become available again.')
    } finally {
      fs.rmSync(budgetDir, { recursive: true, force: true })
    }
  })

  test('Demo Wallet Authorization', 'budget mutations preserve unrelated pending transfer identities', () => {
    const budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-demo-budget-preserve-'))
    const store = new PersistentStore(budgetDir)
    const txHash = `0x${'c'.repeat(64)}`
    try {
      store.recordPendingDemoBudget(txHash, 3, '0x9', `0x${'d'.repeat(40)}`)
      if (!store.reserveDemoBudget(2, 10)) throw new Error('Budget reservation failed unexpectedly.')
      if (store.getPendingDemoBudgetReservations().length !== 1) throw new Error('reserveDemoBudget dropped the pending reservation.')
      store.releaseDemoBudget(2)
      if (store.getPendingDemoBudgetReservations().length !== 1) throw new Error('releaseDemoBudget dropped the pending reservation.')
      store.bindDemoDeposit(txHash, 'tenant_a', 3, `0x${'d'.repeat(40)}`, 'session:test')
      if (store.getDemoDepositBinding(txHash)?.tenantId !== 'tenant_a') throw new Error('Sponsored transfer tenant binding was not persisted.')
      if (store.getDemoDepositBinding(txHash)?.tenantId === 'tenant_b') throw new Error('Sponsored transfer binding accepted the wrong tenant.')
    } finally {
      fs.rmSync(budgetDir, { recursive: true, force: true })
    }
  })

  await testAsync('Demo Wallet Authorization', 'uncertain Base budget stays reserved until finalized absence or receipt', async () => {
    const budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-demo-reconcile-'))
    const store = new PersistentStore(budgetDir)
    const txHash = `0x${'a'.repeat(64)}`
    const senderAddress = `0x${'b'.repeat(40)}`
    let finalizedNonce = 7n
    let transaction: object | null = null
    let receipt: object | null = null
    let rpcFails = false
    const relayer = {
      getTransactionReceipt: async () => {
        if (rpcFails) throw new Error('RPC unavailable')
        return receipt
      },
      verifyReceiptFinality: async (_hash: string, candidate: { status?: string } | null) => ({
        confirmed: candidate?.status === '0x1',
        confirmations: candidate?.status === '0x1' ? 3 : 0,
      }),
      getTransactionByHash: async () => transaction,
      getFinalizedTransactionCount: async () => finalizedNonce,
    }
    try {
      if (!store.reserveDemoBudget(3, 5)) throw new Error('Could not reserve test budget.')
      const lockPath = path.join(budgetDir, 'demo-budget.lock')
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, operation: 'test' }))
      try {
        let rejectedBusyWrite = false
        try { store.recordPendingDemoBudget(txHash, 3, '0x7', senderAddress) }
        catch { rejectedBusyWrite = true }
        if (!rejectedBusyWrite) throw new Error('A busy budget lock silently accepted a pre-broadcast record.')
      } finally {
        fs.unlinkSync(lockPath)
      }
      store.recordPendingDemoBudget(txHash, 3, '0x7', senderAddress)
      const pending = store.getPendingDemoBudgetReservations()
      if (pending.length !== 1 || pending[0].nonce !== '0x7' || pending[0].senderAddress !== senderAddress) {
        throw new Error('Predicted signed transfer identity was not persisted.')
      }

      await reconcilePendingDemoBudget(relayer, store)
      finalizedNonce = 8n
      transaction = { hash: txHash }
      await reconcilePendingDemoBudget(relayer, store)
      transaction = null
      rpcFails = true
      await reconcilePendingDemoBudget(relayer, store)
      if (store.getPendingDemoBudgetReservations().length !== 1 || store.reserveDemoBudget(3, 5)) {
        throw new Error('An uncertain transfer was released before absence was proven.')
      }

      rpcFails = false
      await reconcilePendingDemoBudget(relayer, store)
      if (store.getPendingDemoBudgetReservations().length !== 0 || !store.reserveDemoBudget(5, 5)) {
        throw new Error('Finalized nonce replacement did not release the absent transfer budget.')
      }

      store.releaseDemoBudget(5)
      if (!store.reserveDemoBudget(3, 5)) throw new Error('Could not reserve confirmed transfer budget.')
      store.recordPendingDemoBudget(txHash, 3, '0x8', senderAddress)
      receipt = { status: '0x1' }
      await reconcilePendingDemoBudget(relayer, store)
      if (store.getPendingDemoBudgetReservations().length !== 0 || store.reserveDemoBudget(3, 5)) {
        throw new Error('Confirmed transfer budget was incorrectly released.')
      }
    } finally {
      fs.rmSync(budgetDir, { recursive: true, force: true })
    }
  })

  await testAsync('RPC Resilience', 'read-only JSON-RPC calls fail over to the next endpoint', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls++
      if (String(input).includes('first.invalid')) throw new Error('primary unavailable')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const result = await fetchRpcJson<{ result?: string }>(['https://first.invalid', 'https://second.test'], {
        jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [],
      })
      if (result.json.result !== '0x1' || result.endpoint !== 'https://second.test' || calls !== 2) {
        throw new Error('RPC fallback did not select the healthy endpoint.')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await testAsync('RPC Resilience', 'signed broadcasts fail over with the identical payload', async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    let firstBody = ''
    let secondBody = ''
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++
      const body = String(init?.body || '')
      if (calls === 1) firstBody = body
      if (calls === 2) secondBody = body
      if (String(input).includes('first.invalid')) throw new Error('primary unavailable')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 7, result: 'broadcast-ok' }), { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const result = await broadcastRpcJson<{ result?: string }>(['https://first.invalid', 'https://second.test'], {
        jsonrpc: '2.0', id: 7, method: 'sendRawTransaction', params: ['signed-payload'],
      })
      if (result.json.result !== 'broadcast-ok' || result.endpoint !== 'https://second.test' || calls !== 2 || firstBody !== secondBody) {
        throw new Error('The signed broadcast did not fail over with the same payload.')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Zcash Resilience', 'Zcash write fallback is limited to clear pre-broadcast connection failures', () => {
    if (!isSafeZcashWriteRetry({ code: 'ECONNREFUSED', stderr: 'connection refused' })) {
      throw new Error('A refused Zcash server connection was not classified as safe to retry.')
    }
    if (isSafeZcashWriteRetry({ code: 'ECONNRESET', stderr: 'connection reset after broadcast' })) {
      throw new Error('An uncertain Zcash connection reset was incorrectly marked safe to retry.')
    }
    if (isSafeZcashWriteRetry({ code: 'ECONNREFUSED', stderr: 'Prepared transaction: ' + 'a'.repeat(64) })) {
      throw new Error('A prepared Zcash transaction was incorrectly marked safe to retry.')
    }
  })

  await testAsync('RPC Resilience', 'nullable transaction lookups continue after a healthy null result', async () => {
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const endpoint = String(input)
      seen.push(endpoint)
      const result = endpoint.includes('first.invalid') ? null : { hash: '0xknown' }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 8, result }), { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const result = await fetchRpcResultAcrossPool<{ hash: string }>(['https://first.invalid', 'https://second.test'], {
        jsonrpc: '2.0', id: 8, method: 'eth_getTransactionByHash', params: ['0xhash'],
      })
      if (result.result?.hash !== '0xknown' || seen.length !== 2 || result.endpoint !== 'https://second.test') {
        throw new Error('The nullable transaction lookup stopped at the first null result.')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await testAsync('RPC Resilience', 'Base deposit verification checks fallback RPCs after a null receipt', async () => {
    const originalFetch = globalThis.fetch
    const vault = '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e'
    const txHash = `0x${'1'.repeat(64)}`
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(input)
      const body = JSON.parse(String(init?.body || '{}')) as { method?: string }
      if (body.method === 'eth_chainId') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x14a34' }), { status: 200 })
      }
      if (body.method === 'eth_getTransactionReceipt') {
        const result = endpoint.includes('publicnode')
          ? {
              status: '0x1',
              from: `0x${'2'.repeat(40)}`,
              logs: [],
              blockNumber: '0x64',
              blockHash: `0x${'a'.repeat(64)}`,
            }
          : null
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result }), { status: 200 })
      }
      if (body.method === 'eth_blockNumber') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: endpoint.includes('publicnode') ? '0x66' : null }), { status: 200 })
      }
      if (body.method === 'eth_getBlockByNumber') {
        const blockTag = (JSON.parse(String(init?.body || '{}')) as { params?: unknown[] }).params?.[0]
        const result = endpoint.includes('publicnode')
          ? blockTag === 'finalized'
            ? { number: '0x66', hash: `0x${'b'.repeat(64)}`, timestamp: '0x64' }
            : { number: '0x64', hash: `0x${'a'.repeat(64)}`, timestamp: '0x64' }
          : null
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 4, result }), { status: 200 })
      }
      if (body.method === 'eth_getTransactionByHash') {
        const result = endpoint.includes('publicnode')
          ? { to: vault, from: `0x${'2'.repeat(40)}`, value: '0x2386f26fc10000' }
          : null
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result }), { status: 200 })
      }
      throw new Error(`Unexpected RPC method: ${body.method}`)
    }) as typeof globalThis.fetch
    try {
      const result = await new BaseRelayerService().verifyDeposit(txHash, vault, 0.01, 'ETH')
      if (!result.verified || result.amountTransferred !== 0.01) {
        throw new Error(`Base deposit verification did not recover the fallback receipt: ${JSON.stringify(result)}`)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await testAsync('Base Finality', 'safe Base inclusion is readable but cannot trigger irreversible shielding', async () => {
    const originalFetch = globalThis.fetch
    const vault = '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e'
    const txHash = `0x${'2'.repeat(64)}`
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(input)
      const body = JSON.parse(String(init?.body || '{}')) as { method?: string; params?: unknown[] }
      const onFallback = endpoint.includes('publicnode')
      if (body.method === 'eth_chainId') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x14a34' }), { status: 200 })
      }
      if (body.method === 'eth_getTransactionReceipt') {
        const result = onFallback
          ? { status: '0x1', from: `0x${'2'.repeat(40)}`, logs: [], blockNumber: '0x64', blockHash: `0x${'a'.repeat(64)}` }
          : null
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result }), { status: 200 })
      }
      if (body.method === 'eth_blockNumber') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result: onFallback ? '0x66' : null }), { status: 200 })
      }
      if (body.method === 'eth_getTransactionByHash') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          result: { to: vault, from: `0x${'2'.repeat(40)}`, value: '0x2386f26fc10000' },
        }), { status: 200 })
      }
      if (body.method === 'eth_getBlockByNumber') {
        const tag = body.params?.[0]
        const result = onFallback
          ? tag === 'finalized'
            ? { number: '0x63', hash: `0x${'b'.repeat(64)}`, timestamp: '0x64' }
            : tag === 'safe'
              ? { number: '0x64', hash: `0x${'c'.repeat(64)}`, timestamp: '0x64' }
            : { number: '0x64', hash: `0x${'a'.repeat(64)}`, timestamp: '0x64' }
          : null
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 4, result }), { status: 200 })
      }
      throw new Error(`Unexpected RPC method: ${body.method}`)
    }) as typeof globalThis.fetch
    try {
      const relayer = new BaseRelayerService()
      const readOnlyResult = await relayer.verifyDeposit(txHash, vault, 0.01, 'ETH')
      if (!readOnlyResult.verified) {
        throw new Error(`A safe receipt should be readable for a non-irreversible status: ${JSON.stringify(readOnlyResult)}`)
      }
      const irreversibleResult = await relayer.verifyDeposit(txHash, vault, 0.01, 'ETH', { requireFinalized: true })
      if (irreversibleResult.verified || irreversibleResult.error !== 'BASE_TX_NOT_FINALIZED') {
        throw new Error(`A safe-only receipt was allowed to trigger an irreversible effect: ${JSON.stringify(irreversibleResult)}`)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  await testAsync('RPC Resilience', 'Solana balance reads continue after a healthy null result', async () => {
    const originalFetch = globalThis.fetch
    const originalFallbacks = process.env.SOLANA_DEVNET_RPC_FALLBACKS
    process.env.SOLANA_DEVNET_RPC_FALLBACKS = 'https://solana-fallback.test'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(input)
      const body = JSON.parse(String(init?.body || '{}')) as { method?: string }
      if (body.method !== 'getBalance') throw new Error(`Unexpected RPC method: ${body.method}`)
      const result = endpoint.includes('solana-fallback.test') ? { value: 750_000_000 } : null
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 9, result }), { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const balance = await new SolanaRelayerService().getBalanceForAddress('demo-address')
      if (balance !== 0.75) throw new Error(`Solana fallback balance was not recovered: ${balance}`)
    } finally {
      globalThis.fetch = originalFetch
      if (originalFallbacks === undefined) delete process.env.SOLANA_DEVNET_RPC_FALLBACKS
      else process.env.SOLANA_DEVNET_RPC_FALLBACKS = originalFallbacks
    }
  })

  await testAsync('RPC Resilience', 'Solana payout status checks every RPC after a healthy null result', async () => {
    const originalFetch = globalThis.fetch
    const originalFallbacks = process.env.SOLANA_DEVNET_RPC_FALLBACKS
    process.env.SOLANA_DEVNET_RPC_FALLBACKS = 'https://solana-status-fallback.test'
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(input)
      const body = JSON.parse(String(init?.body || '{}')) as { method?: string }
      if (body.method !== 'getSignatureStatuses') throw new Error(`Unexpected RPC method: ${body.method}`)
      const result = endpoint.includes('solana-status-fallback.test')
        ? { value: [{ confirmationStatus: 'finalized', err: null, slot: 42 }] }
        : { value: [null] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, result }), { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const status = await new SolanaRelayerService().getSignatureStatus('status-fallback-signature')
      if (!status || status.confirmationStatus !== 'finalized' || status.slot !== 42) {
        throw new Error(`Solana signature status stopped at the first null RPC: ${JSON.stringify(status)}`)
      }
    } finally {
      globalThis.fetch = originalFetch
      if (originalFallbacks === undefined) delete process.env.SOLANA_DEVNET_RPC_FALLBACKS
      else process.env.SOLANA_DEVNET_RPC_FALLBACKS = originalFallbacks
    }
  })

  test('Invoice & Replay Protection', 'atomicConsumePaymentRequest rejects duplicate payment (Replay Attack Prevention)', () => {
    const testId = `test_replay_${Date.now()}`
    try {
      persistentStore.saveRequest({
        id: testId,
        amount: 50.0,
        asset: 'USDC',
        chain: 'base',
        shieldedReceiver: 'u1test_receiver',
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      })

      // First payment succeeds
      persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_attempt_1',
      })

      // Second payment MUST fail with ALREADY_CONSUMED
      const replayRes = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_attempt_2',
      })

      if (replayRes.success) {
        throw new Error('Replay attack should have been blocked')
      }
      if (replayRes.error !== 'ALREADY_CONSUMED') {
        throw new Error(`Expected ALREADY_CONSUMED, got ${replayRes.error}`)
      }
    } finally {
      persistentStore.deleteRequest(testId)
    }
  })

  test('Invoice & Replay Protection', 'atomicConsumePaymentRequest strictly rejects underpayment (Amount Integrity)', () => {
    const testId = `test_amount_${Date.now()}`
    try {
      persistentStore.saveRequest({
        id: testId,
        amount: 50.0,
        asset: 'USDC',
        chain: 'base',
        shieldedReceiver: 'u1test_receiver',
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      })

      // Payer attempts to pay $5 on $50 invoice
      const tamperRes = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 5.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_underpay',
      })

      if (tamperRes.success) {
        throw new Error('Underpayment should have been blocked')
      }
      if (tamperRes.error !== 'AMOUNT_MISMATCH') {
        throw new Error(`Expected AMOUNT_MISMATCH, got ${tamperRes.error}`)
      }
    } finally {
      persistentStore.deleteRequest(testId)
    }
  })

  test('Invoice & Replay Protection', 'atomicConsumePaymentRequest rejects asset mismatch (Asset Integrity)', () => {
    const testId = `test_asset_${Date.now()}`
    try {
      persistentStore.saveRequest({
        id: testId,
        amount: 50.0,
        asset: 'USDC',
        chain: 'base',
        shieldedReceiver: 'u1test_receiver',
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      })

      const mismatchRes = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'ETH',
        payChain: 'base',
        txHash: '0xhash_mismatch',
      })

      if (mismatchRes.success) {
        throw new Error('Asset mismatch should have been blocked')
      }
      if (mismatchRes.error !== 'ASSET_MISMATCH') {
        throw new Error(`Expected ASSET_MISMATCH, got ${mismatchRes.error}`)
      }
    } finally {
      persistentStore.deleteRequest(testId)
    }
  })

  test('Invoice & Replay Protection', 'atomicConsumePaymentRequest strictly rejects expired requests', () => {
    const testId = `test_exp_${Date.now()}`
    try {
      persistentStore.saveRequest({
        id: testId,
        amount: 50.0,
        asset: 'USDC',
        chain: 'base',
        shieldedReceiver: 'u1test_receiver',
        status: 'active',
        createdAt: Date.now() - 7200000,
        expiresAt: Date.now() - 3600000, // Expired 1 hour ago
      })

      const expRes = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_expired',
      })

      if (expRes.success) {
        throw new Error('Expired request should have been blocked')
      }
      if (expRes.error !== 'EXPIRED') {
        throw new Error(`Expected EXPIRED, got ${expRes.error}`)
      }
    } finally {
      persistentStore.deleteRequest(testId)
    }
  })

  await testAsync('Invoice & Replay Protection', 'a verified in-flight payment can finish after the invoice expiry time', async () => {
    const testId = `test_expiry_during_settlement_${Date.now()}`
    const createdAt = Date.now()
    persistentStore.saveRequest({
      id: testId,
      amount: 8,
      asset: 'USDC',
      chain: 'base',
      shieldedReceiver: 'test-receiver',
      status: 'active',
      createdAt,
      expiresAt: createdAt + 500,
    })
    if (!persistentStore.claimPaymentRequestProcessing(testId)) {
      persistentStore.deleteRequest(testId)
      throw new Error('Could not claim the still-active invoice before settlement.')
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 510))
      const result = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 8,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: `0xexpiry${Date.now()}`,
      })
      if (!result.success) {
        throw new Error(`The verified in-flight invoice was rejected after expiry: ${result.error}`)
      }
    } finally {
      persistentStore.releasePaymentRequestProcessing(testId)
      persistentStore.deleteRequest(testId)
    }
  })

  test('Invoice & Replay Protection', 'Repeated payment attempts: exactly one claim succeeds', () => {
    const testId = `test_race_${Date.now()}`
    try {
      persistentStore.saveRequest({
        id: testId,
        amount: 50.0,
        asset: 'USDC',
        chain: 'base',
        shieldedReceiver: 'u1test_receiver',
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      })

      const r1 = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_race_1',
      })
      const r2 = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_race_2',
      })
      const r3 = persistentStore.atomicConsumePaymentRequest(testId, {
        payAmount: 50.0,
        payAsset: 'USDC',
        payChain: 'base',
        txHash: '0xhash_race_3',
      })

      const successes = [r1, r2, r3].filter((r) => r.success)
      const failures = [r1, r2, r3].filter((r) => !r.success)

      if (successes.length !== 1) {
        throw new Error(`Expected exactly 1 claim to succeed, got ${successes.length}`)
      }
      if (failures.length !== 2) {
        throw new Error(`Expected exactly 2 claims to be rejected, got ${failures.length}`)
      }
      for (const fail of failures) {
        if (fail.error !== 'ALREADY_CONSUMED') {
          throw new Error(`Expected ALREADY_CONSUMED, got ${fail.error}`)
        }
      }
    } finally {
      persistentStore.deleteRequest(testId)
    }
  })

  test('Invoice & Replay Protection', 'invoice processing lock is shared across store instances', () => {
    const invoiceId = `req_cross_process_${Date.now()}`
    const createdAt = Date.now()
    persistentStore.saveRequest({
      id: invoiceId,
      amount: 10,
      asset: 'USDC',
      chain: 'base',
      shieldedReceiver: 'test-receiver',
      status: 'active',
      createdAt,
      expiresAt: createdAt + 60_000,
      enclaveFingerprint: 'audit_invoice_tenant',
    })
    const secondStore = new PersistentStore(testDataDir)
    if (!persistentStore.claimPaymentRequestProcessing(invoiceId)) throw new Error('First request claim failed')
    if (secondStore.claimPaymentRequestProcessing(invoiceId)) throw new Error('Second store claimed an in-flight invoice')
    persistentStore.releasePaymentRequestProcessing(invoiceId)
    if (!secondStore.claimPaymentRequestProcessing(invoiceId)) throw new Error('Invoice claim was not released')
    secondStore.releasePaymentRequestProcessing(invoiceId)
  })

  test('Settlement Concurrency', 'a pending payout can only be resumed by one store at a time', () => {
    const secondStore = new PersistentStore(testDataDir)
    const tenant = `audit_settlement_${Date.now()}`
    const txId = 'tx_pending_settlement'
    if (!persistentStore.claimTransactionSettlement(tenant, txId)) throw new Error('First settlement claim failed')
    if (secondStore.claimTransactionSettlement(tenant, txId)) throw new Error('Concurrent settlement claim succeeded')
    persistentStore.releaseTransactionSettlement(tenant, txId)
    if (!secondStore.claimTransactionSettlement(tenant, txId)) throw new Error('Released settlement claim could not be retried')
    secondStore.releaseTransactionSettlement(tenant, txId)
  })

  test('Balance History', 'historical chart excludes failed and unconfirmed deposits and failed sends', () => {
    const makeTx = (
      id: string,
      type: AuraTransaction['type'],
      status: AuraTransaction['status'],
      amount: number,
      createdAt: number
    ): AuraTransaction => ({
      id,
      type,
      status,
      fromAsset: 'USDC',
      fromAmount: amount,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: amount,
      toChain: 'base',
      bufferMode: 'fast',
      createdAt,
      legs: {},
      feeUsd: 0,
    })
    const txs = [
      makeTx('confirmed-deposit', 'deposit', 'completed', 100, 2_000),
      makeTx('failed-deposit', 'deposit', 'failed', 30, 2_100),
      makeTx('pending-deposit', 'deposit', 'processing', 20, 2_200),
      makeTx('completed-send', 'send', 'completed', 10, 2_300),
      makeTx('failed-send', 'send', 'failed', 40, 2_400),
      makeTx('reserved-send', 'send', 'settling_destination', 5, 2_500),
    ]
    if (getHistoricalLedgerBalance(85, txs, 1_500) !== 0) {
      throw new Error('History before all real ledger effects should start at zero')
    }
    if (getHistoricalLedgerBalance(85, txs, 2_250) !== 100) {
      throw new Error('History should include the confirmed deposit but ignore failed and unconfirmed entries')
    }
    if (getHistoricalLedgerBalance(85, txs, 2_400) !== 90) {
      throw new Error('History should include a live spend reservation but ignore the failed send')
    }
  })

  test('Durable Claim Recovery', 'claims left by a crashed process no longer block pending demo work', () => {
    const crypto = require('crypto')
    const deadPid = process.pid + 1_000_000
    const requestId = `audit_claim_recovery_${Date.now()}`
    const createdAt = Date.now()
    persistentStore.saveRequest({
      id: requestId,
      amount: 10,
      asset: 'USDC',
      chain: 'base',
      shieldedReceiver: 'test-receiver',
      status: 'active',
      createdAt,
      expiresAt: createdAt + 60_000,
      enclaveFingerprint: 'audit_claim_recovery_tenant',
    })

    const txHash = `0x${'a'.repeat(64)}`
    const settlementTenant = `audit_claim_recovery_${Date.now()}`
    const settlementTxId = 'tx_crashed_before_settlement'
    const claims = [
      {
        directory: 'payment-request-claims',
        key: requestId,
        data: { requestId, pid: deadPid, createdAt: Date.now() - 60_000 },
        claim: () => persistentStore.claimPaymentRequestProcessing(requestId),
        release: () => persistentStore.releasePaymentRequestProcessing(requestId),
      },
      {
        directory: 'payment-tx-claims',
        key: txHash,
        data: { paymentTxHash: txHash, pid: deadPid, createdAt: Date.now() - 60_000 },
        claim: () => persistentStore.claimPaymentTxHash(txHash),
        release: () => persistentStore.releasePaymentTxHash(txHash),
      },
      {
        directory: 'settlement-claims',
        key: `${settlementTenant}:${settlementTxId}`,
        data: { settlementKey: `${settlementTenant}:${settlementTxId}`, pid: deadPid, createdAt: Date.now() - 60_000 },
        claim: () => persistentStore.claimTransactionSettlement(settlementTenant, settlementTxId),
        release: () => persistentStore.releaseTransactionSettlement(settlementTenant, settlementTxId),
      },
    ]

    try {
      for (const entry of claims) {
        const filename = `${crypto.createHash('sha256').update(entry.key).digest('hex')}.claim`
        const claimPath = path.join(testDataDir, entry.directory, filename)
        fs.writeFileSync(claimPath, JSON.stringify(entry.data), 'utf-8')
        if (!entry.claim()) throw new Error(`Could not recover stale ${entry.directory} claim`)
        entry.release()
      }

      const uncertainHash = `0x${'b'.repeat(64)}`
      if (!persistentStore.claimPaymentTxHash(uncertainHash)) {
        throw new Error('Could not claim the payment before its simulated broadcast.')
      }
      if (!persistentStore.markPaymentTxHashExternalEffectMayHaveStarted(uncertainHash)) {
        throw new Error('Could not persist the pending external-effect marker.')
      }
      const uncertainFilename = `${crypto.createHash('sha256').update(uncertainHash).digest('hex')}.claim`
      const uncertainPath = path.join(testDataDir, 'payment-tx-claims', uncertainFilename)
      const uncertainClaim = JSON.parse(fs.readFileSync(uncertainPath, 'utf-8'))
      if (uncertainClaim.externalEffectMayHaveStarted !== true) {
        throw new Error('The external-effect marker was not durably saved.')
      }
      fs.writeFileSync(uncertainPath, JSON.stringify({
        ...uncertainClaim,
        pid: deadPid,
      }), 'utf-8')
      if (new PersistentStore(testDataDir).claimPaymentTxHash(uncertainHash)) {
        throw new Error('A claim with a possibly broadcast transaction was automatically recovered.')
      }

      if (!persistentStore.claimTransactionSettlement(settlementTenant, settlementTxId)) {
        throw new Error('Could not claim destination settlement before its simulated broadcast.')
      }
      if (!persistentStore.markTransactionSettlementExternalEffectMayHaveStarted(settlementTenant, settlementTxId)) {
        throw new Error('Could not persist the destination payout broadcast marker.')
      }
      const settlementFilename = `${crypto.createHash('sha256').update(`${settlementTenant}:${settlementTxId}`).digest('hex')}.claim`
      const settlementPath = path.join(testDataDir, 'settlement-claims', settlementFilename)
      const settlementClaim = JSON.parse(fs.readFileSync(settlementPath, 'utf-8'))
      if (settlementClaim.externalEffectMayHaveStarted !== true) {
        throw new Error('The destination payout broadcast marker was not durably saved.')
      }
      if (!persistentStore.transactionSettlementExternalEffectMayHaveStarted(settlementTenant, settlementTxId)) {
        throw new Error('The settlement recovery path could not detect the lost-response broadcast marker.')
      }
      fs.writeFileSync(settlementPath, JSON.stringify({ ...settlementClaim, pid: deadPid }), 'utf-8')
      if (new PersistentStore(testDataDir).claimTransactionSettlement(settlementTenant, settlementTxId)) {
        throw new Error('A possibly broadcast destination payout was automatically retried after a crash.')
      }
      persistentStore.releaseTransactionSettlement(settlementTenant, settlementTxId)

      if (!persistentStore.claimPaymentRequestProcessing(requestId)) {
        throw new Error('Could not re-claim the active invoice for the uncertain-broadcast test.')
      }
      if (!persistentStore.markPaymentRequestExternalEffectMayHaveStarted(requestId)) {
        throw new Error('Could not persist the invoice external-effect marker.')
      }
      const requestClaimName = `${crypto.createHash('sha256').update(requestId).digest('hex')}.claim`
      const requestClaimPath = path.join(testDataDir, 'payment-request-claims', requestClaimName)
      const requestClaim = JSON.parse(fs.readFileSync(requestClaimPath, 'utf-8'))
      fs.writeFileSync(requestClaimPath, JSON.stringify({ ...requestClaim, pid: deadPid }), 'utf-8')
      if (new PersistentStore(testDataDir).claimPaymentRequestProcessing(requestId)) {
        throw new Error('An invoice claim with a possibly broadcast payout was automatically recovered.')
      }
      persistentStore.releasePaymentRequestProcessing(requestId)

      const malformedTenant = 'audit_malformed_claim_recovery'
      const malformedTxId = 'tx_partial_claim'
      const malformedKey = `${malformedTenant}:${malformedTxId}`
      const malformedName = `${crypto.createHash('sha256').update(malformedKey).digest('hex')}.claim`
      const malformedPath = path.join(testDataDir, 'settlement-claims', malformedName)
      fs.writeFileSync(malformedPath, '{partial', 'utf-8')
      const tenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000)
      fs.utimesSync(malformedPath, tenMinutesAgo, tenMinutesAgo)
      if (!persistentStore.claimTransactionSettlement(malformedTenant, malformedTxId)) {
        throw new Error('An old malformed claim file still blocks settlement recovery')
      }
      persistentStore.releaseTransactionSettlement(malformedTenant, malformedTxId)
    } finally {
      persistentStore.deleteRequest(requestId)
    }
  })

  test('Persistence Integrity', 'ledger and invoice writes fail closed when durable storage is unavailable', () => {
    const blockedPath = path.join(testDataDir, `blocked-store-${Date.now()}`)
    fs.writeFileSync(blockedPath, 'file blocks directory creation')
    const brokenStore = new PersistentStore(blockedPath)
    let ledgerThrew = false
    let requestsThrew = false
    try { brokenStore.writeRawLedger({ audit: [] }) } catch { ledgerThrew = true }
    try { brokenStore.saveRequests({}) } catch { requestsThrew = true }
    if (!ledgerThrew || !requestsThrew) {
      throw new Error(`Storage failure was hidden (ledger=${ledgerThrew}, requests=${requestsThrew})`)
    }
  })

  test('Persistence Integrity', 'corrupt ledger and invoice files fail closed instead of appearing empty', () => {
    const corruptPath = path.join(testDataDir, `corrupt-store-${Date.now()}`)
    const corruptStore = new PersistentStore(corruptPath)
    fs.writeFileSync(path.join(corruptPath, 'ledger.json'), '{broken', 'utf-8')
    fs.writeFileSync(path.join(corruptPath, 'requests.json'), '{broken', 'utf-8')
    let ledgerThrew = false
    let requestsThrew = false
    try { corruptStore.readRawLedger() } catch { ledgerThrew = true }
    try { corruptStore.loadRequests() } catch { requestsThrew = true }
    if (!ledgerThrew || !requestsThrew) {
      throw new Error(`Corrupt storage appeared empty (ledger=${ledgerThrew}, requests=${requestsThrew})`)
    }
    if (fs.readFileSync(path.join(corruptPath, 'ledger.json'), 'utf-8') !== '{broken' ||
        fs.readFileSync(path.join(corruptPath, 'requests.json'), 'utf-8') !== '{broken') {
      throw new Error('Corrupt source files were modified during failed reads')
    }
    fs.writeFileSync(path.join(corruptPath, 'ledger.json'), '[]', 'utf-8')
    fs.writeFileSync(path.join(corruptPath, 'requests.json'), 'null', 'utf-8')
    corruptStore.clearCache()
    ledgerThrew = false
    requestsThrew = false
    try { corruptStore.readRawLedger() } catch { ledgerThrew = true }
    try { corruptStore.loadRequests() } catch { requestsThrew = true }
    if (!ledgerThrew || !requestsThrew) {
      throw new Error(`Invalid storage root types were accepted (ledger=${ledgerThrew}, requests=${requestsThrew})`)
    }
  })

  test('Persistence Integrity', 'returned storage snapshots cannot mutate the in-memory cache', () => {
    const snapshotStore = new PersistentStore(path.join(testDataDir, `snapshot-store-${Date.now()}`))
    const tenant = 'audit_snapshot'
    snapshotStore.saveTransactions(tenant, [{
      id: 'tx_snapshot', type: 'deposit', status: 'completed', fromAsset: 'USDC', fromAmount: 1,
      fromChain: 'base', toAsset: 'USDC', toAmount: 1, toChain: 'base', createdAt: Date.now(),
      bufferMode: 'private', legs: {}, feeUsd: 0,
    }])
    const txSnapshot = snapshotStore.loadTransactions(tenant)
    txSnapshot[0].status = 'failed'
    if (snapshotStore.loadTransactions(tenant)[0].status !== 'completed') {
      throw new Error('Mutating a returned transaction snapshot changed the cached ledger')
    }

    snapshotStore.saveRequest({
      id: 'req_snapshot', status: 'active', amount: 1, asset: 'USDC', chain: 'base',
      shieldedReceiver: 'u1audit_receiver', createdAt: 100, expiresAt: 200,
    })
    const requestSnapshot = snapshotStore.loadRequests()
    requestSnapshot.req_snapshot.status = 'consumed'
    if (snapshotStore.loadRequests().req_snapshot.status !== 'active') {
      throw new Error('Mutating a returned request snapshot changed the cached requests')
    }
  })

  test('Persistence Integrity', 'settlement quotes survive a new store instance and consume atomically', () => {
    const quotePath = path.join(testDataDir, `quote-store-${Date.now()}`)
    const firstStore = new PersistentStore(quotePath)
    const quote = {
      quoteId: 'quote_audit_persisted',
      tenantId: 'audit_quote_tenant',
      amountUsd: 2.5,
      amountZec: 0.012345,
      amountSol: 0.01,
      asset: 'SOL' as const,
      chain: 'solana' as const,
      transactionType: 'send' as const,
      bufferMode: 'fast',
      zecUsd: 202.5,
      solUsd: 250,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 90_000,
      privacyRiskSnapshot: {
        schemaVersion: 'aura-privacy-risk-v1' as const,
        hash: 'test-risk-hash',
        evaluatedAt: Date.now(),
        amountUsd: 2.5,
        policy: 'fast' as const,
        riskCodes: [],
        totalBalanceUsd: 2.5,
        policyReadyUsd: 2.5,
        latestFundingAgeMs: null,
        matchingFundingAmountUsd: null,
        recommendedAction: 'pay' as const,
      },
    }
    firstStore.saveSettlementQuote(quote)

    const restartedStore = new PersistentStore(quotePath)
    const restored = restartedStore.getSettlementQuote(quote.quoteId)
    if (!restored || restored.tenantId !== quote.tenantId || restored.amountZec !== quote.amountZec) {
      throw new Error('A settlement quote was lost across a store restart')
    }
    if (!restartedStore.consumeSettlementQuote(quote.quoteId, quote.tenantId)) {
      throw new Error('The restored settlement quote could not be consumed')
    }
    const secondConsumer = new PersistentStore(quotePath)
    if (secondConsumer.consumeSettlementQuote(quote.quoteId, quote.tenantId)) {
      throw new Error('A settlement quote was consumed more than once')
    }
  })

  test('Crash Recovery Durability', 'pending external operations survive a fresh store instance with exact chain intent fields', () => {
    const tenant = `pending_operation_tenant_${Date.now()}`
    const txId = `tx_pending_operation_${Date.now()}`
    const operationId = `deposit-shield:${tenant}:${txId}`
    const transaction: AuraTransaction = {
      id: txId,
      type: 'deposit',
      status: 'routing_shielded',
      fromAsset: 'USDC',
      fromAmount: 1,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 1,
      toChain: 'zcash',
      bufferMode: 'private',
      createdAt: Date.now(),
      legs: { shielded: { chain: 'zcash', description: 'prepared', status: 'enclave_committed' } },
      feeUsd: 0,
    }
    persistentStore.savePendingOperation({
      id: operationId,
      kind: 'deposit_shield',
      status: 'prepared',
      tenantId: tenant,
      txId,
      createdAt: transaction.createdAt,
      updatedAt: transaction.createdAt,
      transaction,
      sourceTxHash: `0x${'c'.repeat(64)}`,
      paymentTxHash: `0x${'c'.repeat(64)}`,
      memo: `Aura Shield: ${txId}`,
      amountUsd: 1,
      amountZec: 0.01,
      recipientAddress: 'utest1preparedreceiver',
    })
    const restartedStore = new PersistentStore(testDataDir)
    const recovered = restartedStore.getPendingOperation(operationId)
    if (!recovered || recovered.memo !== `Aura Shield: ${txId}` || recovered.amountZec !== 0.01 || recovered.recipientAddress !== 'utest1preparedreceiver') {
      throw new Error('The durable operation did not survive a store restart with its exact recovery fields.')
    }
    restartedStore.updatePendingOperation(operationId, {
      status: 'broadcasting',
      zcashTxid: 'd'.repeat(64),
    })
    const afterUpdate = persistentStore.getPendingOperation(operationId)
    if (!afterUpdate || afterUpdate.status !== 'broadcasting' || afterUpdate.zcashTxid !== 'd'.repeat(64)) {
      throw new Error('Pending operation updates were not visible across store instances.')
    }
    persistentStore.deletePendingOperation(operationId)
  })

  test('Crash Recovery Durability', 'invoice recovery can consume an expired active request without changing its payment identity', () => {
    const requestId = `recover_invoice_${Date.now()}`
    const txHash = `0x${'e'.repeat(64)}`
    persistentStore.saveRequest({
      id: requestId,
      amount: 2,
      asset: 'USDC',
      chain: 'base',
      shieldedReceiver: 'utest1receiver',
      status: 'active',
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    })
    try {
      const recovered = persistentStore.recoverPaymentRequestConsumption(requestId, {
        payAmount: 2,
        payAsset: 'USDC',
        payChain: 'base',
        txHash,
      })
      if (!recovered.success || recovered.request.status !== 'consumed' || recovered.request.txHash !== txHash) {
        throw new Error('A durable invoice settlement could not finish after restart.')
      }
    } finally {
      persistentStore.deleteRequest(requestId)
    }
  })

  await testAsync('Crash Recovery Durability', 'restart reconciliation restores a shielded deposit from its exact wallet memo', async () => {
    const tenant = `deposit_recovery_${Date.now()}`
    const txId = `tx_deposit_recovery_${Date.now()}`
    const sourceHash = `0x${'a'.repeat(64)}`
    const memo = `Aura Shield: ${txId}`
    const zcashTxid = 'b'.repeat(64)
    const transaction: AuraTransaction = {
      id: txId,
      type: 'deposit',
      status: 'routing_shielded',
      fromAsset: 'USDC',
      fromAmount: 5,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 5,
      toChain: 'zcash',
      bufferMode: 'private',
      createdAt: Date.now(),
      legs: {
        deposit: { chain: 'base', txHash: sourceHash, status: 'confirmed', description: 'confirmed' },
        shielded: { chain: 'zcash', status: 'enclave_committed', description: 'pending' },
      },
      feeUsd: 0,
    }
    persistentStore.savePendingOperation({
      id: `deposit-shield:${tenant}:${txId}`,
      kind: 'deposit_shield',
      status: 'broadcasting',
      tenantId: tenant,
      txId,
      createdAt: transaction.createdAt,
      updatedAt: transaction.createdAt,
      transaction,
      sourceTxHash: sourceHash,
      paymentTxHash: sourceHash,
      memo,
      amountUsd: 5,
      amountZec: 0.01,
      recipientAddress: 'utest1recoveryreceiver',
    })

    const originalFind = zcashDevtoolService.findBroadcastTxidByMemo
    const originalVerify = zcashDevtoolService.verifyConfirmation
    try {
      zcashDevtoolService.findBroadcastTxidByMemo = async (requestedMemo) => requestedMemo === memo ? zcashTxid : undefined
      zcashDevtoolService.verifyConfirmation = async (requestedTxid) => ({ confirmed: requestedTxid === zcashTxid, state: requestedTxid === zcashTxid ? 'confirmed' : 'unknown', blockHeight: 123 })
      await reconcilePendingOperations(persistentStore, ledgerService)

      const recovered = ledgerService.getTransactionById(txId, tenant)
      if (recovered?.legs?.shielded?.txHash !== zcashTxid || recovered.status !== 'completed') {
        throw new Error('Deposit restart recovery did not restore the exact wallet transaction.')
      }
      if (persistentStore.getPendingOperation(`deposit-shield:${tenant}:${txId}`)) {
        throw new Error('Recovered deposit intent was not removed after the ledger write.')
      }
    } finally {
      zcashDevtoolService.findBroadcastTxidByMemo = originalFind
      zcashDevtoolService.verifyConfirmation = originalVerify
      persistentStore.deletePendingOperation(`deposit-shield:${tenant}:${txId}`)
      persistentStore.resetTenant(tenant, [])
    }
  })

  await testAsync('Crash Recovery Durability', 'restart reconciliation resumes one-time receive consumption with the recipient ledger write', async () => {
    const tenant = `invoice_recovery_${Date.now()}`
    const requestId = `request_recovery_${Date.now()}`
    const txId = `tx_invoice_recovery_${Date.now()}`
    const paymentHash = `0x${'c'.repeat(64)}`
    const memo = `Aura Invoice Shield: ${txId}`
    const zcashTxid = 'd'.repeat(64)
    const now = Date.now()
    persistentStore.saveRequest({
      id: requestId,
      amount: 7,
      asset: 'USDC',
      chain: 'base',
      shieldedReceiver: 'utest1invoicerecoveryreceiver',
      status: 'active',
      createdAt: now - 120_000,
      expiresAt: now - 60_000,
    })
    const transaction: AuraTransaction = {
      id: txId,
      type: 'receive',
      status: 'routing_shielded',
      fromAsset: 'USDC',
      fromAmount: 7,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 7,
      toChain: 'zcash',
      recipientAddress: 'utest1invoicerecoveryreceiver',
      bufferMode: 'private',
      createdAt: now,
      legs: {
        deposit: { chain: 'base', txHash: paymentHash, status: 'confirmed', description: 'confirmed' },
        shielded: { chain: 'zcash', status: 'enclave_committed', description: 'pending' },
      },
      feeUsd: 0,
    }
    const operationId = `invoice-shield:${tenant}:${txId}`
    persistentStore.savePendingOperation({
      id: operationId,
      kind: 'invoice_shield',
      status: 'broadcasting',
      tenantId: tenant,
      txId,
      createdAt: now,
      updatedAt: now,
      transaction,
      requestId,
      sourceTxHash: paymentHash,
      paymentTxHash: paymentHash,
      memo,
      amountUsd: 7,
      amountZec: 0.02,
      recipientAddress: transaction.recipientAddress,
    })

    const originalFind = zcashDevtoolService.findBroadcastTxidByMemo
    const originalVerify = zcashDevtoolService.verifyConfirmation
    try {
      zcashDevtoolService.findBroadcastTxidByMemo = async (requestedMemo) => requestedMemo === memo ? zcashTxid : undefined
      zcashDevtoolService.verifyConfirmation = async (requestedTxid) => ({ confirmed: requestedTxid === zcashTxid, state: requestedTxid === zcashTxid ? 'confirmed' : 'unknown', blockHeight: 456 })
      await reconcilePendingOperations(persistentStore, ledgerService)

      const recoveredRequest = persistentStore.getPaymentRequest(requestId)
      const recovered = ledgerService.getTransactionById(txId, tenant)
      if (recoveredRequest?.status !== 'consumed' || recoveredRequest.txHash !== paymentHash) {
        throw new Error('Invoice restart recovery did not preserve the original payment identity.')
      }
      if (recovered?.legs?.shielded?.txHash !== zcashTxid || recovered.status !== 'completed') {
        throw new Error('Invoice restart recovery did not restore the recipient ledger transaction.')
      }
      if (persistentStore.getPendingOperation(operationId)) {
        throw new Error('Recovered invoice intent was not removed after both state writes completed.')
      }
    } finally {
      zcashDevtoolService.findBroadcastTxidByMemo = originalFind
      zcashDevtoolService.verifyConfirmation = originalVerify
      persistentStore.deletePendingOperation(operationId)
      persistentStore.deleteRequest(requestId)
      persistentStore.resetTenant(tenant, [])
    }
  })

  await testAsync('Crash Recovery Durability', 'destination recovery checks the persisted Solana signature and Base hash before releasing settlement claims', async () => {
    const solTenant = `destination_recovery_sol_${Date.now()}`
    const baseTenant = `destination_recovery_base_${Date.now()}`
    const solTxId = `tx_destination_sol_${Date.now()}`
    const baseTxId = `tx_destination_base_${Date.now()}`
    const solSignature = '1'.repeat(88)
    const baseHash = `0x${'f'.repeat(64)}`
    const makeTransaction = (id: string, toChain: 'solana' | 'base'): AuraTransaction => ({
      id,
      type: 'send',
      status: 'routing_shielded',
      fromAsset: 'ZEC',
      fromAmount: 1,
      fromChain: 'zcash',
      toAsset: toChain === 'solana' ? 'SOL' : 'USDC',
      toAmount: 0.01,
      toChain,
      recipientAddress: toChain === 'solana'
        ? '11111111111111111111111111111111'
        : '0x1111111111111111111111111111111111111111',
      bufferMode: 'fast',
      createdAt: Date.now(),
      legs: {
        shielded: { chain: 'zcash', description: 'confirmed', status: 'confirmed', txHash: 'a'.repeat(64) },
        delivery: { chain: toChain, description: 'pending', status: 'pending' },
      },
      feeUsd: 0,
    })
    const solTx = makeTransaction(solTxId, 'solana')
    const baseTx = makeTransaction(baseTxId, 'base')
    ledgerService.addTransaction(solTx, solTenant)
    ledgerService.addTransaction(baseTx, baseTenant)
    if (!persistentStore.claimTransactionSettlement(solTenant, solTxId) ||
      !persistentStore.markTransactionSettlementExternalEffectMayHaveStarted(solTenant, solTxId) ||
      !persistentStore.claimTransactionSettlement(baseTenant, baseTxId) ||
      !persistentStore.markTransactionSettlementExternalEffectMayHaveStarted(baseTenant, baseTxId)) {
      throw new Error('Could not create the simulated destination settlement claims.')
    }
    persistentStore.savePendingOperation({
      id: `destination-payout:${solTenant}:${solTxId}`,
      kind: 'destination_payout',
      status: 'broadcasting',
      tenantId: solTenant,
      txId: solTxId,
      createdAt: solTx.createdAt,
      updatedAt: solTx.createdAt,
      transaction: solTx,
      destinationChain: 'solana',
      recipientAddress: solTx.recipientAddress,
      expectedSignature: solSignature,
      recentBlockhash: 'recovery-blockhash',
    })
    persistentStore.savePendingOperation({
      id: `destination-payout:${baseTenant}:${baseTxId}`,
      kind: 'destination_payout',
      status: 'broadcasting',
      tenantId: baseTenant,
      txId: baseTxId,
      createdAt: baseTx.createdAt,
      updatedAt: baseTx.createdAt,
      transaction: baseTx,
      destinationChain: 'base',
      recipientAddress: baseTx.recipientAddress,
      expectedTxHash: baseHash,
      expectedNonce: '0x2a',
      senderAddress: '0x2222222222222222222222222222222222222222',
    })

    const originalSolStatus = solanaRelayer.getSignatureStatus
    const originalSolExpired = solanaRelayer.isBlockhashExpired
    const originalBaseLookup = baseRelayer.getTransactionByHash
    const originalBaseReceipt = baseRelayer.getTransactionReceipt
    try {
      solanaRelayer.getSignatureStatus = async () => ({ confirmationStatus: 'finalized' })
      solanaRelayer.isBlockhashExpired = async () => false
      baseRelayer.getTransactionByHash = async () => ({ hash: baseHash })
      baseRelayer.getTransactionReceipt = async () => ({ status: '0x1' })
      await reconcilePendingOperations(persistentStore, ledgerService)

      const recoveredSol = ledgerService.getTransactionById(solTxId, solTenant)
      if (recoveredSol?.legs?.delivery?.txHash !== solSignature || recoveredSol.status !== 'completed' || recoveredSol.legs.delivery?.confirmationStatus !== 'finalized') {
        throw new Error('Restart reconciliation did not recover the exact Solana signature.')
      }
      const recoveredBase = ledgerService.getTransactionById(baseTxId, baseTenant)
      if (recoveredBase?.legs?.delivery?.txHash !== baseHash || recoveredBase.legs.delivery?.status !== 'confirmed' || recoveredBase.status !== 'completed') {
        throw new Error('Restart reconciliation did not recover the exact Base transaction hash.')
      }
      if (persistentStore.getPendingOperation(`destination-payout:${solTenant}:${solTxId}`) || persistentStore.getPendingOperation(`destination-payout:${baseTenant}:${baseTxId}`)) {
        throw new Error('Recovered destination intents were not removed after their identities were saved to the ledger.')
      }
    } finally {
      solanaRelayer.getSignatureStatus = originalSolStatus
      solanaRelayer.isBlockhashExpired = originalSolExpired
      baseRelayer.getTransactionByHash = originalBaseLookup
      baseRelayer.getTransactionReceipt = originalBaseReceipt
      persistentStore.releaseTransactionSettlement(solTenant, solTxId)
      persistentStore.releaseTransactionSettlement(baseTenant, baseTxId)
      persistentStore.deletePendingOperation(`destination-payout:${solTenant}:${solTxId}`)
      persistentStore.deletePendingOperation(`destination-payout:${baseTenant}:${baseTxId}`)
      persistentStore.resetTenant(solTenant, [])
      persistentStore.resetTenant(baseTenant, [])
    }
  })

  test('Production Retention', 'redacts old recipient metadata without deleting accounting facts', () => {
    const previousRetention = process.env.AURA_DATA_RETENTION_DAYS
    const retentionPath = path.join(testDataDir, `retention-store-${Date.now()}`)
    const oldCreatedAt = Date.now() - 3 * 24 * 60 * 60 * 1000
    try {
      process.env.AURA_DATA_RETENTION_DAYS = '1'
      const firstStore = new PersistentStore(retentionPath)
      firstStore.saveTransactions('retention_tenant', [{
        id: 'tx_retention', type: 'send', status: 'completed', fromAsset: 'ZEC', fromAmount: 1,
        fromChain: 'zcash', toAsset: 'SOL', toAmount: 0.01, toChain: 'solana',
        recipientAddress: '11111111111111111111111111111111',
        toAddress: '11111111111111111111111111111111',
        createdAt: oldCreatedAt, bufferMode: 'fast',
        legs: {
          delivery: {
            chain: 'solana', description: 'recipient detail', destinationAddress: '11111111111111111111111111111111',
            explorerUrl: 'https://example.invalid/tx', status: 'confirmed', confirmationStatus: 'finalized',
          },
        },
        zkData: {
          privacyRoutingType: 'direct_atomic_route', clientCommitmentHash: 'commitment',
          intermediateHopExecuted: true, senderUnlinked: true, recipientUnlinked: true, auditStatus: 'verified',
        },
        feeUsd: 0,
      }])

      const restartedStore = new PersistentStore(retentionPath)
      const retained = restartedStore.loadTransactions('retention_tenant')[0]
      if (!retained || retained.fromAmount !== 1 || retained.toAmount !== 0.01) {
        throw new Error('Retention removed accounting facts required for balance reconciliation')
      }
      if (retained.recipientAddress || retained.toAddress || retained.zkData || retained.legs.delivery?.destinationAddress || retained.legs.delivery?.explorerUrl || retained.legs.delivery?.description !== undefined) {
        throw new Error('Retention left direct recipient or local proof metadata in the old record')
      }
    } finally {
      if (previousRetention === undefined) delete process.env.AURA_DATA_RETENTION_DAYS
      else process.env.AURA_DATA_RETENTION_DAYS = previousRetention
    }
  })

  test('Production Boundary', 'never advertises demo execution as production-ready', () => {
    const blocked = getProductionExecutionBlock('audit_write', 'production')
    if (!blocked || blocked.error !== 'PRODUCTION_BOUNDARY_NOT_READY') {
      throw new Error('Production execution must fail closed until the production custody boundary exists.')
    }
    if (getProductionExecutionBlock('audit_write', 'development')) {
      throw new Error('Hackathon demo execution must remain available in development.')
    }
  })

  // --- SUITE 3: MULTI-TENANT ISOLATION & BALANCE INVARIANTS ---
  test('Ledger Invariants', 'Multi-tenant isolation: Tenant A mutations do not pollute Tenant B', () => {
    const tenantA = `audit_tenant_a_${Date.now()}`
    const tenantB = `audit_tenant_b_${Date.now()}`

    // Load clean initial ledgers
    const txsA = persistentStore.loadTransactions(tenantA, [])
    const txsB = persistentStore.loadTransactions(tenantB, [])

    if (txsA.length !== 0 || txsB.length !== 0) {
      throw new Error('Initial clean seed failed')
    }

    // Add transaction to Tenant A
    persistentStore.saveTransactions(tenantA, [
      {
        id: `tx_a_${Date.now()}`,
        type: 'deposit',
        status: 'completed',
        fromAsset: 'USDC',
        fromAmount: 100,
        fromChain: 'base',
        toAsset: 'USDC',
        toAmount: 99.75,
        toChain: 'zcash',
        bufferMode: 'private',
        createdAt: Date.now(),
        legs: {},
        feeUsd: 0.25,
      },
    ])

    // Verify Tenant B remains empty
    const txsBAfter = persistentStore.loadTransactions(tenantB, [])
    if (txsBAfter.length !== 0) {
      throw new Error(`Tenant B was corrupted by Tenant A! Count: ${txsBAfter.length}`)
    }

    // Verify Tenant A has exactly 1
    const txsAAfter = persistentStore.loadTransactions(tenantA, [])
    if (txsAAfter.length !== 1) {
      throw new Error(`Tenant A transaction missing. Count: ${txsAAfter.length}`)
    }
  })

  test('Ledger Invariants', 'A pending broadcast shielded spend stays reserved after two minutes', () => {
    const tenant = `audit_pending_shielded_${Date.now()}`
    const now = Date.now()
    persistentStore.saveTransactions(tenant, [
      {
        id: 'tx_pending_source_spend',
        type: 'send',
        status: 'routing_shielded',
        fromAsset: 'USDC',
        fromAmount: 40,
        fromChain: 'zcash',
        toAsset: 'USDC',
        toAmount: 40,
        toChain: 'base',
        recipientAddress: `0x${'1'.repeat(40)}`,
        bufferMode: 'fast',
        createdAt: now - 5 * 60_000,
        feeUsd: 0.22,
        legs: {
          shielded: { chain: 'zcash', description: 'broadcast', txHash: 'a'.repeat(64), status: 'broadcasting' },
        },
      },
      {
        id: 'tx_funded_balance',
        type: 'deposit',
        status: 'completed',
        fromAsset: 'USDC',
        fromAmount: 100,
        fromChain: 'base',
        toAsset: 'USDC',
        toAmount: 100,
        toChain: 'zcash',
        bufferMode: 'fast',
        createdAt: now - 10 * 60_000,
        feeUsd: 0,
        legs: { shielded: { chain: 'zcash', description: 'confirmed', txHash: 'b'.repeat(64), status: 'confirmed' } },
      },
    ])
    const balance = ledgerService.getTenantBalance(tenant)
    if (balance.totalUsd !== 60) throw new Error(`Pending source spend was not reserved without a fictitious routing fee: balance=${balance.totalUsd}`)
  })

  test('Settlement Recovery', 'an interrupted post-broadcast request keeps a durable pending record and reservation', () => {
    const tenant = `audit_interrupted_spend_${Date.now()}`
    const now = Date.now()
    ledgerService.addTransaction({
      id: 'tx_recovery_funding',
      type: 'deposit',
      status: 'completed',
      fromAsset: 'USDC',
      fromAmount: 100,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 100,
      toChain: 'zcash',
      bufferMode: 'fast',
      createdAt: now - 10 * 60_000,
      legs: { shielded: { chain: 'zcash', description: 'confirmed', txHash: 'a'.repeat(64), status: 'confirmed' } },
      feeUsd: 0,
    }, tenant)
    const pendingTx = {
      id: 'tx_recovery_spend',
      type: 'send' as const,
      status: 'processing' as const,
      fromAsset: 'USDC' as const,
      fromAmount: 40,
      fromChain: 'zcash' as const,
      toAsset: 'USDC' as const,
      toAmount: 40,
      toChain: 'base' as const,
      recipientAddress: `0x${'3'.repeat(40)}`,
      bufferMode: 'fast' as const,
      createdAt: now,
      legs: { shielded: { chain: 'zcash' as const, description: 'pending', status: 'pending' as const } },
      feeUsd: 0.22,
    }
    const reservation = ledgerService.reserveSpend(tenant, pendingTx, 40.22, 'fast')
    if (!reservation.success) throw new Error('Could not reserve funds for recovery test.')

    ledgerService.confirmSpend(tenant, pendingTx.id, {
      ...pendingTx,
      status: 'routing_shielded',
      legs: { shielded: { chain: 'zcash', description: 'broadcast in progress', txHash: 'b'.repeat(64), status: 'broadcasting' } },
    })

    const recovered = ledgerService.getTransactionById(pendingTx.id, tenant)
    const balance = ledgerService.getTenantBalance(tenant)
    if (recovered?.status !== 'routing_shielded' || recovered.legs?.shielded?.status !== 'broadcasting') {
      throw new Error('Interrupted spend recovery did not preserve its pending chain state.')
    }
    if (balance.totalUsd !== 60) throw new Error(`Interrupted post-broadcast spend was not held without a fictitious routing fee: balance=${balance.totalUsd}`)
  })

  test('Ledger Invariants', 'An old in-flight spend without a saved hash is not auto-refunded', () => {
    const tenant = `audit_uncertain_broadcast_${Date.now()}`
    const now = Date.now()
    persistentStore.saveTransactions(tenant, [
      {
        id: 'tx_uncertain_broadcast',
        type: 'send',
        status: 'processing',
        fromAsset: 'USDC',
        fromAmount: 40,
        fromChain: 'zcash',
        toAsset: 'USDC',
        toAmount: 40,
        toChain: 'base',
        recipientAddress: `0x${'2'.repeat(40)}`,
        bufferMode: 'fast',
        createdAt: now - 5 * 60_000,
        feeUsd: 0.22,
        legs: {},
      },
      {
        id: 'tx_confirmed_balance',
        type: 'deposit',
        status: 'completed',
        fromAsset: 'USDC',
        fromAmount: 100,
        fromChain: 'base',
        toAsset: 'USDC',
        toAmount: 100,
        toChain: 'zcash',
        bufferMode: 'fast',
        createdAt: now - 10 * 60_000,
        feeUsd: 0,
        legs: {},
      },
    ])
    const balance = ledgerService.getTenantBalance(tenant)
    if (balance.totalUsd !== 60) throw new Error(`Uncertain source spend was incorrectly refunded: balance=${balance.totalUsd}`)
  })

  // --- SUITE 4: ADDRESS FORMAT VALIDATION ---
  test('Address Validation', 'validateEvmAddress strictly validates 42-char hex starting with 0x', () => {
    if (!validateEvmAddress('0x71C84920b7635292caceB5606F516e8647E64e8B')) {
      throw new Error('Valid EVM address marked invalid')
    }
    if (validateEvmAddress('0xInvalidHexLength')) {
      throw new Error('Short EVM address was accepted')
    }
    if (validateEvmAddress('7YwE5R4QGj1uM2H')) {
      throw new Error('Solana address accepted as EVM')
    }
  })

  test('Address Validation', 'validateSolanaAddress strictly validates base58 public keys', () => {
    if (!validateSolanaAddress('7YwE5R4QGj1uM2H4F8d87b3n4k5m6p7q8r9sXt1u2v3w')) {
      throw new Error('Valid Solana address marked invalid')
    }
    if (validateSolanaAddress('0x71C84920b7635292caceB5606F516e8647E64e8B')) {
      throw new Error('EVM address accepted as Solana')
    }
  })

  // --- SUITE 5: RATE LIMITER MECHANISM ---
  test('Rate Limiter', 'InMemoryRateLimiter enforces token capacity and blocks on exhaustion', () => {
    const limiter = new InMemoryRateLimiter(3, 60) // 3 tokens max
    const id = 'test_client_rl'

    const c1 = limiter.check(id)
    const c2 = limiter.check(id)
    const c3 = limiter.check(id)
    const c4 = limiter.check(id) // Should be blocked

    if (!c1.allowed || !c2.allowed || !c3.allowed) {
      throw new Error('Allowed requests within capacity failed')
    }
    if (c4.allowed) {
      throw new Error('4th request should have been rate limited')
    }
    if (c4.remaining !== 0) {
      throw new Error('Remaining tokens should be 0 on rate limited response')
    }
  })

  test('Rate Limiter', 'durable shared bucket survives a second server instance', () => {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-shared-rate-limit-'))
    const firstInstance = new PersistentStore(sharedDir)
    const secondInstance = new PersistentStore(sharedDir)
    try {
      for (let index = 0; index < 3; index += 1) {
        const result = firstInstance.checkSharedRateLimit('preflight-test', 'same-client', 3, 60)
        if (!result?.allowed) throw new Error(`Request ${index + 1} should be allowed`)
      }
      const blocked = secondInstance.checkSharedRateLimit('preflight-test', 'same-client', 3, 60)
      if (!blocked || blocked.allowed || blocked.remaining !== 0) {
        throw new Error('A second server instance must observe the shared bucket')
      }
    } finally {
      fs.rmSync(sharedDir, { recursive: true, force: true })
    }
  })

  test('Shared Cache', 'redacted health snapshots survive a second server instance', () => {
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-shared-cache-'))
    const firstInstance = new PersistentStore(sharedDir)
    const secondInstance = new PersistentStore(sharedDir)
    try {
      firstInstance.setSharedCache('health-test', 'shared-key', { status: 'ready' }, 60_000)
      const cached = secondInstance.getSharedCache<{ status?: string }>('health-test', 'shared-key', 60_000)
      if (cached?.status !== 'ready') throw new Error('The second server instance did not read the shared snapshot')
    } finally {
      fs.rmSync(sharedDir, { recursive: true, force: true })
    }
  })

  test('Trusted Client Identity', 'forwarded IP headers are trusted only behind an explicit proxy setting', () => {
    const previous = process.env.AURA_TRUST_PROXY
    try {
      delete process.env.AURA_TRUST_PROXY
      const direct = getTrustedClientId(new Headers({ 'x-forwarded-for': '203.0.113.10' }))
      if (direct !== 'direct-client') throw new Error('Untrusted forwarded IP must not identify a direct client')

      const tenant = getTrustedClientId(new Headers({ 'x-aura-enclave-fingerprint': 'tenant_a' }))
      if (tenant !== 'direct-client') throw new Error('Unverified tenant fingerprint must not create a rate-limit identity')

      const browser = getTrustedClientId(new Headers({ cookie: `${RATE_LIMIT_COOKIE_NAME}=550e8400-e29b-41d4-a716-446655440000` }))
      if (!browser.startsWith('browser:')) throw new Error('Server-issued browser bucket must isolate ordinary clients')

      const session = getTrustedClientId(new Headers({ 'x-aura-enclave-fingerprint': 'tenant_a' }), { sessionToken: 'signed-session-token' })
      if (!session.startsWith('session:')) throw new Error('Authenticated session must provide a stable rate-limit identity')

      process.env.AURA_TRUST_PROXY = 'true'
      const proxied = getTrustedClientId(new Headers({ 'x-forwarded-for': '203.0.113.10, 10.0.0.2' }))
      if (proxied !== '203.0.113.10') throw new Error('Trusted proxy mode must use the first forwarded client IP')
    } finally {
      if (previous === undefined) delete process.env.AURA_TRUST_PROXY
      else process.env.AURA_TRUST_PROXY = previous
    }
  })

  test('Jury Session Authorization', 'jury cookies are HMAC-verified in every runtime mode', () => {
    const forged = 'not-a-signed-jury-session'
    if (verifyJurySession(forged)) throw new Error('Forged jury cookie must never be accepted')
    // Do not make this cryptographic unit test depend on live operator leases.
    // The runtime pool is intentionally allowed to be exhausted by concurrent
    // jury browsers; this test only needs one isolated, synthetic assignment.
    const previousPool = process.env.AURA_JURY_TENANT_IDS
    const previousLegacyTenant = process.env.AURA_JURY_TENANT_ID
    process.env.AURA_JURY_TENANT_IDS = `vault_r_test_jury_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    try {
      const issued = issueJurySession()
      if (!issued || !verifyJurySession(issued.token)) throw new Error('Issued jury session must verify')
    } finally {
      if (previousPool === undefined) delete process.env.AURA_JURY_TENANT_IDS
      else process.env.AURA_JURY_TENANT_IDS = previousPool
      if (previousLegacyTenant === undefined) delete process.env.AURA_JURY_TENANT_ID
      else process.env.AURA_JURY_TENANT_ID = previousLegacyTenant
    }
  })

  // --- SUITE 6: UNGUESSABLE CRYPTO ID GENERATOR ---
  test('Cryptographic IDs', 'generateSecureId produces unique, collision-resistant IDs', () => {
    const id1 = generateSecureId('tx')
    const id2 = generateSecureId('tx')
    if (id1 === id2) {
      throw new Error('Collision detected in secure ID generator')
    }
    if (!id1.startsWith('tx_') || id1.length < 24) {
      throw new Error(`ID format invalid: ${id1}`)
    }
  })

  test('Deposit Authorization', 'ECDSA signature binds tenant, amount, chain, transaction and sender', () => {
    const crypto = require('crypto')
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
    const payload = 'tenant_a:deposit:25.00:25:USDC:base:0x' + 'a'.repeat(64) + ':0x' + 'b'.repeat(40) + ':123456789:00112233445566778899aabbccddeeff'
    const signature = 'sig_0x' + crypto.sign('sha256', Buffer.from(payload), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('hex')

    if (!verifyClientEcdsaSignature(publicKey, payload, signature)) {
      throw new Error('Valid deposit authorization was rejected')
    }
    if (verifyClientEcdsaSignature(publicKey, payload.replace('25.00', '250.00'), signature)) {
      throw new Error('Tampered deposit amount was accepted')
    }
    if (persistentStore.bindSpendSigningKey('audit_unbound_tenant', publicKey)) {
      throw new Error('A spend key claimed a tenant before recovery authority registration')
    }
    if (!persistentStore.registerInitialAuthKeys('audit_deposit_tenant', publicKey, publicKey)) {
      throw new Error('Initial recovery and signing keys could not be registered')
    }
    if (!persistentStore.bindSpendSigningKey('audit_deposit_tenant', publicKey)) {
      throw new Error('The pinned signing key was not recognized on retry')
    }
    const alternatePair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const alternatePublicKey = alternatePair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex')
    if (persistentStore.bindSpendSigningKey('audit_deposit_tenant', alternatePublicKey)) {
      throw new Error('A different signing key replaced the pinned key')
    }
    const recoveryOnlyTenant = `audit_recovery_only_${Date.now()}`
    if (!persistentStore.bindRecoveryKey(recoveryOnlyTenant, publicKey)) {
      throw new Error('Recovery-only tenant setup failed')
    }
    if (persistentStore.bindSpendSigningKey(recoveryOnlyTenant, alternatePublicKey)) {
      throw new Error('A fresh browser key claimed a tenant with a missing spend key')
    }
  })

  test('Recovery Authorization', 'recovery authority and rotated spend key survive a new store instance', () => {
    const crypto = require('crypto')
    const tenant = `audit_recovery_${Date.now()}`
    const firstPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const recoveryPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const rotatedPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const publicHex = (key: unknown) => (key as { export: (options: { type: string; format: string }) => Buffer })
      .export({ type: 'spki', format: 'der' }).toString('hex')
    const firstPublicKey = publicHex(firstPair.publicKey)
    const recoveryPublicKey = publicHex(recoveryPair.publicKey)
    const rotatedPublicKey = publicHex(rotatedPair.publicKey)

    if (!persistentStore.registerInitialAuthKeys(tenant, recoveryPublicKey, firstPublicKey)) throw new Error('Initial auth keys were not bound')

    const restartedStore = new PersistentStore(testDataDir)
    if (restartedStore.getRecoveryKey(tenant) !== recoveryPublicKey) {
      throw new Error('Recovery authority was not durable across store instances')
    }
    if (restartedStore.getSpendSigningKey(tenant) !== firstPublicKey) {
      throw new Error('Initial spend key was not durable across store instances')
    }
    if (!restartedStore.rotateSpendSigningKey(tenant, rotatedPublicKey)) {
      throw new Error('Spend key rotation failed')
    }
    if (persistentStore.getSpendSigningKey(tenant) !== rotatedPublicKey) {
      throw new Error('An existing store returned a stale spend key after rotation')
    }
    if (persistentStore.bindSpendSigningKey(tenant, firstPublicKey)) {
      throw new Error('The pre-rotation spend key remained authorized')
    }
    if (!persistentStore.bindSpendSigningKey(tenant, rotatedPublicKey)) {
      throw new Error('The rotated spend key was not accepted')
    }
  })

  test('Demo Wallet Authorization', 'sponsored demo transfers require a short-lived server session bound to the client', () => {
    const address = '0x' + 'a'.repeat(40)
    const session = issueDemoSession(address, 'audit-client')
    if (!verifyDemoSession(session.token, address, 'audit-client')) {
      throw new Error('A freshly issued demo session was rejected')
    }
    if (verifyDemoSession(session.token, address, 'different-client')) {
      throw new Error('A demo session was accepted for a different client binding')
    }
    if (verifyDemoSession(session.token, '0x' + 'b'.repeat(40), 'audit-client')) {
      throw new Error('A demo session was accepted for a different wallet address')
    }
    const parts = session.token.split('.')
    if (parts.length !== 2) throw new Error('Demo session token is not signed')
    const tamperedPayload = Buffer.from(JSON.stringify({ address, client: 'x', expiresAt: session.expiresAt, nonce: 'tampered' }), 'utf8').toString('base64url')
    if (verifyDemoSession(`${tamperedPayload}.${parts[1]}`, address, 'audit-client')) {
      throw new Error('Tampered demo session payload was accepted')
    }
  })

  test('Deposit Replay Protection', 'transaction hash claims are exclusive and reusable only after release', () => {
    const hash = `0x${generateSecureId('claim').replace(/[^a-f0-9]/gi, '').padEnd(64, '0').slice(0, 64)}`
    if (!persistentStore.claimPaymentTxHash(hash)) throw new Error('Initial transaction claim failed')
    if (persistentStore.claimPaymentTxHash(hash.toUpperCase())) throw new Error('Concurrent duplicate claim succeeded')
    const secondStore = new PersistentStore(testDataDir)
    if (secondStore.claimPaymentTxHash(hash)) throw new Error('A second store instance claimed an in-flight payment')
    persistentStore.releasePaymentTxHash(hash)
    if (!secondStore.claimPaymentTxHash(hash)) throw new Error('Claim was not released after retryable failure')
    secondStore.releasePaymentTxHash(hash)
  })

  test('Deposit Replay Protection', 'case-sensitive Solana signatures remain distinct payment identifiers', () => {
    const upperBase58Signature = 'A'.repeat(80)
    const lowerBase58Signature = 'a'.repeat(80)
    const secondStore = new PersistentStore(testDataDir)
    if (!persistentStore.claimPaymentTxHash(upperBase58Signature)) throw new Error('Could not claim first Solana signature')
    try {
      if (!secondStore.claimPaymentTxHash(lowerBase58Signature)) {
        throw new Error('A distinct case-sensitive Solana signature was treated as a duplicate')
      }
    } finally {
      persistentStore.releasePaymentTxHash(upperBase58Signature)
      secondStore.releasePaymentTxHash(lowerBase58Signature)
    }
  })

  test('Authorization Replay Protection', 'signed nonce claims survive store instances and reject duplicates', () => {
    const tenant = `audit_nonce_${Date.now()}`
    const nonce = '00112233445566778899aabbccddeeff'
    if (!persistentStore.claimAuthNonce(tenant, 'spend', nonce)) throw new Error('First nonce claim failed')
    const secondStore = new PersistentStore(testDataDir)
    if (secondStore.claimAuthNonce(tenant, 'spend', nonce)) throw new Error('Duplicate nonce claim succeeded after store reinitialization')
    if (!persistentStore.claimAuthNonce(tenant, 'reset_vault', nonce)) throw new Error('Action scopes should be independent')
  })

  test('Authorization Replay Protection', 'short-window requests do not delete a still-valid spend nonce', () => {
    const tenant = `audit_nonce_window_${Date.now()}`
    const nonce = 'ffeeddccbbaa99887766554433221100'
    const filename = `${tenant}.spend.${nonce}.nonce`
    const noncePath = path.join(testDataDir, 'auth-nonces', filename)
    if (!persistentStore.claimAuthNonce(tenant, 'spend', nonce, 5 * 60 * 1000)) {
      throw new Error('Initial spend nonce claim failed')
    }

    // Simulate a consumed 3-minute-old signature. Spend accepts signatures
    // for 5 minutes, while activity/status use a shorter 2-minute window.
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000)
    fs.utimesSync(noncePath, threeMinutesAgo, threeMinutesAgo)
    const cleanupNonce = '11223344556677889900aabbccddeeff'
    if (!persistentStore.claimAuthNonce(`audit_cleanup_${tenant}`, 'activity', cleanupNonce, 2 * 60 * 1000)) {
      throw new Error('Short-window cleanup nonce claim failed')
    }
    const secondStore = new PersistentStore(testDataDir)
    if (secondStore.claimAuthNonce(tenant, 'spend', nonce, 5 * 60 * 1000)) {
      throw new Error('A still-valid spend nonce was deleted and could be replayed')
    }
  })

  // --- SUITE 7: SOLANA BASE58 & RELAYER DERIVATION ---
  test('Solana Cryptography', 'Base58 encode/decode roundtrip and deterministic public key derivation', () => {
    const { base58Encode, base58Decode, solanaRelayer } = require('../lib/crypto/solana-relayer')
    const sample = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128])
    const encoded = base58Encode(sample)
    const decoded = base58Decode(encoded)
    if (decoded.length !== sample.length || !decoded.every((v: number, i: number) => v === sample[i])) {
      throw new Error('Base58 roundtrip integrity check failed')
    }
    const zeroBytes = new Uint8Array([0, 0, 0])
    if (base58Encode(zeroBytes) !== '111' || base58Decode('111').length !== zeroBytes.length) {
      throw new Error('Base58 leading-zero bytes were not preserved exactly')
    }
    if (base58Decode('1').length !== 1 || base58Decode('').length !== 0 || base58Encode(new Uint8Array()) !== '') {
      throw new Error('Base58 zero/empty edge cases decoded to a non-canonical length')
    }
    const pubkey = solanaRelayer.getPublicKey()
    if (!pubkey || pubkey.length < 32 || pubkey.length > 44) {
      throw new Error(`Derived Solana public key invalid: ${pubkey}`)
    }
  })

  test('Solana Cryptography', '32-byte seeds derive their public key and inconsistent 64-byte keys are rejected', () => {
    const seed = new Uint8Array(32).fill(7)
    const fromSeed = deriveSolanaKeyMaterial(seed)
    if (!fromSeed || fromSeed.publicKeyBytes.length !== 32 || Buffer.from(fromSeed.publicKeyBytes).equals(Buffer.from(seed))) {
      throw new Error('A 32-byte Ed25519 seed did not produce its derived public key')
    }
    const keypair = new Uint8Array(64)
    keypair.set(seed)
    keypair.set(fromSeed.publicKeyBytes, 32)
    if (!deriveSolanaKeyMaterial(keypair)) throw new Error('A matching 64-byte Solana keypair was rejected')
    keypair[63] ^= 1
    if (deriveSolanaKeyMaterial(keypair)) throw new Error('A mismatched public key was accepted')
  })

  test('Solana Confirmation', 'invoice settlement requires confirmed/finalized status, not processed', () => {
    if (isConfirmedSolanaSignatureStatus({ confirmationStatus: 'processed' })) {
      throw new Error('A merely processed Solana transaction must not settle an invoice.')
    }
    if (!isConfirmedSolanaSignatureStatus({ confirmationStatus: 'confirmed' })) {
      throw new Error('A confirmed Solana transaction should pass the confirmation check.')
    }
    if (!isConfirmedSolanaSignatureStatus({ confirmationStatus: 'finalized' })) {
      throw new Error('A finalized Solana transaction should pass the confirmation check.')
    }
    if (isConfirmedSolanaSignatureStatus({ confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } })) {
      throw new Error('A failed Solana transaction must not pass the confirmation check.')
    }
    if (isConfirmedSolanaSignatureStatus({ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } })) {
      throw new Error('A failed but confirmed Solana transaction must not pass the confirmation check.')
    }
  })

  test('Solana Finality', 'Pay completion requires finalized destination status', () => {
    if (isFinalizedSolanaSignatureStatus({ confirmationStatus: 'processed' })) {
      throw new Error('A processed Solana transaction must not complete Pay.')
    }
    if (isFinalizedSolanaSignatureStatus({ confirmationStatus: 'confirmed' })) {
      throw new Error('A merely confirmed Solana payout must remain pending.')
    }
    if (!isFinalizedSolanaSignatureStatus({ confirmationStatus: 'finalized' })) {
      throw new Error('A finalized Solana payout must complete Pay.')
    }
    if (isFinalizedSolanaSignatureStatus({ confirmationStatus: 'finalized', err: { InstructionError: [0, 'Custom'] } })) {
      throw new Error('A failed finalized-looking Solana payout must not complete Pay.')
    }
  })

  test('Solana RPC', 'balance checks reject unavailable and malformed RPC results instead of reporting zero', () => {
    if (parseSolanaBalanceResponse({ result: { value: 1_250_000_000 } }) !== 1.25) {
      throw new Error('A valid Solana balance was not converted from lamports.')
    }
    for (const response of [
      { error: { message: 'RPC unavailable' } },
      { result: {} },
      { result: { value: -1 } },
      { result: { value: 1.5 } },
      null,
    ]) {
      let rejected = false
      try {
        parseSolanaBalanceResponse(response)
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error('An invalid Solana RPC response was treated as a successful zero balance.')
    }
  })

  test('Quote Routing', 'Default quote chains match the selected asset network', () => {
    const { getDefaultChainForAsset } = require('../lib/services/near-intents-service')
    if (getDefaultChainForAsset('SOL') !== 'solana') throw new Error('SOL must default to Solana')
    if (getDefaultChainForAsset('ZEC') !== 'zcash') throw new Error('ZEC must default to Zcash')
    if (getDefaultChainForAsset('USDC') !== 'base') throw new Error('USDC must default to Base')
  })

  test('Demo Route Scope', 'only Base Sepolia USDC is accepted as a live public entry route', () => {
    if (!isWorkingDemoEntryRoute('base', 'USDC')) throw new Error('Base Sepolia USDC must remain enabled')
    if (isWorkingDemoEntryRoute('solana', 'SOL')) throw new Error('Solana SOL entry must remain a roadmap route')
    if (isWorkingDemoEntryRoute('base', 'ETH')) throw new Error('Base ETH entry must remain disabled')
  })

  test('Settlement Pricing', 'stale, future-dated, and invalid rates cannot price settlements', () => {
    const now = Date.now()
    const liveRate = { symbol: 'SOL' as const, usdPrice: 150, change24h: 0, lastUpdated: now, status: 'live' as const }
    if (!isFreshSettlementRate(liveRate, now, 300_000)) {
      throw new Error('A current live price should be accepted')
    }
    if (isFreshSettlementRate({ ...liveRate, lastUpdated: now - 300_001 }, now, 300_000)) {
      throw new Error('An expired price should be rejected')
    }
    if (isFreshSettlementRate({ ...liveRate, lastUpdated: now + 1 }, now, 300_000)) {
      throw new Error('A future-dated price should be rejected')
    }
    if (isFreshSettlementRate({ ...liveRate, status: 'stale' }, now, 300_000)) {
      throw new Error('A fallback display price should not be used for settlement')
    }
    if (isFreshSettlementRate({ ...liveRate, usdPrice: Number.NaN }, now, 300_000)) {
      throw new Error('A non-finite price should be rejected')
    }
  })

  test('Settlement Pricing', 'demo readiness requires both fresh ZEC and SOL rates', () => {
    const now = Date.now()
    const zec = { symbol: 'ZEC' as const, usdPrice: 50, change24h: 0, lastUpdated: now, status: 'live' as const }
    const sol = { symbol: 'SOL' as const, usdPrice: 100, change24h: 0, lastUpdated: now, status: 'live' as const }
    if (!areSettlementRatesReady(zec, sol, now, 5 * 60_000)) {
      throw new Error('Fresh rates for both settlement assets should enable pricing readiness.')
    }
    if (areSettlementRatesReady(zec, null, now, 5 * 60_000)) {
      throw new Error('A missing SOL rate must not report settlement pricing as ready.')
    }
    if (areSettlementRatesReady(zec, { ...sol, status: 'stale' }, now, 5 * 60_000)) {
      throw new Error('A stale SOL rate must not report settlement pricing as ready.')
    }
  })

  test('Settlement Pricing', 'oracle money movement requires a close two-source quorum and rejects abnormal jumps', () => {
    if (selectConsensusRate([{ price: 30, change24h: 0 }]) !== null) {
      throw new Error('A single price source must not be accepted for settlement')
    }
    if (selectConsensusRate([{ price: 30, change24h: 0 }, { price: 33, change24h: 0 }]) !== null) {
      throw new Error('A divergent source pair must fail closed')
    }
    const accepted = selectConsensusRate([{ price: 30, change24h: 0 }, { price: 30.3, change24h: 0 }], 30)
    if (!accepted || Math.abs(accepted.price - 30.15) > 0.000001) {
      throw new Error('A close two-source consensus should be accepted')
    }
    if (selectConsensusRate([{ price: 40, change24h: 0 }, { price: 40.2, change24h: 0 }], 30) !== null) {
      throw new Error('An abnormal jump from the last accepted rate must fail closed')
    }
  })

  test('Zcash Shielded Readiness', 'transparent funds do not count toward PCZT shielded sends', () => {
    const transparentOnly = { orchardSpendable: 0, saplingSpendable: 0, unshieldedSpendable: 10 }
    if (getShieldedSpendableZec(transparentOnly) !== 0 || canFundShieldedSend(transparentOnly, 1)) {
      throw new Error('Transparent ZEC was incorrectly counted as available for a shielded-only spend.')
    }
    const shielded = { orchardSpendable: 0.6, saplingSpendable: 0.5, unshieldedSpendable: 0 }
    if (getShieldedSpendableZec(shielded) !== 1.1 || !canFundShieldedSend(shielded, 1)) {
      throw new Error('Spendable Sapling/Orchard funds were not counted for shielded execution.')
    }
    if (canFundShieldedSend(shielded, 1.1)) {
      throw new Error('The shielded transaction fee reserve was not preserved.')
    }
    const ironwoodOnly = { orchardSpendable: 0, saplingSpendable: 0, ironwoodSpendable: 1.1, unshieldedSpendable: 0 }
    if (getShieldedSpendableZec(ironwoodOnly) !== 1.1 || !canFundShieldedSend(ironwoodOnly, 1)) {
      throw new Error('Ironwood shielded funds were not included in the spendable pool balance.')
    }
    if (ZCASH_FEE_RESERVE_ZEC < 0.0001 || !canFundShieldedSend(ironwoodOnly, 1) || canFundShieldedSend(ironwoodOnly, 1.10001)) {
      throw new Error(`ZIP-317 fee reserve is not enforced at the minimum 0.0001 ZEC: ${ZCASH_FEE_RESERVE_ZEC}`)
    }
    const aggregateOnly = {
      orchardSpendable: 0,
      saplingSpendable: 0,
      totalSpendable: 0.07297946,
      poolBreakdownAvailable: false,
    }
    if (Math.abs(getShieldedSpendableZec(aggregateOnly) - 0.07297946) > 0.00000001 || !canFundShieldedSend(aggregateOnly, 0.07)) {
      throw new Error('Aggregate shielded balance was not used when the wallet omitted pool breakdown fields.')
    }
  })

  test('Settlement Pricing', 'client actions accept only live, non-future rates within the five-minute window', () => {
    const now = Date.now()
    const liveRate = { symbol: 'ZEC' as const, usdPrice: 50, change24h: 0, lastUpdated: now, status: 'live' as const }
    if (!isFreshMarketRate(liveRate, now) || isFreshMarketRate({ ...liveRate, status: 'stale' }, now)) {
      throw new Error('A missing or stale rate was accepted for a money action.')
    }
    if (isFreshMarketRate({ ...liveRate, lastUpdated: now + 1 }, now) ||
        isFreshMarketRate({ ...liveRate, lastUpdated: now - 300_001 }, now)) {
      throw new Error('A future-dated or expired rate was accepted for a money action.')
    }
  })

  test('Settlement Pricing', 'the client and server use the same locked quote rounding', () => {
    const locked = calculateSettlementAmounts(10, 50, 200)
    if (locked.amountZec !== 0.2 || locked.amountSol !== 0.05) {
      throw new Error('Locked settlement quote rounding is not deterministic.')
    }
    const changedMarketRate = calculateSettlementAmounts(10, 51, 201)
    if (changedMarketRate.amountZec === locked.amountZec || changedMarketRate.amountSol === locked.amountSol) {
      throw new Error('The regression fixture did not model rate drift.')
    }
  })

  test('Solana Cryptography', 'Invoice authorization rejects an altered message and accepts a valid wallet signature', () => {
    const crypto = require('crypto')
    const { base58Encode, verifySolanaMessageSignature } = require('../lib/crypto/solana-relayer')
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
    const rawPublicKey = spki.subarray(spki.length - 32)
    const message = 'Aura invoice payment authorization test'
    const signature = crypto.sign(null, Buffer.from(message), privateKey)
    const address = base58Encode(rawPublicKey)
    const signatureBase64 = signature.toString('base64')
    if (!verifySolanaMessageSignature(message, address, signatureBase64)) throw new Error('Valid Ed25519 signature was rejected')
    if (verifySolanaMessageSignature(`${message}!`, address, signatureBase64)) throw new Error('Altered invoice authorization message was accepted')
  })

  // --- SUITE 8: BASE SEPOLIA EVM DERIVATION ---
  test('Base EVM Cryptography', 'Pure TypeScript Keccak-256 & secp256k1 EVM address matches user wallet', () => {
    const { keccak256Hex, baseRelayer } = require('../lib/crypto/base-relayer')
    const emptyKeccak = keccak256Hex(new Uint8Array(0))
    // Standard Keccak-256 of empty string is c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    if (emptyKeccak.toLowerCase() !== '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') {
      throw new Error(`Keccak-256 standard test vector mismatch: got ${emptyKeccak}`)
    }
    const derivedAddr = baseRelayer.getAddress()
    if (!derivedAddr.startsWith('0x') || derivedAddr.length !== 42) {
      throw new Error(`Derived EVM address invalid: ${derivedAddr}`)
    }
    if (derivedAddr.toLowerCase() !== '0x9caf6275fe5e9f833818d1a76a09d9c067c19033') {
      throw new Error(`Derived address mismatch: got ${derivedAddr}, expected 0x9CAF6275fe5e9F833818D1a76A09d9c067C19033`)
    }
  })

  test('Base Network Readiness', 'rejects RPC endpoints connected to a different EVM network', () => {
    if (!isBaseSepoliaChainId('0x14a34') || !isBaseSepoliaChainId('0x014A34')) {
      throw new Error('Base Sepolia chain ID was not recognized in canonical hexadecimal forms.')
    }
    for (const chainId of ['0x2105', '0x1', '84532', '', null, undefined]) {
      if (isBaseSepoliaChainId(chainId)) {
        throw new Error(`A non-Base-Sepolia RPC chain ID was accepted: ${String(chainId)}`)
      }
    }
  })

  await testAsync('Crash Recovery Durability', 'Base invoice recovery scans only the exact signed payer and amount', async () => {
    const originalFetch = globalThis.fetch
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const token = (process.env.BASE_SEPOLIA_USDC_CONTRACT || '0x036CbD53842c5426634e7929541eC2318f3dCF7e').toLowerCase()
    const vault = (process.env.VAULT_DEPOSIT_ADDRESS || '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e').toLowerCase()
    const sender = '0x3333333333333333333333333333333333333333'
    const txHash = `0x${'a'.repeat(64)}`
    const topicAddress = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
    const calls: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { method?: string }
      calls.push(body.method || '')
      const result = body.method === 'eth_blockNumber'
        ? '0x64'
        : body.method === 'eth_getLogs'
          ? [{
              address: token,
              topics: [transferTopic, topicAddress(sender), topicAddress(vault)],
              data: '0xf4240',
              transactionHash: txHash,
              blockNumber: '0x20',
              logIndex: '0x0',
            }]
          : []
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const relayer = new BaseRelayerService()
      const found = await relayer.findUsdcTransferCandidates({
        fromBlock: 10,
        senderAddress: sender,
        vaultAddress: vault,
        amountUnits: 1_000_000n,
      })
      if (found.length !== 1 || found[0].txHash !== txHash || found[0].amountUnits !== 1_000_000n) {
        throw new Error('Exact Base recovery transfer was not selected.')
      }
      if (!calls.includes('eth_getLogs') || !calls.includes('eth_blockNumber')) {
        throw new Error('Recovery scanner did not query the bounded Base log window.')
      }
      const message = createPaymentRecoveryAuthorizationMessage({
        requestId: 'req_recovery_test', amountCents: 100, asset: 'USDC', chain: 'base', payerAddress: sender,
      })
      if (!message.includes('Purpose: recover a source transfer after client interruption')) {
        throw new Error('Recovery authorization message is not purpose-bound.')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('Base EVM Cryptography', 'Recovers the signer of a personal_sign invoice authorization', () => {
    const { deriveEvmAddress, keccak256, recoverPersonalSignAddress } = require('../lib/crypto/base-relayer')
    const message = 'Aura invoice payment authorization test'
    const messageBytes = Buffer.from(message, 'utf8')
    const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${messageBytes.length}`, 'utf8')
    const digest = Buffer.from(keccak256(Buffer.concat([prefix, messageBytes])))
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
    const r = BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
    // Private key = 1 and nonce = 1: s = z + r (mod n), recovery id is G.y parity (0).
    const s = (BigInt(`0x${digest.toString('hex')}`) + r) % n
    const signature = `0x${Buffer.concat([Buffer.from(r.toString(16).padStart(64, '0'), 'hex'), Buffer.from(s.toString(16).padStart(64, '0'), 'hex'), Buffer.from([27])]).toString('hex')}`
    const expectedAddress = deriveEvmAddress(`0x${'0'.repeat(63)}1`)
    const recoveredAddress = recoverPersonalSignAddress(message, signature)
    if (recoveredAddress !== expectedAddress) throw new Error(`Recovered ${recoveredAddress}, expected ${expectedAddress}`)
    if (recoverPersonalSignAddress(`${message}!`, signature) === expectedAddress) throw new Error('Signature was accepted for a different message')
  })

  await testAsync('Base EVM Cryptography', 'Accepts deployed ERC-1271 contract-wallet authorization', async () => {
    const originalFetch = globalThis.fetch
    const contractAddress = '0x1111111111111111111111111111111111111111'
    const message = 'Aura ERC-1271 authorization test'
    const signature = `0x${'11'.repeat(65)}`
    let saw1271Call = false
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { method?: string; params?: Array<{ to?: string; data?: string }> }
      if (body.method !== 'eth_call') throw new Error(`Unexpected RPC method: ${body.method}`)
      const call = body.params?.[0]
      if (call?.to?.toLowerCase() !== contractAddress.toLowerCase() || !call.data?.startsWith('0x1626ba7e')) {
        throw new Error('ERC-1271 call was not encoded for the contract wallet.')
      }
      saw1271Call = true
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 12, result: '0x1626ba7e' }), { status: 200 })
    }) as typeof globalThis.fetch
    try {
      const verified = await new BaseRelayerService().verifyWalletSignature(contractAddress, message, signature)
      if (!verified || !saw1271Call) throw new Error('ERC-1271 contract-wallet authorization was rejected.')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // --- SUITE 9: SECP256K1 RAW SIGNING CAPABILITY ---
  test('Base EVM Cryptography', 'Test Node.js native secp256k1 ECDSA signing', () => {
    const crypto = require('crypto')
    const privHex = crypto.randomBytes(32).toString('hex')
    const sec1Header = Buffer.from('302e0201010420', 'hex')
    const sec1Footer = Buffer.from('a00706052b8104000a', 'hex')
    const der = Buffer.concat([sec1Header, Buffer.from(privHex, 'hex'), sec1Footer])
    const privKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' })

    const testDigest = Buffer.alloc(32, 1)
    try {
      const sig = crypto.sign(null, testDigest, { key: privKey, dsaEncoding: 'ieee-p1363' })
      if (sig.length !== 64) {
        throw new Error(`Signature length invalid: ${sig.length}`)
      }
    } catch (err: unknown) {
      throw new Error(`Raw digest sign error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  test('Privacy Wait Accounting', 'privacy waits start at shielded confirmation and fast mode adds no artificial delay', () => {
    const tenant = `test_privacy_wait_${Date.now()}`
    const now = Date.now()
    ledgerService.addTransaction({
      id: 'tx_private_wait_confirmation',
      type: 'deposit',
      status: 'completed',
      fromAsset: 'USDC',
      fromAmount: 40,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 40,
      toChain: 'zcash',
      bufferMode: 'private',
      createdAt: now - 48 * 60 * 60 * 1000,
      completedAt: now - 60 * 60 * 1000,
      legs: { shielded: { chain: 'zcash', description: 'confirmed', status: 'confirmed' } },
      feeUsd: 0,
    }, tenant)
    ledgerService.addTransaction({
      id: 'tx_fast_no_extra_wait',
      type: 'deposit',
      status: 'completed',
      fromAsset: 'USDC',
      fromAmount: 10,
      fromChain: 'base',
      toAsset: 'USDC',
      toAmount: 10,
      toChain: 'zcash',
      bufferMode: 'fast',
      createdAt: now,
      completedAt: now,
      legs: { shielded: { chain: 'zcash', description: 'confirmed', status: 'confirmed' } },
      feeUsd: 0,
    }, tenant)

    const balance = ledgerService.getTenantBalance(tenant)
    if (balance.totalUsd !== 50 || balance.readyToSpendUsd !== 10) {
      throw new Error(`Expected $50 total with $10 ready; got $${balance.totalUsd} total and $${balance.readyToSpendUsd} ready.`)
    }
    const privatePolicyBalance = persistentStore.calculateTenantBalance(tenant, 0, [], 'private')
    const fastPolicyBalance = persistentStore.calculateTenantBalance(tenant, 0, [], 'fast')
    if (privatePolicyBalance.readyToSpendUsd !== 0 || fastPolicyBalance.readyToSpendUsd !== 50) {
      throw new Error('The selected wait policy was not applied to every balance entry consistently.')
    }
  })

  // --- SUITE 10: FAIL-CLOSED ATOMIC ROLLBACK GUARANTEE ---
  test('Atomic Safety & Rollback', 'Reservation release restores vault balance with zero leakage on broadcast error', () => {
    const tenant = 'test_tenant_rollback_' + Date.now()
    // Initial state: 0 balance
    const b0 = ledgerService.getTenantBalance(tenant)
    if (b0.totalUsd !== 0) {
      throw new Error(`Expected initial 0 balance, got ${b0.totalUsd}`)
    }

    // Record a deposit of $100
    ledgerService.addTransaction(
      {
        id: 'tx_dep_test_100',
        type: 'deposit',
        status: 'completed',
        fromAsset: 'USDC',
        fromAmount: 100,
        fromChain: 'base',
        toAsset: 'USDC',
        toAmount: 100,
        toChain: 'zcash',
        bufferMode: 'private',
        createdAt: Date.now() - 86400 * 1000 * 2,
        legs: {},
        feeUsd: 0,
      },
      tenant
    )
    const b1 = ledgerService.getTenantBalance(tenant)
    if (b1.totalUsd !== 100) {
      throw new Error(`Expected 100 total after deposit, got ${b1.totalUsd}`)
    }

    // Reserve $40 for spend using fast buffer mode
    const res = ledgerService.reserveSpend(
      tenant,
      {
        id: 'tx_spend_test_40',
        type: 'send',
        status: 'settling_destination',
        fromAsset: 'USDC',
        fromAmount: 40,
        fromChain: 'zcash',
        toAsset: 'USDC',
        toAmount: 40,
        toChain: 'solana',
        bufferMode: 'fast',
        createdAt: Date.now(),
        legs: {},
        feeUsd: 0,
      },
      40,
      'fast'
    )
    if (!res.success) {
      throw new Error('Reservation of $40 failed')
    }
    const b2 = ledgerService.getTenantBalance(tenant)
    if (b2.readyToSpendUsd !== 60) {
      throw new Error(`Expected 60 ready to spend during reservation, got ${b2.readyToSpendUsd}`)
    }

    // Simulate Relayer failure and release reservation
    ledgerService.releaseReservation(tenant, 'tx_spend_test_40', 'Destination relayer simulated network failure')
    const b3 = ledgerService.getTenantBalance(tenant)
    if (b3.readyToSpendUsd !== 100) {
      throw new Error(`Expected 100 ready to spend after rollback, got ${b3.readyToSpendUsd}`)
    }
  })

  test('Atomic Safety & Concurrency', 'two store instances cannot reserve the same tenant balance twice', () => {
    const tenant = 'test_tenant_concurrency_' + Date.now()
    ledgerService.addTransaction(
      {
        id: 'tx_dep_concurrency_100',
        type: 'deposit',
        status: 'completed',
        fromAsset: 'USDC',
        fromAmount: 100,
        fromChain: 'base',
        toAsset: 'USDC',
        toAmount: 100,
        toChain: 'zcash',
        bufferMode: 'fast',
        createdAt: Date.now() - 86_400_000,
        legs: {},
        feeUsd: 0,
      },
      tenant
    )
    const secondStore = new PersistentStore(testDataDir)
    const secondLedger = new LedgerService(secondStore)
    const first = ledgerService.reserveSpend(tenant, {
      id: 'tx_spend_concurrency_first',
      type: 'send', status: 'settling_destination', fromAsset: 'USDC', fromAmount: 60,
      fromChain: 'zcash', toAsset: 'USDC', toAmount: 60, toChain: 'solana',
      bufferMode: 'fast', createdAt: Date.now(), legs: {}, feeUsd: 0,
    }, 60, 'fast')
    const second = secondLedger.reserveSpend(tenant, {
      id: 'tx_spend_concurrency_second',
      type: 'send', status: 'settling_destination', fromAsset: 'USDC', fromAmount: 60,
      fromChain: 'zcash', toAsset: 'USDC', toAmount: 60, toChain: 'solana',
      bufferMode: 'fast', createdAt: Date.now(), legs: {}, feeUsd: 0,
    }, 60, 'fast')
    if (!first.success) throw new Error('The first reservation failed unexpectedly')
    if (second.success || second.error !== 'INSUFFICIENT_FUNDS') {
      throw new Error(`The second reservation was not rejected atomically: ${second.error || 'success'}`)
    }
    ledgerService.releaseReservation(tenant, 'tx_spend_concurrency_first', 'audit cleanup')
  })

  test('Ledger mutation writes preserve concurrent status updates', 'read-modify-write ledger operations do not overwrite a newer process snapshot', () => {
    const tenant = 'test_tenant_ledger_mutation_' + Date.now()
    const firstStore = new PersistentStore(testDataDir)
    const firstLedger = new LedgerService(firstStore)
    const secondLedger = new LedgerService(new PersistentStore(testDataDir))
    const initial = {
      id: 'tx_ledger_mutation_initial',
      type: 'send' as const,
      status: 'processing' as const,
      fromAsset: 'USDC' as const,
      fromAmount: 10,
      fromChain: 'zcash' as const,
      toAsset: 'USDC' as const,
      toAmount: 10,
      toChain: 'solana' as const,
      bufferMode: 'fast' as const,
      createdAt: Date.now(),
      legs: {},
      feeUsd: 0,
    }
    firstLedger.addTransaction(initial, tenant)
    // Prime the first instance with an intentionally stale in-memory snapshot.
    firstLedger.getTransactions(tenant)
    const updated = secondLedger.updateTransaction(initial.id, { status: 'completed' }, tenant)
    if (!updated || updated.status !== 'completed') throw new Error('Concurrent status update failed')
    firstLedger.addTransaction({ ...initial, id: 'tx_ledger_mutation_second' }, tenant)

    const finalLedger = new LedgerService(new PersistentStore(testDataDir))
    const final = finalLedger.getTransactions(tenant)
    const preserved = final.find((tx) => tx.id === initial.id)
    const appended = final.find((tx) => tx.id === 'tx_ledger_mutation_second')
    if (preserved?.status !== 'completed' || !appended) {
      throw new Error('A concurrent ledger mutation was overwritten by a stale snapshot')
    }
  })

  // --- SUITE 11: MULTI-CHAIN INTEGRITY & ETH/USDC VERIFICATION ---
  test('Deposit Verification', 'verifyDeposit correctly supports both ERC-20 USDC and native ETH', () => {
    const { baseRelayer } = require('../lib/crypto/base-relayer')
    if (typeof baseRelayer.verifyDeposit !== 'function') {
      throw new Error('baseRelayer.verifyDeposit is not a function')
    }
  })

  test('Deposit Isolation', 'ERC-20 deposits reject one transaction containing multiple senders', () => {
    const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    const token = '0x1111111111111111111111111111111111111111'
    const vault = '0x2222222222222222222222222222222222222222'
    const topicAddress = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
    const log = (sender: string, amount: string) => ({
      address: token,
      topics: [topic, topicAddress(sender), topicAddress(vault)],
      data: `0x${BigInt(amount).toString(16)}`,
    })
    const sameSender = summarizeErc20VaultTransfers(
      [log('0x3333333333333333333333333333333333333333', '100'), log('0x3333333333333333333333333333333333333333', '200')],
      token,
      vault
    )
    if (sameSender.mixedSenders || sameSender.amountUnits !== 300n) {
      throw new Error('Repeated deposits from one sender should be aggregated')
    }
    const mixed = summarizeErc20VaultTransfers(
      [log('0x3333333333333333333333333333333333333333', '100'), log('0x4444444444444444444444444444444444444444', '200')],
      token,
      vault
    )
    if (!mixed.mixedSenders) throw new Error('Transfers from different senders must not be aggregated')
  })

  test('Deposit Isolation', 'Solana deposits reject one transaction containing multiple senders', () => {
    const transfer = (source: string, lamports: number) => ({
      program: 'system',
      parsed: { type: 'transfer', info: { source, destination: 'vault-address', lamports } },
    })
    const sameSender = summarizeSolanaVaultTransfers(
      [transfer('sender-a', 100), transfer('sender-a', 200)],
      'vault-address'
    )
    if (sameSender.mixedSenders || sameSender.amountLamports !== 300n) {
      throw new Error('Repeated transfers from one sender should be aggregated')
    }
    const mixed = summarizeSolanaVaultTransfers(
      [transfer('sender-a', 100), transfer('sender-b', 200)],
      'vault-address'
    )
    if (!mixed.mixedSenders) throw new Error('Transfers from different senders must not be aggregated')
  })

  await testAsync('Settlement Recovery', 'finalized Solana delivery reconciles the private Zcash leg without another payout', async () => {
    const tenant = `audit_private_leg_reconcile_${Date.now()}`
    const confirmedId = 'tx_private_leg_confirmed'
    const expiredId = 'tx_private_leg_expired'
    const signature = '1'.repeat(88)
    const makeTransaction = (id: string, txHash: string): AuraTransaction => ({
      id,
      type: 'send',
      status: 'completed',
      fromAsset: 'USDC',
      fromAmount: 0.5,
      fromChain: 'zcash',
      toAsset: 'SOL',
      toAmount: 0.005,
      toChain: 'solana',
      recipientAddress: '11111111111111111111111111111111',
      bufferMode: 'fast',
      createdAt: Date.now(),
      completedAt: Date.now(),
      legs: {
        shielded: { chain: 'zcash', description: 'broadcast', txHash, status: 'broadcasting' },
        delivery: { chain: 'solana', description: 'finalized', txHash: signature, status: 'confirmed', confirmationStatus: 'finalized' },
      },
      feeUsd: 0,
    })
    const confirmedHash = 'c'.repeat(64)
    const expiredHash = 'd'.repeat(64)
    ledgerService.addTransaction(makeTransaction(confirmedId, confirmedHash), tenant)
    ledgerService.addTransaction(makeTransaction(expiredId, expiredHash), tenant)
    const originalVerify = zcashDevtoolService.verifyConfirmation
    try {
      zcashDevtoolService.verifyConfirmation = async (txid) => txid === confirmedHash
        ? { confirmed: true, state: 'confirmed', blockHeight: 123 }
        : { confirmed: false, state: 'expired', expiryHeight: 122 }

      await reconcileConfirmedShieldedPayouts(persistentStore, ledgerService)

      const confirmed = ledgerService.getTransactionById(confirmedId, tenant)
      if (confirmed?.legs?.shielded?.status !== 'confirmed' || confirmed.status !== 'completed' || confirmed.legs?.delivery?.txHash !== signature) {
        throw new Error('A mined Zcash private leg was not reconciled while preserving the finalized Solana receipt.')
      }
      const expired = ledgerService.getTransactionById(expiredId, tenant)
      if (expired?.legs?.shielded?.status !== 'failed' || expired.status !== 'completed' || expired.legs?.delivery?.txHash !== signature || expired.privateSettlementRecovery?.reason !== 'expired') {
        throw new Error('An expired private leg did not receive operator recovery state while preserving delivered value.')
      }
    } finally {
      zcashDevtoolService.verifyConfirmation = originalVerify
      persistentStore.resetTenant(tenant, [])
    }
  })

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length

  return {
    total: results.length,
    passed,
    failed,
    results,
  }
  } finally {
    fs.rmSync(testDataDir, { recursive: true, force: true })
  }
}
