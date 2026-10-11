import { NextRequest, NextResponse } from 'next/server'
import { ledgerService } from '@/lib/services/ledger-service'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'
import { InMemoryRateLimiter } from '@/lib/utils/rate-limiter'
import { getTrustedClientId } from '@/lib/services/demo-session-service'
import { verifyClientEcdsaSignature } from '@/lib/crypto/ecdsa-auth'
import { persistentStore } from '@/lib/services/persistent-store'
import { isFinalizedSolanaSignatureStatus, solanaRelayer } from '@/lib/crypto/solana-relayer'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { hasConfirmedShieldedSource } from '@/lib/utils/transaction-finality'

const statusLimiter = new InMemoryRateLimiter(30, 60)

function isRealSolanaSignature(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ txId: string }> }
) {
  try {
    const identifier = getTrustedClientId(req.headers)
    const rate = statusLimiter.check(identifier)
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: 'RATE_LIMITED' }, {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfter || 60) },
      })
    }
    const { txId } = await params
    const tenantId = req.headers.get('x-aura-enclave-fingerprint') || ''
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId)) {
      return NextResponse.json({ success: false, error: 'TENANT_REQUIRED' }, { status: 401 })
    }
    const timestamp = Number(req.headers.get('x-aura-auth-timestamp'))
    const nonce = req.headers.get('x-aura-auth-nonce') || ''
    const publicKey = req.headers.get('x-aura-auth-public-key') || ''
    const signature = req.headers.get('x-aura-auth-signature') || ''
    if (
      !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > 2 * 60 * 1000 ||
      !/^[a-f0-9]{32}$/i.test(nonce) || !publicKey || !signature
    ) {
      return NextResponse.json({ success: false, error: 'AUTHORIZATION_REQUIRED' }, { status: 401 })
    }
    const signedPayload = `${tenantId}:read_activity:${timestamp}:${nonce}`
    if (!verifyClientEcdsaSignature(publicKey, signedPayload, signature)) {
      return NextResponse.json({ success: false, error: 'INVALID_AUTHORIZATION' }, { status: 401 })
    }
    if (!persistentStore.claimAuthNonce(tenantId, 'status', nonce, 2 * 60 * 1000)) {
      return NextResponse.json({ success: false, error: 'NONCE_REPLAYED' }, { status: 401 })
    }
    if (!persistentStore.verifySpendSigningKey(tenantId, publicKey)) {
      return NextResponse.json({ success: false, error: 'SIGNING_KEY_MISMATCH' }, { status: 401 })
    }
    let tx = ledgerService.getTransactionById(txId, tenantId)

    if (!tx) {
      return NextResponse.json(
        { success: false, error: 'Transaction not found' },
        { status: 404 }
      )
    }

    // A persisted completed flag is not proof of Solana finality. Reconcile
    // legacy/early records before exposing them to the caller.
    if (tx.status === 'completed' && tx.toChain === 'solana' && tx.legs?.delivery?.confirmationStatus !== 'finalized') {
      const deliveryHash = tx.legs?.delivery?.txHash
      const signatureStatus = isRealSolanaSignature(deliveryHash)
        ? await solanaRelayer.getSignatureStatus(deliveryHash).catch(() => null)
        : null
      if (!isFinalizedSolanaSignatureStatus(signatureStatus)) {
        const sourceConfirmed = hasConfirmedShieldedSource(tx)
        const updated = ledgerService.updateTransaction(txId, {
          status: signatureStatus?.err && !sourceConfirmed ? 'failed' : 'routing_shielded',
          completedAt: undefined,
          legs: {
            ...tx.legs,
            delivery: tx.legs.delivery
              ? {
                  ...tx.legs.delivery,
                  status: signatureStatus?.err ? 'failed' : deliveryHash ? 'broadcasting' : 'pending',
                  confirmationStatus: signatureStatus?.confirmationStatus,
                  description: signatureStatus?.err
                    ? 'Solana payout failed on-chain.'
                    : 'Solana payout is awaiting finalized confirmation.',
                }
              : undefined,
          },
        }, tenantId)
        if (updated) tx = updated
      }
    }

    // Recover a Zcash txid from the exact operation memo if the CLI response
    // was lost after broadcast. This is read/reconcile state recovery only;
    // it never issues a second send.
    if (tx.legs?.shielded && !tx.legs.shielded.txHash &&
      (tx.status === 'processing' || tx.status === 'routing_shielded' || tx.status === 'settling_destination')) {
      const memo = tx.type === 'send' || tx.type === 'withdraw'
        ? `Aura Spend: ${tx.id}`
        : tx.type === 'receive'
          ? `Aura Invoice Shield: ${tx.id}`
          : `Aura Shield: ${tx.id}`
      const recoveredTxid = await zcashDevtoolService.findBroadcastTxidByMemo(memo)
      if (recoveredTxid) {
        tx = ledgerService.updateTransaction(txId, {
          legs: {
            ...tx.legs,
            shielded: {
              ...tx.legs.shielded,
              txHash: recoveredTxid,
              explorerUrl: `https://testnet.cipherscan.app/tx/${recoveredTxid}`,
              status: 'broadcasting',
              description: 'Recovered the Zcash broadcast identifier from the durable wallet record; awaiting confirmation.',
            },
          },
        }, tenantId) || tx
      }
    }

    // Active on-chain reconciliation for pending transactions
    if ((tx.status === 'processing' || tx.status === 'routing_shielded') && tx.legs?.deposit?.txHash && tx.fromChain === 'base') {
      try {
        const receipt = await baseRelayer.getTransactionReceipt(tx.legs.deposit.txHash)
        if (receipt) {
          const finality = receipt.status === '0x1'
            ? await baseRelayer.verifyReceiptFinality(tx.legs.deposit.txHash, receipt)
            : { confirmed: false }
          if (finality.confirmed) {
            const hasRealZcashTx = Boolean(
              tx.legs?.shielded?.txHash &&
              /^[0-9a-fA-F]{64}$/.test(tx.legs.shielded.txHash)
            )
            const inventoryBacked = hasConfirmedShieldedSource(tx) && tx.settlementMode === 'jury_inventory'

            let isZcashConfirmed = false
            if (hasRealZcashTx && tx.legs?.shielded?.txHash) {
              const conf = await zcashDevtoolService.verifyConfirmation(tx.legs.shielded.txHash).catch(() => ({ confirmed: false }))
              isZcashConfirmed = Boolean(conf.confirmed)
            }

            const shieldedStatus = hasRealZcashTx
              ? (isZcashConfirmed ? 'confirmed' : 'broadcasting')
              : inventoryBacked ? 'confirmed' : 'pending'

            const overallStatus = hasRealZcashTx || inventoryBacked
              ? ((isZcashConfirmed || inventoryBacked) ? 'completed' : 'routing_shielded')
              : 'routing_shielded'

            const updated = ledgerService.updateTransaction(
              txId,
              {
                status: overallStatus,
                completedAt: overallStatus === 'completed' ? Date.now() : undefined,
                legs: {
                  ...tx.legs,
                  deposit: {
                    ...tx.legs.deposit,
                    status: 'confirmed',
                    description: tx.legs.deposit.description.includes('(Confirmed')
                      ? tx.legs.deposit.description
                      : `${tx.legs.deposit.description} (Confirmed on-chain)`,
                  },
                  shielded: tx.legs.shielded ? {
                    ...tx.legs.shielded,
                    status: hasRealZcashTx || inventoryBacked ? shieldedStatus : 'pending',
                    description: hasRealZcashTx
                      ? (isZcashConfirmed
                          ? `Shielded transaction confirmed on Zcash Testnet (Tx #${tx.legs.shielded.txHash!.slice(0, 16)}...)`
                          : `Shielded transaction in Zcash mempool (Tx #${tx.legs.shielded.txHash!.slice(0, 16)}...). Awaiting block confirmation.`)
                      : inventoryBacked
                        ? 'Backed by AURA’s confirmed shielded Zcash Testnet inventory.'
                        : 'Waiting for a confirmed Zcash Testnet shielded transaction.',
                  } : undefined,
                },
              },
              tenantId
            )
            if (updated) tx = updated
          } else if (receipt.status === '0x0') {
            const updated = ledgerService.updateTransaction(txId, { status: 'failed' }, tenantId)
            if (updated) tx = updated
          }
        }
      } catch (err) {
        console.warn('Base Sepolia status sync delayed:', err)
      }
    } else if (
      (tx.status === 'routing_near' || tx.status === 'settling_destination' || tx.status === 'routing_shielded') &&
      tx.legs?.delivery?.txHash && tx.toChain === 'solana'
    ) {
      try {
        const sigStatus = await solanaRelayer.getSignatureStatus(tx.legs.delivery.txHash)
        if (sigStatus) {
          if (isFinalizedSolanaSignatureStatus(sigStatus)) {
            const shieldedTxHash = tx.legs?.shielded?.txHash
            const shieldedBroadcasted = Boolean(shieldedTxHash && /^[0-9a-fA-F]{64}$/.test(shieldedTxHash))
            const shieldedConfirmed = hasConfirmedShieldedSource(tx) || Boolean(
              shieldedTxHash && /^[0-9a-fA-F]{64}$/.test(shieldedTxHash) &&
              (await zcashDevtoolService.verifyConfirmation(shieldedTxHash).catch(() => ({ confirmed: false }))).confirmed
            )
            // A real Zcash txid is enough to authorize the liquidity-backed
            // destination payout. Solana finality may arrive before Zcash
            // mining; do not demote a delivered payment just because the
            // private leg is still confirming.
            const nextStatus = shieldedConfirmed || shieldedBroadcasted ? 'completed' : 'routing_shielded'
            const updated = ledgerService.updateTransaction(
              txId,
              {
                status: nextStatus,
                completedAt: nextStatus === 'completed' ? Date.now() : undefined,
                legs: {
                  ...tx.legs,
                  shielded: tx.legs.shielded ? {
                    ...tx.legs.shielded,
                    status: shieldedConfirmed ? 'confirmed' : tx.legs.shielded.status,
                  } : undefined,
                  delivery: {
                    ...tx.legs.delivery,
                    status: 'confirmed',
                    confirmationStatus: 'finalized',
                  },
                },
              },
              tenantId
            )
            if (updated) tx = updated
          } else if (sigStatus.err) {
            const sourceSpendConfirmed = hasConfirmedShieldedSource(tx)
            const updated = ledgerService.updateTransaction(txId, {
              status: sourceSpendConfirmed ? 'routing_shielded' : 'failed',
              legs: tx.legs?.delivery ? { ...tx.legs, delivery: { ...tx.legs.delivery, status: 'failed' } } : tx.legs,
            }, tenantId)
            if (updated) tx = updated
          }
        }
      } catch (err) {
        console.warn('Solana Devnet status sync delayed:', err)
      }
    } else if (
      (tx.status === 'routing_near' || tx.status === 'settling_destination' || tx.status === 'routing_shielded') &&
      tx.legs?.delivery?.txHash && tx.toChain === 'base'
    ) {
      try {
        const receipt = await baseRelayer.getTransactionReceipt(tx.legs.delivery.txHash)
        if (receipt) {
          const finality = receipt.status === '0x1'
            ? await baseRelayer.verifyReceiptFinality(tx.legs.delivery.txHash, receipt)
            : { confirmed: false }
          if (finality.confirmed) {
            const shieldedTxHash = tx.legs?.shielded?.txHash
            const shieldedConfirmed = hasConfirmedShieldedSource(tx) || Boolean(
              shieldedTxHash && /^[0-9a-fA-F]{64}$/.test(shieldedTxHash) &&
              (await zcashDevtoolService.verifyConfirmation(shieldedTxHash).catch(() => ({ confirmed: false }))).confirmed
            )
            const nextStatus = shieldedConfirmed ? 'completed' : 'routing_shielded'
            const updated = ledgerService.updateTransaction(
              txId,
              {
                status: nextStatus,
                completedAt: nextStatus === 'completed' ? Date.now() : undefined,
                legs: {
                  ...tx.legs,
                  shielded: tx.legs.shielded ? {
                    ...tx.legs.shielded,
                    status: shieldedConfirmed ? 'confirmed' : tx.legs.shielded.status,
                  } : undefined,
                  delivery: {
                    ...tx.legs.delivery,
                    status: 'confirmed',
                  },
                },
              },
              tenantId
            )
            if (updated) tx = updated
          } else if (receipt.status === '0x0') {
            const sourceSpendConfirmed = hasConfirmedShieldedSource(tx)
            const updated = ledgerService.updateTransaction(txId, {
              status: sourceSpendConfirmed ? 'routing_shielded' : 'failed',
              legs: tx.legs?.delivery ? { ...tx.legs, delivery: { ...tx.legs.delivery, status: 'failed' } } : tx.legs,
            }, tenantId)
            if (updated) tx = updated
          }
        }
      } catch (err) {
        console.warn('Base Sepolia spend status sync delayed:', err)
      }
    }

    return NextResponse.json({
      success: true,
      data: tx,
    }, { headers: { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' } })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to retrieve transaction status' },
      { status: 500 }
    )
  }
}
