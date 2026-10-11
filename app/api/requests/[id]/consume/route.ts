import { NextRequest, NextResponse } from 'next/server'
import { persistentStore } from '@/lib/services/persistent-store'
import { ledgerService } from '@/lib/services/ledger-service'
import { nearIntentsService } from '@/lib/services/near-intents-service'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { ratesService } from '@/lib/services/rates-service'
import { isFinalizedSolanaSignatureStatus, solanaRelayer, summarizeSolanaVaultTransfers, verifySolanaMessageSignature } from '@/lib/crypto/solana-relayer'
import { AssetSymbol, AuraTransaction, ChainId, TransactionStatus } from '@/lib/types/aura'
import { globalPaymentLimiter, isSharedUnauthenticatedIdentifier, paymentLimiter } from '@/lib/utils/rate-limiter'
import { generateSecureId } from '@/lib/utils'
import { baseRelayer, isBaseSepoliaChainId, summarizeErc20VaultTransfers } from '@/lib/crypto/base-relayer'
import { createPaymentAuthorizationMessage, createPaymentRecoveryAuthorizationMessage } from '@/lib/crypto/payment-authorization'
import { canFundShieldedSend } from '@/lib/services/zcash-balance'
import { isWorkingDemoEntryRoute, WORKING_DEMO_ROUTE_MESSAGE } from '@/lib/services/demo-route'
import { getProductionExecutionBlock } from '@/lib/services/production-boundary'
import { reconcilePendingOperations } from '@/lib/services/pending-operation-reconciler'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const productionBlock = getProductionExecutionBlock('payment_request_consume')
  if (productionBlock) return NextResponse.json({ success: false, ...productionBlock }, { status: 503 })
  let claimedRequestId: string | null = null
  let claimedPaymentTxHash: string | null = null
  let zcashSettlementMayHaveBroadcast = false
  let recoveryTransaction: { tenantId: string; transaction: AuraTransaction } | undefined
  let pendingShieldOperationId: string | undefined
  let sourceBlockTimestampMs: number | undefined
  let sourceBlockNumber: number | undefined
  try {
    const identifier = paymentLimiter.getIdentifier(req)
    const globalRate = globalPaymentLimiter.check('global')
    if (!globalRate.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED' }, {
        status: 429,
        headers: { 'Retry-After': String(globalRate.retryAfter || 60) },
      })
    }
    const rate = paymentLimiter.check(identifier)
    if (!isSharedUnauthenticatedIdentifier(identifier) && !rate.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMIT_EXCEEDED' }, {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfter || 60) },
      })
    }
    await reconcilePendingOperations()
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const {
      payAsset = 'USDC',
      payChain = 'base',
      payAmount,
      clientProof,
      payerSignature,
      payerPublicKey,
      recoveryPayerAddress,
    } = body

    const numAmount = Number(payAmount)
    if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 1_000_000) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_PAYMENT_AMOUNT',
          message: 'Payment amount must be greater than zero.',
        },
        { status: 400 }
      )
    }
    if (Math.abs(numAmount * 100 - Math.round(numAmount * 100)) > 1e-7) {
      return NextResponse.json({ success: false, error: 'INVALID_PAYMENT_PRECISION' }, { status: 400 })
    }

    const { txHash: clientTxHash } = body
    let verifiedTxHash = clientTxHash ? String(clientTxHash).trim() : ''
    const normPayChain = String(payChain || 'base').toLowerCase().includes('sol') ? 'solana' : 'base'
    let recoveryMode = false
    let recoveredPayerAddress = ''
    const invoiceBeforePayout = persistentStore.getPaymentRequest(id, { preserveActive: true })
    if (!invoiceBeforePayout) {
      return NextResponse.json({ success: false, error: 'REQUEST_NOT_FOUND' }, { status: 404 })
    }
    if (!isWorkingDemoEntryRoute(invoiceBeforePayout.chain, invoiceBeforePayout.asset)) {
      return NextResponse.json({
        success: false,
        error: 'ROUTE_NOT_ENABLED',
        message: WORKING_DEMO_ROUTE_MESSAGE,
      }, { status: 409 })
    }
    if (!invoiceBeforePayout.sharedAt) {
      return NextResponse.json({
        success: false,
        error: 'PAYMENT_REQUEST_NOT_PUBLISHED',
        message: 'This payment request is still a private draft.',
      }, { status: 404 })
    }
    if (invoiceBeforePayout.status !== 'active') {
      return NextResponse.json({ success: false, error: 'REQUEST_NOT_ACTIVE' }, { status: 409 })
    }
    if (invoiceBeforePayout.amount && Math.round(numAmount * 100) !== Math.round(invoiceBeforePayout.amount * 100)) {
      return NextResponse.json({ success: false, error: 'AMOUNT_MISMATCH', expectedAmount: invoiceBeforePayout.amount }, { status: 400 })
    }
    if (!invoiceBeforePayout.amount && invoiceBeforePayout.minimumAmount && numAmount < invoiceBeforePayout.minimumAmount) {
      return NextResponse.json({
        success: false,
        error: 'MINIMUM_PAYMENT_AMOUNT',
        message: `Open payment requests require at least $${invoiceBeforePayout.minimumAmount.toFixed(2)}.`,
        minimumAmount: invoiceBeforePayout.minimumAmount,
      }, { status: 400 })
    }
    if (normPayChain === 'base' && payAsset === 'USDC' && !invoiceBeforePayout.payerAddress) {
      return NextResponse.json({
        success: false,
        error: 'PAYER_BINDING_REQUIRED',
        message: 'Base payments must be prepared with the payer wallet before funds are sent. This lets AURA recover the exact transfer if the browser is interrupted.',
      }, { status: 409 })
    }
    if (invoiceBeforePayout.asset && payAsset !== invoiceBeforePayout.asset) {
      return NextResponse.json({ success: false, error: 'ASSET_MISMATCH', expectedAsset: invoiceBeforePayout.asset }, { status: 400 })
    }
    if (invoiceBeforePayout.chain && normPayChain !== invoiceBeforePayout.chain) {
      return NextResponse.json({ success: false, error: 'CHAIN_MISMATCH', expectedChain: invoiceBeforePayout.chain }, { status: 400 })
    }

    // If a payer's tab died after the transfer was broadcast, allow a fresh
    // tab to recover it by signing the invoice + payer identity. The server
    // discovers exactly one matching finalized transfer; it never guesses by
    // balance and never changes the invoice's tenant.
    if (!verifiedTxHash) {
      const recoveryAddress = typeof recoveryPayerAddress === 'string' ? recoveryPayerAddress.trim() : ''
      if (normPayChain !== 'base' || String(payAsset) !== 'USDC' || !/^0x[0-9a-f]{40}$/i.test(recoveryAddress) || typeof payerSignature !== 'string') {
        return NextResponse.json(
          { success: false, error: 'MISSING_TX_PROOF', message: 'Provide the transaction ID, or recover a Base payment from the same wallet.' },
          { status: 400 },
        )
      }
      if (!Number.isSafeInteger(invoiceBeforePayout.sourceStartBlock)) {
        return NextResponse.json(
          { success: false, error: 'RECOVERY_WINDOW_UNAVAILABLE', message: 'This invoice was created before resumable payment recovery was enabled.' },
          { status: 409 },
        )
      }
      const recoveryMessage = createPaymentRecoveryAuthorizationMessage({
        requestId: id,
        amountCents: Math.round(numAmount * 100),
        asset: String(payAsset),
        chain: normPayChain,
        payerAddress: recoveryAddress,
      })
      if (!(await baseRelayer.verifyWalletSignature(recoveryAddress, recoveryMessage, payerSignature))) {
        return NextResponse.json({ success: false, error: 'PAYER_SIGNATURE_MISMATCH', message: 'Sign the recovery request with the wallet that sent the payment.' }, { status: 403 })
      }
      const recovered = recoveryAddress.toLowerCase()
      let candidates
      try {
        const payerPreparedBlock = Number(invoiceBeforePayout.payerPreparedBlock)
        if (!Number.isSafeInteger(payerPreparedBlock)) {
          return NextResponse.json({ success: false, error: 'PAYER_PREPARATION_REQUIRED', message: 'Prepare the invoice from the intended payer wallet before sending.' }, { status: 400 })
        }
        candidates = await baseRelayer.findUsdcTransferCandidates({
          fromBlock: payerPreparedBlock + 1,
          senderAddress: recovered,
          vaultAddress: process.env.VAULT_DEPOSIT_ADDRESS || '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e',
          amountUnits: BigInt(Math.round(numAmount * 1e6)),
        })
      } catch {
        return NextResponse.json({ success: false, error: 'RECOVERY_SCAN_FAILED', message: 'Base payment recovery is temporarily unavailable. No payment was consumed.' }, { status: 503 })
      }
      if (candidates.length === 0) {
        return NextResponse.json({ success: false, error: 'PAYMENT_NOT_FOUND_FOR_RECOVERY', message: 'No matching finalized Base USDC payment was found for this invoice and wallet.' }, { status: 404 })
      }
      if (candidates.length > 1) {
        return NextResponse.json({ success: false, error: 'RECOVERY_AMBIGUOUS', message: 'More than one matching payment was found. Enter the exact transaction ID to choose safely.' }, { status: 409 })
      }
      verifiedTxHash = candidates[0].txHash
      recoveredPayerAddress = recovered
      recoveryMode = true
    }

    const authorizationMessage = createPaymentAuthorizationMessage({
      requestId: id,
      txHash: verifiedTxHash,
      amountCents: Math.round(numAmount * 100),
      asset: String(payAsset),
      chain: normPayChain,
    })
    if (verifiedTxHash && persistentStore.hasUsedPaymentTxHash(verifiedTxHash, id)) {
      return NextResponse.json({ success: false, error: 'TX_ALREADY_USED' }, { status: 409 })
    }
    if (
      !verifiedTxHash ||
      (normPayChain === 'base' && !/^0x[0-9a-fA-F]{64}$/.test(verifiedTxHash)) ||
      (normPayChain === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(verifiedTxHash))
    ) {
      return NextResponse.json(
        {
          success: false,
          error: 'MISSING_TX_PROOF',
          message: 'Valid on-chain transaction hash proof (txHash) is required to fulfill this payment request.',
        },
        { status: 400 }
      )
    }

    if (persistentStore.hasUsedPaymentTxHash(verifiedTxHash, id)) {
      return NextResponse.json({ success: false, error: 'TX_ALREADY_USED' }, { status: 409 })
    }


    // 0. VERIFY INVOICE ELIGIBILITY BEFORE RPC EXECUTION
    const existingReq = persistentStore.getPaymentRequest(id, { preserveActive: true })
    if (!existingReq) {
      return NextResponse.json(
        { success: false, error: 'REQUEST_NOT_FOUND', message: 'Payment request does not exist.' },
        { status: 404 }
      )
    }
    if (existingReq.status === 'consumed') {
      return NextResponse.json(
        {
          success: false,
          error: 'REQUEST_ALREADY_CONSUMED',
          message: 'Replay rejected. This single-use private payment request was already fulfilled and cannot be reused.',
          consumedAt: existingReq.consumedAt,
          txHash: existingReq.txHash,
        },
        { status: 409 }
      )
    }
    if (existingReq.status === 'expired') {
      return NextResponse.json(
        {
          success: false,
          error: 'REQUEST_EXPIRED',
          message: 'Payment rejected. This single-use payment link has expired.',
          expiresAt: existingReq.expiresAt,
        },
        { status: 410 }
      )
    }
    if (!isWorkingDemoEntryRoute(normPayChain, payAsset)) {
      return NextResponse.json({ success: false, error: 'ROUTE_NOT_ENABLED', message: WORKING_DEMO_ROUTE_MESSAGE }, { status: 400 })
    }

    // 1. FAIL-CLOSED ON-CHAIN TRANSACTION PROOF VERIFICATION
    if (normPayChain === 'base') {
      try {
        const rpcChainId = await baseRelayer.getRpcChainId()
        if (!rpcChainId) {
          return NextResponse.json({ success: false, error: 'BASE_RPC_UNAVAILABLE', message: 'Base Sepolia RPC is unavailable; the invoice payment was not consumed.' }, { status: 503 })
        }
        if (!isBaseSepoliaChainId(rpcChainId)) {
          return NextResponse.json({ success: false, error: 'WRONG_SOURCE_CHAIN', message: 'The configured RPC is not connected to Base Sepolia; the invoice payment was not consumed.' }, { status: 503 })
        }
        const receipt = await baseRelayer.getTransactionReceipt(verifiedTxHash)

        if (!receipt) {
          return NextResponse.json(
            {
              success: false,
              error: 'TX_NOT_CONFIRMED',
              message: 'Transaction is still pending on Base Sepolia. Please wait for confirmation.',
            },
            { status: 400 }
          )
        } else {
          if (receipt.status !== '0x1') {
            return NextResponse.json(
              {
                success: false,
                error: 'ONCHAIN_TX_REVERTED',
                message: 'The submitted Base Sepolia transaction reverted on-chain.',
              },
              { status: 400 }
            )
          }

          // A receive also triggers an irreversible Zcash shielding effect.
          // Safe inclusion is useful for read-only status, but cannot authorize
          // the external shield until Base reports finalized.
          const finality = await baseRelayer.verifyReceiptFinality(
            verifiedTxHash,
            receipt,
            { requireFinalized: true },
          )
          if (!finality.confirmed) {
            return NextResponse.json(
              {
                success: false,
                error: 'TX_NOT_FINAL',
                message: 'Base Sepolia included the payment, but it has not reached the required finality yet. Please retry after more confirmations.',
                confirmations: finality.confirmations,
              },
              { status: 425 }
            )
          }
          sourceBlockTimestampMs = finality.blockTimestampMs
          sourceBlockNumber = finality.blockNumber

          // Strict rejection if transaction has 0 logs
          if (!Array.isArray(receipt.logs) || receipt.logs.length === 0) {
            return NextResponse.json(
              {
                success: false,
                error: 'INVALID_PAYMENT_LOGS',
                message: 'Transaction does not contain ERC-20 token transfer events.',
              },
              { status: 400 }
            )
          }

          const BASE_SEPOLIA_USDC = (process.env.BASE_SEPOLIA_USDC_CONTRACT || '0x036CbD53842c5426634e7929541eC2318f3dCF7e').toLowerCase()
          const vaultAddress = (process.env.VAULT_DEPOSIT_ADDRESS || '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e').toLowerCase()

          const transfers = summarizeErc20VaultTransfers(
            receipt.logs,
            BASE_SEPOLIA_USDC,
            vaultAddress
          )
          const expectedUnits = BigInt(Math.round(numAmount * 1e6))
          const hasValidTransfer = transfers.matchingLogCount > 0 &&
            !transfers.mixedSenders && transfers.amountUnits === expectedUnits

          if (!hasValidTransfer) {
            return NextResponse.json(
              {
                success: false,
                error: 'INVALID_PAYMENT_LOGS',
                message: 'Transaction does not contain a verified USDC transfer to the payment vault matching the invoice amount.',
              },
              { status: 400 }
            )
          }
          const transferSender = transfers.sender
          if (!transferSender) {
            return NextResponse.json({
              success: false,
              error: 'PAYER_SIGNATURE_MISMATCH',
              message: 'The payer wallet could not be recovered from the confirmed Base transfer.',
            }, { status: 403 })
          }
          const payerAuthorizationValid = recoveryMode
            ? recoveredPayerAddress === transferSender.toLowerCase()
            : await baseRelayer.verifyWalletSignature(transferSender, authorizationMessage, String(payerSignature || ''))
          if (!payerAuthorizationValid) {
            return NextResponse.json({
              success: false,
              error: 'PAYER_SIGNATURE_MISMATCH',
              message: 'Sign this invoice with the same Base wallet or contract wallet that sent the payment.',
            }, { status: 403 })
          }
          if (invoiceBeforePayout.payerAddress && invoiceBeforePayout.payerAddress.toLowerCase() !== transferSender.toLowerCase()) {
            return NextResponse.json({
              success: false,
              error: 'PAYER_BINDING_MISMATCH',
              message: 'This payment request is bound to a different payer wallet.',
            }, { status: 403 })
          }
        }
      } catch (verifyErr) {
        return NextResponse.json(
          {
            success: false,
            error: 'RPC_VERIFICATION_FAILED',
            message: 'Failed to verify transaction receipt from Base Sepolia RPC. Payment was not consumed.',
          },
          { status: 502 }
        )
      }
    } else if (normPayChain === 'solana') {
      try {
        const status = await solanaRelayer.getSignatureStatus(verifiedTxHash)
        // A Solana receipt is not a completed payment until it is finalized.
        // `confirmed` is sufficient for observation, but it can still be
        // rolled back and must never consume an invoice or start shielding.
        if (!status || (!isFinalizedSolanaSignatureStatus(status) && !status.err)) {
          return NextResponse.json(
            {
              success: false,
              error: 'TX_NOT_CONFIRMED',
              message: 'Transaction is not found or not finalized on Solana Devnet. Please wait for finality.',
            },
            { status: 400 }
          )
        }
        if (status?.err) {
          return NextResponse.json(
            {
              success: false,
              error: 'SOLANA_TX_FAILED',
              message: 'The submitted Solana Devnet transaction failed on-chain.',
            },
            { status: 400 }
          )
        }

        // Fetch transaction details
        const txData = await solanaRelayer.getParsedTransaction(verifiedTxHash)
          if (!txData) {
          return NextResponse.json(
            { success: false, error: 'TX_DETAILS_UNAVAILABLE', message: 'Solana transaction details are unavailable; payment was not consumed.' },
            { status: 502 }
          )
        } else {
          if (txData.meta?.err) {
            return NextResponse.json(
              {
                success: false,
                error: 'SOLANA_TX_FAILED',
                message: 'The submitted Solana Devnet transaction failed on-chain.',
              },
              { status: 400 }
            )
          }
          if (typeof txData.blockTime === 'number' && Number.isFinite(txData.blockTime)) {
            sourceBlockTimestampMs = txData.blockTime * 1000
          }

          const instructions = txData.transaction?.message?.instructions || []
          const innerInstructions = txData.meta?.innerInstructions?.flatMap((i: { instructions: any[] }) => i.instructions) || []
          const allInstructions = [...instructions, ...innerInstructions]

          const vaultPub = process.env.SOLANA_VAULT_ADDRESS || solanaRelayer.getPublicKey()
          if (!vaultPub) {
            return NextResponse.json({ success: false, error: 'SOLANA_VAULT_NOT_CONFIGURED' }, { status: 503 })
          }
          const accountKeys = txData.transaction?.message?.accountKeys || []
          const tokenBalances = txData.meta?.postTokenBalances || []
          const preTokenBalances = txData.meta?.preTokenBalances || []
          const usdcMint = process.env.SOLANA_USDC_MINT
          const expectedUsdcUnits = BigInt(Math.round(numAmount * 1e6))
          const savedSolRate = invoiceBeforePayout.rateUsdAtCreation
          const solRate = Number.isFinite(savedSolRate) && (savedSolRate || 0) > 0
            ? savedSolRate!
            : (payAsset === 'SOL' ? (await ratesService.getFreshRate('SOL'))?.usdPrice : undefined)
          if (payAsset === 'SOL' && !solRate) {
            return NextResponse.json({
              success: false,
              error: 'LIVE_RATE_UNAVAILABLE',
              message: 'The SOL payment rate is temporarily unavailable. The invoice was not consumed; try again later.',
            }, { status: 503 })
          }
          const expectedLamports = payAsset === 'SOL'
            ? BigInt(Math.round((numAmount / solRate!) * 1e9))
            : 0n
          const solTransfers = summarizeSolanaVaultTransfers(allInstructions, vaultPub)
          let usdcTransferAuthority: string | undefined

          const hasValidSolanaTransfer = !solTransfers.mixedSenders && (
            (payAsset === 'SOL' && solTransfers.matchingInstructionCount > 0 && solTransfers.amountLamports === expectedLamports) ||
            allInstructions.some((ix: any) => {
            const parsed = ix?.parsed
            const info = parsed?.info
            if (!info) return false
            if (payAsset !== 'USDC' || !usdcMint || !['transfer', 'transferChecked'].includes(parsed.type)) return false
            if (parsed.type === 'transferChecked' && info.mint !== usdcMint) return false
            const destinationIndex = accountKeys.findIndex((key: any) =>
              (typeof key === 'string' ? key : key?.pubkey?.toString()) === info.destination
            )
            if (destinationIndex < 0) return false
            const post = tokenBalances.find((balance: any) =>
              balance.accountIndex === destinationIndex && balance.owner === vaultPub && balance.mint === usdcMint
            )
            if (!post) return false
            const pre = preTokenBalances.find((balance: any) =>
              balance.accountIndex === destinationIndex && balance.owner === vaultPub && balance.mint === usdcMint
            )
            const received = BigInt(post.uiTokenAmount?.amount || '0') - BigInt(pre?.uiTokenAmount?.amount || '0')
            if (received !== expectedUsdcUnits || typeof info.authority !== 'string') return false
            usdcTransferAuthority = info.authority
            return true
          }))

          if (!hasValidSolanaTransfer) {
            return NextResponse.json(
              {
                success: false,
                error: 'INVALID_SOLANA_PAYMENT',
                message: 'Solana transaction does not contain a verified transfer to the payment vault.',
              },
              { status: 400 }
            )
          }
          const onChainPayer = payAsset === 'SOL' ? solTransfers.sender : usdcTransferAuthority
          const signedPayer = String(payerPublicKey || '')
          if (
            !signedPayer || signedPayer !== onChainPayer ||
            !verifySolanaMessageSignature(authorizationMessage, signedPayer, String(payerSignature || ''))
          ) {
            return NextResponse.json({
              success: false,
              error: 'PAYER_SIGNATURE_MISMATCH',
              message: 'Sign this invoice with the same Solana wallet that sent the payment.',
            }, { status: 403 })
          }
        }
      } catch (verifyErr) {
        return NextResponse.json(
          {
            success: false,
            error: 'RPC_VERIFICATION_FAILED',
            message: 'Failed to verify transaction with Solana Devnet RPC. Payment was not consumed.',
          },
          { status: 502 }
        )
      }
    }

    // The invoice lifetime applies to the source-chain payment, not to the
    // browser's ability to report its hash. This prevents a paid invoice from
    // being stranded by a tab crash while still rejecting old transactions.
    const requestForWindow = persistentStore.getPaymentRequest(id, { preserveActive: true })
    if (!requestForWindow || requestForWindow.status === 'expired') {
      return NextResponse.json({ success: false, error: 'REQUEST_EXPIRED' }, { status: 410 })
    }
    if (sourceBlockTimestampMs === undefined || !Number.isFinite(sourceBlockTimestampMs) ||
      sourceBlockTimestampMs < requestForWindow.createdAt || sourceBlockTimestampMs > requestForWindow.expiresAt) {
      return NextResponse.json(
        {
          success: false,
          error: 'PAYMENT_OUTSIDE_REQUEST_WINDOW',
          message: 'The source-chain payment was not included during this invoice window. The invoice was not consumed.',
          createdAt: requestForWindow.createdAt,
          expiresAt: requestForWindow.expiresAt,
          sourceBlockTimestamp: sourceBlockTimestampMs,
        },
        { status: 400 }
      )
    }
    const payerPreparedBlock = requestForWindow.payerPreparedBlock
    const payerBindingExpiresAt = requestForWindow.payerBindingExpiresAt
    if (requestForWindow.chain === 'base' &&
      (!requestForWindow.payerAddress || !Number.isSafeInteger(payerPreparedBlock) ||
        typeof payerBindingExpiresAt !== 'number' || !Number.isSafeInteger(payerBindingExpiresAt) || sourceBlockTimestampMs > payerBindingExpiresAt ||
        sourceBlockNumber === undefined || sourceBlockNumber <= (payerPreparedBlock ?? Number.MAX_SAFE_INTEGER))) {
      return NextResponse.json({
        success: false,
        error: 'PAYER_PREPARATION_REQUIRED',
        message: 'The open-amount payment was not included during the payer preparation lease. Prepare the request again from the intended payer wallet.',
      }, { status: 400 })
    }

    const txId = generateSecureId('tx_rec')

    // 0. Preliminary validation of invoice before Zcash shielding
    const existingReqForShield = persistentStore.getPaymentRequest(id, { preserveActive: true })
    if (!existingReqForShield) {
      return NextResponse.json({ success: false, error: 'NOT_FOUND', message: 'Payment request does not exist.' }, { status: 404 })
    }
    if (existingReqForShield.status === 'consumed') {
      return NextResponse.json(
        {
          success: false,
          error: 'REQUEST_ALREADY_CONSUMED',
          message: 'Replay rejected. This single-use private payment request was already fulfilled and cannot be reused.',
          consumedAt: existingReqForShield.consumedAt,
          txHash: existingReqForShield.txHash,
        },
        { status: 409 }
      )
    }
    if (existingReqForShield.status === 'expired') {
      return NextResponse.json(
        {
          success: false,
          error: 'REQUEST_EXPIRED',
          message: 'Payment rejected. This single-use payment link has expired.',
          expiresAt: existingReqForShield.expiresAt,
        },
        { status: 410 }
      )
    }
    if (existingReqForShield.amount && existingReqForShield.amount > 0) {
      if (Math.round(numAmount * 100) !== Math.round(existingReqForShield.amount * 100)) {
        return NextResponse.json(
          {
            success: false,
            error: 'AMOUNT_MISMATCH',
            message: `Amount mismatch. This invoice requires exactly $${existingReqForShield.amount} ${existingReqForShield.asset}.`,
            expectedAmount: existingReqForShield.amount,
          },
          { status: 400 }
        )
      }
    }
    if (existingReqForShield.asset && payAsset !== existingReqForShield.asset) {
      return NextResponse.json(
        {
          success: false,
          error: 'ASSET_MISMATCH',
          message: `Asset mismatch. This invoice requires payment in ${existingReqForShield.asset}.`,
          expectedAsset: existingReqForShield.asset,
        },
        { status: 400 }
      )
    }
    if (existingReqForShield.chain && normPayChain !== existingReqForShield.chain) {
      return NextResponse.json(
        {
          success: false,
          error: 'CHAIN_MISMATCH',
          message: `Chain mismatch. This invoice requires payment on ${existingReqForShield.chain}.`,
          expectedChain: existingReqForShield.chain,
        },
        { status: 400 }
      )
    }

    if (!persistentStore.claimPaymentRequestProcessing(id, { allowExpired: true })) {
      return NextResponse.json({ success: false, error: 'REQUEST_PROCESSING' }, { status: 409 })
    }
    claimedRequestId = id
    if (!persistentStore.claimPaymentTxHash(verifiedTxHash)) {
      persistentStore.releasePaymentRequestProcessing(id)
      claimedRequestId = null
      return NextResponse.json({ success: false, error: 'TX_ALREADY_USED_OR_PROCESSING' }, { status: 409 })
    }
    claimedPaymentTxHash = verifiedTxHash

    const recipientTenant = existingReqForShield.enclaveFingerprint || 'default'
    // No live provider quote is used in this test-only route, so no estimated
    // fee is deducted from the receiver's balance.
    const feeUsd = 0

    // Real Zcash shielding: derive recipient unified address & broadcast shielded note if test ZEC exists
    const tenantAccount = await zcashDevtoolService.ensureTenantAccount(recipientTenant).catch(() => null)
    if (!tenantAccount || existingReqForShield.zcashAccountId !== tenantAccount.accountId) {
      persistentStore.releasePaymentRequestProcessing(id)
      claimedRequestId = null
      persistentStore.releasePaymentTxHash(verifiedTxHash)
      claimedPaymentTxHash = null
      return NextResponse.json({
        success: false,
        error: 'TENANT_ZCASH_ACCOUNT_MISMATCH',
        message: 'This payment request is not bound to the recipient tenant Zcash account. No shielding transaction was sent.',
      }, { status: 409 })
    }
    // Route this invoice to its own diversified receiver, not the shared
    // service wallet address. The sender wallet is separate from the recipient.
    const realZcashUnified = existingReqForShield.shieldedReceiver

    let zcashTxid: string | undefined
    let zcashConfirmed = false
    let zcashBroadcastUncertain = false
    let zcashExplorerUrl = realZcashUnified ? `https://testnet.zcashblockexplorer.com/address/${realZcashUnified}` : undefined

    // Compute live proportional ZEC based on USD rate
    const zecRate = await ratesService.getFreshRate('ZEC')
    if (!zecRate) {
      persistentStore.releasePaymentRequestProcessing(id)
      claimedRequestId = null
      persistentStore.releasePaymentTxHash(verifiedTxHash)
      claimedPaymentTxHash = null
      return NextResponse.json({
        success: false,
        error: 'LIVE_RATE_UNAVAILABLE',
              message: 'We cannot calculate the ZEC transfer amount at the current rate; the invoice was left unchanged. Try again later.',
      }, { status: 503 })
    }
    const proportionalZec = Number((numAmount / zecRate.usdPrice).toFixed(6))
    const shieldMemo = `Aura Invoice Shield: ${txId}`

    // Attempt real Zcash testnet shielded broadcast if daemon is available and spendable test ZEC exists
    let zcashAttemptError: string | null = null
    if (zcashDevtoolService.isAvailable() && realZcashUnified) {
      try {
        // Invoice shielding is funded by Aura's shared relayer account and
        // delivered to the already-bound tenant receiver. The tenant account
        // is the source only for outbound Pay operations.
        const zBal = await zcashDevtoolService.getBalance().catch(() => null)
        const proposalFeeZec = await zcashDevtoolService.estimateShieldedFeeZec(undefined, realZcashUnified, proportionalZec).catch(() => null)
        if (proposalFeeZec === null) zcashAttemptError = 'ZCASH_FEE_ESTIMATE_UNAVAILABLE'
        if (proposalFeeZec !== null && canFundShieldedSend(zBal, proportionalZec, proposalFeeZec)) {
          const zecToSend = proportionalZec
          // Persist the full invoice settlement intent before Zcash is called.
          // A restart can therefore consume the same invoice and write the
          // recipient ledger row after recovering this exact memo.
          const operationId = `invoice-shield:${recipientTenant}:${txId}`
          const pendingLegs = nearIntentsService.generateRoutingLegs(
            'receive',
            payChain as ChainId,
            'zcash',
            txId,
            realZcashUnified,
            verifiedTxHash,
            undefined,
          )
          if (pendingLegs.deposit) {
            pendingLegs.deposit.status = 'confirmed'
            pendingLegs.deposit.txHash = verifiedTxHash
            pendingLegs.deposit.description = `Payment received on ${payChain.toUpperCase()} (Confirmed on-chain)`
          }
          if (pendingLegs.shielded) {
            pendingLegs.shielded.destinationAddress = realZcashUnified
            pendingLegs.shielded.status = 'enclave_committed'
            pendingLegs.shielded.description = 'Invoice shielding is durably prepared before broadcast.'
          }
          const pendingTransaction: AuraTransaction = {
            id: txId,
            type: 'receive',
            status: 'routing_shielded',
            fromAsset: payAsset as AssetSymbol,
            fromAmount: numAmount,
            fromChain: payChain as ChainId,
            toAsset: existingReqForShield.asset || (payAsset as AssetSymbol),
            toAmount: numAmount,
            toChain: 'zcash',
            recipientAddress: existingReqForShield.shieldedReceiver || realZcashUnified,
            bufferMode: existingReqForShield.bufferMode || 'private',
            createdAt: Date.now(),
            backingZec: proportionalZec,
            legs: pendingLegs,
            zkData: nearIntentsService.generateAuditCommitment(txId),
            feeUsd,
          }
          persistentStore.savePendingOperation({
            id: operationId,
            kind: 'invoice_shield',
            status: 'prepared',
            tenantId: recipientTenant,
            txId,
            createdAt: pendingTransaction.createdAt,
            updatedAt: pendingTransaction.createdAt,
            transaction: pendingTransaction,
            requestId: id,
            sourceTxHash: verifiedTxHash,
            paymentTxHash: verifiedTxHash,
            memo: shieldMemo,
            amountUsd: numAmount,
            amountZec: zecToSend,
            recipientAddress: realZcashUnified,
          })
          pendingShieldOperationId = operationId
          const shieldRes = await zcashDevtoolService.sendShielded(
            realZcashUnified,
            zecToSend,
            shieldMemo,
            () => {
              if (!persistentStore.updatePendingOperation(operationId, { status: 'broadcasting' })) {
                throw new Error('Could not persist the invoice shielding operation before broadcast.')
              }
              if (
                !persistentStore.markPaymentTxHashExternalEffectMayHaveStarted(verifiedTxHash) ||
                !persistentStore.markPaymentRequestExternalEffectMayHaveStarted(id)
              ) {
                throw new Error('Could not persist the invoice payment lock before Zcash broadcast.')
              }
            }
          )
          if (shieldRes.success && shieldRes.txid) {
            zcashSettlementMayHaveBroadcast = true
            zcashTxid = shieldRes.txid
            zcashExplorerUrl = `https://testnet.cipherscan.app/tx/${shieldRes.txid}`

            const confRes = await zcashDevtoolService.verifyConfirmation(shieldRes.txid)
            if (confRes.confirmed) {
              zcashConfirmed = true
            }
          } else {
            zcashBroadcastUncertain = Boolean(shieldRes.broadcastUncertain || shieldRes.success)
            zcashSettlementMayHaveBroadcast = zcashBroadcastUncertain
            zcashAttemptError = shieldRes.error || 'Zcash testnet live shield failed'

            if (zcashBroadcastUncertain && shieldRes.txid) {
              zcashTxid = shieldRes.txid
              zcashExplorerUrl = `https://testnet.cipherscan.app/tx/${shieldRes.txid}`
              zcashBroadcastUncertain = false
              zcashSettlementMayHaveBroadcast = true
              persistentStore.updatePendingOperation(pendingShieldOperationId!, { status: 'broadcasted', zcashTxid: shieldRes.txid })
              const confRes = await zcashDevtoolService.verifyConfirmation(shieldRes.txid)
              if (confRes.confirmed) zcashConfirmed = true
            }

            // Recover a response lost after broadcast from the exact invoice
            // memo. Never resend the shielded payment on a timeout.
            if (zcashBroadcastUncertain) {
              const recoveredTxid = zcashTxid || await zcashDevtoolService.findBroadcastTxidByMemo(shieldMemo)
              if (recoveredTxid) {
                zcashTxid = recoveredTxid
                zcashExplorerUrl = `https://testnet.cipherscan.app/tx/${recoveredTxid}`
                zcashBroadcastUncertain = false
                zcashSettlementMayHaveBroadcast = true
                zcashAttemptError = null
                const confRes = await zcashDevtoolService.verifyConfirmation(recoveredTxid)
                if (confRes.confirmed) zcashConfirmed = true
              }
            }
          }
        }
      } catch (zErr) {
        zcashAttemptError = zErr instanceof Error ? zErr.message : String(zErr)
      }
    }

    // Fail-Safe Gate: If Zcash on-chain shielding was attempted and failed, do NOT burn invoice
    if (zcashAttemptError && !zcashSettlementMayHaveBroadcast) {
      if (pendingShieldOperationId) persistentStore.deletePendingOperation(pendingShieldOperationId)
      persistentStore.releasePaymentRequestProcessing(id)
      claimedRequestId = null
      persistentStore.releasePaymentTxHash(verifiedTxHash)
      claimedPaymentTxHash = null
      return NextResponse.json(
        {
          success: false,
          error: 'ZCASH_SHIELD_FAILED',
          message: `Zcash testnet shielded broadcast failed: ${zcashAttemptError}. Invoice was not consumed and remains valid.`,
        },
        { status: 502 }
      )
    }

    if (!zcashTxid && !zcashSettlementMayHaveBroadcast) {
      // Do not burn the invoice or tell the payer the settlement succeeded when
      // the source-chain payment is verified but no shielded payout was sent.
      // The same source transaction may be retried after testnet liquidity is
      // restored; replay checks will reject it once a receive is actually saved.
      if (pendingShieldOperationId) persistentStore.deletePendingOperation(pendingShieldOperationId)
      persistentStore.releasePaymentRequestProcessing(id)
      claimedRequestId = null
      persistentStore.releasePaymentTxHash(verifiedTxHash)
      claimedPaymentTxHash = null
      return NextResponse.json({
        success: false,
        error: 'SHIELDED_PAYOUT_UNAVAILABLE',
        message: 'Source payment is confirmed, but no Zcash shielded payout was broadcast. The invoice remains active; retry this same transaction after testnet payout funds are available.',
      }, { status: 503 })
    }

    // 1. ATOMIC COMPARE-AND-SWAP CONSUMPTION (Executed AFTER Zcash check succeeds)
    const consumeResult = persistentStore.atomicConsumePaymentRequest(id, {
      payAmount: numAmount,
      payAsset: payAsset as AssetSymbol,
      payChain: normPayChain as ChainId,
      txHash: verifiedTxHash,
      clientProof,
    })

    if (!consumeResult.success) {
      if (!zcashSettlementMayHaveBroadcast) {
        persistentStore.releasePaymentRequestProcessing(id)
        claimedRequestId = null
        persistentStore.releasePaymentTxHash(verifiedTxHash)
        claimedPaymentTxHash = null
      }
      return NextResponse.json(
        {
          success: false,
          error: zcashSettlementMayHaveBroadcast ? 'SETTLEMENT_REQUIRES_REVIEW' : consumeResult.error || 'CONSUME_FAILED',
          message: zcashSettlementMayHaveBroadcast
            ? 'Zcash payout may already have been broadcast. The invoice and payment are locked to prevent a duplicate; check the Zcash transaction before retrying.'
            : 'Failed to atomically consume payment request.',
          zcashTxid,
        },
        { status: zcashSettlementMayHaveBroadcast ? 202 : consumeResult.error === 'TX_ALREADY_USED' ? 409 : 400 }
      )
    }
    persistentStore.releasePaymentRequestProcessing(id)
    claimedRequestId = null
    persistentStore.releasePaymentTxHash(verifiedTxHash)
    claimedPaymentTxHash = null

    const consumedReq = consumeResult.request!

    const legs = nearIntentsService.generateRoutingLegs(
      'receive',
      payChain as ChainId,
      'zcash',
      txId,
      realZcashUnified,
      verifiedTxHash,
      zcashTxid
    )

    if (legs.deposit) {
      legs.deposit.status = 'confirmed'
      legs.deposit.txHash = verifiedTxHash
      legs.deposit.description = `Payment received on ${payChain.toUpperCase()} (Confirmed on-chain)`
    }
    if (legs.shielded) {
      legs.shielded.destinationAddress = realZcashUnified || undefined
      legs.shielded.txHash = zcashTxid || undefined
      legs.shielded.explorerUrl = zcashTxid ? zcashExplorerUrl : undefined
      if (zcashTxid) {
        legs.shielded.status = zcashConfirmed ? 'confirmed' : 'broadcasting'
        legs.shielded.description = zcashConfirmed
          ? `Shielded note confirmed on Zcash Testnet (Tx #${zcashTxid.slice(0, 16)}...)`
          : `Shielded note broadcast to Zcash mempool (Tx #${zcashTxid.slice(0, 16)}...). Awaiting confirmation.`
      } else {
        legs.shielded.status = zcashBroadcastUncertain ? 'broadcasting' : 'pending'
        legs.shielded.description = zcashBroadcastUncertain
          ? 'The Zcash response is uncertain. Aura is recovering the exact broadcast from the durable wallet record; no duplicate shielding will be attempted.'
          : 'Waiting for a confirmed Zcash Testnet shielded transaction.'
      }
    }

    // Never report a receive as completed until its shielded transaction is confirmed.
    const txStatus: TransactionStatus = zcashTxid
      ? (zcashConfirmed ? 'completed' : 'routing_shielded')
      : 'routing_shielded'

    // 2. RECORD IN RECIPIENT'S ISOLATED TENANT LEDGER
    const tx: AuraTransaction = {
      id: txId,
      type: 'receive',
      status: txStatus,
      fromAsset: payAsset as AssetSymbol,
      fromAmount: numAmount,
      fromChain: payChain as ChainId,
      toAsset: consumedReq.asset || (payAsset as AssetSymbol),
      toAmount: numAmount,
      toChain: 'zcash',
      recipientAddress: consumedReq.shieldedReceiver || realZcashUnified,
      bufferMode: consumedReq.bufferMode || 'private',
      createdAt: Date.now(),
      completedAt: txStatus === 'completed' ? Date.now() : undefined,
      backingZec: proportionalZec,
      legs,
      zkData: nearIntentsService.generateAuditCommitment(txId),
      feeUsd,
    }

    recoveryTransaction = { tenantId: recipientTenant, transaction: tx }

    try {
      ledgerService.addTransaction(tx, recipientTenant)
      // Keep the durable shield operation while Zcash is unconfirmed. Expiry
      // reconciliation must still be able to revert the consumed invoice.
      if (pendingShieldOperationId && zcashConfirmed) persistentStore.deletePendingOperation(pendingShieldOperationId)
    } catch (saveErr) {
      // If a payout may have reached Zcash, keep the invoice consumed so a
      // retry cannot issue a duplicate shielded payment.
      if (!zcashBroadcastUncertain && !zcashTxid) {
        persistentStore.revertPaymentRequestConsumption(id)
      }
      throw saveErr
    }

    return NextResponse.json({
      success: true,
      message: zcashTxid
        ? 'Payment received on-chain and shielded on Zcash Testnet.'
        : 'Payment received on the source chain; waiting for confirmed Zcash shielding.',
      transaction: tx,
      txHash: verifiedTxHash,
      zcashTxid,
      requestStatus: 'consumed',
    }, {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Referrer-Policy': 'no-referrer',
      }
    })
  } catch (error) {
    if (claimedRequestId && !zcashSettlementMayHaveBroadcast) {
      persistentStore.releasePaymentRequestProcessing(claimedRequestId)
      claimedRequestId = null
    }
    if (recoveryTransaction) {
      try {
        const { tenantId, transaction } = recoveryTransaction
        const alreadyStored = ledgerService.getTransactionById(transaction.id, tenantId)
        if (!alreadyStored) ledgerService.addTransaction(transaction, tenantId)
        const stored = ledgerService.getTransactionById(transaction.id, tenantId)
        if (stored) {
          if (pendingShieldOperationId && stored.legs?.shielded?.status === 'confirmed') persistentStore.deletePendingOperation(pendingShieldOperationId)
          if (claimedRequestId) persistentStore.releasePaymentRequestProcessing(claimedRequestId)
          claimedRequestId = null
          if (claimedPaymentTxHash) persistentStore.releasePaymentTxHash(claimedPaymentTxHash)
          claimedPaymentTxHash = null
          return NextResponse.json({
            success: true,
            message: stored.status === 'completed'
              ? 'Payment received and shielded on Zcash Testnet.'
              : 'Payment is recorded; Zcash confirmation is still pending. Check Activity for its status.',
            transaction: stored,
            txHash: stored.legs?.deposit?.txHash,
            zcashTxid: stored.legs?.shielded?.txHash,
            requestStatus: 'consumed',
          }, { headers: { 'Cache-Control': 'no-store' } })
        }
      } catch (recoveryError) {
        console.error('Could not persist interrupted invoice settlement:', recoveryError)
      }
    }
    // Keep the source transaction claim if a shielded payout might already be
    // on-chain; releasing it could let another invoice trigger the same payout.
    if (claimedPaymentTxHash && !zcashSettlementMayHaveBroadcast) {
      persistentStore.releasePaymentTxHash(claimedPaymentTxHash)
    }
    return NextResponse.json(
      { success: false, error: 'PAYMENT_FAILED', message: 'Failed to process payment request.' },
      { status: 500 }
    )
  }
}
