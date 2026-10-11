import { NextRequest, NextResponse } from 'next/server'
import { ledgerService } from '@/lib/services/ledger-service'
import { persistentStore } from '@/lib/services/persistent-store'
import { nearIntentsService } from '@/lib/services/near-intents-service'
import { AssetSymbol, AuraTransaction, ChainId, PrivacyBufferMode } from '@/lib/types/aura'
import { globalPaymentLimiter, isSharedUnauthenticatedIdentifier, paymentLimiter } from '@/lib/utils/rate-limiter'
import { generateSecureId, validateSolanaAddress } from '@/lib/utils'
import { baseRelayer, createBaseDepositProofMessage } from '@/lib/crypto/base-relayer'
import { solanaRelayer } from '@/lib/crypto/solana-relayer'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { ratesService } from '@/lib/services/rates-service'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { canonicalizeChainAddress, canonicalizeTransactionHash } from '@/lib/crypto/payment-authorization'
import { canFundShieldedSend, getShieldedSpendableZec, ZCASH_FEE_RESERVE_ZEC } from '@/lib/services/zcash-balance'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { reconcilePendingOperations } from '@/lib/services/pending-operation-reconciler'
import { getSharedJuryEntitlementUsd, usesSharedJuryZcashSource } from '@/lib/services/jury-zcash-source'

export async function POST(req: NextRequest) {
  const productionBlock = getProductionExecutionBlock('deposit')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  let claimedTxHash: string | undefined
  let zcashPayoutMayHaveBroadcast = false
  let recoveryTransaction: { tenantId: string; transaction: AuraTransaction } | undefined
  let pendingShieldOperationId: string | undefined
  try {
    // Section 14: Rate limiting enforcement
    const globalRateCheck = globalPaymentLimiter.check('global')
    if (!globalRateCheck.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED', message: 'Too many deposit requests. Please retry later.' }, {
        status: 429,
        headers: { 'Retry-After': String(globalRateCheck.retryAfter || 60) },
      })
    }
    const identifier = paymentLimiter.getIdentifier(req)
    const rateCheck = paymentLimiter.check(identifier)
    if (!isSharedUnauthenticatedIdentifier(identifier) && !rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'RATE_LIMIT_EXCEEDED',
          message: `Too many deposit requests. Please retry in ${rateCheck.retryAfter} seconds.`,
        },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } }
      )
    }
    await reconcilePendingOperations()

    const body = await req.json().catch(() => ({}))
    const {
      asset = 'USDC',
      amount,
      chain = 'base',
      type = 'deposit',
      recipientAddress,
      enclaveFingerprint,
      bufferMode = 'private',
      onChainTxHash,
      clientSignature,
    } = body

    const headerTenant = req.headers.get('x-aura-enclave-fingerprint')
    if (enclaveFingerprint && headerTenant && enclaveFingerprint !== headerTenant) {
      return NextResponse.json({ success: false, error: 'TENANT_MISMATCH' }, { status: 401 })
    }
    const tenantId = enclaveFingerprint || headerTenant
    if (typeof tenantId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId)) {
      return NextResponse.json({ success: false, error: 'TENANT_REQUIRED' }, { status: 401 })
    }

    const numAmount = Number(amount)
    if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 1_000_000) {
      return NextResponse.json(
        { success: false, error: 'INVALID_AMOUNT', message: 'Invalid deposit amount.' },
        { status: 400 }
      )
    }
    if (Math.abs(numAmount * 100 - Math.round(numAmount * 100)) > 1e-7) {
      return NextResponse.json({ success: false, error: 'INVALID_AMOUNT_PRECISION', message: 'Deposit amount must use no more than two decimal places.' }, { status: 400 })
    }

    if (chain !== 'base') {
      return NextResponse.json(
        {
          success: false,
          error: 'UNSUPPORTED_CHAIN',
          message: `The active public-entry route starts on Base Sepolia. Chain '${chain}' is not supported for deposits.`,
        },
        { status: 400 }
      )
    }
    if (asset !== 'USDC') {
      return NextResponse.json({ success: false, error: 'ROUTE_NOT_ENABLED', message: 'The working demo accepts Base Sepolia USDC entry only. Other assets are roadmap routes.' }, { status: 400 })
    }
    if (type !== 'deposit' && type !== 'receive') {
      return NextResponse.json({ success: false, error: 'INVALID_TYPE', message: 'Unsupported deposit type.' }, { status: 400 })
    }

    // Cryptographically secure transaction ID (Section 13)
    const isReceive = type === 'receive'
    const txId = generateSecureId(isReceive ? 'tx_rec' : 'tx_dep')

    // A deposit is accepted only with a transaction hash from the payer's wallet.
    let txStatus: 'completed' | 'processing' | 'failed' | 'routing_shielded' = 'processing'
    let isConfirmedOnChain = false
    let finalTxHash = onChainTxHash

    if (!finalTxHash || typeof finalTxHash !== 'string') {
      return NextResponse.json(
        { success: false, error: 'ONCHAIN_TX_REQUIRED', message: 'Use your connected wallet to send the payment, then provide its transaction hash.' },
        { status: 400 }
      )
    }

    const validHash = chain === 'base'
      ? /^0x[0-9a-fA-F]{64}$/.test(finalTxHash)
      : /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(finalTxHash)
    if (!validHash) {
      return NextResponse.json({ success: false, error: 'INVALID_TX_HASH', message: 'Transaction hash format is invalid.' }, { status: 400 })
    }
    const canonicalTxHash = canonicalizeTransactionHash(chain, finalTxHash)

    const signature = clientSignature
    if (
      !signature || signature.enclaveFingerprint !== tenantId ||
      signature.amountUsd !== numAmount || signature.asset !== asset || signature.chain !== chain ||
      typeof signature.amountOnChain !== 'number' || !Number.isFinite(signature.amountOnChain) || signature.amountOnChain <= 0 ||
      signature.txHash !== canonicalTxHash || typeof signature.senderAddress !== 'string' ||
      !(chain === 'base' ? /^0x[a-fA-F0-9]{40}$/.test(signature.senderAddress) : validateSolanaAddress(signature.senderAddress)) ||
      typeof signature.clientTimestamp !== 'number' || Math.abs(Date.now() - signature.clientTimestamp) > 5 * 60 * 1000 ||
      typeof signature.nonce !== 'string' || !/^[a-f0-9]{32}$/i.test(signature.nonce) ||
      typeof signature.authPublicKey !== 'string' || typeof signature.signature !== 'string'
    ) {
      return NextResponse.json({ success: false, error: 'INVALID_DEPOSIT_AUTHORIZATION' }, { status: 401 })
    }
    const canonicalSender = canonicalizeChainAddress(chain, signature.senderAddress)
    const signedPayload = `${tenantId}:deposit:${numAmount.toFixed(2)}:${signature.amountOnChain}:${asset}:${chain}:${canonicalTxHash}:${canonicalSender}:${signature.clientTimestamp}:${signature.nonce}`
    if (
      !verifyClientEcdsaSignature(signature.authPublicKey, signedPayload, signature.signature) ||
      !persistentStore.verifySpendSigningKey(tenantId, signature.authPublicKey)
    ) {
      return NextResponse.json({ success: false, error: 'INVALID_DEPOSIT_SIGNATURE' }, { status: 401 })
    }

    // Check the durable ledger before claiming the hash as well as after a
    // claim collision. A stale claim can be recovered after a restart; the
    // ledger/pending operation must still win so the same Base payment can
    // never create a second entitlement.
    const existingLedgerTx = ledgerService.getTransactions(tenantId).find((candidate) =>
      candidate.legs?.deposit?.txHash?.toLowerCase() === canonicalTxHash.toLowerCase() ||
      candidate.legs?.deposit?.txHash?.toLowerCase() === finalTxHash.toLowerCase() ||
      candidate.id === finalTxHash
    )
    if (existingLedgerTx) {
      return NextResponse.json({
        success: true,
        message: existingLedgerTx.status === 'completed'
          ? 'Deposit verified and allocated to the private balance.'
          : 'Deposit verified on the source chain; private backing is still pending.',
        transaction: existingLedgerTx,
        creditedAmount: existingLedgerTx.status === 'completed' ? existingLedgerTx.toAmount : 0,
        pendingAmount: existingLedgerTx.status === 'completed' ? 0 : existingLedgerTx.toAmount,
        feeUsd: existingLedgerTx.feeUsd || 0,
        newVaultBalance: ledgerService.getTenantBalance(tenantId).totalUsd,
      })
    }
    if (!persistentStore.claimPaymentTxHash(finalTxHash)) {
      const existingTxs = ledgerService.getTransactions(tenantId)
      const existing = existingTxs.find((t) =>
        t.legs?.deposit?.txHash?.toLowerCase() === canonicalTxHash.toLowerCase() ||
        t.legs?.deposit?.txHash?.toLowerCase() === finalTxHash.toLowerCase() ||
        t.id === finalTxHash
      )
      if (existing) {
        return NextResponse.json({
          success: true,
          message: existing.status === 'completed'
            ? 'Deposit verified and shielded into the private vault.'
            : 'Deposit verified on the source chain; waiting for Zcash confirmation.',
          transaction: existing,
          creditedAmount: existing.status === 'completed' ? existing.toAmount : 0,
          pendingAmount: existing.status === 'completed' ? 0 : existing.toAmount,
          feeUsd: existing.feeUsd || 0,
          newVaultBalance: ledgerService.getTenantBalance(tenantId).totalUsd,
        })
      }
      const pendingOps = persistentStore.listPendingOperations()
      const pendingOp = pendingOps.find((op) =>
        (op.kind === 'deposit_shield' || op.kind === 'deposit_backing') &&
        (op.sourceTxHash || op.paymentTxHash || '').toLowerCase() === finalTxHash.toLowerCase()
      )
      if (pendingOp?.transaction) {
        const tx = pendingOp.transaction
        return NextResponse.json({
          success: true,
          message: pendingOp.kind === 'deposit_backing'
            ? 'Deposit verified on the source chain; waiting for confirmed Zcash pool capacity.'
            : 'Deposit verified on the source chain; waiting for Zcash confirmation.',
          transaction: tx,
          creditedAmount: 0,
          pendingAmount: tx.toAmount,
          feeUsd: tx.feeUsd || 0,
          newVaultBalance: ledgerService.getTenantBalance(tenantId).totalUsd,
        })
      }
      return NextResponse.json({ success: false, error: 'TX_ALREADY_USED', message: 'This transaction is already being processed or has already been credited.' }, { status: 409 })
    }
    claimedTxHash = finalTxHash
    const zecRate = await ratesService.getFreshRate('ZEC')
    if (!zecRate) {
      persistentStore.releasePaymentTxHash(finalTxHash)
      claimedTxHash = undefined
      return NextResponse.json({
        success: false,
        error: 'LIVE_RATE_UNAVAILABLE',
        message: 'The exact amount is temporarily unavailable. The payment was not credited; try the same transfer again later.',
      }, { status: 503 })
    }
    let settledAmountUsd = 0

      if (chain === 'base') {
        const vaultAddr = process.env.VAULT_DEPOSIT_ADDRESS || '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e'
        const expectedChainAmount = signature.amountOnChain
        // Base Sepolia is an L2 testnet where blocks confirm in 2-3 seconds.
        // Waiting for Ethereum L1 finalization takes 15-20 minutes and blocks live testing.
        // We require valid receipt status 0x1 and canonical block inclusion immediately.
        const requireFinalized = process.env.AURA_ENFORCE_L1_FINALITY === '1'
        const baseVerification = await baseRelayer.verifyDeposit(
          finalTxHash,
          vaultAddr,
          expectedChainAmount,
          asset,
          { requireFinalized },
        )

        if (baseVerification.reverted) {
          persistentStore.releasePaymentTxHash(finalTxHash)
          claimedTxHash = undefined
          return NextResponse.json(
            {
              success: false,
              error: 'ONCHAIN_TX_REVERTED',
              message: 'Base Sepolia deposit transaction failed or reverted on-chain.',
            },
            { status: 400 }
          )
        }

        if (baseVerification.error === 'BASE_RPC_UNAVAILABLE' || baseVerification.error === 'WRONG_SOURCE_CHAIN') {
          persistentStore.releasePaymentTxHash(finalTxHash)
          claimedTxHash = undefined
          return NextResponse.json({
            success: false,
            error: baseVerification.error,
            message: 'Aura cannot verify this payment on Base Sepolia right now. No vault credit was recorded; do not send another payment until the network is ready.',
          }, { status: 503 })
        }

        if (baseVerification.error === 'DEPOSIT_REQUIREMENTS_NOT_MET') {
          persistentStore.releasePaymentTxHash(finalTxHash)
          claimedTxHash = undefined
          return NextResponse.json(
            {
              success: false,
              error: 'INVALID_DEPOSIT_TRANSACTION',
              message: `Transaction verified on Base Sepolia, but does NOT contain a valid ${asset} transfer of at least $${numAmount} to the Aura vault (${vaultAddr.slice(0, 10)}...). Arbitrary or mismatched transaction hashes cannot be credited.`,
            },
            { status: 400 }
          )
        }

        if (!baseVerification.verified) {
          persistentStore.releasePaymentTxHash(finalTxHash)
          claimedTxHash = undefined
          const pendingFinality = baseVerification.error === 'BASE_TX_NOT_FINALIZED'
          return NextResponse.json({
            success: false,
            error: pendingFinality ? 'BASE_TX_NOT_FINALIZED' : 'TX_NOT_CONFIRMED',
            message: pendingFinality
              ? 'The Base Sepolia deposit is mined and safe, but its block is not finalized yet. Aura will keep checking this same transaction before shielding.'
              : 'The source-chain payment is not confirmed yet. Aura will keep checking this same transaction before shielding.',
          }, { status: 425 })
        }
        if (baseVerification.sender?.toLowerCase() !== signature.senderAddress.toLowerCase()) {
          persistentStore.releasePaymentTxHash(finalTxHash)
          claimedTxHash = undefined
          return NextResponse.json({ success: false, error: 'TX_SENDER_MISMATCH' }, { status: 400 })
        }
        const demoSender = (() => { try { return baseRelayer.getAddress().toLowerCase() } catch { return '' } })()
        const isSponsoredDemoDeposit = demoSender && canonicalSender === demoSender
        if (isSponsoredDemoDeposit) {
          const binding = persistentStore.getDemoDepositBinding(finalTxHash)
          if (!binding || binding.tenantId !== tenantId || binding.senderAddress !== demoSender || Math.abs(binding.amountUsd - numAmount) > 0.01) {
            persistentStore.releasePaymentTxHash(finalTxHash)
            claimedTxHash = undefined
            return NextResponse.json({ success: false, error: 'DEMO_DEPOSIT_TENANT_MISMATCH', message: 'This sponsored transfer is bound to a different Aura tenant.' }, { status: 403 })
          }
        } else {
          const proofMessage = typeof signature.baseWalletMessage === 'string' ? signature.baseWalletMessage : ''
          const proofSignature = typeof signature.baseWalletSignature === 'string' ? signature.baseWalletSignature : ''
          const expectedProofMessage = createBaseDepositProofMessage({
            tenantId,
            amountUsd: numAmount,
            amountOnChain: signature.amountOnChain,
            asset,
            chain,
            txHash: canonicalTxHash,
            senderAddress: canonicalSender,
          })
          if (!proofMessage || proofMessage !== expectedProofMessage || !(await baseRelayer.verifyWalletSignature(canonicalSender, proofMessage, proofSignature))) {
            persistentStore.releasePaymentTxHash(finalTxHash)
            claimedTxHash = undefined
            return NextResponse.json({ success: false, error: 'BASE_WALLET_PROOF_REQUIRED', message: 'The connected Base wallet or contract wallet must approve this exact deposit proof.' }, { status: 401 })
          }
        }
        const actualAmount = baseVerification.amountTransferred || 0
        settledAmountUsd = actualAmount
        isConfirmedOnChain = true
      }
    if (!Number.isFinite(settledAmountUsd) || settledAmountUsd <= 0) {
      persistentStore.releasePaymentTxHash(finalTxHash)
      claimedTxHash = undefined
      return NextResponse.json({ success: false, error: 'INVALID_SETTLEMENT_AMOUNT' }, { status: 400 })
    }
    // This test-only route has no live swap/solver quote. Do not charge a
    // fabricated percentage; credit the verified source value after shielding.
    const feeUsd = 0
    const netCreditUsd = Number(settledAmountUsd.toFixed(2))
    let tenantZcashAccount: { accountId: string; unified: string }
    const sharedZcashSource = usesSharedJuryZcashSource(tenantId)
    try {
      tenantZcashAccount = sharedZcashSource
        ? await zcashDevtoolService.getSharedSourceAccount()
        : await zcashDevtoolService.ensureTenantAccount(tenantId)
    } catch (accountError) {
      persistentStore.releasePaymentTxHash(finalTxHash)
      claimedTxHash = undefined
      console.warn('Could not resolve tenant Zcash Testnet account:', accountError)
      return NextResponse.json({
        success: false,
        error: 'PRIVATE_ACCOUNT_UNAVAILABLE',
        message: 'AURA-operated Zcash private state is unavailable. The confirmed Base transfer was not credited; retry the same transfer when Zcash Testnet is ready.',
      }, { status: 503 })
    }
    const realZcashUnified = tenantZcashAccount.unified

    let zcashTxid: string | undefined
    let zcashConfirmed = false
    let zcashBroadcastUncertain = false
    let shieldFailureStage = 'SOURCE_BALANCE_UNAVAILABLE'
    let zcashExplorerUrl = `https://testnet.zcashblockexplorer.com/address/${realZcashUnified}`

    // Compute live proportional ZEC based on USD rate
    const proportionalZec = Number((settledAmountUsd / zecRate.usdPrice).toFixed(6))

    if (sharedZcashSource) {
      // Jury deposits allocate against the already confirmed shared Zcash
      // inventory. This is a real chain-backed entitlement credit; it does
      // not pretend that a new Zcash tx was created for every Base deposit.
      const sourceBalance = await zcashDevtoolService.getBalance(tenantZcashAccount.accountId).catch(() => null)
      const sourceZec = sourceBalance ? getShieldedSpendableZec(sourceBalance) : 0
      const sourceCapacityUsd = Number(Math.max(0, sourceZec - ZCASH_FEE_RESERVE_ZEC).toFixed(6)) * zecRate.usdPrice
      if (!sourceBalance?.available || !Number.isFinite(sourceCapacityUsd)) {
        persistentStore.releasePaymentTxHash(finalTxHash)
        claimedTxHash = undefined
        return NextResponse.json({
          success: false,
          error: 'JURY_INVENTORY_UNAVAILABLE',
          message: 'AURA confirmed Zcash inventory is not large enough for this entitlement yet. No Base deposit was credited.',
        }, { status: 503 })
      }

      const legs = nearIntentsService.generateRoutingLegs(
        isReceive ? 'receive' : 'deposit',
        chain as ChainId,
        'zcash',
        txId,
        recipientAddress || tenantZcashAccount.unified,
        finalTxHash,
        undefined,
      )
      if (legs.deposit) {
        legs.deposit.status = 'confirmed'
        legs.deposit.description = `Deposited $${settledAmountUsd.toFixed(2)} ${asset} on Base Sepolia (Confirmed on-chain)`
      }
      if (legs.shielded) {
        legs.shielded.status = 'confirmed'
        legs.shielded.txHash = undefined
        legs.shielded.explorerUrl = undefined
        legs.shielded.destinationAddress = tenantZcashAccount.unified
        legs.shielded.description = 'Backed by AURA’s confirmed shielded Zcash Testnet inventory.'
      }
      const tx: AuraTransaction = {
        id: txId,
        type: isReceive ? 'receive' : 'deposit',
        status: 'completed',
        fromAsset: asset as AssetSymbol,
        fromAmount: settledAmountUsd,
        fromChain: chain as ChainId,
        toAsset: asset as AssetSymbol,
        toAmount: netCreditUsd,
        toChain: 'zcash',
        recipientAddress: isReceive ? (recipientAddress || 'aura.money/gio') : undefined,
        bufferMode: (bufferMode as PrivacyBufferMode) || 'private',
        createdAt: Date.now(),
        completedAt: Date.now(),
        backingZec: proportionalZec,
        settlementMode: 'jury_inventory',
        backingSource: 'confirmed_zcash_inventory',
        legs,
        zkData: nearIntentsService.generateAuditCommitment(txId),
        feeUsd,
      }
      type SharedPoolAllocation = { allocated: boolean; tx: AuraTransaction | null; balanceBeforeUsd: number; balanceAfterUsd: number }
      const allocation = persistentStore.mutateLedger<SharedPoolAllocation>((ledger) => {
        const tenantTransactions = Array.isArray(ledger[tenantId]) ? ledger[tenantId] : []
        const existing = tenantTransactions.find((candidate) => candidate.id === txId)
        if (existing) {
          return {
            ledger,
            result: {
              allocated: true,
              tx: existing,
              balanceBeforeUsd: Math.max(0, existing.balanceCheckpoint?.beforeUsd || 0),
              balanceAfterUsd: ledgerService.getTenantBalance(tenantId).totalUsd,
            },
          }
        }

        const existingEntitlementUsd = getSharedJuryEntitlementUsd(ledgerService, persistentStore.listPendingOperations())
        if (existingEntitlementUsd + netCreditUsd > sourceCapacityUsd + 1e-9) {
          return { ledger, result: { allocated: false, tx: null, balanceBeforeUsd: 0, balanceAfterUsd: 0 } }
        }

        const balanceBeforeUsd = ledgerService.getTenantBalance(tenantId).totalUsd
        const allocatedTx: AuraTransaction = {
          ...tx,
          balanceCheckpoint: {
            beforeUsd: balanceBeforeUsd,
            afterUsd: Number((balanceBeforeUsd + netCreditUsd).toFixed(2)),
            deltaUsd: netCreditUsd,
            capturedAt: Date.now(),
          },
        }
        ledger[tenantId] = [allocatedTx, ...tenantTransactions]
        return {
          ledger,
          result: {
            allocated: true,
            tx: allocatedTx,
            balanceBeforeUsd,
            balanceAfterUsd: Number((balanceBeforeUsd + netCreditUsd).toFixed(2)),
          },
        }
      })

      if (!allocation.allocated || !allocation.tx) {
        const pendingShieldedLeg = legs.shielded ? {
          ...legs.shielded,
          status: 'pending' as const,
          txHash: undefined,
          explorerUrl: undefined,
          description: 'Base deposit is confirmed; waiting for confirmed shared Zcash pool capacity before crediting Private Balance.',
        } : undefined
        const pendingTransaction: AuraTransaction = {
          ...tx,
          status: 'processing',
          completedAt: undefined,
          legs: { ...legs, shielded: pendingShieldedLeg },
        }
        const backingOperationId = `deposit-backing:${tenantId}:${finalTxHash}`
        pendingShieldOperationId = backingOperationId
        recoveryTransaction = { tenantId, transaction: pendingTransaction }
        persistentStore.savePendingOperation({
          id: backingOperationId,
          kind: 'deposit_backing',
          status: 'recovery_required',
          tenantId,
          txId,
          createdAt: pendingTransaction.createdAt,
          updatedAt: Date.now(),
          transaction: pendingTransaction,
          sourceTxHash: finalTxHash,
          paymentTxHash: finalTxHash,
          amountUsd: netCreditUsd,
          amountZec: proportionalZec,
          recipientAddress: tenantZcashAccount.unified,
          senderAccountId: tenantZcashAccount.accountId,
        })
        if (!ledgerService.getTransactionById(txId, tenantId)) ledgerService.addTransaction(pendingTransaction, tenantId)
        return NextResponse.json({
          success: true,
          error: 'JURY_INVENTORY_PENDING',
          message: 'Base deposit confirmed. Private Balance credit is safely pending until confirmed Zcash pool capacity is available; do not send this deposit again.',
          transaction: pendingTransaction,
          creditedAmount: 0,
          pendingAmount: netCreditUsd,
          feeUsd,
          newVaultBalance: ledgerService.getTenantBalance(tenantId).totalUsd,
          pendingBacking: true,
        }, { status: 202 })
      }

      const allocatedTx = allocation.tx
      recoveryTransaction = { tenantId, transaction: allocatedTx }
      persistentStore.consumeDemoDepositBinding(finalTxHash)
      persistentStore.releasePaymentTxHash(finalTxHash)
      claimedTxHash = undefined
      return NextResponse.json({
        success: true,
        message: 'Base deposit verified and allocated from AURA’s confirmed shielded Zcash Testnet inventory.',
        transaction: allocatedTx,
        creditedAmount: netCreditUsd,
        pendingAmount: 0,
        feeUsd,
        newVaultBalance: allocation.balanceAfterUsd,
        settlementMode: 'jury_inventory',
      })
    }

    const shieldMemo = `Aura Shield: ${txId}`
    const shieldDestinationAddress = sharedZcashSource
      ? await zcashDevtoolService.generateFreshAddress(tenantZcashAccount.accountId)
      : realZcashUnified
    const shieldSenderAccountId = sharedZcashSource ? tenantZcashAccount.accountId : undefined

    // Attempt real Zcash testnet shielded broadcast if spendable test ZEC exists
    if (realZcashUnified) {
      try {
        // Jury mode intentionally uses one configured AuraVault source of truth
        // for deposit, Activity, Quote and Pay. Tenant ledger entitlement still
        // caps what that pooled chain balance can expose to this tenant.
        // Read the already-verified spendable balance first. A failed or
        // concurrent lightwalletd sync can temporarily make a previously
        // spendable note look unavailable; do not turn that transient sync
        // result into a false zero before attempting the real send.
        let zBal = await zcashDevtoolService.getBalance(shieldSenderAccountId).catch(() => null)
        let proposalFeeZec = await zcashDevtoolService.estimateShieldedFeeZec(shieldSenderAccountId, shieldDestinationAddress, proportionalZec).catch(() => null)
        // A concurrent wallet sync can make the read-only proposal preview
        // fail even though the source balance is available. Retry once after
        // sync, then use the documented ZIP-317 minimum only as a conservative
        // pre-broadcast reserve. The real wallet send still performs the final
        // fee/input check and no vault credit is written unless it broadcasts.
        if (proposalFeeZec === null) {
          const syncResult = await zcashDevtoolService.sync().catch(() => ({ success: false }))
          if (syncResult.success) {
            proposalFeeZec = await zcashDevtoolService.estimateShieldedFeeZec(shieldSenderAccountId, shieldDestinationAddress, proportionalZec).catch(() => null)
          }
        }
        const feeReserveZec = proposalFeeZec ?? ZCASH_FEE_RESERVE_ZEC
        if (!canFundShieldedSend(zBal, proportionalZec, feeReserveZec)) {
          const syncResult = await zcashDevtoolService.sync().catch(() => ({ success: false }))
          if (syncResult.success) {
            zBal = await zcashDevtoolService.getBalance(shieldSenderAccountId).catch(() => null)
          }
        }
        const zecToSend = proportionalZec
        const operationId = `deposit-shield:${tenantId}:${txId}`
        const pendingLegs = nearIntentsService.generateRoutingLegs(
          isReceive ? 'receive' : 'deposit',
          chain as ChainId,
          'zcash',
          txId,
          recipientAddress || shieldDestinationAddress,
          finalTxHash,
          undefined,
        )
        if (pendingLegs.deposit) {
          pendingLegs.deposit.status = isConfirmedOnChain ? 'confirmed' : 'pending'
          pendingLegs.deposit.description = isConfirmedOnChain
            ? `Deposited $${settledAmountUsd.toFixed(2)} ${asset} on Base Sepolia (Confirmed on-chain)`
            : 'Deposit is awaiting Base Sepolia confirmation.'
        }
        if (pendingLegs.shielded) {
          pendingLegs.shielded.destinationAddress = shieldDestinationAddress
          pendingLegs.shielded.status = 'broadcasting'
          pendingLegs.shielded.description = 'Shielding into Zcash Testnet private pool...'
        }
        const pendingTransaction: AuraTransaction = {
          id: txId,
          type: isReceive ? 'receive' : 'deposit',
          status: 'routing_shielded',
          fromAsset: asset as AssetSymbol,
          fromAmount: settledAmountUsd,
          fromChain: chain as ChainId,
          toAsset: asset as AssetSymbol,
          toAmount: netCreditUsd,
          toChain: 'zcash',
          recipientAddress: isReceive ? (recipientAddress || 'aura.money/gio') : undefined,
          bufferMode: (bufferMode as PrivacyBufferMode) || 'private',
          createdAt: Date.now(),
          backingZec: zecToSend,
          legs: pendingLegs,
          zkData: nearIntentsService.generateAuditCommitment(txId),
          feeUsd,
        }
        if (isConfirmedOnChain) {
          persistentStore.savePendingOperation({
            id: operationId,
            kind: 'deposit_shield',
            status: 'prepared',
            tenantId,
            txId,
            createdAt: pendingTransaction.createdAt,
            updatedAt: pendingTransaction.createdAt,
            transaction: pendingTransaction,
            sourceTxHash: finalTxHash,
            paymentTxHash: finalTxHash,
            memo: shieldMemo,
            amountUsd: netCreditUsd,
            amountZec: zecToSend,
            recipientAddress: shieldDestinationAddress,
            senderAccountId: shieldSenderAccountId,
            attemptNumber: 1,
            attemptId: generateSecureId('shield-attempt'),
          })
          pendingShieldOperationId = operationId
        }
        if (canFundShieldedSend(zBal, proportionalZec, feeReserveZec)) {
          shieldFailureStage = 'ZCASH_SEND_NOT_ACCEPTED'
          const shieldRes = await zcashDevtoolService.sendShielded(
            shieldDestinationAddress,
            zecToSend,
            shieldMemo,
            () => {
              if (!persistentStore.updatePendingOperation(operationId, { status: 'broadcasting' })) {
                throw new Error('Could not persist the Zcash shielding operation before broadcast.')
              }
              if (!persistentStore.markPaymentTxHashExternalEffectMayHaveStarted(finalTxHash!)) {
                throw new Error('Could not persist the source payment lock before Zcash broadcast.')
              }
            },
            shieldSenderAccountId,
          )
          if (shieldRes.success && shieldRes.txid) {
            zcashPayoutMayHaveBroadcast = true
            zcashTxid = shieldRes.txid
            zcashExplorerUrl = `https://testnet.cipherscan.app/tx/${shieldRes.txid}`

            // Verify confirmation on Zcash testnet explorer
            const confRes = await zcashDevtoolService.verifyConfirmation(shieldRes.txid)
            if (confRes.confirmed) {
              zcashConfirmed = true
            }
          } else if (shieldRes.broadcastUncertain) {
            zcashBroadcastUncertain = true
            zcashPayoutMayHaveBroadcast = true

            // The wallet persists the prepared transaction before the RPC
            // call. Prefer that deterministic txid over a memo scan whenever
            // the command returned it alongside an uncertain RPC result.
            const preparedTxid = shieldRes.txid
            if (preparedTxid) {
              zcashTxid = preparedTxid
              zcashExplorerUrl = `https://testnet.cipherscan.app/tx/${preparedTxid}`
              zcashBroadcastUncertain = false
              persistentStore.updatePendingOperation(pendingShieldOperationId!, { status: 'broadcasted', zcashTxid: preparedTxid })
              const confRes = await zcashDevtoolService.verifyConfirmation(preparedTxid)
              if (confRes.confirmed) zcashConfirmed = true
            }

            // The CLI can lose its response immediately after broadcast. Use
            // the exact operation memo to recover the real txid without ever
            // retrying the shield or creating a duplicate payout.
            const recoveredTxid = zcashTxid || await zcashDevtoolService.findBroadcastTxidByMemo(shieldMemo)
            if (recoveredTxid) {
              zcashTxid = recoveredTxid
              zcashExplorerUrl = `https://testnet.cipherscan.app/tx/${recoveredTxid}`
              zcashBroadcastUncertain = false
              const confRes = await zcashDevtoolService.verifyConfirmation(recoveredTxid)
              if (confRes.confirmed) zcashConfirmed = true
            }
          } else {
            shieldFailureStage = /persist the source payment lock/i.test(shieldRes.error || '')
              ? 'SOURCE_PAYMENT_LOCK_UNAVAILABLE'
              : /Invalid Zcash|Invalid Zcash sender/i.test(shieldRes.error || '')
                ? 'ZCASH_SEND_VALIDATION_FAILED'
                : 'ZCASH_SEND_PREBROADCAST_FAILED'
            console.error('Zcash shielding failed before broadcast:', shieldRes.error)
          }
        } else {
          shieldFailureStage = !zBal?.available
            ? 'SOURCE_BALANCE_UNAVAILABLE'
            : proposalFeeZec === null
              ? 'ZCASH_FEE_ESTIMATE_UNAVAILABLE'
              : 'SOURCE_SHIELDED_FUNDS_INSUFFICIENT'
        }
      } catch (zErr) {
          console.error('Zcash testnet live shield attempt error:', zErr)
          shieldFailureStage = 'ZCASH_SEND_PREBROADCAST_FAILED'
      }
    }

    if (!zcashTxid && !zcashBroadcastUncertain) {
      // A confirmed public deposit must remain recoverable even when Zcash
      // cannot broadcast right now. Keep the durable intent and the source
      // claim; the background reconciler will retry once liquidity/RPC returns.
      if (pendingShieldOperationId) {
        persistentStore.updatePendingOperation(pendingShieldOperationId, {
          status: 'recovery_required',
          transaction: {
            ...(persistentStore.getPendingOperation(pendingShieldOperationId)?.transaction || {} as AuraTransaction),
            status: 'routing_shielded',
            legs: {
              ...(persistentStore.getPendingOperation(pendingShieldOperationId)?.transaction?.legs || {}),
              shielded: {
                ...(persistentStore.getPendingOperation(pendingShieldOperationId)?.transaction?.legs?.shielded || {}),
                chain: 'zcash',
                status: 'pending',
                description: 'Base deposit is confirmed; waiting for the Zcash shielded broadcast to recover.',
              },
            },
          },
        })
      }
      return NextResponse.json({
        success: false,
        error: 'SHIELDED_PAYOUT_UNAVAILABLE',
        reason: shieldFailureStage,
        message: 'Source payment is confirmed. The Zcash shield is queued for automatic recovery; no duplicate deposit is required.',
      }, { status: 503 })
    }

    const legs = nearIntentsService.generateRoutingLegs(
      isReceive ? 'receive' : 'deposit',
      chain as ChainId,
      'zcash',
      txId,
      recipientAddress || realZcashUnified,
      finalTxHash,
      zcashTxid
    )

    const chainName = 'Base Sepolia'

    if (legs.deposit) {
      legs.deposit.status = isConfirmedOnChain ? 'confirmed' : 'pending'
      legs.deposit.description = isConfirmedOnChain
        ? `Deposited $${settledAmountUsd.toFixed(2)} ${asset} on ${chainName} (Confirmed on-chain)`
        : `Deposit broadcast to ${chainName} (Awaiting block inclusion)`
    }
    if (legs.shielded) {
      legs.shielded.destinationAddress = realZcashUnified || undefined
      legs.shielded.txHash = zcashTxid || undefined
      legs.shielded.explorerUrl = zcashExplorerUrl
      if (zcashTxid) {
        legs.shielded.status = zcashConfirmed ? 'confirmed' : 'broadcasting'
        legs.shielded.description = zcashConfirmed
          ? `Shielded transaction confirmed on Zcash Testnet (Tx #${zcashTxid.slice(0, 16)}...)`
          : `Shielded transaction broadcast to Zcash mempool (Tx #${zcashTxid.slice(0, 16)}...). Awaiting block confirmation.`
      } else {
        legs.shielded.status = zcashBroadcastUncertain ? 'broadcasting' : 'pending'
        legs.shielded.description = isConfirmedOnChain
          ? zcashBroadcastUncertain
            ? 'The Zcash response is uncertain. Aura is recovering the exact broadcast from the durable wallet record; no duplicate shielding will be attempted.'
            : 'Public-chain deposit confirmed. Waiting for a confirmed Zcash Testnet shielded transaction.'
          : `Deposit submitted on ${chainName}. Awaiting block confirmation before Zcash shielding.`
      }
    }

    if (isConfirmedOnChain) {
      if (zcashTxid) {
        txStatus = zcashConfirmed ? 'completed' : 'routing_shielded'
      } else {
        txStatus = 'routing_shielded'
      }
    } else {
      txStatus = 'processing'
    }

    const balanceBeforeUsd = zcashConfirmed
      ? ledgerService.getTenantBalance(tenantId).totalUsd
      : undefined
    const balanceAfterUsd = balanceBeforeUsd === undefined
      ? undefined
      : Number((balanceBeforeUsd + netCreditUsd).toFixed(2))
    const tx: AuraTransaction = {
      id: txId,
      type: isReceive ? 'receive' : 'deposit',
      status: txStatus,
      fromAsset: asset as AssetSymbol,
      fromAmount: settledAmountUsd,
      fromChain: chain as ChainId,
      toAsset: asset as AssetSymbol,
      toAmount: netCreditUsd,
      toChain: 'zcash',
      recipientAddress: isReceive ? (recipientAddress || 'aura.money/gio') : undefined,
      bufferMode: (bufferMode as PrivacyBufferMode) || 'private',
      createdAt: Date.now(),
      completedAt: txStatus === 'completed' ? Date.now() : undefined,
      backingZec: proportionalZec,
      balanceCheckpoint: balanceBeforeUsd !== undefined && balanceAfterUsd !== undefined
        ? { beforeUsd: balanceBeforeUsd, afterUsd: balanceAfterUsd, deltaUsd: netCreditUsd, capturedAt: Date.now() }
        : undefined,
      legs,
      zkData: nearIntentsService.generateAuditCommitment(txId),
      feeUsd,
    }

    if (pendingShieldOperationId) {
      persistentStore.updatePendingOperation(pendingShieldOperationId, {
        status: zcashConfirmed ? 'confirmed' : 'broadcasted',
        zcashTxid,
        transaction: tx,
      })
    }

    // Keep the complete, verified settlement record available to the outer
    // catch. If persistence fails after Zcash may have broadcast, the catch
    // makes one best-effort durable write instead of leaving the deposit as an
    // invisible orphan behind a permanent transaction-hash claim.
    recoveryTransaction = { tenantId, transaction: tx }

    // Record in tenant's isolated ledger
    ledgerService.addTransaction(tx, tenantId)
    // Keep a broadcasted/unconfirmed Zcash operation durable. The reconciler
    // must later observe confirmed or definitively expired before cleanup.
    if (pendingShieldOperationId && zcashConfirmed) {
      persistentStore.deletePendingOperation(pendingShieldOperationId)
      persistentStore.consumeDemoDepositBinding(finalTxHash)
      persistentStore.releasePaymentTxHash(finalTxHash)
      claimedTxHash = undefined
    }

    const updatedBalance = ledgerService.getTenantBalance(tenantId)

    return NextResponse.json({
      success: true,
      message: zcashBroadcastUncertain
        ? 'The source payment is confirmed, but the Zcash response is uncertain. Aura is recovering the exact broadcast automatically; funds remain reserved to prevent a duplicate payment.'
        : txStatus === 'completed'
        ? 'Deposit verified and shielded into the private vault.'
        : isConfirmedOnChain
          ? 'Deposit verified on the source chain; waiting for Zcash confirmation.'
        : `Deposit broadcast to ${chainName}; awaiting block confirmation`,
      transaction: tx,
      // Pending deposits are visible in the unconfirmed ledger total, but are
      // not yet spendable balance. Keep the API field truthful for SDK/users.
      creditedAmount: txStatus === 'completed' ? netCreditUsd : 0,
      pendingAmount: txStatus === 'completed' ? 0 : netCreditUsd,
      feeUsd,
      newVaultBalance: updatedBalance.totalUsd,
    })
  } catch (error) {
    if (zcashPayoutMayHaveBroadcast && recoveryTransaction) {
      try {
        const { tenantId, transaction } = recoveryTransaction
        const alreadyStored = ledgerService.getTransactionById(transaction.id, tenantId)
        if (!alreadyStored) ledgerService.addTransaction(transaction, tenantId)
        const stored = ledgerService.getTransactionById(transaction.id, tenantId)
        if (stored) {
          if (pendingShieldOperationId && stored.legs?.shielded?.status === 'confirmed') {
            persistentStore.deletePendingOperation(pendingShieldOperationId)
            if (claimedTxHash) persistentStore.releasePaymentTxHash(claimedTxHash)
            claimedTxHash = undefined
          }
          return NextResponse.json({
            success: true,
            message: stored.status === 'completed'
              ? 'Deposit verified and shielded into the private balance.'
              : 'Deposit is recorded. Zcash confirmation is still pending; check Activity for its status.',
            transaction: stored,
            creditedAmount: stored.status === 'completed' ? stored.toAmount : 0,
            feeUsd: stored.feeUsd,
          }, { headers: { 'Cache-Control': 'no-store' } })
        }
      } catch (recoveryError) {
        console.error('Could not persist interrupted deposit recovery state:', recoveryError)
      }
    }
    if (claimedTxHash && !zcashPayoutMayHaveBroadcast && !pendingShieldOperationId) {
      persistentStore.releasePaymentTxHash(claimedTxHash)
    }
    return NextResponse.json(
      { success: false, error: 'SERVER_ERROR', message: 'Failed to process deposit' },
      { status: 500 }
    )
  }
}
