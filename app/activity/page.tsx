/** Hackathon testnet demo activity. */

'use client'

import { useEffect, useState } from 'react'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { UnlinkabilityModal } from '@/components/unlinkability-modal'
import { ExecutionLogDrawer } from '@/components/execution-log-drawer'
import { LiveExecutionLogPanel } from '@/components/live-execution-log-panel'
import { useAura } from '@/lib/context/aura-context'
import { AuraTransaction } from '@/lib/types/aura'
import { ArrowRightIcon, SparkleIcon, RefreshIcon } from '@/components/aura-icons'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { VerifiedReceiptCard, VerifiedProof } from '@/components/verified-receipt-card'

function formatAuraTx(item: AuraTransaction) {
  const isPositive = item.type === 'deposit' || item.type === 'receive'
  const isShieldedVaultState =
    (item.type === 'deposit' || item.type === 'receive') && item.legs?.shielded?.status === 'confirmed'
  const isSharedPoolBacking = item.settlementMode === 'jury_inventory' && item.backingSource === 'confirmed_zcash_inventory'
  // A Solana send is complete only after the destination leg itself is
  // finalized. Never let a stale `completed` record leak into the activity UI.
  const isCompleted = item.toChain === 'solana'
    ? hasCompletedDestinationDelivery(item)
    : item.status === 'completed'

  let title = 'Private Transfer'
  if (item.type === 'deposit') title = 'Added money'
  else if (item.type === 'receive') title = 'Received money'
  else if (item.type === 'send') title = 'Paid someone'
  else if (item.type === 'withdraw') title = 'Withdrew money'

  let subtitle = `${item.fromChain?.toUpperCase()} → ${item.toChain?.toUpperCase()}`
  if (item.recipientAddress) {
    subtitle += ` (${item.recipientAddress.slice(0, 8)}...)`
  }

  const sign = isPositive ? '+' : '-'
  let amountFormatted = ''
  if (!isPositive) {
    const usd = item.fromAmount || item.toAmount || 0
    if (item.toAsset === 'SOL' && item.toAmount) {
      amountFormatted = `-$${usd.toFixed(2)} (${item.toAmount} SOL)`
    } else {
      amountFormatted = `-$${usd.toFixed(2)} ${item.toAsset || 'USDC'}`
    }
  } else {
    const usd = item.toAmount || item.fromAmount || 0
    amountFormatted = `+$${usd.toFixed(2)} ${item.toAsset || 'USDC'}`
  }

  const timeDiff = Math.max(0, Math.floor((Date.now() - (item.createdAt || Date.now())) / 1000))
  let timeAgo = 'Just now'
  if (timeDiff >= 86400) timeAgo = `${Math.floor(timeDiff / 86400)}d ago`
  else if (timeDiff >= 3600) timeAgo = `${Math.floor(timeDiff / 3600)}h ago`
  else if (timeDiff >= 60) timeAgo = `${Math.floor(timeDiff / 60)}m ago`

  let statusLabel = 'Processing'
  if (item.status === 'failed') {
    statusLabel = 'Failed'
  } else if (isCompleted) {
    statusLabel = 'Completed'
  } else if (item.status === 'settling_destination' || item.status === 'routing_near') {
    statusLabel = 'Payout confirming'
  } else if (isShieldedVaultState) {
    statusLabel = isSharedPoolBacking ? 'Backed by Zcash pool' : 'In privacy pool'
  } else if (item.type === 'deposit') {
    if (item.legs?.shielded?.status === 'broadcasting') {
      if (item.legs?.shielded?.description?.includes('expired') || item.legs?.shielded?.description?.includes('retry') || item.legs?.shielded?.description?.includes('Re-broadcasted')) {
        statusLabel = 'Retrying shielding'
      } else {
        statusLabel = 'Shielding'
      }
    } else {
      statusLabel = 'Base confirmed'
    }
  }

  return {
    title,
    subtitle,
    amountFormatted,
    isPositive,
    isShielded: isShieldedVaultState,
    timeAgo,
    statusLabel,
  }
}

export default function ActivityPage() {
  const { transactions, loadingTransactions, refreshTransactions, privateBalance } = useAura()
  const [filter, setFilter] = useState<'all' | 'deposits' | 'sends' | 'received'>('all')
  const [showTechDetails, setShowTechDetails] = useState(false)
  const [showReferenceProof, setShowReferenceProof] = useState(false)
  const [showExecutionLog, setShowExecutionLog] = useState(false)
  // Keep only the stable identity here. The transaction itself can be
  // reconciled in the background (for example, after a Zcash retry), so a
  // copied object would leave the details drawer showing an obsolete txid.
  const [inspectTxId, setInspectTxId] = useState<string | null>(null)
  const [savedProof, setSavedProof] = useState<{ proof: VerifiedProof; verifiedAt: number; privateBalanceUsd: number; privateBalanceBeforeUsd?: number; checkpointAfterUsd?: number; depositCreditedUsd?: number } | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('proof') === '1') {
      setShowTechDetails(true)
      setShowReferenceProof(true)
    }
  }, [])

  useEffect(() => {
    let active = true
    void fetch('/api/proof/last-verified', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (active && payload?.available && payload.proof) {
          setSavedProof({
            proof: { ...payload.proof, balanceMark: payload.balanceMark },
            verifiedAt: Number(payload.verifiedAt || 0),
            privateBalanceUsd: Number(payload.privateBalanceUsd || 0),
            privateBalanceBeforeUsd: Number(payload.balanceCheckpoint?.beforeUsd || 0),
            checkpointAfterUsd: Number(payload.balanceCheckpoint?.afterUsd || 0),
            depositCreditedUsd: Number(payload.balanceCheckpoint?.deltaUsd || payload.balanceCheckpoint?.afterUsd || 0),
          })
        }
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  const [syncTimeoutReached, setSyncTimeoutReached] = useState(false)
  useEffect(() => {
    void refreshTransactions()
    const timer = setTimeout(() => {
      setSyncTimeoutReached(true)
    }, 3000)
    return () => clearTimeout(timer)
  }, [refreshTransactions])

  const userDeposits = transactions.filter((item) => item.type === 'deposit')
  const userSends = transactions.filter((item) => item.type === 'send' || item.type === 'withdraw')
  const latestDeposit = userDeposits[0] || null
  const latestSpend = userSends.find((item) => hasCompletedDestinationDelivery(item)) || userSends[0] || null
  const inspectTx = inspectTxId ? transactions.find((item) => item.id === inspectTxId) || null : null

  const filtered = transactions.filter((t) => {
    if (filter === 'all') return true
    if (filter === 'deposits') return t.type === 'deposit'
    if (filter === 'sends') return t.type === 'send' || t.type === 'withdraw'
    if (filter === 'received') return t.type === 'receive'
    return true
  })

  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · ACTIVITY
            </small>
            <h1>Activity</h1>
            <p>See what happened to your money.</p>
          </div>

          {/* Visual Route Flow */}
          <div className="visual-flow" style={{ marginBottom: 24 }}>
            <span>ADD MONEY</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span className="visual-flow-highlight">PRIVATE BALANCE</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span>PAY A RECIPIENT</span>
          </div>

          <div style={{ maxWidth: 660, margin: '0 auto 8px' }}>
            <div style={{ color: 'var(--violet)', fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Network receipt</div>
            <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>This receipt shows which network steps were confirmed. Your own activity is listed below.</div>
          </div>

          <VerifiedReceiptCard
            deposit={latestDeposit}
            spend={latestSpend}
            privateBalanceUsd={privateBalance.totalUsd}
            privateBalanceBeforeUsd={latestDeposit?.balanceCheckpoint?.beforeUsd ?? savedProof?.privateBalanceBeforeUsd}
            checkpointAfterUsd={latestDeposit?.balanceCheckpoint?.afterUsd ?? savedProof?.checkpointAfterUsd}
            depositCreditedUsd={latestDeposit?.balanceCheckpoint?.deltaUsd ?? latestDeposit?.toAmount ?? savedProof?.depositCreditedUsd}
            savedProof={showReferenceProof && !latestDeposit && !latestSpend ? savedProof?.proof : null}
            savedAt={savedProof?.verifiedAt}
            unavailable={!latestDeposit && !latestSpend && (!showReferenceProof || !savedProof)}
          />

          <div style={{ maxWidth: 660, margin: '28px auto 0' }}>
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 18, marginBottom: 14 }}>
              <div style={{ color: 'var(--ink)', fontSize: 13, fontWeight: 800 }}>Your activity</div>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>Only payments and balance changes for this account appear here.</div>
            </div>
            {/* Filter Tabs & Action Controls */}
            <div className="activity-controls" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <div className="activity-filter-group" style={{ flexShrink: 0 }}>
                {[
                  { key: 'all', label: 'All' },
                  { key: 'deposits', label: 'Deposits' },
                  { key: 'sends', label: 'Payments' },
                  { key: 'received', label: 'Received' },
                ].map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key as typeof filter)}
                    className={`activity-filter-btn ${filter === f.key ? 'active' : ''}`}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => refreshTransactions()}
                  className="activity-tech-toggle"
                  title="Refresh transaction confirmations"
                  style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                >
                  <RefreshIcon size={12} color="currentColor" />
                  <span>Refresh</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowTechDetails(!showTechDetails)}
                  className={`activity-tech-toggle ${showTechDetails ? 'active' : ''}`}
                  style={{ padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                >
                  {showTechDetails ? 'Hide details' : 'View details'}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setShowReferenceProof(true)
                    setShowExecutionLog(true)
                  }}
                  className="activity-tech-toggle"
                  style={{
                    background: 'var(--lav)',
                    color: 'var(--violet)',
                    borderColor: '#d9d0ff',
                    fontWeight: 700,
                    padding: '6px 10px',
                    fontSize: 11,
                    whiteSpace: 'nowrap',
                  }}
                >
                  For judges · verify demo
                </button>
              </div>
            </div>

            {/* Transaction List */}
            <div className="activity-table-card">
              {loadingTransactions && filtered.length > 0 && (
                <div style={{ padding: '8px 16px', background: 'var(--lav)', borderBottom: '1px solid #ede9fe', color: 'var(--violet)', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <RefreshIcon size={12} color="var(--violet)" />
                  <span>Syncing ledger with Zcash testnet...</span>
                </div>
              )}
              {loadingTransactions && filtered.length === 0 && !syncTimeoutReached ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#77727d', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <SparkleIcon size={14} color="var(--violet)" />
                  <span>Syncing activity...</span>
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '44px 24px', textAlign: 'center' }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: '50%',
                      background: 'var(--lav)',
                      display: 'grid',
                      placeItems: 'center',
                      margin: '0 auto 12px',
                    }}
                  >
                    <SparkleIcon size={18} color="var(--violet)" />
                  </div>
                  <strong style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#191820', marginBottom: 4 }}>
                    No private transactions in this filter
                  </strong>
                  <p style={{ color: '#77727d', fontSize: 12, margin: 0 }}>
                    Add money to your Private Balance or create a payment request to see your activity.
                  </p>
                </div>
              ) : (
                filtered.map((item) => {
                  const formatted = formatAuraTx(item)
                  const isDemoSeed = item.id === 'tx_rec_01' || item.id === 'tx_snd_02' || item.id === 'tx_dep_03' || item.id === 'tx_wth_04'
                  const chainHashes = [
                    { label: `${item.fromChain?.toUpperCase() || 'Source'} transaction`, hash: item.legs?.deposit?.txHash, chain: item.fromChain },
                    { label: 'Zcash Testnet transaction', hash: item.legs?.shielded?.txHash, chain: 'zcash' },
                    { label: `${item.toChain?.toUpperCase() || 'Destination'} transaction`, hash: item.legs?.delivery?.txHash, chain: item.toChain },
                  ].filter(({ hash, chain }) => {
                    if (!hash || !chain) return false
                    if (chain === 'solana') return /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(hash)
                    if (chain === 'zcash') return /^[a-fA-F0-9]{64}$/.test(hash)
                    return /^0x[a-fA-F0-9]{64}$/.test(hash)
                  })

                  return (
                    <div key={item.id} style={{ borderBottom: '1px solid #e7e4eb' }}>
                      <div className="activity-item-row">
                        <div>
                          <strong>
                            {formatted.title}
                            {isDemoSeed && (
                              <span style={{ background: '#f1f0f4', color: '#77727d', fontSize: 9, padding: '2px 6px', borderRadius: 4, marginLeft: 6, fontWeight: 700, verticalAlign: 'middle' }}>
                                DEMO SAMPLE
                              </span>
                            )}
                          </strong>
                          <small>{formatted.subtitle} • {formatted.timeAgo}</small>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <strong style={{ fontSize: 15, color: formatted.isPositive ? 'var(--green)' : '#191820' }}>
                            {formatted.amountFormatted}
                          </strong>
                          <span
                            className={formatted.isShielded ? 'comp-tag-private' : 'comp-tag-public'}
                            style={{ marginTop: 4, display: 'inline-block' }}
                          >
                            {formatted.statusLabel}
                          </span>
                        </div>
                      </div>

                      {showTechDetails && (
                        <div style={{ background: '#fcfbfe', borderTop: '1px dashed #e7e4eb', padding: '14px 24px', fontSize: 11, fontFamily: 'var(--font-ui)', color: '#56515d' }}>
                          <div style={{ marginBottom: 4 }}>
                            <span style={{ color: '#77727d' }}>Route:</span> <strong>{item.fromChain?.toUpperCase()} → {item.toChain?.toUpperCase()}</strong> (testnet)
                          </div>
                          {chainHashes.length ? chainHashes.map(({ label, hash }) => (
                            <div key={label} style={{ marginBottom: 4, wordBreak: 'break-all' }}>
                              <span style={{ color: '#77727d' }}>{label}:</span> {hash}
                            </div>
                          )) : <div style={{ color: '#77727d', marginBottom: 4 }}>No network transaction hash has been recorded yet.</div>}
                          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #eee' }}>
                            <button
                              type="button"
                              onClick={() => setInspectTxId(item.id)}
                              style={{
                                background: 'var(--lav)',
                                border: '1px solid var(--line)',
                                color: 'var(--violet)',
                                borderRadius: 6,
                                padding: '6px 12px',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                            >
                              View transaction details →
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </main>

      <UnlinkabilityModal
        isOpen={!!inspectTx}
        onClose={() => setInspectTxId(null)}
        transaction={inspectTx}
      />

      <ExecutionLogDrawer
        isOpen={showExecutionLog}
        onClose={() => setShowExecutionLog(false)}
        verifiedProof={savedProof ? {
          ...savedProof.proof,
          balanceCheckpoint: {
            beforeUsd: savedProof.privateBalanceBeforeUsd,
            afterUsd: savedProof.checkpointAfterUsd ?? savedProof.privateBalanceUsd,
            deltaUsd: savedProof.depositCreditedUsd,
          },
        } : null}
      />

      <AuraFooter />
    </>
  )
}
