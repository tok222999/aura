import { NextRequest, NextResponse } from 'next/server'
import { ledgerService } from '@/lib/services/ledger-service'
import { nearIntentsService } from '@/lib/services/near-intents-service'
import { AssetSymbol, AuraTransaction, ChainId, PrivacyBufferMode, TransactionType, TransactionStatus } from '@/lib/types/aura'
import { globalPaymentLimiter, paymentLimiter } from '@/lib/utils/rate-limiter'
import { generateSecureId } from '@/lib/utils'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { isFinalizedSolanaSignatureStatus, solanaRelayer } from '@/lib/crypto/solana-relayer'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { isSafeZcashWriteRetry, zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { persistentStore } from '@/lib/services/persistent-store'
import { canFundShieldedSend, getMinimumConfirmationsForBuffer, getShieldedSpendableZec, ZCASH_FEE_RESERVE_ZEC } from '@/lib/services/zcash-balance'
import { settlementQuoteService } from '@/lib/services/settlement-quote-service'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { reconcilePendingOperations } from '@/lib/services/pending-operation-reconciler'
import { calculatePrivacyRiskSnapshot } from '@/lib/utils/privacy-risk'
import { reconcileLedgerBalanceWithShieldedChain } from '@/lib/services/authoritative-balance'
import { usesSharedJuryZcashSource } from '@/lib/services/jury-zcash-source'
import { hasJuryAccessForTenant } from '@/lib/services/demo-session-service'


export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('spend')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  let reservedSpend: { tenantId: string; txId: string; transaction: AuraTransaction } | null = null
  let zcashSpendMayHaveBroadcast = false
  let zcashSpendTxidForRecovery: string | undefined
  let zcashSpendExplorerForRecovery: string | undefined
  let zcashSpendConfirmedForRecovery = false
  let destinationHashForRecovery: string | undefined
  let settlementClaimed = false
  let zcashSpendOperationId: string | undefined
  const destinationOperationIdFor = (tenant: string, transactionId: string) => `destination-payout:${tenant}:${transactionId}`
  try {
    // Section 14: Rate limiting enforcement
    const globalRateCheck = globalPaymentLimiter.check('global')
    if (!globalRateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many payment authorization calls.' },
        { status: 429, headers: { 'Retry-After': String(globalRateCheck.retryAfter) } },
      )
    }

    const body = await req.json().catch(() => ({}))
    const {
      type = 'send',
      recipient,
      asset = 'USDC',
      amount,
      chain = 'solana',
      bufferMode = 'private',
      clientSignature,
      enclaveFingerprint,
      onChainTxHash,
      settlementQuote,
    } = body

    const headerTenant = req.headers.get('x-aura-enclave-fingerprint')
    if (
      (enclaveFingerprint !== undefined && typeof enclaveFingerprint !== 'string') ||
      (headerTenant && enclaveFingerprint && headerTenant !== enclaveFingerprint)
    ) {
      return NextResponse.json({ success: false, error: 'TENANT_MISMATCH' }, { status: 401 })
    }
    const tenantId = enclaveFingerprint || headerTenant
    if (!tenantId || !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId)) {
      return NextResponse.json({ success: false, error: 'TENANT_REQUIRED' }, { status: 401 })
    }

    const numAmount = Number(amount)
    if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 1_000_000) {
      return NextResponse.json(
        { success: false, error: 'INVALID_AMOUNT', message: 'Invalid spend amount.' },
        { status: 400 }
      )
    }
    if (Math.abs(numAmount * 100 - Math.round(numAmount * 100)) > 1e-7) {
      return NextResponse.json({ success: false, error: 'INVALID_AMOUNT_PRECISION', message: 'Spend amount must use no more than two decimal places.' }, { status: 400 })
    }
    if (type !== 'send' && type !== 'withdraw') {
      return NextResponse.json({ success: false, error: 'INVALID_TRANSACTION_TYPE' }, { status: 400 })
    }
    if (!['fast', 'private', 'strong', 'custom'].includes(bufferMode)) {
      return NextResponse.json({ success: false, error: 'INVALID_PRIVACY_WAIT' }, { status: 400 })
    }

    // The locked hackathon route is Base Sepolia → shielded Zcash → Solana Devnet.
    // Keep both private sends and withdrawals on the same live destination;
    // future exits may be displayed in the UI, but are not executable yet.
    if ((type === 'send' || type === 'withdraw') && chain !== 'solana') {
      return NextResponse.json(
        { success: false, error: 'UNSUPPORTED_DEMO_ROUTE', message: 'This demo currently exits on Solana Devnet only. Other destinations are coming next.' },
        { status: 400 }
      )
    }

    // 0. STRICT DEMO CHAIN VALIDATION
    if (chain !== 'base' && chain !== 'solana') {
      return NextResponse.json(
        {
          success: false,
          error: 'UNSUPPORTED_CHAIN',
          message: `The active hackathon testnet demo is restricted to Base Sepolia and Solana Devnet. Chain '${chain}' is not supported in the live execution relayer.`,
        },
        { status: 400 }
      )
    }
    if (chain === 'base' && asset !== 'USDC') {
      return NextResponse.json(
        { success: false, error: 'UNSUPPORTED_ASSET', message: 'Base Sepolia relayer currently pays out USDC only.' },
        { status: 400 }
      )
    }
    if (chain === 'solana' && asset !== 'SOL') {
      return NextResponse.json(
        { success: false, error: 'UNSUPPORTED_ASSET', message: 'Solana Devnet payouts currently support SOL only.' },
        { status: 400 }
      )
    }

    // 1. RECIPIENT ADDRESS VALIDATION
    if (!recipient || typeof recipient !== 'string' || recipient.trim().length < 8) {
      return NextResponse.json(
        { success: false, error: 'INVALID_RECIPIENT', message: 'A valid destination address is required.' },
        { status: 400 }
      )
    }

    // EVM & Solana format sanity check
    if (chain === 'base') {
      if (!/^0x[a-fA-F0-9]{40}$/.test(recipient.trim())) {
        return NextResponse.json(
          { success: false, error: 'INVALID_EVM_ADDRESS', message: 'Invalid EVM destination address format.' },
          { status: 400 }
        )
      }
    } else if (chain === 'solana') {
      if (!/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(recipient.trim())) {
        return NextResponse.json(
          { success: false, error: 'INVALID_SOLANA_ADDRESS', message: 'Invalid Solana destination address format.' },
          { status: 400 }
        )
      }
    }

    const relayerRecipient = chain === 'base' ? baseRelayer.getAddress() : solanaRelayer.getPublicKey()
    const isRelayerRecipient = chain === 'base'
      ? recipient.trim().toLowerCase() === relayerRecipient.trim().toLowerCase()
      : recipient.trim() === relayerRecipient.trim()
    if (isRelayerRecipient) {
      return NextResponse.json(
        { success: false, error: 'RECIPIENT_IS_RELAYER', message: 'Choose a separate destination wallet. Sending to Aura’s own payout wallet would not deliver funds.' },
        { status: 400 }
      )
    }

    // 2. CLIENT SIGNATURE / AUTHORIZATION VERIFICATION (UNCONDITIONAL)
    if (!clientSignature || typeof clientSignature !== 'object') {
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED_SPEND',
          message: 'Cryptographic client intent signature is required to authorize spending from private vault.',
        },
        { status: 401 }
      )
    }

    if (!clientSignature.intentCommitment || typeof clientSignature.intentCommitment !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED_SPEND',
          message: 'Cryptographic client intent commitment is missing.',
        },
        { status: 401 }
      )
    }

    // MANDATORY NONCE (Fixes Issue 7)
    if (!clientSignature.nonce || typeof clientSignature.nonce !== 'string' || !/^[a-f0-9]{32}$/i.test(clientSignature.nonce)) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_NONCE',
          message: 'Cryptographic nonce of at least 16 characters is strictly required for replay protection.',
        },
        { status: 401 }
      )
    }

    // MANDATORY TIMESTAMP
    if (!clientSignature.clientTimestamp || typeof clientSignature.clientTimestamp !== 'number') {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_TIMESTAMP',
          message: 'Client timestamp is required for temporal correlation prevention.',
        },
        { status: 401 }
      )
    }

    // Strict 5-minute validity window
    if (Math.abs(Date.now() - clientSignature.clientTimestamp) > 5 * 60 * 1000) {
      return NextResponse.json(
        {
          success: false,
          error: 'SIGNATURE_EXPIRED',
          message: 'Spend signature expired. Client timestamp exceeds 5-minute validity window.',
        },
        { status: 401 }
      )
    }

    // Nonce replay rejection
    // Strict tenant isolation verification
    if (clientSignature.enclaveFingerprint && clientSignature.enclaveFingerprint !== tenantId) {
      return NextResponse.json(
        {
          success: false,
          error: 'TENANT_MISMATCH',
          message: 'Spend signature enclave fingerprint does not match request tenant context.',
        },
        { status: 401 }
      )
    }

    // UNCONDITIONAL CRYPTOGRAPHIC VERIFICATION (Fixes Issues 7 & 8)
    const signedAmountZec = Number(clientSignature.amountZec)
    const signedFingerprint = clientSignature.enclaveFingerprint
    const publicKey = typeof clientSignature.authPublicKey === 'string' ? clientSignature.authPublicKey : ''
    const quoteId = typeof clientSignature.quoteId === 'string' ? clientSignature.quoteId : ''
    const quoteZecUsd = Number(clientSignature.quoteZecUsd)
    const quoteSolUsd = clientSignature.quoteSolUsd === undefined ? undefined : Number(clientSignature.quoteSolUsd)
    const quoteExpiresAt = Number(clientSignature.quoteExpiresAt)
    const privacyRiskHash = typeof clientSignature.privacyRiskHash === 'string' ? clientSignature.privacyRiskHash : ''
    const providedQuote = settlementQuote && typeof settlementQuote === 'object' ? settlementQuote as Record<string, unknown> : null
    if (!providedQuote || providedQuote.quoteId !== quoteId ||
      Number(providedQuote.quoteZecUsd) !== quoteZecUsd ||
      (providedQuote.quoteSolUsd === undefined ? quoteSolUsd !== undefined : Number(providedQuote.quoteSolUsd) !== quoteSolUsd) ||
      Number(providedQuote.expiresAt) !== quoteExpiresAt ||
      providedQuote.privacyRiskHash !== privacyRiskHash) {
      return NextResponse.json({
        success: false,
        error: 'SETTLEMENT_QUOTE_REQUIRED',
        message: 'A signed, short-lived settlement quote is required. Request a new quote and try again.',
      }, { status: 409 })
    }
    const quoteVerification = settlementQuoteService.verify({
      quoteId,
      tenantId,
      amountUsd: numAmount,
      amountZec: signedAmountZec,
      asset: String(clientSignature.asset || ''),
      chain: String(clientSignature.chain || ''),
      transactionType: String(clientSignature.transactionType || ''),
      bufferMode: String(clientSignature.bufferMode || ''),
      quoteZecUsd,
      quoteSolUsd,
      quoteExpiresAt,
      privacyRiskHash,
    })
    if (!quoteVerification.ok) {
      return NextResponse.json({
        success: false,
        error: quoteVerification.error,
        message: quoteVerification.error === 'QUOTE_EXPIRED'
          ? 'The settlement quote expired. Request a new quote and confirm again.'
          : 'The settlement quote does not match this spend intent.',
      }, { status: 409 })
    }
    const lockedQuote = quoteVerification.quote
    const candidates = [
      `${tenantId}:${signedAmountZec.toFixed(6)}:${recipient.trim()}:${clientSignature.clientTimestamp}:${clientSignature.nonce}:${Number(clientSignature.amountUsd).toFixed(2)}:${clientSignature.asset}:${clientSignature.chain}:${clientSignature.transactionType}:${clientSignature.bufferMode}:${quoteId}:${quoteZecUsd.toFixed(8)}:${quoteSolUsd === undefined ? '' : quoteSolUsd.toFixed(8)}:${quoteExpiresAt}:${privacyRiskHash}`,
    ]
    // The vault fingerprint is derived from the recovery seed, not from this separate
    // ECDSA key. Bind the signed payload to that vault identifier and verify key possession.
    if (!signedFingerprint || signedFingerprint !== tenantId || !publicKey) {
      return NextResponse.json({ success: false, error: 'INVALID_SIGNING_KEY' }, { status: 401 })
    }
    if (
      !Number.isFinite(signedAmountZec) || signedAmountZec <= 0 ||
      Number(clientSignature.amountUsd) !== numAmount ||
      clientSignature.asset !== asset || clientSignature.chain !== chain ||
      clientSignature.transactionType !== type || clientSignature.bufferMode !== bufferMode ||
      !Number.isFinite(quoteZecUsd) || (chain === 'solana' && !Number.isFinite(quoteSolUsd))
    ) {
      return NextResponse.json({ success: false, error: 'SIGNED_INTENT_MISMATCH' }, { status: 401 })
    }

    let isAuthorized = false

    // Priority 1: Verify authentic ECDSA P-256 asymmetric signature if public key provided
    {
      for (const cand of candidates) {
        if (verifyClientEcdsaSignature(publicKey, cand, clientSignature.intentCommitment)) {
          isAuthorized = true
          break
        }
      }
    }

    if (!isAuthorized) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_SIGNATURE',
          message: 'Cryptographic intent commitment verification failed. Signature does not match spend parameters or was forged.',
        },
        { status: 401 }
      )
    }

    const expectedZecAmount = Number((numAmount / lockedQuote.zecUsd).toFixed(6))
    if (Number(signedAmountZec.toFixed(6)) !== expectedZecAmount) {
      return NextResponse.json({
        success: false,
        error: 'SIGNED_AMOUNT_QUOTE_MISMATCH',
        message: 'The signed ZEC amount does not match the locked settlement quote.',
      }, { status: 409 })
    }

    if (!persistentStore.claimAuthNonce(tenantId, 'spend', clientSignature.nonce)) {
      return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
    }

    if (!persistentStore.verifySpendSigningKey(tenantId, publicKey)) {
      const juryCookie = req.cookies.get('aura_jury_session')?.value || ''
      const isJuryReviewer = hasJuryAccessForTenant(tenantId, req.headers, juryCookie)
      if (isJuryReviewer) {
        persistentStore.rotateSpendSigningKey(tenantId, publicKey)
      } else {
        return NextResponse.json(
          { success: false, error: 'SIGNING_KEY_MISMATCH', message: 'A different signing key is already bound to this account.' },
          { status: 401 }
        )
      }
    }

    // The per-identity bucket is evaluated only after the signature and the
    // registered spend key have been verified. A caller cannot bypass it by
    // rotating an untrusted public-key value in the request body.
    const rateCheck = paymentLimiter.check(paymentLimiter.getIdentifier(req, publicKey))
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Too many payment authorization calls. Please retry in ${rateCheck.retryAfter} seconds.`,
        },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } }
      )
    }

    await reconcilePendingOperations()

    // No live provider quote is used in this test-only route, so do not deduct
    // a made-up solver/protocol percentage from the demo balance.
    const feeUsd = 0
    const totalRequiredUsd = numAmount

    // 4. ATOMIC BALANCE RESERVATION & RACE CONDITION LOCK (Fixes Issue 9)
    const txType: TransactionType = type === 'withdraw' ? 'withdraw' : 'send'
    const txId = generateSecureId(txType === 'withdraw' ? 'tx_wth' : 'tx_snd')

    const solAmount = chain === 'solana'
      ? lockedQuote.amountSol!
      : numAmount

    const deliveredAsset: AssetSymbol = chain === 'solana' ? 'SOL' : (asset as AssetSymbol)
    const deliveredAmount: number = chain === 'solana' ? solAmount : numAmount

    // Read the live tenant shielded balance before reserving the ledger amount.
    // A recovered tenant may have real Zcash notes while its old browser's
    // ledger row is absent; the confirmed chain amount must still be usable.
    const sharedJuryZcashSource = usesSharedJuryZcashSource(tenantId)
    // Add Money can allocate from the confirmed shared pool, but Pay's visible
    // product route must still create a real Zcash spend. The spend only needs
    // a durably persisted broadcast txid before Solana is attempted; mined
    // confirmation continues asynchronously and must not freeze the jury demo.
    // Keep inventory-only Pay as an explicit operator escape hatch, never as
    // the hosted default.
    const inventoryBackedJuryMode = sharedJuryZcashSource && process.env.AURA_JURY_INVENTORY_ONLY === 'true'
    const tenantZcashAccount = sharedJuryZcashSource
      ? await zcashDevtoolService.getSharedSourceAccount()
      : await zcashDevtoolService.ensureTenantAccount(tenantId)
    const tenantBalanceBeforeReserve = await zcashDevtoolService.getBalance(tenantZcashAccount.accountId).catch(() => null)
    if (!tenantBalanceBeforeReserve?.available) {
      return NextResponse.json(
        {
          success: false,
          error: 'ZCASH_BALANCE_UNAVAILABLE',
          message: 'The confirmed Zcash balance is temporarily unavailable. No funds were reserved and no transaction was sent.',
        },
        { status: 503 },
      )
    }
    const confirmedTenantZec = tenantBalanceBeforeReserve
      ? getShieldedSpendableZec(tenantBalanceBeforeReserve)
      : 0
    const minimumConfirmations = getMinimumConfirmationsForBuffer(bufferMode as string)
    // Live mode needs a fresh shielded destination. Jury mode uses the shared
    // source account but still requires this real destination to be available.
    const realZcashUnified = inventoryBackedJuryMode
      ? undefined
      : (await zcashDevtoolService.listAddresses().catch(() => ({} as { unified?: string }))).unified
    if (!inventoryBackedJuryMode && !realZcashUnified) {
      return NextResponse.json(
        {
          success: false,
          error: 'ZCASH_DESTINATION_UNAVAILABLE',
          message: 'A real Zcash shielded destination could not be prepared. No funds were reserved and no transaction was sent.',
        },
        { status: 503 },
      )
    }
    let actualFeeZec = !inventoryBackedJuryMode && realZcashUnified
      ? await zcashDevtoolService.estimateShieldedFeeZec(tenantZcashAccount.accountId, realZcashUnified, signedAmountZec, minimumConfirmations)
      : null
    // The proposal preview can race with a lightwalletd sync. Retry once, then
    // use only the documented ZIP-317 minimum reserve. The actual wallet send
    // still validates inputs and its exact fee before any destination payout.
    if (actualFeeZec === null && !inventoryBackedJuryMode && zcashDevtoolService.isAvailable() && realZcashUnified) {
      const syncResult = await zcashDevtoolService.sync().catch(() => ({ success: false }))
      if (syncResult.success) {
        actualFeeZec = await zcashDevtoolService.estimateShieldedFeeZec(
          tenantZcashAccount.accountId,
          realZcashUnified,
          signedAmountZec,
          minimumConfirmations,
        )
      }
    }
    const feeReserveZec = inventoryBackedJuryMode ? ZCASH_FEE_RESERVE_ZEC : (actualFeeZec ?? ZCASH_FEE_RESERVE_ZEC)
    const spendableTenantZec = Math.max(0, confirmedTenantZec - feeReserveZec)
    const eligibleTenantBalance = await zcashDevtoolService.getBalance(
      tenantZcashAccount.accountId,
      minimumConfirmations,
    ).catch(() => null)
    const eligibleTenantZec = eligibleTenantBalance?.available
      ? Math.max(0, getShieldedSpendableZec(eligibleTenantBalance) - feeReserveZec)
      : 0
    if (!eligibleTenantBalance?.available || eligibleTenantZec < signedAmountZec) {
      return NextResponse.json({
        success: false,
        error: 'ZCASH_NOTES_NOT_MATURE',
        message: 'The selected Privacy Balance does not yet contain a Zcash note old enough for this payment policy.',
        requiredZec: signedAmountZec,
        eligibleZec: eligibleTenantZec,
        minimumConfirmations,
      }, { status: 409 })
    }
    const confirmedTenantUsd = Number((spendableTenantZec * lockedQuote.zecUsd).toFixed(2))
    const tenantLedger = ledgerService.getTenantBalance(tenantId)
    const maxEntitlementUsd = sharedJuryZcashSource ? tenantLedger.totalUsd : null
    const reconciledTenantBalance = reconcileLedgerBalanceWithShieldedChain(
      tenantLedger,
      confirmedTenantUsd,
      spendableTenantZec,
      lockedQuote.zecUsd,
      eligibleTenantZec,
      maxEntitlementUsd,
    )
    const currentPrivacyRisk = calculatePrivacyRiskSnapshot({
      transactions: ledgerService.getTransactions(tenantId),
      totalBalanceUsd: reconciledTenantBalance.totalUsd,
      amountUsd: numAmount,
      policy: bufferMode as PrivacyBufferMode,
      zecUsd: lockedQuote.zecUsd,
      now: lockedQuote.issuedAt,
    })
    if (currentPrivacyRisk.hash !== lockedQuote.privacyRiskSnapshot.hash) {
      return NextResponse.json({
        success: false,
        error: 'PRIVACY_POLICY_CHANGED',
        message: 'The server-side Privacy Check changed before payment. Request a fresh quote so the policy decision is signed again.',
        privacyRisk: currentPrivacyRisk,
      }, { status: 409 })
    }

    const initialLegs = nearIntentsService.generateRoutingLegs(
      txType,
      'zcash',
      chain as ChainId,
      txId,
      recipient.trim()
    )

    const pendingTx: AuraTransaction = {
      id: txId,
      type: txType,
      status: 'processing',
      fromAsset: (asset as AssetSymbol) || 'USDC',
      fromAmount: numAmount,
      fromChain: 'zcash',
      toAsset: deliveredAsset,
      toAmount: deliveredAmount,
      toChain: chain as ChainId,
      recipientAddress: recipient.trim(),
      bufferMode: (bufferMode as PrivacyBufferMode) || 'private',
      createdAt: Date.now(),
      reservedZec: signedAmountZec,
      settlementMode: inventoryBackedJuryMode ? 'jury_inventory' : 'live_zcash',
      backingSource: inventoryBackedJuryMode ? 'confirmed_zcash_inventory' : undefined,
      legs: initialLegs,
      zkData: nearIntentsService.generateAuditCommitment(clientSignature.intentCommitment),
      feeUsd,
    }

    const reservation = ledgerService.reserveSpend(
      tenantId,
      pendingTx,
      totalRequiredUsd,
      bufferMode as string,
      confirmedTenantUsd,
      spendableTenantZec,
      lockedQuote.zecUsd,
    )
    if (!reservation.success) {
      const isLedgerBusy = reservation.error === 'LEDGER_BUSY'
      return NextResponse.json(
        {
          success: false,
          error: isLedgerBusy ? 'LEDGER_BUSY' : 'INSUFFICIENT_FUNDS',
          message: isLedgerBusy
            ? 'The vault ledger is busy processing another operation. No funds were reserved; retry shortly.'
            : `Insufficient vault balance. You have $${(reservation.availableBalance ?? 0).toFixed(2)} available, but $${totalRequiredUsd.toFixed(2)} is required.`,
          availableBalance: reservation.availableBalance ?? 0,
          requiredAmount: totalRequiredUsd,
        },
        { status: isLedgerBusy ? 503 : 400 }
      )
    }
    reservedSpend = { tenantId, txId, transaction: pendingTx }

    // Consume the quote only after signing-key verification, a successful
    // Zcash balance read, and the atomic ledger reservation. A transient
    // balance/RPC failure therefore leaves the quote retryable.
    if (!settlementQuoteService.consume(quoteId, tenantId)) {
      ledgerService.releaseReservation(tenantId, txId, 'Settlement quote was already consumed before broadcast.')
      reservedSpend = null
      return NextResponse.json({ success: false, error: 'QUOTE_ALREADY_USED', message: 'This settlement quote has already been used. Request a new quote.' }, { status: 409 })
    }

    // 5. SHIELDED AUTHORIZATION & ZCASH SPEND LEG (Executed FIRST)
    let zcashSpendTxid: string | undefined
    let zcashSpendBroadcastUncertain = false
    let zcashSpendConfirmed = false
    let zcashSpendExplorerUrl = realZcashUnified ? `https://testnet.zcashblockexplorer.com/address/${realZcashUnified}` : undefined
    let shieldedSpendError: string | null = null

    if (!inventoryBackedJuryMode) {
      zcashSpendOperationId = `spend-shield:${tenantId}:${txId}`
      persistentStore.savePendingOperation({
      id: zcashSpendOperationId,
      kind: 'spend_shield',
      status: 'prepared',
      tenantId,
      txId,
      createdAt: pendingTx.createdAt,
      updatedAt: pendingTx.createdAt,
      transaction: pendingTx,
      memo: `Aura Spend: ${txId}`,
      amountUsd: numAmount,
      amountZec: signedAmountZec,
      recipientAddress: realZcashUnified,
      })

    // Compute live proportional ZEC based on USD rate
    const proportionalZec = signedAmountZec

    // Attempt real Zcash testnet shielded spend if spendable test ZEC exists
    const isZcashDaemonActive = zcashDevtoolService.isAvailable()

      if (isZcashDaemonActive && realZcashUnified) {
      try {
        const tenantBal = tenantBalanceBeforeReserve
        const canTenantFund = canFundShieldedSend(tenantBal, proportionalZec, actualFeeZec ?? ZCASH_FEE_RESERVE_ZEC)

        if (canTenantFund) {
          const zecToSend = proportionalZec
          const spendSenderAccount = tenantZcashAccount.accountId
          const spendRecipient = realZcashUnified
          const spendRes = await zcashDevtoolService.sendShielded(
            spendRecipient,
            zecToSend,
            `Aura Spend: ${txId}`,
            () => {
              zcashSpendMayHaveBroadcast = true
              persistentStore.updatePendingOperation(zcashSpendOperationId!, { status: 'broadcasting' })
              const current = ledgerService.getTransactionById(txId, tenantId) || pendingTx
              const markedLegs = {
                ...current.legs,
                shielded: current.legs?.shielded ? {
                  ...current.legs.shielded,
                  status: 'broadcasting' as const,
                  description: 'Zcash shielded broadcast is starting; the balance stays reserved until its result is reconciled.',
                } : undefined,
              }
              ledgerService.confirmSpend(tenantId, txId, {
                status: 'routing_shielded',
                legs: markedLegs,
              })
            },
            spendSenderAccount,
            getMinimumConfirmationsForBuffer(bufferMode as string),
          )
          zcashSpendMayHaveBroadcast = Boolean(spendRes.success || spendRes.broadcastUncertain)
          if (spendRes.success && spendRes.txid) {
            zcashSpendTxid = spendRes.txid
            zcashSpendTxidForRecovery = spendRes.txid
            zcashSpendExplorerUrl = `https://testnet.cipherscan.app/tx/${spendRes.txid}`
            zcashSpendExplorerForRecovery = zcashSpendExplorerUrl
            persistentStore.updatePendingOperation(zcashSpendOperationId!, {
              status: 'broadcasted',
              zcashTxid: spendRes.txid,
            })

            const confRes = await zcashDevtoolService.verifyConfirmation(spendRes.txid)
            if (confRes.confirmed) {
              zcashSpendConfirmed = true
              zcashSpendConfirmedForRecovery = true
                persistentStore.updatePendingOperation(zcashSpendOperationId!, { status: 'confirmed' })
            }
          } else {
            zcashSpendBroadcastUncertain = Boolean(spendRes.broadcastUncertain)
            shieldedSpendError = spendRes.error || 'Zcash testnet shielded note spend failed'

            if (zcashSpendBroadcastUncertain && spendRes.txid) {
              zcashSpendTxid = spendRes.txid
              zcashSpendTxidForRecovery = spendRes.txid
              zcashSpendExplorerUrl = `https://testnet.cipherscan.app/tx/${spendRes.txid}`
              zcashSpendExplorerForRecovery = zcashSpendExplorerUrl
              zcashSpendBroadcastUncertain = false
              shieldedSpendError = null
              persistentStore.updatePendingOperation(zcashSpendOperationId!, { status: 'broadcasted', zcashTxid: spendRes.txid })
              const confRes = await zcashDevtoolService.verifyConfirmation(spendRes.txid)
              if (confRes.confirmed) {
                zcashSpendConfirmed = true
                zcashSpendConfirmedForRecovery = true
                persistentStore.updatePendingOperation(zcashSpendOperationId!, { status: 'confirmed' })
              }
            }

            // A timeout or truncated CLI response can arrive just before the
            // wallet transaction record becomes visible. Re-read the exact
            // operation memo once here so the request can continue with the
            // real txid instead of freezing the demo at "verify manually" or
            // risking a duplicate broadcast on retry.
            if (zcashSpendBroadcastUncertain) {
              const recoveredTxid = zcashSpendTxid || await zcashDevtoolService.findBroadcastTxidByMemo(`Aura Spend: ${txId}`)
              if (recoveredTxid) {
                zcashSpendTxid = recoveredTxid
                zcashSpendTxidForRecovery = recoveredTxid
              zcashSpendExplorerUrl = `https://testnet.cipherscan.app/tx/${recoveredTxid}`
                zcashSpendExplorerForRecovery = zcashSpendExplorerUrl
                zcashSpendBroadcastUncertain = false
                shieldedSpendError = null
                persistentStore.updatePendingOperation(zcashSpendOperationId!, {
                  status: 'broadcasted',
                  zcashTxid: recoveredTxid,
                })

                const confRes = await zcashDevtoolService.verifyConfirmation(recoveredTxid)
                if (confRes.confirmed) {
                  zcashSpendConfirmed = true
                  zcashSpendConfirmedForRecovery = true
                  persistentStore.updatePendingOperation(zcashSpendOperationId!, { status: 'confirmed' })
                }
              }
            }
          }
        } else {
          shieldedSpendError = "AURA's Zcash Testnet source is not sufficient for the payment amount and network fee. You do not need to provide ZEC."
        }
      } catch (zErr) {
        shieldedSpendError = zErr instanceof Error ? zErr.message : String(zErr)
        if (isSafeZcashWriteRetry(zErr)) {
          zcashSpendMayHaveBroadcast = false
          zcashSpendBroadcastUncertain = false
        }
      }
      }
    } else {
      // The source proof for this mode is the confirmed shared Zcash
      // inventory read above. No fresh Zcash broadcast is part of the jury
      // payment, so there is deliberately no per-payment Zcash txid.
      zcashSpendConfirmed = true
    }

    if (!zcashSpendTxid && !inventoryBackedJuryMode) {
      if (zcashSpendMayHaveBroadcast || zcashSpendBroadcastUncertain) {
        const pendingLegs = {
          ...initialLegs,
          shielded: initialLegs.shielded ? {
            ...initialLegs.shielded,
            status: 'broadcasting' as const,
            description: 'The Zcash response is uncertain. Aura is recovering the exact broadcast from the durable wallet record; funds remain reserved and no duplicate spend will be attempted.',
          } : undefined,
        }
        const pendingTransaction = ledgerService.confirmSpend(tenantId, txId, {
          status: 'routing_shielded',
          legs: pendingLegs,
        }) || { ...pendingTx, status: 'routing_shielded' as const, legs: pendingLegs }

        return NextResponse.json({
          success: false,
          error: 'SHIELDED_SPEND_BROADCAST_UNCERTAIN',
          message: 'The Zcash transfer result is uncertain. Aura is recovering it automatically from the durable wallet record; funds remain reserved to prevent a duplicate payment.',
          transaction: pendingTransaction,
          pendingConfirmation: true,
        }, { status: 202 })
      }
      if (zcashSpendOperationId) persistentStore.deletePendingOperation(zcashSpendOperationId)
      ledgerService.releaseReservation(tenantId, txId, 'Zcash shielded spend is not confirmed')
      return NextResponse.json(
        { success: false, error: 'SHIELDED_SPEND_UNCONFIRMED', message: 'The Zcash Testnet transfer is not confirmed; no funds were sent to the destination chain.' },
        { status: 502 }
      )
    }

    if (!zcashSpendTxid && !inventoryBackedJuryMode) {
      // A broadcast Zcash spend may still confirm after this request ends. Keep
      // the reservation and transaction pending; releasing it here would let a
      // retry spend the same ledger funds while the first on-chain spend lands.
      const pendingLegs = {
        ...initialLegs,
        shielded: initialLegs.shielded ? {
          ...initialLegs.shielded,
          txHash: zcashSpendTxid,
          explorerUrl: zcashSpendExplorerUrl,
          status: 'broadcasting' as const,
          description: `Shielded spend broadcast to Zcash Testnet (Tx #${zcashSpendTxid!.slice(0, 16)}...). Awaiting confirmation.`,
        } : undefined,
      }
      const pendingTransaction = ledgerService.confirmSpend(tenantId, txId, {
        status: 'routing_shielded',
        legs: pendingLegs,
      }) || { ...pendingTx, status: 'routing_shielded' as const, legs: pendingLegs }
      return NextResponse.json({
        success: true,
         message: 'The Zcash transfer was broadcast but its txid was not recovered. Funds remain reserved and no destination payout was sent.',
        transaction: pendingTransaction,
        pendingConfirmation: true,
      }, { status: 202 })
    }

    // Persist the confirmed source spend before attempting the destination
    // payout. Activity polling may resume settlement, so hold its durable claim
    // until this request has saved the payout hash or a definitive failure.
    settlementClaimed = persistentStore.claimTransactionSettlement(tenantId, txId)
    const sourceConfirmedLegs = {
      ...initialLegs,
      shielded: initialLegs.shielded ? {
        ...initialLegs.shielded,
        txHash: inventoryBackedJuryMode ? undefined : zcashSpendTxid,
        explorerUrl: inventoryBackedJuryMode ? undefined : zcashSpendExplorerUrl,
        status: inventoryBackedJuryMode || zcashSpendConfirmed ? 'confirmed' as const : 'broadcasting' as const,
        description: inventoryBackedJuryMode
          ? 'Backed by AURA’s confirmed shielded Zcash Testnet inventory. Destination payout is pending.'
          : zcashSpendConfirmed
            ? `Shielded spend confirmed on Zcash Testnet (Tx #${zcashSpendTxid!.slice(0, 16)}...). Destination payout is pending.`
            : `Shielded spend broadcast to Zcash Testnet (Tx #${zcashSpendTxid!.slice(0, 16)}...). Destination payout may proceed while confirmation finishes.`,
      } : undefined,
    }
    ledgerService.confirmSpend(tenantId, txId, {
      status: 'routing_shielded',
      legs: sourceConfirmedLegs,
    })
    if (zcashSpendOperationId) persistentStore.deletePendingOperation(zcashSpendOperationId)

    if (!settlementClaimed) {
      zcashSpendMayHaveBroadcast = true
      zcashSpendTxidForRecovery = zcashSpendTxid
      zcashSpendExplorerForRecovery = zcashSpendExplorerUrl
      zcashSpendConfirmedForRecovery = true
      return NextResponse.json({
        success: true,
        message: 'The Zcash source is confirmed. The destination transfer is queued and will be retried safely.',
        transaction: ledgerService.getTransactionById(txId, tenantId) || pendingTx,
        pendingSettlement: true,
      }, { status: 202 })
    }

    const destinationOperationId = destinationOperationIdFor(tenantId, txId)
    const sourceConfirmedTransaction = ledgerService.getTransactionById(txId, tenantId) || pendingTx

    const saveDestinationIntent = async (intent: {
      signature?: string
      recentBlockhash?: string
      senderAddress?: string
      txHash?: string
      nonce?: string
    }) => {
      const operation = persistentStore.savePendingOperation({
        id: destinationOperationId,
        kind: 'destination_payout',
        status: 'prepared',
        tenantId,
        txId,
        createdAt: sourceConfirmedTransaction.createdAt,
        updatedAt: Date.now(),
        transaction: sourceConfirmedTransaction,
        destinationChain: chain as ChainId,
        recipientAddress: recipient.trim(),
        amountUsd: deliveredAmount,
        expectedSignature: intent.signature,
        expectedTxHash: intent.txHash,
        expectedNonce: intent.nonce,
        senderAddress: intent.senderAddress,
        recentBlockhash: intent.recentBlockhash,
      })
      if (!operation) throw new Error('Could not persist the destination payout identity before broadcast.')
      if (!persistentStore.markTransactionSettlementExternalEffectMayHaveStarted(tenantId, txId)) {
        throw new Error('Could not persist the destination payout lock before broadcast.')
      }
      persistentStore.updatePendingOperation(destinationOperationId, { status: 'broadcasting' })
    }

    // Fail-Closed Gate: If on-chain Zcash spend was attempted and failed, ABORT relayer payout immediately!
    if (shieldedSpendError) {
      ledgerService.releaseReservation(tenantId, txId, shieldedSpendError)
      return NextResponse.json(
        {
          success: false,
          error: 'SHIELDED_SPEND_FAILED',
          message: `Shielded vault authorization failed: ${shieldedSpendError}. Destination relayer payout was aborted to prevent loss of funds.`,
        },
        { status: 502 }
      )
    }

    // 6. PUBLIC TESTNET RELAYER PAYOUT (Executed SECOND - after shielded intent is authorized)
    let txStatus: TransactionStatus = 'settling_destination'
    let isDeliveredOnChain = false
    let deliveryFailedOnChain = false
    let finalTxHash: string | undefined

    let broadcastError: string | null = null

    // Automatic testnet relayer payout for Solana destination
    if (!finalTxHash && chain === 'solana') {
      try {
        const relayerResult = await solanaRelayer.sendSol(recipient.trim(), solAmount, saveDestinationIntent)
        if (relayerResult.success && relayerResult.signature) {
          finalTxHash = relayerResult.signature
          destinationHashForRecovery = finalTxHash
          txStatus = 'settling_destination'
          isDeliveredOnChain = false
        } else if (relayerResult.broadcastUncertain && relayerResult.signature) {
          finalTxHash = relayerResult.signature
          destinationHashForRecovery = finalTxHash
          txStatus = 'settling_destination'
          broadcastError = relayerResult.error || 'Solana broadcast result is uncertain; monitoring its signature.'
        } else {
          broadcastError = relayerResult.error || 'Solana Devnet relayer broadcast failed'
        }
      } catch (err: unknown) {
        broadcastError = err instanceof Error ? err.message : String(err)
        console.warn('Solana relayer broadcast error:', err)
      }
    }

    // Automatic testnet relayer payout for Base Sepolia destination
    if (!finalTxHash && chain === 'base') {
      try {
        const relayerResult = await baseRelayer.sendUsdc(recipient.trim(), numAmount, saveDestinationIntent)
        if (relayerResult.success && relayerResult.txHash) {
          finalTxHash = relayerResult.txHash
          destinationHashForRecovery = finalTxHash
          txStatus = 'settling_destination'
          isDeliveredOnChain = false
        } else if (relayerResult.broadcastUncertain && relayerResult.txHash) {
          finalTxHash = relayerResult.txHash
          destinationHashForRecovery = finalTxHash
          txStatus = 'settling_destination'
          broadcastError = relayerResult.message || 'Base broadcast result is uncertain; monitoring its predicted hash.'
        } else if (relayerResult.insufficientGas) {
          broadcastError = relayerResult.message || 'Base Sepolia relayer has insufficient ETH for gas'
        } else {
          broadcastError = relayerResult.error || 'Base Sepolia relayer broadcast failed'
        }
      } catch (err: unknown) {
        broadcastError = err instanceof Error ? err.message : String(err)
        console.warn('Base Sepolia relayer broadcast error:', err)
      }
    }

    if (!finalTxHash && zcashSpendTxid) {
      // Once a real Zcash txid exists, its source effect is irreversible even
      // while confirmation is pending. Keep the reservation and let the
      // destination reconciliation retry; never release into a double-spend.
      const pendingLegs = {
        ...initialLegs,
        shielded: initialLegs.shielded ? {
          ...initialLegs.shielded,
          txHash: zcashSpendTxid,
          explorerUrl: zcashSpendExplorerUrl,
          status: zcashSpendConfirmed ? 'confirmed' as const : 'broadcasting' as const,
          description: zcashSpendConfirmed
            ? `Shielded spend confirmed on Zcash Testnet (Tx #${zcashSpendTxid.slice(0, 16)}...). Destination payout is pending.`
            : `Shielded spend broadcast to Zcash Testnet (Tx #${zcashSpendTxid.slice(0, 16)}...). Destination payout is pending while confirmation finishes.`,
        } : undefined,
        delivery: initialLegs.delivery ? {
          ...initialLegs.delivery,
          status: 'failed' as const,
          description: broadcastError || 'Destination payout is pending; Aura will retry when the relayer is available.',
        } : undefined,
      }
      const pendingTransaction = ledgerService.confirmSpend(tenantId, txId, {
        status: 'routing_shielded',
        legs: pendingLegs,
      }) || { ...pendingTx, status: 'routing_shielded' as const, legs: pendingLegs }
      if (settlementClaimed && !persistentStore.transactionSettlementExternalEffectMayHaveStarted(tenantId, txId)) {
        persistentStore.releaseTransactionSettlement(tenantId, txId)
        settlementClaimed = false
      }
      return NextResponse.json({
        success: true,
        message: zcashSpendConfirmed
          ? 'Zcash source spend is confirmed. The destination payout is queued for retry; the balance remains reserved.'
          : 'Zcash source spend is broadcast. The destination payout is queued for retry; the balance remains reserved while confirmation finishes.',
        transaction: pendingTransaction,
        pendingSettlement: true,
        relayerError: broadcastError || undefined,
      }, { status: 202 })
    }

    if (!finalTxHash) {
      ledgerService.releaseReservation(tenantId, txId, broadcastError || 'Relayer broadcast failed')
      return NextResponse.json(
        {
          success: false,
          error: 'RELAYER_BROADCAST_FAILED',
          message: broadcastError || 'Failed to broadcast settlement payout on destination chain. Your private vault balance was not debited.',
        },
        { status: 502 }
      )
    }

    if (finalTxHash) {
      if (chain === 'solana') {
        try {
          const sig = await solanaRelayer.getSignatureStatus(finalTxHash)
          if (isFinalizedSolanaSignatureStatus(sig)) {
            txStatus = 'completed'
            isDeliveredOnChain = true
          } else if (sig?.err) {
            txStatus = 'failed'
            isDeliveredOnChain = false
            deliveryFailedOnChain = true
          }
        } catch (err) {
          console.warn('Solana Devnet spend verification delayed:', err)
        }
      } else if (chain === 'base') {
        try {
          const receipt = await baseRelayer.getTransactionReceipt(finalTxHash)
          const finality = receipt?.status === '0x1'
            ? await baseRelayer.verifyReceiptFinality(finalTxHash, receipt)
            : { confirmed: false }
          if (finality.confirmed) {
            txStatus = 'completed'
            isDeliveredOnChain = true
          } else if (receipt?.status === '0x0') {
            txStatus = 'failed'
            isDeliveredOnChain = false
            deliveryFailedOnChain = true
          }
        } catch (err) {
          console.warn('Base Sepolia spend verification delayed:', err)
        }
      }
    }

    if (deliveryFailedOnChain && zcashSpendTxid) {
      // A failed destination attempt cannot release funds after the Zcash
      // source spend has been broadcast.
      txStatus = 'routing_shielded'
    }

    const legs = nearIntentsService.generateRoutingLegs(
      txType,
      'zcash',
      chain as ChainId,
      txId,
      recipient.trim(),
      finalTxHash,
      zcashSpendTxid
    )

    if (legs.shielded) {
      legs.shielded.destinationAddress = realZcashUnified || undefined
      legs.shielded.txHash = zcashSpendTxid || undefined
      legs.shielded.explorerUrl = zcashSpendTxid ? zcashSpendExplorerUrl : undefined
      if (zcashSpendTxid) {
        legs.shielded.status = zcashSpendConfirmed ? 'confirmed' : 'broadcasting'
        legs.shielded.description = zcashSpendConfirmed
          ? `Shielded spend transaction confirmed on Zcash Testnet (Tx #${zcashSpendTxid.slice(0, 16)}...)`
          : `Shielded spend transaction broadcast to Zcash mempool (Tx #${zcashSpendTxid.slice(0, 16)}...). Awaiting block confirmation.`
      } else {
        legs.shielded.status = inventoryBackedJuryMode ? 'confirmed' : 'enclave_authorized'
        legs.shielded.description = inventoryBackedJuryMode
          ? 'Backed by AURA’s confirmed shielded Zcash Testnet inventory.'
          : `Shielded spend authorized via client enclave intent commitment (${tenantId.slice(0, 16)}...)`
      }
    }

    if (legs.delivery) {
      legs.delivery.status = isDeliveredOnChain ? 'confirmed' : deliveryFailedOnChain ? 'failed' : 'pending'
      legs.delivery.confirmationStatus = isDeliveredOnChain
        ? chain === 'solana' ? 'finalized' : 'confirmed'
        : undefined
      if (isDeliveredOnChain) {
        legs.delivery.description = chain === 'solana'
          ? `Delivered ${deliveredAmount} SOL on Solana Devnet to ${recipient.trim().slice(0, 8)}...`
          : `Delivered $${deliveredAmount.toFixed(2)} ${deliveredAsset} on Base Sepolia to ${recipient.trim().slice(0, 8)}...`
      } else if (deliveryFailedOnChain) {
        legs.delivery.description = `Destination payout failed on ${chain}; the source spend remains reserved for retry.`
      } else {
        legs.delivery.description = `Queued for testnet relayer payout to ${recipient.trim().slice(0, 8)}...`
      }
    }

    const tx: AuraTransaction = {
      id: txId,
      type: txType,
      status: txStatus,
      fromAsset: asset as AssetSymbol,
      fromAmount: numAmount,
      fromChain: 'zcash',
      toAsset: deliveredAsset,
      toAmount: deliveredAmount,
      toChain: chain as ChainId,
      recipientAddress: recipient.trim(),
      bufferMode: bufferMode as PrivacyBufferMode,
      createdAt: Date.now(),
      completedAt: txStatus === 'completed' ? Date.now() : undefined,
      settlementMode: inventoryBackedJuryMode ? 'jury_inventory' : 'live_zcash',
      backingSource: inventoryBackedJuryMode ? 'confirmed_zcash_inventory' : undefined,
      legs,
      zkData: nearIntentsService.generateAuditCommitment(clientSignature.intentCommitment),
      feeUsd,
    }

    persistentStore.updatePendingOperation(destinationOperationId, {
      status: finalTxHash && !isDeliveredOnChain && !deliveryFailedOnChain
        ? 'broadcasted'
        : deliveryFailedOnChain
          ? 'recovery_required'
          : isDeliveredOnChain
            ? 'confirmed'
            : 'recovery_required',
      expectedSignature: chain === 'solana' ? finalTxHash : undefined,
      expectedTxHash: chain === 'base' ? finalTxHash : undefined,
      transaction: tx,
    })

    // 6. CONFIRM IN TENANT'S PRIVATE LEDGER
    const confirmedTx = ledgerService.confirmSpend(tenantId, txId, tx) || tx
    const updatedBalance = ledgerService.getTenantBalance(tenantId)
    if (settlementClaimed && (isDeliveredOnChain || deliveryFailedOnChain)) {
      persistentStore.deletePendingOperation(destinationOperationId)
      persistentStore.releaseTransactionSettlement(tenantId, txId)
      settlementClaimed = false
    }

    return NextResponse.json({
      success: true,
      message: `${txType === 'withdraw' ? 'Withdrawal' : 'Private send'} intent authorized and queued in testnet settlement pipeline.`,
      transaction: confirmedTx,
      feeUsd,
      remainingBalance: updatedBalance.totalUsd,
    })
  } catch (error) {
    if (settlementClaimed && reservedSpend && !persistentStore.transactionSettlementExternalEffectMayHaveStarted(reservedSpend.tenantId, reservedSpend.txId)) {
      persistentStore.releaseTransactionSettlement(reservedSpend.tenantId, reservedSpend.txId)
      settlementClaimed = false
    }
    if (reservedSpend) {
      try {
        if (!zcashSpendMayHaveBroadcast) {
          ledgerService.releaseReservation(
            reservedSpend.tenantId,
            reservedSpend.txId,
            'Request failed before a Zcash broadcast was accepted.'
          )
        } else {
          const priorLegs = reservedSpend.transaction.legs
          const recoveredTx: AuraTransaction = {
            ...reservedSpend.transaction,
            status: destinationHashForRecovery ? 'settling_destination' : 'routing_shielded',
            legs: {
              ...priorLegs,
              shielded: priorLegs?.shielded ? {
                ...priorLegs.shielded,
                txHash: zcashSpendTxidForRecovery,
                explorerUrl: zcashSpendExplorerForRecovery,
                status: zcashSpendConfirmedForRecovery ? 'confirmed' : 'broadcasting',
                description: zcashSpendConfirmedForRecovery
                  ? 'Zcash source spend confirmed; payout state saved after an interrupted request.'
                  : 'Zcash broadcast may have reached the network; the balance remains reserved for reconciliation.',
              } : undefined,
              delivery: priorLegs?.delivery ? {
                ...priorLegs.delivery,
                txHash: destinationHashForRecovery,
                status: destinationHashForRecovery ? 'broadcasting' : 'pending',
                description: destinationHashForRecovery
                  ? 'Destination transaction was broadcast; confirmation is required before retry.'
                  : 'No destination receipt was recorded; the source spend remains reserved for reconciliation.',
              } : undefined,
            },
          }
          ledgerService.confirmSpend(reservedSpend.tenantId, reservedSpend.txId, recoveredTx)
        }
      } catch (recoveryError) {
        console.error('Could not persist interrupted spend recovery state:', recoveryError)
      }
    }
    return NextResponse.json(
      { success: false, error: 'SERVER_ERROR', message: 'Failed to process spend transaction' },
      { status: 500 }
    )
  }
}
