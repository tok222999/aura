/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import { AuraTransaction } from '@/lib/types/aura'
import { SparkleIcon, CloseIcon, CheckIcon, ExternalLinkIcon } from './aura-icons'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { canonicalExplorerUrl } from '@/lib/utils/explorer-links'

interface UnlinkabilityModalProps {
  isOpen: boolean
  onClose: () => void
  transaction: AuraTransaction | null
}

export function UnlinkabilityModal({ isOpen, onClose, transaction }: UnlinkabilityModalProps) {
  if (!isOpen || !transaction) return null

  const depositLeg = transaction.legs?.deposit
  const shieldedLeg = transaction.legs?.shielded
  const deliveryLeg = transaction.legs?.delivery
  const deliveryCompleted = hasCompletedDestinationDelivery(transaction)

  const chainLabel = (chain: string) => chain === 'base'
    ? 'Base Sepolia'
    : chain === 'solana'
      ? 'Solana Devnet'
      : chain === 'zcash'
        ? 'Zcash Testnet'
        : chain.toUpperCase()
  const fromChainName = chainLabel(transaction.fromChain)
  const toChainName = chainLabel(transaction.toChain)
  const hasChainTxHash = (chain: string, hash?: string) => chain === 'solana'
    ? Boolean(hash && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(hash))
    : chain === 'base'
      ? Boolean(hash && /^0x[a-fA-F0-9]{64}$/.test(hash))
      : chain === 'zcash'
        ? Boolean(hash && /^[a-fA-F0-9]{64}$/.test(hash))
        : false
  const sourceTxHash = hasChainTxHash(transaction.fromChain, depositLeg?.txHash) ? depositLeg?.txHash : undefined
  const shieldedTxHash = hasChainTxHash('zcash', shieldedLeg?.txHash) ? shieldedLeg?.txHash : undefined
  const deliveryTxHash = hasChainTxHash(transaction.toChain, deliveryLeg?.txHash) ? deliveryLeg?.txHash : undefined
  const sourceExplorerUrl = sourceTxHash
    ? canonicalExplorerUrl(transaction.fromChain, sourceTxHash, depositLeg?.explorerUrl)
    : undefined
  // Keep the receipt link independent from zec.rocks availability. The
  // transaction itself is verified by the wallet/runtime; this is only a
  // human-facing explorer link for the jury.
  const shieldedExplorerUrl = shieldedTxHash
    ? `https://testnet.cipherscan.app/tx/${shieldedTxHash}`
    : undefined
  const deliveryExplorerUrl = deliveryTxHash
    ? canonicalExplorerUrl(transaction.toChain, deliveryTxHash, deliveryLeg?.explorerUrl)
    : undefined
  const privateCreditConfirmed = transaction.status === 'completed' && shieldedLeg?.status === 'confirmed' && Boolean(shieldedTxHash)
  const recipientAmountLabel = transaction.toAsset === 'SOL'
    ? `${transaction.toAmount.toFixed(5)} SOL (≈ $${transaction.fromAmount.toFixed(2)})`
    : `$${transaction.toAmount.toFixed(2)} ${transaction.toAsset}`

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 1100 }}>
      <div
        className="modal-window"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 860, width: '92%', padding: 0, overflow: 'hidden' }}
      >
        {/* Privacy Proof Banner */}
        <div
          style={{
            background: '#e0d7ff',
            borderBottom: '1px solid #c7b9fa',
            padding: '10px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            fontSize: 12,
          }}
        >
          <span style={{ fontWeight: 800, color: '#3b287e', letterSpacing: '0.04em' }}>
            {transaction.type === 'send' || transaction.type === 'withdraw'
              ? `PRIVATE BALANCE → AURA PAYOUT SERVICE → PUBLIC EXIT (${toChainName})`
              : `PUBLIC ENTRY (${fromChainName}) → PRIVATE BALANCE → PAYOUT`}
          </span>
          <span style={{ fontWeight: 600, color: '#5b4f8c' }}>
            {transaction.type === 'send' || transaction.type === 'withdraw'
              ? 'The recipient sees the payout address used by AURA. The private middle helps separate the route, but amount and timing may still link activity.'
              : 'A real Zcash testnet transaction is shown; the demo balance is recorded by AURA and is not a separate self-custody wallet for each user.'}
          </span>
        </div>
        {/* Modal Header */}
        <div
          style={{
            background: 'linear-gradient(135deg, #191820 0%, #2f274a 100%)',
            padding: '24px 28px',
            color: '#fff',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(255, 255, 255, 0.12)',
                padding: '4px 10px',
                borderRadius: 20,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                marginBottom: 8,
                color: '#d4ccff',
              }}
            >
              <SparkleIcon size={12} color="#d4ccff" />
              <span>TRANSACTION DETAILS</span>
            </div>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#fff' }}>
              Public → Private → Public
            </h2>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#beb7d6' }}>
              Real chain records are shown where available. Public amounts, addresses, and timing may still be correlated.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            title="Close"
            style={{
              background: 'rgba(255, 255, 255, 0.15)',
              border: 0,
              color: '#fff',
              width: 32,
              height: 32,
              borderRadius: '50%',
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <CloseIcon size={14} color="#fff" />
          </button>
        </div>

        {/* 3-Column Visualizer */}
        <div style={{ padding: '28px 24px', background: '#faf9fc' }}>
          <div className="unlinkability-grid">
            {transaction.type === 'send' || transaction.type === 'withdraw' ? (
              <>
                {/* Outgoing Column 1: Shielded Private Origin */}
                <div
                  style={{
                    background: 'linear-gradient(180deg, #f5f2ff 0%, #ede7ff 100%)',
                    border: '2px solid var(--violet, #6b55df)',
                    borderRadius: 14,
                    padding: '20px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: -11,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      background: 'var(--violet, #6b55df)',
                      color: '#fff',
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      padding: '2px 10px',
                      borderRadius: 12,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    SHIELDED ORIGIN
                  </div>

                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--violet, #6b55df)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        1. SHIELDED ORIGIN
                      </span>
                      <span style={{ background: '#e0d7ff', color: '#523ec9', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>
                    PRIVATE BALANCE
                      </span>
                    </div>

                    <h4 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#2a1a6b' }}>
                      ${transaction.fromAmount.toFixed(2)} {transaction.fromAsset}
                    </h4>
                    <div style={{ fontSize: 11, color: '#5b4f8c', marginBottom: 14 }}>
                      Amount reserved from Aura's shared, server-operated demo balance.
                    </div>

                    <div style={{ background: '#fff', border: '1px solid #d9d0ff', borderRadius: 8, padding: 10, fontSize: 11, color: '#43347a' }}>
                      <div style={{ marginBottom: 4, color: 'var(--violet, #6b55df)', fontWeight: 700 }}>
                        DEMO CUSTODY:
                      </div>
                      <div style={{ color: 'var(--green)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <CheckIcon size={12} color="var(--green)" />
                        <span>Not user self-custody; unlinkability is not proven.</span>
                      </div>
                    </div>
                  </div>

                </div>

                {/* Outgoing Column 2: Real Zcash Testnet transaction */}
                <div
                  style={{
                    background: '#fff',
                    border: '1px solid #e5e1eb',
                    borderRadius: 14,
                    padding: '20px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        2. ZCASH TESTNET
                      </span>
                      <span style={{ background: '#f1f5f9', color: '#334155', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>
                        {shieldedLeg?.status === 'confirmed' && shieldedTxHash
                          ? 'CONFIRMED'
                          : shieldedLeg?.status === 'failed'
                            ? 'FAILED'
                            : shieldedTxHash
                              ? 'PENDING'
                              : 'NO TX HASH'}
                      </span>
                    </div>

                    <h4 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#191820' }}>
                      Real Zcash transaction
                    </h4>
                    <div style={{ fontSize: 11, color: '#77727d', marginBottom: 14 }}>
                      AURA pays from confirmed shielded Zcash Testnet inventory. Each visible Pay creates a real Zcash shielded spend and records its txid before the destination payout; mining confirmation may finish asynchronously.
                    </div>

                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'var(--font-ui)', color: '#475569' }}>
                      <div style={{ marginBottom: 4, color: '#64748b' }}>ZCASH TRANSACTION ID:</div>
                      <div style={{ wordBreak: 'break-all', marginBottom: 4 }}>
                        {shieldedTxHash || 'Not recorded'}
                      </div>
                      <div style={{ color: '#64748b', fontWeight: 500 }}>
                        This transaction is not a zero-knowledge proof of unlinkability or user self-custody.
                      </div>
                    </div>
                  </div>

                  {shieldedExplorerUrl && (
                    <a href={shieldedExplorerUrl} target="_blank" rel="noreferrer" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f1f5f9', display: 'block', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--violet, #6b55df)', textDecoration: 'none' }}>
                      Inspect Zcash Testnet transaction <ExternalLinkIcon size={12} color="var(--violet)" />
                    </a>
                  )}
                </div>

                {/* Outgoing Column 3: Destination Public Ledger */}
                <div
                  style={{
                    background: '#fff',
                    border: '1px solid #e5e1eb',
                    borderRadius: 14,
                    padding: '20px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        3. PUBLIC EXIT
                      </span>
                      <span style={{ background: '#f1f5f9', color: '#334155', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>
                        {toChainName}
                      </span>
                    </div>

                    <h4 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#191820' }}>
                      {recipientAmountLabel}
                    </h4>
                    <div style={{ fontSize: 11, color: '#77727d', marginBottom: 14 }}>
                      {deliveryCompleted && deliveryTxHash
                        ? `Confirmed on ${toChainName}`
                        : deliveryLeg?.status === 'failed'
                          ? `Failed on ${toChainName}`
                          : deliveryTxHash
                            ? `Submitted to ${toChainName}; awaiting confirmation`
                            : `No recipient transaction recorded on ${toChainName}`}
                    </div>

                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'var(--font-ui)', color: '#475569' }}>
                      <div style={{ marginBottom: 4, color: '#64748b' }}>DESTINATION BLOCK ENTRY:</div>
                      <div style={{ wordBreak: 'break-all' }}>
                        {deliveryTxHash || 'No transaction hash recorded'}
                      </div>
                      <div style={{ marginTop: 4, color: '#94a3b8' }}>
                        AURA&apos;s payout service sends the payment, not your main wallet. Public amounts and timing may still be correlated.
                      </div>
                    </div>
                  </div>

                  {deliveryExplorerUrl && (
                    <a href={deliveryExplorerUrl} target="_blank" rel="noreferrer" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f1f5f9', display: 'block', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--violet, #6b55df)', textDecoration: 'none' }}>
                      Inspect {toChainName} transaction <ExternalLinkIcon size={12} color="var(--violet)" />
                    </a>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Incoming Column 1: Public Entry Chain */}
                <div
                  style={{
                    background: '#fff',
                    border: '1px solid #e5e1eb',
                    borderRadius: 14,
                    padding: '20px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        1. PUBLIC ENTRY
                      </span>
                      <span style={{ background: '#f1f5f9', color: '#334155', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>
                        {fromChainName}
                      </span>
                    </div>

                    <h4 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#191820' }}>
                      {transaction.fromAsset === 'SOL'
                        ? `≈ $${transaction.fromAmount.toFixed(2)} value paid in SOL`
                        : `$${transaction.fromAmount.toFixed(2)} ${transaction.fromAsset}`}
                    </h4>
                    <div style={{ fontSize: 11, color: '#77727d', marginBottom: 14 }}>
                      Deposited from public wallet
                    </div>

                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'var(--font-ui)', color: '#475569' }}>
                      <div style={{ marginBottom: 4, color: '#64748b' }}>PUBLIC BLOCK ENTRY:</div>
                      <div style={{ wordBreak: 'break-all' }}>
                        {sourceTxHash || 'No transaction hash recorded'}
                      </div>
                      <div style={{ marginTop: 4, color: '#94a3b8' }}>
                        {depositLeg?.status === 'confirmed' && sourceTxHash
                          ? `Confirmed on ${fromChainName}`
                          : sourceTxHash
                            ? `Submitted to ${fromChainName}; awaiting confirmation`
                            : 'A blockchain transaction hash is not available.'}
                      </div>
                    </div>
                  </div>

                  {sourceExplorerUrl && (
                    <a href={sourceExplorerUrl} target="_blank" rel="noreferrer" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f1f5f9', display: 'block', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--violet, #6b55df)', textDecoration: 'none' }}>
                      Inspect {fromChainName} transaction <ExternalLinkIcon size={12} color="var(--violet)" />
                    </a>
                  )}
                </div>

                {/* Incoming Column 2: Shielding Enclave */}
                <div
                  style={{
                    background: 'linear-gradient(180deg, #f5f2ff 0%, #ede7ff 100%)',
                    border: '2px solid var(--violet, #6b55df)',
                    borderRadius: 14,
                    padding: '20px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    position: 'relative',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: -11,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      background: 'var(--violet, #6b55df)',
                      color: '#fff',
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      padding: '2px 10px',
                      borderRadius: 12,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    SHIELDING STAGE
                  </div>

                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--violet, #6b55df)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        2. ZCASH TESTNET
                      </span>
                      <span style={{ background: '#e0d7ff', color: '#523ec9', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>
                        {shieldedLeg?.status === 'confirmed' && shieldedTxHash
                          ? 'CONFIRMED'
                          : shieldedLeg?.status === 'failed'
                            ? 'FAILED'
                            : shieldedTxHash
                              ? 'PENDING'
                              : 'NO TX HASH'}
                      </span>
                    </div>

                    <h4 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: '#2a1a6b' }}>
                      Real Zcash transaction
                    </h4>
                    <div style={{ fontSize: 11, color: '#5b4f8c', marginBottom: 14 }}>
                      AURA pays from confirmed shielded Zcash Testnet inventory. Each visible Pay creates a real Zcash shielded spend and records its txid before the destination payout; mining confirmation may finish asynchronously.
                    </div>

                    <div style={{ background: '#fff', border: '1px solid #d9d0ff', borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'var(--font-ui)', color: '#43347a' }}>
                      <div style={{ marginBottom: 4, color: 'var(--violet, #6b55df)', fontWeight: 700 }}>
                        ZCASH TRANSACTION ID:
                      </div>
                      <div style={{ wordBreak: 'break-all', marginBottom: 4 }}>
                        {shieldedTxHash || 'Not recorded'}
                      </div>
                      <div style={{ color: '#64748b', fontWeight: 500 }}>
                        A real Zcash transaction does not prove user self-custody or transaction unlinkability.
                      </div>
                    </div>
                  </div>

                  {shieldedExplorerUrl && (
                    <a href={shieldedExplorerUrl} target="_blank" rel="noreferrer" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #d9d0ff', display: 'block', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--violet, #6b55df)', textDecoration: 'none' }}>
                      Inspect Zcash Testnet transaction <ExternalLinkIcon size={12} color="var(--violet)" />
                    </a>
                  )}
                </div>

                {/* Incoming Column 3: Shielded Private Balance */}
                <div
                  style={{
                    background: '#fff',
                    border: '1px solid #e5e1eb',
                    borderRadius: 14,
                    padding: '20px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: '#475569', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        3. PRIVATE BALANCE
                      </span>
                      <span style={{ background: privateCreditConfirmed ? 'var(--green-light)' : 'var(--warning-light)', color: privateCreditConfirmed ? 'var(--green-dark)' : 'var(--warning)', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>
                        {privateCreditConfirmed ? 'BALANCE CREDITED' : 'WAITING FOR CONFIRMATION'}
                      </span>
                    </div>

                    <h4 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, color: 'var(--green)' }}>
                      {privateCreditConfirmed
                        ? `+$${transaction.toAmount.toFixed(2)} private-balance value`
                        : `$${transaction.toAmount.toFixed(2)} pending; not yet credited`}
                    </h4>
                    <div style={{ fontSize: 11, color: '#77727d', marginBottom: 14 }}>
                      {privateCreditConfirmed
                        ? 'Credited after the Zcash Testnet transaction was confirmed.'
                        : 'The value is not available in Private Balance until Zcash confirmation.'}
                    </div>

                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, fontSize: 11, fontFamily: 'var(--font-ui)', color: '#475569' }}>
                      <div style={{ marginBottom: 4, color: '#64748b' }}>VAULT STATUS:</div>
                      <div style={{ marginBottom: 4, color: '#191820' }}>
                        AURA-operated, pre-funded Zcash Testnet inventory with tenant-scoped authorization. This prototype is not user self-custody.
                      </div>
                      <div style={{ color: privateCreditConfirmed ? 'var(--green-dark)' : 'var(--warning)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        {privateCreditConfirmed && <CheckIcon size={12} color="var(--green-dark)" />}
                        <span>{shieldedTxHash ? 'Real Zcash transaction recorded; unlinkability is not proven.' : 'No real Zcash transaction ID is recorded for this attempt.'}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #f1f5f9', textAlign: 'center', fontSize: 11, color: privateCreditConfirmed ? 'var(--green-dark)' : 'var(--warning)', fontWeight: 700 }}>
                    {privateCreditConfirmed ? 'Private Balance credited after confirmation · public entry remains visible' : 'Still processing · no balance credit yet'}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Explanatory Callout Banner */}
          <div
            style={{
              background: '#fff',
              border: '1px solid #e5e1eb',
              borderRadius: 12,
              padding: '16px 20px',
              marginTop: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div style={{ fontSize: 12, color: '#56515d', lineHeight: 1.5 }}>
              <strong style={{ color: '#191820', display: 'block', marginBottom: 2 }}>
                Privacy Mechanism Note:
              </strong>
              {shieldedTxHash
                ? 'A real Zcash Testnet transaction is recorded for this attempt. '
                : 'No real Zcash Testnet transaction ID is recorded for this attempt. '}
              Public entry and exit may remain visible on {fromChainName} and {toChainName}; the payout service, timing, and amounts can still connect activity. This prototype does not prove unlinkability.
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'var(--violet, #6b55df)',
                color: '#fff',
                border: 0,
                borderRadius: 8,
                padding: '10px 20px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Done Inspecting
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
