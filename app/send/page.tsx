/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import { useState, useEffect } from 'react'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { UnlinkabilityModal } from '@/components/unlinkability-modal'
import { CryptoIcon } from '@/components/crypto-icon'
import { useAura } from '@/lib/context/aura-context'
import { AssetSymbol, AuraTransaction, ChainId, PrivacyBufferMode } from '@/lib/types/aura'
import {
  ZapIcon,
  SparkleIcon,
  ShieldIcon,
  ChevronDownIcon,
  ArrowRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  AlertTriangleIcon,
  ExternalLinkIcon,
  CopyIcon,
  ClockIcon,
  CloseIcon,
} from '@/components/aura-icons'
import { LiveExecutionLogPanel } from '@/components/live-execution-log-panel'
import { NetworkRouteSelector } from '@/components/network-route-selector'
import { isFreshMarketRate } from '@/lib/utils/market-rates'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { VerifiedReceiptCard } from '@/components/verified-receipt-card'
import { DEMO_DESTINATION_NETWORKS } from '@/lib/config/capabilities'
import { fundingAgeMs, fundingValueUsdAtRate, fundingCorrelationValueUsd } from '@/lib/utils/privacy-risk'
import { canonicalExplorerUrl } from '@/lib/utils/explorer-links'
import { LiveProtocolStream, ProtocolLogEntry } from '@/components/live-protocol-stream'

export default function SendPage() {
  const { privateBalance, setPrivacyPolicy, executeSend, rates, transactions, loadingTransactions } = useAura()
  const [sendAmount, setSendAmount] = useState('2.50')
  const [sendAsset, setSendAsset] = useState<AssetSymbol>('SOL')
  const [sendChain, setSendChain] = useState<'Solana' | 'Base'>('Solana')
  const [sendRecipient, setSendRecipient] = useState('')
  const [privacyMode, setPrivacyMode] = useState<PrivacyBufferMode>(privateBalance.privacyPolicy || 'private')
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)
  const [sendExecutionStatus, setSendExecutionStatus] = useState<'idle' | 'routing' | 'sent'>('idle')
  const [sendLogs, setSendLogs] = useState<ProtocolLogEntry[]>([])

  const addSendLog = (tag: string, message: string, type: ProtocolLogEntry['type'] = 'info', explorerUrl?: string, explorerLabel?: string) => {
    const time = new Date().toLocaleTimeString()
    setSendLogs((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].message === message) return prev
      return [
        ...prev,
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          time,
          tag,
          message,
          type,
          explorerUrl,
          explorerLabel,
        },
      ]
    })
  }

  const [lastTx, setLastTx] = useState<AuraTransaction | null>(null)
  const [showInspector, setShowInspector] = useState(false)
  const [showTechDetails, setShowTechDetails] = useState(false)
  const [autoDetectedNetwork, setAutoDetectedNetwork] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const isDeliveryComplete = hasCompletedDestinationDelivery(lastTx)
  const isPayoutSubmitted = Boolean(lastTx && (isDeliveryComplete || lastTx.status === 'settling_destination'))
  const isDeliveryFailed = lastTx?.status === 'failed'
  const isDeliveryPending = Boolean(lastTx && !isDeliveryComplete && !isDeliveryFailed)
  const lastDeliveryExplorerUrl = lastTx?.legs?.delivery?.txHash
    ? canonicalExplorerUrl(lastTx.toChain, lastTx.legs.delivery.txHash, lastTx.legs.delivery.explorerUrl)
    : lastTx?.legs?.delivery?.explorerUrl
  const isShieldedSpendConfirmed = Boolean(
    lastTx?.legs?.shielded?.status === 'confirmed' &&
    /^[a-f0-9]{64}$/i.test(lastTx.legs.shielded.txHash || '')
  )
  const latestDeposit = transactions
    .filter((transaction) => transaction.type === 'deposit' && transaction.status === 'completed')
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))[0] || null

  // Sync privacy mode with vault policy
  useEffect(() => {
    if (privateBalance.privacyPolicy) {
      setPrivacyMode(privateBalance.privacyPolicy)
    }
  }, [privateBalance.privacyPolicy])

  // Jury Demo has a durable, server-controlled Solana recipient that is
  // intentionally different from the payout relayer. Prefill it so the
  // verified demo can reach the review step without asking the reviewer to
  // invent or paste an address. Personal sessions remain manual.
  useEffect(() => {
    let active = true
    fetch('/api/wallet/solana-demo', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        const recipient = payload?.scope === 'jury' && typeof payload.recipientPublicKey === 'string'
          ? payload.recipientPublicKey.trim()
          : ''
        if (!active || !recipient) return
        setSendRecipient((current) => current || recipient)
        setAutoDetectedNetwork('Solana')
      })
      .catch(() => {})
    return () => { active = false }
  }, [])

  const policyWaitMs = {
    fast: 0,
    private: 24 * 60 * 60 * 1000,
    strong: 72 * 60 * 60 * 1000,
    custom: 7 * 24 * 60 * 60 * 1000,
  }[privacyMode]
  const chainBackedLedgerUsd = Math.max(0, Math.min(
    privateBalance.totalUsd ?? 0,
    privateBalance.fastAvailableToSendUsd ?? 0
  ))
  const currentZecUsd = isFreshMarketRate(rates.ZEC) ? rates.ZEC.usdPrice : 0
  const exactImmatureUsd = currentZecUsd > 0 && typeof privateBalance.immatureBufferedZec === 'number'
    ? privateBalance.immatureBufferedZec * currentZecUsd
    : Math.max(0, (privateBalance.totalUsd ?? 0) - (privateBalance.readyToSpendUsd ?? 0))
  const selectedPolicyReadyUsd = Math.max(0, Number((
    currentZecUsd > 0 ? chainBackedLedgerUsd - exactImmatureUsd : privateBalance.readyToSpendUsd
  ).toFixed(2)))
  const maxSendable = selectedPolicyReadyUsd
  const balanceUnavailable = loadingTransactions ||
    !privateBalance.vaultSynced ||
    privateBalance.syncStatus === 'error' ||
    privateBalance.zcashStateSynced !== true ||
    privateBalance.onChainZecBackedUsd === null

  const detectNetworkFromAddress = (addr: string): 'Solana' | 'Base' | null => {
    const clean = addr.trim()
    if (!clean) return null
    if (clean.startsWith('0x')) return 'Base'
    if (/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(clean)) return 'Solana'
    return null
  }

  const handleRecipientChange = (val: string) => {
    setSendRecipient(val)
    setPrivacyAcknowledged(false)
    const detected = detectNetworkFromAddress(val)
    if (detected === 'Solana') {
      setSendChain('Solana')
      setSendAsset('SOL')
      setAutoDetectedNetwork('Solana')
    } else if (detected === 'Base') {
      setAutoDetectedNetwork('Base')
    } else {
      setAutoDetectedNetwork(null)
    }
  }

  const handleAssetChange = (newAsset: AssetSymbol) => {
    setSendAsset(newAsset)
    if (newAsset === 'SOL') {
      setSendChain('Solana')
      setAutoDetectedNetwork('Solana')
    }
  }

  const changePrivacyPolicy = (policy: PrivacyBufferMode) => {
    setPrivacyMode(policy)
    setPrivacyPolicy(policy)
    setPrivacyAcknowledged(false)
  }

  const numAmount = parseFloat(sendAmount) || 0
  const assetRate = rates[sendAsset]
  const assetPrice = isFreshMarketRate(assetRate) ? assetRate.usdPrice : 0
  const recipientTokenQty = numAmount > 0
    ? (sendAsset === 'USDC' || sendAsset === 'USDT' ? numAmount : assetPrice > 0 ? numAmount / assetPrice : 0)
    : 0
  const canShowSolQuote = isFreshMarketRate(rates.ZEC) && isFreshMarketRate(rates.SOL)

  const youPayTotal = numAmount

  // Privacy Engine checks use only confirmed funding records from this tenant.
  // They are warnings about public correlation, not a promise of unlinkability.
  const confirmedFunding = transactions
    .filter((t) => (t.type === 'deposit' || t.type === 'receive') && t.status === 'completed')
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
  const latestFunding = confirmedFunding[0] || null
  const latestFundingAmount = latestFunding ? fundingValueUsdAtRate(latestFunding, currentZecUsd) : 0
  const latestFundingAgeMs = latestFunding ? fundingAgeMs(latestFunding, Date.now()) : Infinity
  const recentFundingTimingRisk = latestFundingAgeMs < 60 * 60 * 1000 && latestFundingAmount > 0
  // A longer policy is meaningful only when the latest fund has actually aged
  // through that window. Keep this separate from the short-term timing check
  // so the user can see why waiting is recommended even after the first hour.
  const policyAgeRisk = latestFunding !== null && privacyMode !== 'fast' &&
    latestFundingAgeMs >= 60 * 60 * 1000 && latestFundingAgeMs < policyWaitMs
  const matchingDeposit = confirmedFunding.find((t) => {
    if (!numAmount || numAmount <= 0) return false
    const depAmt = fundingCorrelationValueUsd(t)
    const amountEchoWindow = privacyMode === 'fast'
      ? 24 * 60 * 60 * 1000
      : privacyMode === 'private' || privacyMode === 'strong'
        ? 7 * 24 * 60 * 60 * 1000
        : 14 * 24 * 60 * 60 * 1000
    if (depAmt <= 0 || fundingAgeMs(t, Date.now()) >= amountEchoWindow) return false
    const tolerance = Math.min(1.5, Math.max(0.3, depAmt * 0.02))
    return Math.abs(numAmount - depAmt) <= tolerance
  })
  const recentDepositMatch = !!matchingDeposit
  const refDepositAmount = matchingDeposit ? fundingCorrelationValueUsd(matchingDeposit) : 0
  const freshBalanceRisk = recentFundingTimingRisk && numAmount >= Math.min(1, latestFundingAmount * 0.5)
  const fullBalanceExit = privateBalance.totalUsd > 0 && numAmount >= (privateBalance.totalUsd * 0.90)
  const waitPortionUsed = numAmount > selectedPolicyReadyUsd && privacyMode !== 'fast'
  const policyLabel = privacyMode === 'private'
    ? '1-day buffer'
    : privacyMode === 'strong'
      ? '3-day buffer'
      : privacyMode === 'custom'
        ? '7-day buffer'
        : 'no'

  // Check if an older mature balance can be safely and realistically used
  // selectedPolicyReadyUsd already excludes every deposit that is still inside
  // the selected wait window. Subtracting the fresh matching deposit again
  // incorrectly erased the older mature balance from the demo.
  const olderMatureUsd = selectedPolicyReadyUsd
  const canUseOlderReadyBalance = recentDepositMatch && olderMatureUsd >= 0.01 && olderMatureUsd >= numAmount
  const olderReadyBalanceDisplay = olderMatureUsd.toFixed(2)

  const activePrivacyWarnings: string[] = []
  if (confirmedFunding.length > 0 && !recentFundingTimingRisk && !recentDepositMatch) {
    activePrivacyWarnings.push('AURA has confirmed funding history for this balance. No recent timing or amount match is detected, but public entry and exit remain visible.')
  }
  if (recentFundingTimingRisk) {
    activePrivacyWarnings.push(`A confirmed funding event is only ${Math.max(1, Math.round(latestFundingAgeMs / 60000))} minutes old. A public observer can compare the entry and exit timing.`)
  }
  if (policyAgeRisk) {
    activePrivacyWarnings.push(`The latest funding event has not aged through the selected ${policyLabel} privacy window yet. Waiting longer separates the balance from the payment more clearly.`)
  }
  if (recentDepositMatch && refDepositAmount > 0) {
    activePrivacyWarnings.push(`This payment closely matches a funding amount of about $${refDepositAmount.toFixed(2)} within the selected comparison window. That amount echo makes the two public legs easier to correlate.`)
  }
  if (freshBalanceRisk && !recentDepositMatch) {
    activePrivacyWarnings.push('This payment uses a large part of a newly confirmed balance. Keeping some balance back or waiting longer reduces the fresh-balance clue.')
  }
  if (fullBalanceExit) {
    activePrivacyWarnings.push('This payment is nearly the entire Private Balance. A full-balance exit creates a strong amount pattern across public chains.')
  }

  const getAddressError = () => {
    if (!sendRecipient.trim()) return null
    const addr = sendRecipient.trim()
    if (sendChain === 'Base') {
      return 'Base Sepolia payouts are not enabled in this demo. Choose a Solana Devnet address.'
    }
    if (addr.startsWith('0x')) return 'Base Sepolia payouts are not enabled in this demo. Choose a Solana Devnet address.'
    if (sendChain === 'Solana') {
      if (!/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(addr)) {
        return 'Solana Devnet requires a valid Base58 public key (32-44 characters).'
      }
      return null
    }
    return null
  }
  const addressError = getAddressError()

  const handleSendSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (numAmount <= 0) return
    if (!sendRecipient.trim() || addressError) return
    if (numAmount > selectedPolicyReadyUsd) return

    const chainId = (sendChain.toLowerCase() as ChainId)
    const buffer = privacyMode as PrivacyBufferMode

    setSendError(null)
    setSendExecutionStatus('routing')
    setSendLogs([])
    addSendLog('INIT', `Initiating payment of $${numAmount.toFixed(2)} to ${sendRecipient.slice(0, 8)}... (${sendChain})`, 'pending')
    try {
      const tx = await executeSend(
        sendRecipient,
        sendAsset,
        numAmount,
        chainId,
        buffer,
        (progress) => {
          if (progress.tag && progress.message) {
            addSendLog(
              progress.tag,
              progress.message,
              progress.tag === 'FINALIZED' ? 'success' : 'info',
              progress.explorerUrl,
              progress.explorerLabel
            )
          }
        }
      )
      if (tx) {
        setLastTx(tx)
        setSendExecutionStatus('sent')
        if (hasCompletedDestinationDelivery(tx)) {
          addSendLog('FINALIZED', `Payment confirmed on destination chain (${sendChain}) ✓`, 'success')
        } else if (tx.status === 'failed' || tx.legs?.delivery?.status === 'failed') {
          addSendLog('PENDING', 'The private spend is recorded, but the destination payout needs recovery.', 'error')
        } else {
          addSendLog('PENDING', `Payment queued. Waiting for final ${sendChain} confirmation.`, 'pending')
        }
      } else {
        setSendExecutionStatus('idle')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Payment processing failed.'
      setSendError(msg)
      addSendLog('ERROR', msg, 'error')
      setSendExecutionStatus('idle')
    }
  }

  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · PAY PRIVATELY
            </small>
            <h1>Pay from Private Balance</h1>
            <p>Choose a recipient and pay from the balance you already prepared. Your main wallet is not the direct payment source.</p>

            {/* Visual Route Flow */}
            <div className="visual-flow" style={{ marginTop: 22, marginBottom: 0 }}>
              <span>ADD MONEY</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span>PRIVATE BALANCE</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span className="visual-flow-highlight">PAY A RECIPIENT</span>
            </div>
          </div>

          <div className="pay-purpose-card">
            <strong>Pay from your Private Balance.</strong>
            <span>AURA uses the prepared balance first, so your main wallet does not send the payment directly.</span>
            <strong style={{ marginTop: 8 }}>The recipient needs no AURA account.</strong>
            <span>Enter a normal Solana address and the recipient receives the payout on the selected test network.</span>
          </div>

          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto', textAlign: 'left' }}>
            <form onSubmit={handleSendSubmit}>
              {sendError && (
                <div
                  style={{
                    background: 'var(--danger-light)',
                    border: '1px solid var(--danger-border)',
                    color: 'var(--danger)',
                    padding: '12px 16px',
                    borderRadius: 10,
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginBottom: 20,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <AlertTriangleIcon size={16} color="var(--danger)" />
                  <span>{sendError}</span>
                </div>
              )}
              {balanceUnavailable && !sendError && sendExecutionStatus === 'idle' && (
                <div
                  role="status"
                  style={{
                    background: '#f8f6ff',
                    border: '1px solid #ded6ff',
                    color: '#41356f',
                    padding: '14px 16px',
                    borderRadius: 10,
                    fontSize: 13,
                    lineHeight: 1.5,
                    marginBottom: 20,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 14,
                    flexWrap: 'wrap',
                  }}
                >
                  <span>
                    <strong style={{ display: 'block', marginBottom: 2 }}>Connect or start the demo wallet first.</strong>
                    <span style={{ color: '#6d6487' }}>Pay unlocks after the authenticated Private Balance sync succeeds.</span>
                  </span>
                  <a
                    href="/balance"
                    style={{
                      color: 'var(--violet)',
                      fontWeight: 800,
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Open Balance →
                  </a>
                </div>
              )}
              {sendExecutionStatus === 'sent' && (
                <div
                  className="modal-status-badge"
                  style={{
                    background: isDeliveryPending ? 'var(--lav)' : isDeliveryFailed ? 'var(--danger-light)' : 'var(--green-dim)',
                    color: isDeliveryPending ? 'var(--violet)' : isDeliveryFailed ? 'var(--danger)' : 'var(--green)',
                    padding: '16px 20px',
                    marginBottom: 24,
                    border: isDeliveryPending ? '1px solid #c7b9fa' : isDeliveryFailed ? '1px solid var(--danger-border)' : '1px solid rgba(76, 168, 135, 0.3)',
                  }}
                >
                  <div>
                    <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
                      {isDeliveryPending ? (
                        <>
                          <SparkleIcon size={14} color="var(--violet)" />
                          <span>Payment is in progress. Waiting for network confirmation.</span>
                        </>
                      ) : isDeliveryFailed ? (
                        <><CloseIcon size={14} color="var(--danger)" /><span>Payment failed.</span></>
                      ) : (
                        <>
                          <CheckIcon size={16} color="var(--green)" />
                          <span>Payment Successfully Delivered!</span>
                        </>
                      )}
                    </strong>
                    <span style={{ fontSize: 12, opacity: 0.9, display: 'block', marginTop: 4 }}>
                      {isDeliveryPending
                        ? `Sent on ${sendChain}; final confirmation is still pending.`
                        : isDeliveryFailed
                          ? 'The recipient payout was not confirmed. Check the transaction details.'
                        : (lastTx?.toAsset === 'SOL'
                            ? `Delivered ${lastTx.toAmount} SOL (≈ $${numAmount.toFixed(2)}) to ${sendRecipient} on Solana Devnet.`
                            : `Delivered ${recipientTokenQty > 0 ? (sendAsset === 'USDC' || sendAsset === 'USDT' ? `$${numAmount.toFixed(2)} ${sendAsset}` : `${recipientTokenQty.toFixed(4)} ${sendAsset} (≈ $${numAmount.toFixed(2)})`) : `${sendAsset}`} to ${sendRecipient} on ${sendChain}.`)}
                    </span>

                    {/* Verified Execution Stepper */}
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                      <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, color: '#191820' }}>
                        Execution Log (Private Spend Lifecycle)
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 6, fontSize: 11 }}>
                        <div style={{ color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          <CheckIcon size={11} color="var(--green)" /> <span>1. Zcash spend source selected</span>
                        </div>
                        <div style={{ color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          <CheckIcon size={11} color="var(--green)" /> <span>2. Local intent authorization signed</span>
                        </div>
                        <div style={{ color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          <CheckIcon size={11} color="var(--green)" /> <span>3. Client spend intent committed</span>
                        </div>
                        <div style={{ color: isShieldedSpendConfirmed ? 'var(--green)' : 'var(--warning)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          {isShieldedSpendConfirmed ? <CheckIcon size={11} color="var(--green)" /> : <ClockIcon size={11} color="var(--warning)" />}
                          <span>{isShieldedSpendConfirmed ? '4. Private Zcash payment confirmed' : '4. Confirming the private Zcash payment...'}</span>
                        </div>
                        <div style={{ color: isPayoutSubmitted ? 'var(--green)' : 'var(--warning)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          {isPayoutSubmitted ? (
                            <CheckIcon size={11} color="var(--green)" />
                          ) : (
                            <ClockIcon size={11} color="var(--warning)" />
                          )}
                          <span>5. Payout submitted to {sendChain}</span>
                        </div>
                        <div style={{ color: isDeliveryComplete ? 'var(--green)' : 'var(--warning)', display: 'flex', alignItems: 'center', gap: 5 }}>
                          {isDeliveryComplete ? (
                            <CheckIcon size={11} color="var(--green)" />
                          ) : (
                            <ClockIcon size={11} color="var(--warning)" />
                          )}
                          <span>{isDeliveryComplete ? '6. Payment finally confirmed on the destination network' : '6. Waiting for final destination confirmation...'}</span>
                        </div>
                      </div>
                    </div>

                    {lastTx && (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(0,0,0,0.08)', fontSize: 11, fontFamily: 'var(--font-ui)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span>
                            {sendChain.toLowerCase() === 'solana' ? 'Solana Delivery' : 'Base Delivery'}:{' '}
                            <strong>
                              {lastTx.legs?.delivery?.txHash
                                ? `${lastTx.legs.delivery.txHash.slice(0, 18)}...`
                                : (isDeliveryComplete ? 'Confirmed on the destination network' : 'Awaiting destination confirmation')}
                            </strong>
                          </span>
                          {lastDeliveryExplorerUrl && (
                            <a
                              href={lastDeliveryExplorerUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: 'var(--violet)', fontWeight: 700, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                            >
                              <ExternalLinkIcon size={12} color="var(--violet)" />
                              <span>View on {sendChain.toLowerCase() === 'solana' ? 'SolScan' : 'BaseScan'}</span>
                            </a>
                          )}
                        </div>
                        <div style={{ color: '#77727d', marginTop: 4 }}>
                          Authorization: signed client intent {lastTx.zkData?.clientCommitmentHash ? `${lastTx.zkData.clientCommitmentHash.slice(0, 20)}...` : '(hash unavailable)'}
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <button
                            type="button"
                            onClick={() => setShowInspector(true)}
                            style={{
                              padding: '6px 12px',
                              background: '#fff',
                              border: '1px solid rgba(0,0,0,0.15)',
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            Inspect Privacy Relay Route →
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSendExecutionStatus('idle')
                              setSendAmount('2.50')
                              setSendRecipient('')
                              setPrivacyAcknowledged(false)
                            }}
                            style={{
                              padding: '6px 12px',
                              background: 'var(--green-dark)',
                              border: 'none',
                              borderRadius: 6,
                              color: '#fff',
                              fontSize: 11,
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            New Payment ↗
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {sendExecutionStatus === 'sent' && isDeliveryComplete && latestDeposit && lastTx ? (
                <VerifiedReceiptCard
                  deposit={latestDeposit}
                  spend={lastTx}
                  privateBalanceUsd={latestDeposit.toAmount}
                />
              ) : null}

              {sendExecutionStatus === 'routing' && (
                <div style={{ marginBottom: 24 }}>
                  <div className="modal-status-badge" style={{ padding: '16px 20px', marginBottom: 12, background: 'var(--lav)', border: '1px solid #c7b9fa' }}>
                    <div>
                      <strong style={{ display: 'block', fontSize: 14, color: 'var(--violet)' }}>Paying from Private Balance...</strong>
                      <span style={{ fontSize: 12, opacity: 0.9, color: 'var(--ink)' }}>
                        Using the private Zcash balance first, then sending the test payout to {sendChain}...
                      </span>
                    </div>
                  </div>
                  <LiveProtocolStream
                    logs={sendLogs}
                    isLive={true}
                    summaryStatus="CONFIRMING PAYMENT"
                    maxHeight={160}
                  />
                </div>
              )}

              {sendExecutionStatus === 'sent' && sendLogs.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <LiveProtocolStream
                    logs={sendLogs}
                    isLive={false}
                    summaryStatus={
                      isDeliveryComplete
                        ? 'PAYMENT DELIVERED ✓'
                        : isDeliveryFailed
                          ? 'PAYMENT FAILED'
                          : 'PAYMENT PROCESSING'
                    }
                    maxHeight={160}
                  />
                </div>
              )}

              {/* Amount to Pay (Clean Editorial Header) */}
              <div className="form-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                    Amount to Pay
                  </label>
                  <span style={{ fontSize: 12, color: '#77727d' }}>
                    Available: <strong style={{ color: '#191820' }}>{balanceUnavailable ? '—' : `$${selectedPolicyReadyUsd.toFixed(2)}`}</strong>
                  </span>
                </div>
                
                <div className="aura-amount-input-wrap">
                  <input
                    type="text"
                    value={sendAmount}
                    onChange={(e) => {
                      setSendAmount(e.target.value)
                      setPrivacyAcknowledged(false)
                    }}
                    placeholder="0.00"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setSendAmount(maxSendable.toFixed(2))
                      setPrivacyAcknowledged(false)
                    }}
                    className="aura-max-btn"
                  >
                    MAX
                  </button>
                </div>
                {balanceUnavailable ? (
                  <small style={{ color: '#9a6700', display: 'block', marginTop: 6, fontWeight: 600 }}>
                    {loadingTransactions
                      ? 'Your private balance is syncing…'
                      : 'Your private balance is not ready yet. Pay unlocks after the confirmed balance sync finishes.'}
                  </small>
                ) : youPayTotal > privateBalance.totalUsd ? (
                  <small style={{ color: 'var(--danger)', display: 'block', marginTop: 6, fontWeight: 600 }}>
                    Total required (${youPayTotal.toFixed(2)}) exceeds total private balance (${privateBalance.totalUsd.toFixed(2)}).
                  </small>
                ) : null}
                {!balanceUnavailable && waitPortionUsed && youPayTotal <= privateBalance.totalUsd && (
                  <small style={{ color: '#9a6700', display: 'block', marginTop: 6, fontWeight: 600 }}>
                    Your selected {policyLabel} wait leaves ${selectedPolicyReadyUsd.toFixed(2)} ready. Lower the amount or choose Fast to skip the extra wait.
                  </small>
                )}

                {!balanceUnavailable && (
                  <div style={{ marginTop: 12, padding: '10px 12px', border: '1px solid #e5e1eb', borderRadius: 10, background: '#fbfaff', fontSize: 11, lineHeight: 1.5 }}>
                    <strong style={{ display: 'block', color: '#302c36', marginBottom: 4 }}>Before you pay</strong>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, color: '#77727d' }}>
                      <span>Still waiting: <b style={{ color: '#9a6700' }}>${Math.max(0, privateBalance.totalUsd - selectedPolicyReadyUsd).toFixed(2)}</b></span>
                      <span>Ready now: <b style={{ color: '#16805c' }}>${selectedPolicyReadyUsd.toFixed(2)}</b></span>
                      <span>Checks to review: <b style={{ color: activePrivacyWarnings.length > 0 ? '#c53b3b' : '#56515d' }}>{activePrivacyWarnings.length}</b></span>
                      <span>Next step: <b style={{ color: 'var(--violet)' }}>{waitPortionUsed ? 'Wait' : activePrivacyWarnings.length > 0 ? 'Review' : 'Pay'}</b></span>
                    </div>
                    <small style={{ display: 'block', marginTop: 5, color: '#77727d' }}>Final risk snapshot is recomputed and signed by the server when you request the payment.</small>
                  </div>
                )}
                
                <div className="aura-preset-group">
                  {['1.00', '2.50', '5.00', '10.00', '25.00', '100.00'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setSendAmount(preset)
                        setPrivacyAcknowledged(false)
                      }}
                      className={`aura-preset-btn ${sendAmount === preset ? 'active' : ''}`}
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Recipient Receives: Tactile Segmented Selectors (No raw HTML select!) */}
              <div className="form-row">
                <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
                  Recipient Receives
                </label>
                <div style={{ background: '#fbfafc', border: '1px solid rgba(222, 219, 229, 0.9)', borderRadius: 16, padding: '16px' }}>
                  <div style={{ marginBottom: 14 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#77727d', display: 'block', marginBottom: 6, textTransform: 'uppercase' }}>
                      Token Asset
                    </span>
                    <div className="aura-chip-group">
                      {(['SOL'] as AssetSymbol[]).map((asset) => (
                        <button
                          key={asset}
                          type="button"
                          className={`aura-chip ${sendAsset === asset ? 'active' : ''}`}
                          onClick={() => handleAssetChange(asset)}
                        >
                          <CryptoIcon name={asset} size={18} />
                          <span>{asset}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 12, padding: '10px 14px', background: '#f4f2f9', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CryptoIcon name="solana" size={16} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#191820' }}>
                      Solana Devnet · <strong style={{ color: 'var(--violet)' }}>Test payout</strong>
                    </span>
                  </div>
                  <small style={{ display: 'block', marginTop: 8, color: '#77727d', lineHeight: 1.5 }}>
                    This demo pays SOL on Solana Devnet. Base Sepolia payouts are not enabled.
                  </small>

                  <div style={{ marginTop: 16 }}>
                    <NetworkRouteSelector
                      title="Destination network"
                      selectedId={sendChain.toLowerCase()}
                      options={DEMO_DESTINATION_NETWORKS}
                      onSelect={() => {
                        setSendChain('Solana')
                        setSendAsset('SOL')
                      }}
                      helper="Live demo route: Zcash Testnet → Solana Devnet"
                    />
                  </div>
                </div>
              </div>

              {/* Recipient Address */}
              <div className="form-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                    Recipient Address
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
                          const text = await navigator.clipboard.readText()
                          if (text) handleRecipientChange(text.trim())
                        }
                      } catch {}
                    }}
                    style={{
                      background: 'var(--lav, #f0edff)',
                      border: '1px solid #d9d0ff',
                      color: 'var(--violet, #6b55df)',
                      padding: '3px 8px',
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <CopyIcon size={12} color="var(--violet, #6b55df)" />
                    <span>Paste</span>
                  </button>
                </div>
                <input
                  type="text"
                  value={sendRecipient}
                  onChange={(e) => handleRecipientChange(e.target.value)}
                  placeholder="Paste a Solana Devnet recipient address"
                  style={{ fontFamily: 'var(--font-ui)', fontSize: 13 }}
                />
                {sendRecipient && autoDetectedNetwork === 'Solana' && (
                  <small style={{ display: 'block', color: 'var(--green-dark, #16805c)', fontSize: 11, marginTop: 7 }}>
                    Demo recipient loaded for this Jury run.
                  </small>
                )}
                {addressError && (
                  <div
                    style={{
                      background: 'var(--danger-light)',
                      border: '1px solid var(--danger-border)',
                      borderRadius: 8,
                      padding: '8px 12px',
                      color: 'var(--danger)',
                      fontSize: 12,
                      fontWeight: 600,
                      marginTop: 8,
                      lineHeight: 1.4,
                    }}
                  >
                    {addressError}
                  </div>
                )}
              </div>

              {/* Privacy Policy & Settlement Speed */}
              <div className="form-row">
                <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
                  Payment timing
                </label>
                <small style={{ display: 'block', color: 'var(--muted)', fontSize: 11, lineHeight: 1.45, marginBottom: 10 }}>
                  Choose how much time to leave between adding money and paying. This can reduce simple timing clues, but it is not a privacy guarantee.
                </small>
                <div className="privacy-pills-wrap">
                  <button
                    type="button"
                    aria-pressed={privacyMode === 'fast'}
                    className={`privacy-pill ${privacyMode === 'fast' ? 'active' : ''}`}
                    onClick={() => changePrivacyPolicy('fast')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <div className="aura-policy-icon-badge">
                        <ZapIcon size={16} />
                      </div>
                      <div>
                        <strong>Fast</strong>
                        <small>Pay after the required confirmations. Fastest option.</small>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-pressed={privacyMode === 'private'}
                    className={`privacy-pill ${privacyMode === 'private' ? 'active' : ''}`}
                    onClick={() => changePrivacyPolicy('private')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <div className="aura-policy-icon-badge">
                        <SparkleIcon size={16} />
                      </div>
                      <div>
                        <strong>1-day buffer</strong>
                        <small>Wait 24 hours for more separation. Not a guarantee.</small>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-pressed={privacyMode === 'strong'}
                    className={`privacy-pill ${privacyMode === 'strong' ? 'active' : ''}`}
                    onClick={() => changePrivacyPolicy('strong')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <div className="aura-policy-icon-badge">
                        <ShieldIcon size={16} />
                      </div>
                      <div>
                        <strong>3-day buffer</strong>
                        <small>Wait 72 hours for more separation. Not a guarantee.</small>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-pressed={privacyMode === 'custom'}
                    className={`privacy-pill ${privacyMode === 'custom' ? 'active' : ''}`}
                    onClick={() => changePrivacyPolicy('custom')}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <div className="aura-policy-icon-badge">
                        <ClockIcon size={16} />
                      </div>
                      <div>
                        <strong>7-day buffer</strong>
                        <small>Wait 7 days for the longest demo separation. Not a guarantee.</small>
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              {/* PRIVACY CHECK (Section 12) */}
              {activePrivacyWarnings.length > 0 ? (
                <div
                  style={{
                    background: 'rgba(223, 85, 85, 0.05)',
                    border: '1px solid rgba(223, 85, 85, 0.3)',
                    borderRadius: 14,
                    padding: '16px 18px',
                    margin: '20px 0',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <strong style={{ color: '#c53b3b', fontSize: 13, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <AlertTriangleIcon size={14} color="#c53b3b" />
                      <span>Privacy Check</span>
                    </strong>
                    <span style={{ fontSize: 10, fontWeight: 800, background: 'rgba(223, 85, 85, 0.1)', color: '#c53b3b', padding: '2px 8px', borderRadius: 4 }}>
                      PRIVACY NOTICE
                    </span>
                  </div>

                  <div style={{ fontSize: 14, color: 'var(--danger)', fontWeight: 700, lineHeight: 1.5, marginBottom: 6 }}>
                    Privacy Check found {activePrivacyWarnings.length} public-correlation risk{activePrivacyWarnings.length === 1 ? '' : 's'}.
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.45, marginBottom: 14 }}>
                    <strong>Why this matters:</strong> the demo can reduce simple amount, timing, and full-balance clues, but it cannot promise unlinkability or hide the AURA operator from its own server records.
                  </div>
                  <ul style={{ margin: '0 0 14px', paddingLeft: 18, color: 'var(--danger)', fontSize: 12, lineHeight: 1.55 }}>
                    {activePrivacyWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 12, borderTop: '1px solid rgba(223, 85, 85, 0.2)' }}>
                    {!waitPortionUsed && <button
                      type="button"
                      onClick={() => setPrivacyAcknowledged(true)}
                      style={{
                        padding: '6px 14px',
                        background: privacyAcknowledged ? 'var(--green)' : '#fff',
                        color: privacyAcknowledged ? '#fff' : '#c53b3b',
                        border: `1px solid ${privacyAcknowledged ? 'var(--green)' : 'rgba(223, 85, 85, 0.4)'}`,
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {privacyAcknowledged && <CheckIcon size={12} color="#fff" />}
                        <span>Pay anyway</span>
                      </span>
                    </button>}

                    <button
                      type="button"
                      onClick={() => changePrivacyPolicy(waitPortionUsed ? 'fast' : privacyMode)}
                      style={{
                        padding: '6px 14px',
                        background: '#fff',
                        color: 'var(--violet)',
                        border: '1px solid #c7b9fa',
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      {waitPortionUsed ? 'Switch to Fast' : `Keep ${policyLabel}`}
                    </button>

                    {canUseOlderReadyBalance && (
                      <button
                        type="button"
                        onClick={() => {
                          setSendAmount(String(Math.min(numAmount, olderMatureUsd)))
                          setPrivacyAcknowledged(true)
                        }}
                        style={{
                          padding: '6px 14px',
                          background: 'var(--lav)',
                          color: 'var(--violet)',
                          border: '1px solid #c7b9fa',
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Limit payment to ready amount (${olderReadyBalanceDisplay})
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: '#f6f5f8',
                    border: '1px solid #d9d5df',
                    borderRadius: 14,
                    padding: '14px 18px',
                    margin: '20px 0',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 10,
                  }}
                >
                  <div>
                    <strong style={{ color: '#56515d', fontSize: 13, fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <CheckIcon size={14} color="#77727d" />
                      <span>No simple amount match found</span>
                    </strong>
                    <span style={{ fontSize: 12, color: '#56515d', opacity: 0.9, display: 'block', marginTop: 2 }}>
                      This check looks only for a simple amount match. Public entry, exit, timing, and amounts can still be connected.
                    </span>
                  </div>
                  <span className="platform-tag" style={{ background: '#ebe9ef', color: '#56515d' }}>
                    Amount check
                  </span>
                </div>
              )}

              {/* Exact-Output Confirmation Summary */}
              <div className="quote-summary-card">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, borderBottom: '1px solid #eee', paddingBottom: 12, marginBottom: 12 }}>
                  <div>
                    <span style={{ fontSize: 12, color: '#77727d', fontWeight: 600 }}>Recipient gets</span>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--green)', marginTop: 2 }}>
                      {sendChain === 'Solana'
                        ? canShowSolQuote ? `${recipientTokenQty.toFixed(4)} SOL` : 'Live payout quote unavailable'
                        : sendAsset === 'USDC' || sendAsset === 'USDT'
                        ? `$${numAmount > 0 ? numAmount.toFixed(2) : '0.00'} ${sendAsset}`
                        : `${recipientTokenQty.toFixed(4)} ${sendAsset}`}
                    </div>
                    <small style={{ fontSize: 12, color: '#77727d' }}>
                      {sendChain === 'Solana'
                        ? `≈ $${numAmount > 0 ? numAmount.toFixed(2) : '0.00'} on Solana Devnet`
                        : sendAsset !== 'USDC' && sendAsset !== 'USDT' && numAmount > 0
                        ? `≈ $${numAmount.toFixed(2)} on ${sendChain}`
                        : `on ${sendChain}`}
                    </small>
                  </div>
                  <div>
                    <span style={{ fontSize: 12, color: '#77727d', fontWeight: 600 }}>You pay</span>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#191820', marginTop: 2 }}>
                      ${youPayTotal > 0 ? youPayTotal.toFixed(2) : '0.00'}
                    </div>
                    <small style={{ fontSize: 11, color: '#77727d' }}>No extra route fee is simulated. Testnet network costs are paid by AURA&apos;s demo service.</small>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: '#77727d' }}>Network:</span>
                  <strong style={{ color: '#191820' }}>{sendChain === 'Solana' ? 'Solana Devnet' : 'Base Sepolia'}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: '#77727d' }}>Completion:</span>
                  <strong style={{ color: 'var(--green)' }}>After the networks confirm it</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: '#77727d' }}>How it is sent:</span>
                  <strong style={{ color: 'var(--green)' }}>AURA sends the testnet payout after confirmation</strong>
                </div>

                <div style={{ marginTop: 14, padding: '14px 16px', borderRadius: 12, background: '#f8f6ff', border: '1px solid #ded5ff' }}>
                  <strong style={{ display: 'block', color: '#191820', fontSize: 13, marginBottom: 9 }}>What will the recipient see?</strong>
                  <div style={{ display: 'grid', gap: 6, fontSize: 12, color: '#56515d', lineHeight: 1.5 }}>
                    <div><strong>Public payout address:</strong> <span style={{ fontFamily: 'var(--font-ui)', wordBreak: 'break-all' }}>{sendRecipient || 'the address you enter above'}</span></div>
                    <div><strong>Public payout:</strong> {sendChain === 'Solana' ? (canShowSolQuote ? `${recipientTokenQty.toFixed(4)} SOL` : 'SOL amount after quote confirmation') : `${numAmount.toFixed(2)} ${sendAsset}`}</div>
                    <div><strong>Time:</strong> the time the destination network confirms the payment.</div>
                    <div style={{ color: '#6b55df' }}>Your main wallet is not the direct payment source.</div>
                  </div>
                    <small style={{ display: 'block', marginTop: 9, color: '#77727d', fontSize: 12, lineHeight: 1.5 }}>Important: public entry, exit, timing, and amounts can still be connected.</small>
                </div>

                {/* Technical details toggle with smooth animated accordion */}
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #e7e4eb' }}>
                  <button
                    type="button"
                    onClick={() => setShowTechDetails(!showTechDetails)}
                    className={`tech-details-toggle ${showTechDetails ? 'open' : ''}`}
                  >
                    <span>{showTechDetails ? 'Hide technical details' : 'View technical details'}</span>
                    <ChevronDownIcon size={13} />
                  </button>
                  <div className={`tech-details-drawer ${showTechDetails ? 'open' : 'closed'}`}>
                    <div style={{ fontSize: 12, color: '#77727d', background: '#fff', padding: 14, borderRadius: 12, border: '1px solid #e7e4eb', lineHeight: 1.6 }}>
                      <div>• <strong>Payment checks:</strong> Private Balance + checks for timing, amount, and full-balance exposure.</div>
                      <div>• <strong>Privacy layer:</strong> Zcash shielded protocol and a payment intent signed in the browser.</div>
                      <div>• <strong>Zcash backing:</strong> AURA uses confirmed shielded Zcash Testnet inventory as the private-balance source. Pay creates a real Zcash shielded spend and records its txid before the Solana payout; mined confirmation can finish asynchronously. This is not self-custody.</div>
                      <div>• <strong>Routing:</strong> this demo uses AURA&apos;s testnet service. More networks can be added later.</div>
                      <div>• <strong>Public footprint:</strong> the recipient sees the payout. Public timing and amounts may still connect it to the source.</div>
                    </div>
                  </div>
                </div>
              </div>

              {(() => {
                const isBufferLimited = youPayTotal > selectedPolicyReadyUsd && youPayTotal <= privateBalance.totalUsd
                const isPrivacyWarningActive = activePrivacyWarnings.length > 0 && !privacyAcknowledged
                return (
                  <button
                    type="submit"
                    className="btn-large-primary"
                    disabled={
                      !canShowSolQuote ||
                      balanceUnavailable ||
                      sendExecutionStatus === 'routing' ||
                      numAmount <= 0 ||
                      youPayTotal > privateBalance.totalUsd ||
                      isBufferLimited ||
                      !sendRecipient.trim() ||
                      !!addressError ||
                      isPrivacyWarningActive
                    }
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                      <span>
                        {sendExecutionStatus === 'routing'
                          ? 'Delivering Privately...'
                          : isBufferLimited
                          ? `Aging in Privacy Buffer ($${selectedPolicyReadyUsd.toFixed(2)} Ready)`
                          : isPrivacyWarningActive
                          ? 'Review Privacy Check Above'
                          : 'Confirm Payment'}
                      </span>
                      <ArrowUpRightIcon size={16} color="#fff" />
                    </span>
                  </button>
                )
              })()}
            </form>
          </div>
        </div>
      </main>

      <UnlinkabilityModal
        isOpen={showInspector}
        onClose={() => setShowInspector(false)}
        transaction={lastTx}
      />

      <AuraFooter />
    </>
  )
}
