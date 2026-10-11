/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { AuraLogo } from '@/components/aura-logo'
import { OdometerCounter } from '@/components/odometer-counter'
import { CryptoIcon } from '@/components/crypto-icon'
import { useAura } from '@/lib/context/aura-context'
import { AssetSymbol, ChainId, AuraTransaction } from '@/lib/types/aura'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { canonicalExplorerUrl } from '@/lib/utils/explorer-links'
import {
  PlusIcon,
  ArrowUpRightIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  SparkleIcon,
  CloseIcon,
  RefreshIcon,
  ShieldIcon,
  AlertTriangleIcon,
  ZapIcon,
  ShoppingBagIcon,
  BuildingIcon,
  CodeIcon,
  CheckIcon,
  WalletIcon,
  ClockIcon,
} from '@/components/aura-icons'
import { RecipientVisibilityCard } from '@/components/recipient-visibility-card'
import { PrivateBalanceExplainer } from '@/components/private-balance-explainer'
import { LiveProtocolStream, ProtocolLogEntry } from '@/components/live-protocol-stream'
import { DEMO_DESTINATION_NETWORKS, PUBLIC_ASSET_CAPABILITIES, PUBLIC_DESTINATION_ASSET_OPTIONS } from '@/lib/config/capabilities'

export default function HomePage() {
  const { wallet, privateBalance, connectWallet, executeDeposit, executeWithdraw, transactions, pendingDepositTransfer, clearPendingDepositTransfer, refreshTransactions } = useAura()

  // Quick Action Modal state from Hero Card
  const [activeModal, setActiveModal] = useState<'none' | 'add' | 'withdraw'>('none')
  const [depositAmount, setDepositAmount] = useState('1.00')
  const [depositStatus, setDepositStatus] = useState<'idle' | 'moving' | 'done' | 'pending'>('idle')
  const [depositTx, setDepositTx] = useState<AuraTransaction | null>(null)
  const [depositBaseTxHash, setDepositBaseTxHash] = useState<string | null>(null)
  const [depositZcashTxid, setDepositZcashTxid] = useState<string | null>(null)
  const [depositBaseConfirmed, setDepositBaseConfirmed] = useState<boolean>(false)
  const [depositZcashConfirmed, setDepositZcashConfirmed] = useState<boolean>(false)
  const [depositLogs, setDepositLogs] = useState<ProtocolLogEntry[]>([])
  const [depositError, setDepositError] = useState<string | null>(null)
  const [demoStartError, setDemoStartError] = useState<string | null>(null)

  const addDepositLog = (tag: string, message: string, type: ProtocolLogEntry['type'] = 'info', explorerUrl?: string, explorerLabel?: string) => {
    const time = new Date().toLocaleTimeString()
    setDepositLogs((prev) => {
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

  const activeBaseTxHash = depositBaseTxHash ||
    depositTx?.legs?.deposit?.txHash ||
    pendingDepositTransfer?.txHash ||
    null

  const activeBaseConfirmed = depositBaseConfirmed ||
    depositTx?.legs?.deposit?.status === 'confirmed' ||
    false

  const activeInventoryBacked = Boolean(
    depositTx?.settlementMode === 'jury_inventory' &&
    depositTx.backingSource === 'confirmed_zcash_inventory',
  )
  const activeZcashTxid = activeInventoryBacked
    ? null
    : depositZcashTxid || depositTx?.legs?.shielded?.txHash || null

  const activeZcashConfirmed = !activeInventoryBacked && Boolean(
    (depositZcashConfirmed || depositTx?.legs?.shielded?.status === 'confirmed') &&
    activeZcashTxid,
  )
  const [selectedDepositAsset, setSelectedDepositAsset] = useState<AssetSymbol>('USDC')
  const [withdrawAmount, setWithdrawAmount] = useState('5.00')
  const [withdrawStatus, setWithdrawStatus] = useState<'idle' | 'sending' | 'done' | 'pending'>('idle')
  const [withdrawTx, setWithdrawTx] = useState<AuraTransaction | null>(null)
  const [withdrawError, setWithdrawError] = useState<string | null>(null)
  const [withdrawDestination, setWithdrawDestination] = useState('')
  const [selectedWithdrawAsset, setSelectedWithdrawAsset] = useState<AssetSymbol>('SOL')
  const [selectedWithdrawChain, setSelectedWithdrawChain] = useState<ChainId>('solana')

  const [tilt, setTilt] = useState({ x: 0, y: 0 })

  const publicBalanceKnown = wallet.balanceSource === 'onchain' || wallet.balanceSource === 'sandbox_usdc'
  const publicUsdcBalance = wallet.publicUsdcBalance ?? 0
  // Never manufacture a balance while the authoritative tenant/Zcash read is
  // unavailable. The old fallback rendered a stale hardcoded amount on the
  // landing page, which could disagree with /balance and make a failed sync look like
  // a real funded wallet.
  const privateBalanceUnavailable = !privateBalance.vaultSynced ||
    privateBalance.syncStatus === 'error' ||
    privateBalance.onChainZecBackedUsd == null
  const displayTotalUsd = privateBalance.totalUsd
  const displayReadyUsd = privateBalance.readyToSpendUsd
  // Do not render a stale incoming amount after the corresponding deposit
  // reached a terminal failed state. Only a live ledger transaction may show
  // the shielding banner.
  const activeIncomingDeposit = transactions.find((transaction) => {
    if (transaction.type !== 'deposit' && transaction.type !== 'receive') return false
    const matchesPendingTransfer = pendingDepositTransfer?.txHash
      ? transaction.legs?.deposit?.txHash?.toLowerCase() === pendingDepositTransfer.txHash.toLowerCase()
      : true
    if (!matchesPendingTransfer) return false
    if (transaction.status === 'completed' || transaction.status === 'failed') return false
    if (transaction.legs?.deposit?.status === 'failed' || transaction.legs?.shielded?.status === 'failed') return false
    return transaction.status === 'processing' ||
      transaction.status === 'initiated' ||
      transaction.status === 'locking_base' ||
      transaction.status === 'routing_shielded' ||
      transaction.status === 'shielded' ||
      transaction.status === 'settling_destination' ||
      transaction.legs?.deposit?.status === 'pending' ||
      transaction.legs?.shielded?.status === 'broadcasting'
  })
  const incomingDepositUsd = activeIncomingDeposit?.toAmount ?? 0
  const incomingDepositUsesPoolBacking = Boolean(
    activeIncomingDeposit?.settlementMode === 'jury_inventory' &&
    activeIncomingDeposit.backingSource === 'confirmed_zcash_inventory',
  )

  // Subtle 3D resting angle (clean fintech depth without aggressive slant)
  const BASE_ROT_X = 2
  const BASE_ROT_Y = -3
  const BASE_ROT_Z = 0.5

  const handleCardMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    setTilt({
      x: (y - 0.5) * -2,
      y: (x - 0.5) * 2.5,
    })
  }

  const handleCardMouseLeave = () => {
    setTilt({ x: 0, y: 0 })
  }

  // FAQ accordion state
  const [openFaq, setOpenFaq] = useState<number | null>(0)

  useEffect(() => {
    const openRoadmapFromHash = () => {
      if (window.location.hash !== '#products') return
      const roadmap = document.querySelector('details[data-roadmap="true"]')
      if (!(roadmap instanceof HTMLDetailsElement)) return
      roadmap.open = true
      roadmap.scrollIntoView({ block: 'start' })
    }

    openRoadmapFromHash()
    window.addEventListener('hashchange', openRoadmapFromHash)
    return () => window.removeEventListener('hashchange', openRoadmapFromHash)
  }, [])

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setDepositError(null)
    const val = parseFloat(depositAmount)
    if (isNaN(val) || val <= 0) {
      setDepositError('Please enter a valid deposit amount.')
      return
    }
    setDepositStatus('moving')
    setDepositBaseTxHash(null)
    setDepositZcashTxid(null)
    setDepositBaseConfirmed(false)
    setDepositZcashConfirmed(false)
    setDepositLogs([])
    addDepositLog('INIT', `Submitting $${val.toFixed(2)} ${selectedDepositAsset} deposit on Base Sepolia...`, 'pending')
    try {
      const tx = await executeDeposit(
        selectedDepositAsset,
        val,
        'base',
        'deposit',
        undefined,
        (progress) => {
          if (progress.baseTxHash) {
            setDepositBaseTxHash(progress.baseTxHash)
            addDepositLog('BASE', `Broadcasted to Base Sepolia (${progress.baseTxHash.slice(0, 10)}...). Waiting for block confirmation (~2-3s)...`, 'pending', `https://sepolia.basescan.org/tx/${progress.baseTxHash}`, 'View on BaseScan ↗')
          }
          if (progress.baseConfirmed !== undefined) {
            setDepositBaseConfirmed(progress.baseConfirmed)
            if (progress.baseConfirmed) {
              addDepositLog('CONFIRMED', 'Base Sepolia deposit confirmed on-chain ✓', 'success')
            }
          }
          if (progress.zcashTxid) {
            setDepositZcashTxid(progress.zcashTxid)
            addDepositLog('ZCASH', `Shielded note broadcasted to Zcash Testnet (${progress.zcashTxid.slice(0, 10)}...). Entering shielded pool...`, 'pending', `https://testnet.cipherscan.app/tx/${progress.zcashTxid}`, 'View on Zcash Explorer ↗')
          }
          if (progress.zcashConfirmed !== undefined) {
            setDepositZcashConfirmed(progress.zcashConfirmed)
          }
          if (progress.logTag && progress.logMessage) {
            addDepositLog(progress.logTag, progress.logMessage, progress.logTag === 'SETTLED' || progress.logTag === 'CONFIRMED' ? 'success' : 'info')
          }
          if (progress.transaction) setDepositTx(progress.transaction)
        }
      )
      if (tx) {
        setDepositTx(tx)
        if (tx.legs?.deposit?.txHash) setDepositBaseTxHash(tx.legs.deposit.txHash)
        if (tx.legs?.deposit?.status === 'confirmed') setDepositBaseConfirmed(true)
        const usesPoolBacking = tx.settlementMode === 'jury_inventory' && tx.backingSource === 'confirmed_zcash_inventory'
        const isShieldedConfirmed = tx.status === 'completed' && (
          usesPoolBacking || Boolean(tx.legs?.shielded?.status === 'confirmed' && tx.legs?.shielded?.txHash)
        )
        if (isShieldedConfirmed) {
          setDepositBaseConfirmed(true)
          setDepositZcashConfirmed(!usesPoolBacking)
          setDepositStatus('done')
          addDepositLog(
            'SETTLED',
            usesPoolBacking
              ? `Base deposit confirmed and backed by AURA's confirmed shielded Zcash pool ✓ Added +$${val.toFixed(2)} to Private Balance!`
              : `Zcash shielded note confirmed in block ✓ Added +$${val.toFixed(2)} to Private Balance!`,
            'success',
          )
          void refreshTransactions()
        } else {
          setDepositStatus('pending')
            addDepositLog(
              'SYNC',
              usesPoolBacking
                ? 'Base deposit confirmed; waiting for the pooled private-balance allocation to finish...'
                : 'Monitoring Zcash testnet tip for block confirmation (target ~75s)...',
              'pending',
            )
        }
      } else {
        setDepositStatus('idle')
        setDepositError('Deposit failed to process.')
      }
    } catch (err: unknown) {
      const failure = err as Error & { pendingFinality?: boolean; txHash?: string; transaction?: AuraTransaction }
      if (failure.txHash) setDepositBaseTxHash(failure.txHash)
      if (failure.transaction) setDepositTx(failure.transaction)
      if (failure.pendingFinality) {
        setDepositStatus('pending')
        setDepositError(null)
      } else {
        setDepositStatus('idle')
        setDepositError(err instanceof Error ? err.message : 'Deposit failed. Please try again.')
      }
    }
  }

  // Polling for pending deposit confirmation on Homepage
  useEffect(() => {
    if (depositStatus !== 'pending' || !wallet.isDemoWallet) return
    let cancelled = false
    let attempts = 0
    const val = parseFloat(depositAmount)
    if (isNaN(val) || val <= 0) return

    const timer = window.setInterval(async () => {
      if (cancelled || attempts >= 180) return
      attempts += 1
      if (attempts % 4 === 0) {
        addDepositLog('SYNC', `Checking Zcash testnet ledger for note commitment (attempt #${attempts})...`, 'pending')
      }

      // If the shielded note was already broadcast to Zcash, check ledger confirmation instead of re-posting deposit
      if (depositZcashTxid || depositTx) {
        try {
          const txs = await refreshTransactions('all')
          if (cancelled) return
          const target = txs.find((t) =>
            (depositZcashTxid && t.legs?.shielded?.txHash?.toLowerCase() === depositZcashTxid.toLowerCase()) ||
            (depositBaseTxHash && t.legs?.deposit?.txHash?.toLowerCase() === depositBaseTxHash.toLowerCase()) ||
            (depositTx && t.id === depositTx.id)
          )
          if (target) {
            setDepositTx(target)
            if (target.legs?.deposit?.status === 'confirmed') setDepositBaseConfirmed(true)
            if (target.legs?.shielded?.txHash) setDepositZcashTxid(target.legs.shielded.txHash)
            const targetUsesPool = target.settlementMode === 'jury_inventory' && target.backingSource === 'confirmed_zcash_inventory'
            const isConfirmed = target.status === 'completed' && (
              targetUsesPool || Boolean(target.legs?.shielded?.status === 'confirmed' && target.legs?.shielded?.txHash)
            )
            if (isConfirmed) {
              setDepositBaseConfirmed(true)
              setDepositZcashConfirmed(!targetUsesPool)
              setDepositStatus('done')
              setDepositError(null)
              addDepositLog(
                'SETTLED',
                targetUsesPool
                  ? `Base deposit confirmed and backed by AURA's confirmed shielded Zcash pool ✓ Added +$${val.toFixed(2)} to Private Balance!`
                  : `Zcash shielded note confirmed in block ✓ Added +$${val.toFixed(2)} to Private Balance!`,
                'success',
              )
              window.clearInterval(timer)
              return
            }
          }
        } catch {
          // Keep polling smoothly
        }
        return
      }

      try {
        const tx = await executeDeposit(
          selectedDepositAsset,
          val,
          'base',
          'deposit',
          undefined,
          (progress) => {
            if (progress.baseTxHash) setDepositBaseTxHash(progress.baseTxHash)
            if (progress.baseConfirmed !== undefined) setDepositBaseConfirmed(progress.baseConfirmed)
            if (progress.zcashTxid) {
              setDepositZcashTxid(progress.zcashTxid)
              addDepositLog('ZCASH', `Shielded transaction in mempool (${progress.zcashTxid.slice(0, 10)}...).`, 'pending', `https://testnet.cipherscan.app/tx/${progress.zcashTxid}`, 'View on Zcash Explorer ↗')
            }
            if (progress.zcashConfirmed !== undefined) setDepositZcashConfirmed(progress.zcashConfirmed)
            if (progress.transaction) setDepositTx(progress.transaction)
          }
        )
        if (cancelled) return
        if (tx) {
          setDepositTx(tx)
          if (tx.legs?.deposit?.txHash) setDepositBaseTxHash(tx.legs.deposit.txHash)
          if (tx.legs?.shielded?.txHash) setDepositZcashTxid(tx.legs.shielded.txHash)
          const usesPoolBacking = tx.settlementMode === 'jury_inventory' && tx.backingSource === 'confirmed_zcash_inventory'
          const isShieldedConfirmed = tx.status === 'completed' && (
            usesPoolBacking || Boolean(tx.legs?.shielded?.status === 'confirmed' && tx.legs?.shielded?.txHash)
          )
          if (isShieldedConfirmed) {
            setDepositBaseConfirmed(true)
            setDepositZcashConfirmed(!usesPoolBacking)
            setDepositStatus('done')
            setDepositError(null)
            addDepositLog(
              'SETTLED',
              usesPoolBacking
                ? `Base deposit confirmed and backed by AURA's confirmed shielded Zcash pool ✓ Added +$${val.toFixed(2)} to Private Balance!`
                : `Zcash shielded note confirmed in block ✓ Added +$${val.toFixed(2)} to Private Balance!`,
              'success',
            )
            void refreshTransactions()
            window.clearInterval(timer)
          }
        }
      } catch (error) {
        if (cancelled) return
        const failure = error as Error & { pendingFinality?: boolean; txHash?: string; transaction?: AuraTransaction; code?: string }
        if (failure.txHash) setDepositBaseTxHash(failure.txHash)
        if (failure.transaction) setDepositTx(failure.transaction)
        if (failure.pendingFinality || failure.code === 'TX_ALREADY_USED' || failure.message?.includes('already being processed')) {
          // In-flight or already claimed; do not display error banner
          return
        }
        setDepositError(failure instanceof Error ? failure.message : 'The deposit is still processing.')
        window.clearInterval(timer)
      }
    }, 2000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [depositStatus, executeDeposit, depositAmount, selectedDepositAsset, wallet.isDemoWallet, depositZcashTxid, depositTx, depositBaseTxHash, refreshTransactions])

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setWithdrawError(null)
    const val = parseFloat(withdrawAmount)
    if (isNaN(val) || val <= 0) {
      setWithdrawError('Please enter a valid withdrawal amount.')
      return
    }

    const trimmedDest = withdrawDestination.trim()
    let destinationToUse = trimmedDest

    if (selectedWithdrawChain === 'solana') {
      if (!destinationToUse) {
        setWithdrawError('Solana withdrawals require a valid Solana Devnet recipient address (Base58 format).')
        return
      }
      if (!/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(destinationToUse)) {
        setWithdrawError('Invalid Solana recipient address. Must be a valid Base58 public key (32-44 characters).')
        return
      }
    } else if (selectedWithdrawChain === 'base') {
      if (!destinationToUse && wallet.connected && !wallet.isDemoWallet) {
        destinationToUse = wallet.address
      }
      if (!destinationToUse || !/^0x[a-fA-F0-9]{40}$/.test(destinationToUse)) {
        setWithdrawError('Base withdrawals require a valid 42-character EVM address (0x...).')
        return
      }
      if (wallet.isDemoWallet && destinationToUse.toLowerCase() === wallet.address.toLowerCase()) {
        setWithdrawError('Use a different Base Sepolia address. The demo wallet cannot send a payout to itself.')
        return
      }
    }

    setWithdrawStatus('sending')
    try {
      const tx = await executeWithdraw(selectedWithdrawAsset, val, selectedWithdrawChain, destinationToUse)
      if (tx) {
        setWithdrawTx(tx)
        if (tx.toChain === 'solana' ? hasCompletedDestinationDelivery(tx) : tx.status === 'completed') {
          setWithdrawStatus('done')
        } else {
          setWithdrawStatus('pending')
        }
      } else {
        setWithdrawStatus('idle')
        setWithdrawError('Withdrawal failed to process.')
      }
    } catch (err: unknown) {
      setWithdrawStatus('idle')
      setWithdrawError(err instanceof Error ? err.message : 'Withdrawal failed. Please check destination address.')
    }
  }

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index)
  }

  return (
    <>
      <AuraHeader />

      <main id="top">
        {/* Hero Section */}
        <section className="hero">
          <div className="hero-copy">
            <small className="eyebrow">
              <i></i> AURA · PRIVATE BALANCE
            </small>
            <h1>
              Private mode for your crypto.<br />
              <em>Pay without exposing your main wallet.</em>
            </h1>
            <p>
              Your wallet can reveal more than the payment. AURA puts a private balance between your main wallet and the people you pay — so they see the payment, not your financial history.
            </p>
            <div className="actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
              <button type="button" onClick={() => window.location.assign('/balance?tour=1&mode=preview')} title="Open AURA Private Balance preview">
                <span>Explore AURA</span>
                <ArrowRightIcon size={14} color="#fff" />
              </button>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event('aura:open-connect-wallet'))}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  border: 0,
                  padding: 0,
                  background: 'transparent',
                  color: 'var(--violet)',
                  font: '600 13px var(--font-ui)',
                  cursor: 'pointer',
                }}
              >
                <span>Connect Wallet</span>
                <ArrowRightIcon size={14} color="var(--violet)" />
              </button>
            </div>
            <div className="trust">
              <ShieldIcon size={16} color="var(--violet)" />
              <p>
                <strong>One private balance between your wallet and the people you pay.</strong>
                <small>You use AURA. They don&apos;t have to. Prepare once; AURA checks timing and amount before you send.</small>
              </p>
            </div>
            {demoStartError && (
              <p role="alert" style={{ margin: '10px 0 0', color: 'var(--danger)', fontSize: 12, fontWeight: 600 }}>
                {demoStartError}
              </p>
            )}
          </div>

          <div className="visual">
            <div className="visual-flow">
              <span>YOUR WALLET</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span className="visual-flow-highlight">PRIVATE BALANCE</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span>PAY ANYONE</span>
            </div>

            {/* Live demo scope vs. broader product direction */}
            <div
              className="hero-route-scope"
              style={{
                maxWidth: 1060,
                margin: '14px auto 20px',
                padding: '12px 16px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: 16,
                background: 'rgba(255,255,255,0.72)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                textAlign: 'left',
              }}
            >
              <div>
                <small style={{ display: 'block', color: 'var(--green)', fontWeight: 800, letterSpacing: '0.08em', fontSize: 9, textTransform: 'uppercase', marginBottom: 4 }}>
                  Product promise
                </small>
                <strong style={{ color: 'var(--ink)', fontSize: 12 }}>
                  Keep your main wallet out of the direct payment path.
                </strong>
              </div>
              <div className="hero-route-expansion">
                <small style={{ display: 'block', color: 'var(--violet)', fontWeight: 800, letterSpacing: '0.08em', fontSize: 9, textTransform: 'uppercase', marginBottom: 4 }}>
                  Current proof · testnet
                </small>
                <strong style={{ color: 'var(--ink)', fontSize: 12 }}>
                  Base Sepolia → Zcash Testnet → Solana Devnet
                </strong>
                <span style={{ display: 'block', color: 'var(--muted)', fontSize: 10, marginTop: 4 }}>
                  The chains prove the route. The product is the Private Balance and the check that runs before a payment leaves.
                </span>
                <span style={{ display: 'block', color: 'var(--muted)', fontSize: 10, marginTop: 4 }}>
                  Demo custody: server-operated testnet · Production direction: user-controlled keys.
                </span>
              </div>
            </div>

            <div
              className="product-card"
              onMouseMove={handleCardMouseMove}
              onMouseLeave={handleCardMouseLeave}
              style={{
                transform: `perspective(1800px) rotateX(${BASE_ROT_X + tilt.x}deg) rotateY(${BASE_ROT_Y + tilt.y}deg) rotateZ(${BASE_ROT_Z}deg)`,
              }}
            >
              <div className="card-head">
                <AuraLogo height={18} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                  <small>PRIVATE BALANCE</small>
                </div>
              </div>

              <div className="card-main">
                <div>
                  <small>Private Balance</small>
                  <strong>
                    {privateBalanceUnavailable ? (
                      <span style={{ fontSize: 22, color: 'var(--muted)' }}>Unavailable</span>
                    ) : (
                      <OdometerCounter value={displayTotalUsd} />
                    )}
                  </strong>
                  {incomingDepositUsd > 0 && (
                    <div style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6, background: '#ede8ff', padding: '3px 8px', borderRadius: 6, color: 'var(--violet)', fontSize: 11, fontWeight: 700 }}>
                      <ClockIcon size={11} color="var(--violet)" />
                      <span>+${incomingDepositUsd.toFixed(2)} USDC incoming · {incomingDepositUsesPoolBacking ? 'pool allocation' : 'shielding'}</span>
                    </div>
                  )}
                </div>
                <label>
                  <span className="card-beacon" />
                  <div>
                    Private state
                    <small>
                      {privateBalanceUnavailable
                        ? privateBalance.syncStatus === 'error'
                          ? 'Sync unavailable — retry required'
                          : 'Waiting for confirmed chain data'
                        : privateBalance.totalUsd > 0
                          ? 'Shielded balance synced'
                          : 'No funds in this balance'}
                    </small>
                  </div>
                </label>
              </div>

              <div style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', padding: '16px 0', marginTop: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <small style={{ fontSize: 10, fontWeight: 800, color: '#77727d', letterSpacing: '0.08em', textTransform: 'uppercase' }}>PAYMENT STATE</small>
                  <span style={{ fontSize: 10, fontWeight: 700, color: privateBalanceUnavailable ? 'var(--warning)' : 'var(--green)' }}>
                    {privateBalanceUnavailable ? 'SYNCING' : 'READY TO EXPLAIN'}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                  {[
                    ['Public entry', 'Base Sepolia'],
                    ['Private middle', 'Zcash Testnet'],
                    ['Public exit', 'Solana Devnet'],
                  ].map(([label, value]) => (
                    <div key={label} style={{ border: '1px solid var(--line)', borderRadius: 9, padding: '9px 10px', background: '#fcfbff' }}>
                      <small style={{ display: 'block', color: 'var(--muted)', fontSize: 9, marginBottom: 3 }}>{label}</small>
                      <strong style={{ color: 'var(--ink)', fontSize: 11 }}>{value}</strong>
                    </div>
                  ))}
                </div>
              </div>

              <div className="card-meta">
                <span>Balance state · <em style={{ color: privateBalanceUnavailable ? 'var(--warning)' : 'var(--green)' }}>{privateBalanceUnavailable ? 'awaiting chain confirmation' : 'ZEC-backed'}</em></span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: privateBalanceUnavailable ? 'var(--warning)' : 'var(--green)' }}>●</span>{' '}
                  {privateBalanceUnavailable ? 'Chain read pending' : 'Confirmed state'} · Testnet demo
                  {wallet.isDemoWallet && (
                    <span style={{ marginLeft: 6, fontSize: 10, background: 'var(--lav)', color: 'var(--violet)', padding: '1px 6px', borderRadius: 4, fontWeight: 700 }}>
                      DEMO
                    </span>
                  )}
                </span>
              </div>

              {/* Ready vs Policy Wait Dual Breakdown */}
              <div className="card-asset">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CryptoIcon name="ZEC" size={36} />
                </div>
                <div>
                  <strong>{privateBalanceUnavailable ? 'Private balance syncing' : 'Ready to spend'}</strong>
                  <div style={{ fontSize: 11, color: '#77727d', marginTop: 2 }}>
                    Privacy policy ·{' '}
                    {privateBalanceUnavailable
                      ? 'Waiting for confirmed chain data'
                      : privateBalance.shieldedWaitRemainingUsd > 0
                      ? `$${privateBalance.shieldedWaitRemainingUsd.toFixed(2)} pending under the active privacy policy`
                      : 'Ready under the active privacy policy'}
                  </div>
                </div>
                <b>
                  {privateBalanceUnavailable ? (
                    <span style={{ color: 'var(--muted)', fontSize: 13 }}>Unavailable</span>
                  ) : (
                    <OdometerCounter value={displayReadyUsd} />
                  )}
                </b>
              </div>

              {/* Elevated Action Buttons */}
              <div className="card-buttons">
                <button
                  type="button"
                  className="card-btn-primary"
                  onClick={() => {
                    setActiveModal('add')
                    setDepositStatus('idle')
                  }}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                >
                  <PlusIcon size={16} color="var(--violet)" />
                  <span>Add Money</span>
                </button>
                <Link href="/send" style={{ width: '100%', textDecoration: 'none', justifyContent: 'center' }}>
                  <ArrowUpRightIcon size={16} color="var(--violet)" />
                  <span>Pay</span>
                </Link>
                <Link href="/receive" style={{ width: '100%', textDecoration: 'none', justifyContent: 'center' }}>
                  <ArrowDownIcon size={16} color="var(--violet)" />
                  <span>Receive</span>
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section
          aria-label="AURA payment guardrail"
          style={{ maxWidth: 1120, margin: '0 auto', padding: '18px 24px 28px', textAlign: 'center' }}
        >
          <p style={{ margin: 0, color: 'var(--ink)', fontSize: 18, lineHeight: 1.45, fontWeight: 650 }}>
            A private balance is not enough. AURA checks whether your timing and amount are about to reconnect the payment before you send.
          </p>
        </section>

        <PrivateBalanceExplainer />

        <details style={{ maxWidth: 920, margin: '0 auto 34px', border: '1px solid var(--line)', borderRadius: 16, background: 'var(--paper)', padding: '0 22px' }}>
          <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '18px 0', color: 'var(--ink)', fontSize: 14, fontWeight: 800 }}>
            Why this matters · use case, privacy check, and honest limits
          </summary>
          <div style={{ paddingBottom: 4 }}>
            <section aria-label="Concrete use case" style={{ margin: '0 0 20px', padding: '0 0 20px', borderBottom: '1px solid var(--line)' }}>
              <span className="section-label">A concrete example</span>
              <h2 style={{ margin: '8px 0 8px', fontSize: 24, color: 'var(--ink)' }}>Keep your main wallet out of the payment.</h2>
              <p style={{ margin: 0, maxWidth: 760, color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                You have $50,000 in your main wallet and need to pay someone $100. Why expose the wallet you paid from? Keep only your spending money in Private Balance and pay from there.
              </p>
            </section>

            <section aria-label="Why now" style={{ margin: '0 0 20px', padding: '0 0 20px', borderBottom: '1px solid var(--line)' }}>
              <span className="section-label">Why now</span>
              <p style={{ margin: '8px 0 0', maxWidth: 780, color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                Stablecoins are becoming a real business payment rail, but onchain activity is still public by default. AURA turns the private middle into a product feature instead of making people manage cryptography themselves.
              </p>
            </section>

            <section aria-label="Privacy Guardrails" style={{ margin: 0, padding: '0 0 18px' }}>
              <span className="section-label">Privacy Guardrails</span>
              <h2 style={{ margin: '8px 0 8px', fontSize: 23, color: 'var(--ink)' }}>Private spending needs a check before it needs a button.</h2>
              <p style={{ margin: 0, maxWidth: 760, color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
                AURA combines payment-time warnings with a spending rule: timing, amount, and full-balance clues can be flagged before publication. Zcash is the private settlement layer underneath, and its confirmation rules become a plain-language check; the user never has to manage ZEC manually.
              </p>
              <p style={{ margin: '10px 0 0', maxWidth: 760, color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
                Track-specific value: someone who already uses a familiar USDC wallet should be able to reach a private working balance without learning Zcash operations. The demo shows the real Zcash step; live asset conversion is a production goal, not a claim of this testnet route.
              </p>
              <p style={{ margin: '10px 0 0', maxWidth: 760, color: 'var(--muted)', fontSize: 12, lineHeight: 1.55 }}>
                Honest boundary: the MVP displays a ZEC-backed USD value, so it can move with the ZEC price. The production direction is a stable-value private spending path; this demo reduces simple clues but does not claim perfect unlinkability or operator-level privacy.
              </p>
            </section>
          </div>
        </details>

        {/* SECTION 1: WHAT CAN THE RECIPIENT SEE? (5-Second Jury Comparison) */}
        <section className="problem-section" id="problem" style={{ paddingTop: 40, paddingBottom: 40 }}>
          <div className="section-head-center" style={{ marginBottom: 28 }}>
            <span className="section-label">01 — What Can the Recipient See?</span>
            <h2 style={{ fontSize: 28, fontWeight: 800, color: 'var(--ink)' }}>
              5-Second Comparison: Why You Need AURA
            </h2>
            <p style={{ maxWidth: 640, margin: '8px auto 0', color: 'var(--muted)', fontSize: 14 }}>
              Your wallet should not become your public financial identity. AURA creates a simple path: Your Wallet → Private Balance → Recipient.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, maxWidth: 920, margin: '0 auto' }}>
            {/* Normal Crypto Payment */}
            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: '24px',
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.02)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <span style={{ fontSize: 10, fontWeight: 800, background: 'rgba(223, 85, 85, 0.1)', color: '#c53b3b', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Normal Crypto Payment
                </span>
                <div style={{ margin: '16px 0 12px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 700, color: '#191820' }}>
                  <span>Main Wallet</span>
                  <ArrowRightIcon size={12} color="#c53b3b" />
                  <span>Recipient</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--danger)', marginBottom: 8 }}>
                  A recipient can inspect the public balance and history tied to the wallet you paid from.
                </div>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.55 }}>
                  Anyone you pay can inspect the balance and transaction history tied to the wallet you used, including incoming and outgoing addresses.
                </p>
              </div>
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 11, color: '#c53b3b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangleIcon size={13} color="#c53b3b" />
                <span>Public-chain activity remains visible on the wallet you paid from.</span>
              </div>
            </div>

            {/* AURA Payment */}
            <div
              style={{
                background: 'linear-gradient(180deg, #fbfaff 0%, #f5f2ff 100%)',
                border: '2px solid var(--violet)',
                borderRadius: 16,
                padding: '24px',
                boxShadow: '0 8px 30px rgba(107, 85, 223, 0.12)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--violet)', color: '#fff', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    AURA Private Payment
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--green)', background: 'var(--green-light)', padding: '2px 6px', borderRadius: 4 }}>
                    TESTNET ROUTE
                  </span>
                </div>
                <div style={{ margin: '16px 0 12px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: 'var(--ink)', flexWrap: 'wrap' }}>
                  <span>Main Wallet</span>
                  <ArrowRightIcon size={12} color="var(--violet)" />
                  <span style={{ background: 'var(--lav)', color: 'var(--violet)', padding: '2px 6px', borderRadius: 4 }}>Private Balance</span>
                  <ArrowRightIcon size={12} color="var(--violet)" />
                  <span>Recipient</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--violet)', marginBottom: 8 }}>
                  The payment comes from Private Balance, not directly from your main wallet.
                </div>
                <p style={{ fontSize: 12, color: '#5b4f8c', margin: 0, lineHeight: 1.55 }}>
                  The recipient gets the payment. Your main wallet is not the direct sender, although public timing and amount data may still make the route linkable.
                </p>
              </div>
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #d9d0ff', fontSize: 11, color: 'var(--violet)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <ShieldIcon size={13} color="var(--violet)" />
                <span>The demo keeps a Zcash-backed Private Balance between entry and exit. Timing and amounts may still link activity.</span>
              </div>
            </div>
          </div>

          {/* Section 13: What Can The Recipient See? Card */}
          <div style={{ maxWidth: 1060, margin: '24px auto 0' }}>
            <RecipientVisibilityCard />
          </div>
        </section>

        {/* SECTION 2: THE THREE-STEP FLOW */}
        <section className="steps" id="strengths" style={{ paddingTop: 30, paddingBottom: 40 }}>
          <div className="steps-title">
            <span className="section-label">02 — How it works</span>
            <h2>
              Add. Keep. Pay.<br />
              <em>Three clear steps.</em>
            </h2>
          </div>
          <p className="steps-lead">
            Aura turns a complicated cross-chain route into one simple balance. The current jury demo keeps the public entry and exit visible while the middle is backed by AURA&apos;s pre-funded Zcash Testnet inventory.
          </p>

          <div className="step-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <article>
              <b>01</b>
              <h3>Add crypto</h3>
              <p>Bring USDC from Base Sepolia. Aura verifies the deposit before adding it to your Private Balance.</p>
            </article>
            <article className="featured">
              <b>02</b>
              <h3>Keep it private</h3>
              <p>The balance is backed by a confirmed private Zcash Testnet step. Aura handles the technical work behind the interface.</p>
            </article>
            <article>
              <b>03</b>
              <h3>Pay out</h3>
              <p>Send SOL on Solana Devnet. The recipient gets the payment, and every completed step shows its real testnet receipt.</p>
            </article>
          </div>
        </section>

        <section aria-label="First customers" style={{ maxWidth: 920, margin: '0 auto 34px' }}>
          <span className="section-label">Who AURA is for</span>
          <div style={{ marginTop: 12, border: '1px solid var(--line)', borderRadius: 16, padding: '20px 22px', background: 'var(--card)' }}>
            <strong style={{ display: 'block', fontSize: 19, color: 'var(--ink)', marginBottom: 7 }}>Anyone who pays from a public wallet.</strong>
            <span style={{ display: 'block', color: 'var(--muted)', fontSize: 14, lineHeight: 1.6, maxWidth: 720 }}>Prepare a working balance once, then pay without making your main wallet the direct public payment source.</span>
          </div>
        </section>

        {/* SECTION 03: CURRENT ROUTE & NEXT NETWORKS */}
        <div id="products" aria-hidden="true" style={{ height: 1, marginTop: -1 }} />
        <details
          data-roadmap="true"
          className="ecosystem-section"
          style={{ maxWidth: 1180, margin: '0 auto', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}
        >
          <summary
            style={{ cursor: 'pointer', listStyle: 'none', padding: '18px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, color: 'var(--ink)', fontSize: 14, fontWeight: 800 }}
          >
            <span>What&apos;s next — networks and product directions</span>
            <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>Current route · expansion map</span>
          </summary>
        <section style={{ paddingTop: 18, paddingBottom: 30 }}>
          <div className="section-head-center" style={{ marginBottom: 32 }}>
            <span className="section-label">03 — Current route &amp; what&apos;s next</span>
            <h2 style={{ fontSize: 32, fontWeight: 900, color: 'var(--ink)', letterSpacing: '-0.03em' }}>
              Current testnet route. One route is enabled.
            </h2>
            <p style={{ maxWidth: 720, margin: '10px auto 0', color: 'var(--muted)', fontSize: 15, lineHeight: 1.6 }}>
              The current testnet route is scoped to Base Sepolia → Zcash Testnet → Solana Devnet. Other networks and product surfaces are clearly marked as coming next.
            </p>
          </div>

          {/* Strategic Roadmap Status Bar */}
          <div
            style={{
              maxWidth: 1060,
              margin: '0 auto 36px',
              background: '#ffffff',
              border: '1px solid var(--line)',
              borderRadius: 16,
              padding: '18px 24px',
              boxShadow: '0 4px 20px rgba(25, 24, 32, 0.04)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14, borderBottom: '1px solid #f0edf5', paddingBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SparkleIcon size={15} color="var(--violet)" />
                <strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink)' }}>
                  Current route &amp; expansion map
                </strong>
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', background: 'var(--green-light)', padding: '3px 8px', borderRadius: 6 }}>
                ● SUPPORTED ROUTE · TESTNET · EXPANSION NEXT
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
              <div style={{ background: 'var(--green-light)', border: '1px solid var(--green-border)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <strong style={{ fontSize: 13, color: '#065f46' }}>Private Balance</strong>
                  <span style={{ fontSize: 9, fontWeight: 800, background: '#f0edff', color: 'var(--violet)', padding: '1px 5px', borderRadius: 4 }}>SUPPORTED ROUTE</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Base Sepolia deposit · AURA-operated private Zcash inventory</div>
              </div>

              <div style={{ background: 'var(--paper)', border: '1px solid var(--lav-border)', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <strong style={{ fontSize: 13, color: 'var(--violet)' }}>Business Controls</strong>
                  <span style={{ fontSize: 9, fontWeight: 800, background: 'var(--lav)', color: 'var(--violet)', padding: '1px 5px', borderRadius: 4 }}>COMING NEXT</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Working-balance, approval, and selective audit/export controls for teams</div>
              </div>
            </div>
            <p style={{ maxWidth: 760, margin: '12px auto 0', color: 'var(--muted)', fontSize: 11, lineHeight: 1.55, textAlign: 'center' }}>
              The current core is Private Balance → Pay → Receive. Business controls and API are the only next-stage directions; they are not enabled in this demo.
            </p>
          </div>

          <details style={{ maxWidth: 1060, margin: '20px auto 0', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '16px 4px', color: 'var(--ink)', fontSize: 13, fontWeight: 800 }}>
              <span>Works now · scoped testnet routes</span>
              <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>Private Pay · AURA Request</span>
            </summary>

          {/* Expanded roadmap details */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, maxWidth: 1060, margin: '0 auto' }}>
            {/* 1. Private Pay — enabled in this scoped testnet demo */}
            <div
              style={{
                background: '#ffffff',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--green-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <WalletIcon size={18} color="var(--green)" />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--green)', color: '#ffffff', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>
                    ENABLED · TESTNET
                  </span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  Private Pay
                </h3>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 16 }}>
                  Pay from Private Balance to Solana Devnet in the scoped testnet route.
                </p>
              </div>
              <Link
                href="/send"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'var(--green)',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: 'none',
                }}
              >
                  <span>Try Demo</span>
                <ArrowRightIcon size={14} color="#ffffff" />
              </Link>
            </div>

            {/* 2. AURA Request */}
            <div
              style={{
                background: '#ffffff',
                border: '1.5px solid var(--green)',
                borderRadius: 16,
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 4px 16px rgba(16, 185, 129, 0.08)',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--green-light)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <RefreshIcon size={18} color="var(--green)" />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--green)', color: '#ffffff', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>
                    ENABLED · TESTNET
                  </span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  AURA Request
                </h3>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 16 }}>
                  Get paid via one-time private links without sharing your main wallet.
                </p>
              </div>
              <Link
                href="/receive"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'var(--green)',
                  color: '#ffffff',
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: 'none',
                }}
              >
                <span>Try Demo</span>
                <ArrowRightIcon size={14} color="#ffffff" />
              </Link>
            </div>

            {/* 3. AURA Commerce */}
            <div
              style={{
                background: '#ffffff',
                border: '1.5px solid var(--green)',
                borderRadius: 16,
                padding: '24px',
                display: 'none',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 4px 16px rgba(16, 185, 129, 0.08)',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--lav)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ShoppingBagIcon size={18} color="var(--violet)" />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--lav)', color: 'var(--violet)', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>
                    COMING NEXT
                  </span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  AURA Commerce
                </h3>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 16 }}>
                  Private checkout widget for online stores and creators.
                </p>
              </div>
              <Link
                href="/aura-pay"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'var(--lav)',
                  color: 'var(--violet)',
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: 'none',
                }}
              >
                <span>Learn More</span>
                <ArrowRightIcon size={14} color="var(--violet)" />
              </Link>
            </div>

            {/* 4. AURA Payroll */}
            <div
              style={{
                background: '#ffffff',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: '24px',
                display: 'none',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--lav)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <BuildingIcon size={18} color="var(--violet)" />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--lav)', color: 'var(--violet)', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>
                    COMING NEXT
                  </span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  AURA Payroll
                </h3>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 16 }}>
                  Pay people privately without exposing your main-wallet balance.
                </p>
              </div>
              <Link
                href="/business"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'var(--lav)',
                  color: 'var(--violet)',
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: 'none',
                }}
              >
                <span>Learn More</span>
                <ArrowRightIcon size={14} color="var(--violet)" />
              </Link>
            </div>

            {/* 5. Business Controls — shown in the separate coming-next summary */}
            <div
              style={{
                background: '#ffffff',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: '24px',
                display: 'none',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--lav)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <ZapIcon size={18} color="var(--violet)" />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--lav)', color: 'var(--violet)', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>
                    COMING NEXT
                  </span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  Business Controls
                </h3>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 16 }}>
                  Working-balance and payment policy tools for teams.
                </p>
              </div>
              <Link
                href="/business"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'var(--lav)',
                  color: 'var(--violet)',
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: 'none',
                }}
              >
                <span>Learn More</span>
                <ArrowRightIcon size={14} color="var(--violet)" />
              </Link>
            </div>

            {/* 6. More Networks */}
            <div
              style={{
                background: '#ffffff',
                border: '1px solid var(--line)',
                borderRadius: 16,
                padding: '24px',
                display: 'none',
                flexDirection: 'column',
                justifyContent: 'space-between',
                boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--lav)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <CodeIcon size={18} color="var(--violet)" />
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--lav)', color: 'var(--violet)', padding: '3px 8px', borderRadius: 4, letterSpacing: '0.04em' }}>
                    COMING NEXT
                  </span>
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>
                  More Networks
                </h3>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 16 }}>
                  Expand the same Private Balance flow beyond the current testnet route.
                </p>
              </div>
              <Link
                href="/business"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '10px 16px',
                  borderRadius: 10,
                  background: 'var(--lav)',
                  color: 'var(--violet)',
                  fontWeight: 700,
                  fontSize: 13,
                  textDecoration: 'none',
                }}
              >
                <span>Learn More</span>
                <ArrowRightIcon size={14} color="var(--violet)" />
              </Link>
            </div>
          </div>
          </details>
          <details style={{ maxWidth: 1060, margin: '18px auto 0', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '16px 4px', color: 'var(--ink)', fontSize: 13, fontWeight: 800 }}>
              Coming next · not enabled in this demo
            </summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, padding: '0 0 18px' }}>
              <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px' }}>
                <strong style={{ display: 'block', fontSize: 13, color: 'var(--violet)' }}>Business Controls</strong>
                <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>Team balances, approvals, and audit exports.</span>
              </div>
              <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px' }}>
                <strong style={{ display: 'block', fontSize: 13, color: 'var(--violet)' }}>More Networks</strong>
                <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>Expand the same Private Balance flow beyond this testnet route.</span>
              </div>
              <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px' }}>
                <strong style={{ display: 'block', fontSize: 13, color: 'var(--violet)' }}>API &amp; Commerce</strong>
                <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>Merchant checkout and programmable payment controls.</span>
              </div>
            </div>
          </details>
        </section>
        </details>

        {/* SECTION 04: Real route explanation */}
        <section className="transition-section" id="transition">
          <div className="transition-header">
            <span className="section-label">04 — How the demo is verified</span>
            <h2>Follow the real route.</h2>
            <p>The demo records every confirmed step. A visual animation is never presented as blockchain proof.</p>
          </div>

          <div className="transition-box" style={{ display: 'grid', gap: 16 }}>
            <div className="flow-cards">
              <div className="transfer-box">
                <small>Public entry</small>
                <strong>Base Sepolia</strong>
                <span>USDC deposit receipt</span>
              </div>
              <div className="transfer-arrow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ArrowRightIcon size={16} color="var(--violet)" />
              </div>
              <div className="transfer-box shielded">
                <small>Private Balance</small>
                <strong>Zcash Testnet</strong>
                <span>Pre-funded Zcash jury inventory</span>
              </div>
              <div className="transfer-arrow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <ArrowRightIcon size={16} color="var(--violet)" />
              </div>
              <div className="transfer-box">
                <small>Public exit</small>
                <strong>Solana Devnet</strong>
                <span>Finalized payout signature</span>
              </div>
            </div>
            <Link href="/activity" className="sim-button" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, textDecoration: 'none' }}>
              <span>View recorded activity</span>
              <ArrowRightIcon size={14} color="#fff" />
            </Link>
          </div>
        </section>

        <details
          style={{ maxWidth: 1180, margin: '0 auto', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}
        >
          <summary
            style={{ cursor: 'pointer', listStyle: 'none', padding: '18px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, color: 'var(--ink)', fontSize: 14, fontWeight: 800 }}
          >
            <span>How AURA can become a business</span>
            <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>Business logic · no invented pricing</span>
          </summary>
          <section style={{ padding: '8px 0 30px' }}>
            <p style={{ maxWidth: 700, margin: '0 auto 18px', color: 'var(--muted)', fontSize: 14, lineHeight: 1.6, textAlign: 'center' }}>
              The current demo proves the product loop. The business expands from the same Private Balance rather than from a new wallet or speculative token.
            </p>
            <p style={{ maxWidth: 760, margin: '0 auto 20px', color: 'var(--muted)', fontSize: 12, lineHeight: 1.6, textAlign: 'center' }}>
              <strong style={{ color: 'var(--ink)' }}>Market context, not AURA TAM:</strong> McKinsey/Artemis estimated actual stablecoin payments at approximately $390B in 2025, including approximately $226B in B2B payments. This frames the payment rail; it is not a claim about AURA market share.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
              {[
                ['Today · AURA service fee', 'Private Balance payments'],
                ['Later · merchant, business, and API expansion', 'Aura Pay Checkout · working-balance tools · privacy payment infrastructure'],
              ].map(([title, detail]) => (
                <div key={title} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px', background: 'var(--paper)' }}>
                  <strong style={{ display: 'block', color: 'var(--ink)', fontSize: 13, marginBottom: 4 }}>{title}</strong>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{detail}</span>
                </div>
              ))}
            </div>
            <p style={{ margin: '16px 0 0', color: 'var(--muted)', fontSize: 11, textAlign: 'center' }}>
              These are monetization paths, not current revenue, user counts, percentages, or live pricing.
            </p>
          </section>
        </details>

        <details
          style={{ maxWidth: 1180, margin: '0 auto', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}
        >
          <summary
            style={{ cursor: 'pointer', listStyle: 'none', padding: '18px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, color: 'var(--ink)', fontSize: 14, fontWeight: 800 }}
          >
            <span>Technical details and privacy model</span>
            <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>Policies · architecture · FAQ</span>
          </summary>

        {/* SECTION 05: Privacy Policies */}
        <section className="modes-section" id="modes">
          <div className="section-head-center">
            <span className="section-label">05 — Privacy Check settings</span>
            <h2>Choose how quickly your balance is ready to use.</h2>
            <p>
              A longer wait may reduce simple timing clues between adding and spending funds. Public transactions can still be correlated; no wait guarantees unlinkability.
            </p>
          </div>

          <div className="modes-grid">
            <div className="mode-card">
              <div>
                <div className="mode-header">
                  <span className="mode-badge">Fastest</span>
                  <span className="mode-delay">No added wait</span>
                </div>
                <h3>Fast</h3>
                <p>Use the balance after the required Zcash and recipient-network confirmations.</p>
              </div>
              <div className="mode-specs">
                <div className="spec-row">
                  <span>Extra wait</span>
                  <strong>None</strong>
                </div>
                <div className="spec-row">
                  <span>Vault</span>
                  <strong>Zcash Shielded Pool</strong>
                </div>
                <div className="spec-row">
                  <span>Timing clues</span>
                  <strong>Less delay between actions</strong>
                </div>
              </div>
            </div>

            <div className="mode-card featured">
              <div>
                <div className="mode-header">
                  <span className="mode-badge">Recommended</span>
                  <span className="mode-delay">1-day buffer</span>
                </div>
                <h3>1-day buffer</h3>
                <p>Wait 24 hours after the shielded deposit is confirmed. This may reduce simple timing clues, but does not guarantee unlinkability.</p>
              </div>
              <div className="mode-specs">
                <div className="spec-row">
                  <span>Policy</span>
                  <strong>1-day balance-age buffer</strong>
                </div>
                <div className="spec-row">
                  <span>Vault</span>
                  <strong>AURA testnet route</strong>
                </div>
                <div className="spec-row">
                  <span>Timing separation</span>
                  <strong>May reduce simple timing clues</strong>
                </div>
              </div>
            </div>

            <div className="mode-card">
              <div>
                <div className="mode-header">
                  <span className="mode-badge">Longer wait</span>
                  <span className="mode-delay">3-day buffer</span>
                </div>
                <h3>3-day buffer</h3>
                <p>Wait 72 hours after the shielded deposit is confirmed. This may reduce simple timing clues, but amount and public-chain data can still reveal links.</p>
              </div>
              <div className="mode-specs">
                <div className="spec-row">
                  <span>Policy</span>
                  <strong>3-day balance-age buffer</strong>
                </div>
                <div className="spec-row">
                  <span>Privacy note</span>
                  <strong>No unlinkability guarantee</strong>
                </div>
                <div className="spec-row">
                  <span>Timing Link</span>
                  <strong>May reduce simple timing clues</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 06: Architecture / Self-Custody */}
        <section className="arch-section" id="architecture">
          <div className="section-head-center">
            <span className="section-label">06 — Client-Authorized Keystore Architecture</span>
            <h2>Local Action Signing. Server-Operated Testnet Wallets.</h2>
            <p>Client-side signatures authorize actions, while this testnet demo uses server-operated relayers and a Zcash test wallet. This is not a self-custody guarantee.</p>
          </div>

          <div className="arch-grid">
            <div className="arch-card">
              <span className="arch-num">01 / LOCAL KEYSTORE</span>
              <h3>Client Intent Signing</h3>
              <p>
                Your client authorization credentials and recovery phrase are generated locally in your browser. Every spend intent requires your explicit local cryptographic signature.
              </p>
            </div>
            <div className="arch-card">
              <span className="arch-num">02 / ZCASH TESTNET</span>
              <h3>Shielded Zcash Inventory</h3>
              <p>
                The demo uses the matching ZEC amount from AURA&apos;s pre-funded Zcash Testnet inventory. AURA records the route; the private balance is read independently from the Zcash wallet.
              </p>
            </div>
            <div className="arch-card">
              <span className="arch-num">03 / TESTNET ROUTE</span>
              <h3>Public Exit, Clear Boundary</h3>
              <p>
                This demo routes from Base Sepolia through the private Zcash Testnet step to Solana Devnet. Additional networks can be added later; the product promise is the Private Balance and the payment check.
              </p>
            </div>
          </div>
        </section>

        {/* SECTION 08: FAQ */}
        <section className="faq-section" id="faq">
          <div className="section-head-center">
            <span className="section-label">07 — Frequently Asked Questions</span>
            <h2>Honest Privacy. Simply Explained.</h2>
            <p>What the current testnet demo does — and does not — protect.</p>
          </div>

          <div className="faq-list">
            {[
              {
                q: "How does Aura protect my financial privacy?",
                a: "When you fund the demo on Base Sepolia, AURA verifies the payment and uses its pre-funded Zcash Testnet jury inventory for the private step. The testnet keys are operated by AURA, and public entry and payout activity may still be linked using timing or other metadata.",
              },
              {
                q: "Do I need to buy or know about Zcash (ZEC)?",
                a: "No. In this testnet demo, the interface handles the Zcash steps for you. The demo uses test tokens only; it does not support USDT or ETH yet.",
              },
              {
                q: "Why not just use a second wallet?",
                a: "A second public wallet can separate addresses, but the funding transfer can connect the two wallets again. AURA adds a persistent private balance and checks timing, amount, and full-balance clues before the public payment. It reduces simple links; it does not promise perfect unlinkability.",
              },
              {
                q: "Does Aura promise 100% anonymity?",
                a: "No. Public entry and exit transactions remain visible. This prototype demonstrates a private Zcash testnet state, but it does not prove that timing, amount, or other metadata cannot link transactions.",
              },
              {
                q: "Is Aura non-custodial? Can anyone freeze my funds?",
                a: "This is a testnet prototype, not a self-custody guarantee. The demo uses server-operated testnet relayers and a Zcash test wallet; never send real funds.",
              },
              {
                q: "Which assets and networks are supported in this demo?",
                a: "The demo accepts USDC deposits on Base Sepolia. Private sends support SOL on Solana Devnet only; private sends to Base are not enabled. Other assets and networks are not enabled in this demo.",
              },
            ].map((faq, idx) => (
              <div key={idx} className={`faq-item ${openFaq === idx ? 'open' : ''}`}>
                <button type="button" className="faq-question" onClick={() => toggleFaq(idx)}>
                  <span>{faq.q}</span>
                  <span className="toggle-icon">+</span>
                </button>
                {openFaq === idx && <div className="faq-answer">{faq.a}</div>}
              </div>
            ))}
          </div>
        </section>

        {/* Ticker / Trust Banner */}
        <div className="ticker-bar">
          <span>
            <i className="ticker-dot"></i>
            AURA · SUPPORTED ROUTE · TESTNET
          </span>
          <span>TEST TOKENS ONLY · NOT FOR REAL FUNDS</span>
          <span>POWERED BY ZCASH TECHNOLOGY</span>
        </div>

        {/* Manifesto / Vision */}
        <section className="manifesto-section" id="manifesto">
          <h2 className="manifesto-title">
            Fund publicly.<br />
            Hold privately.<br />
            Send SOL on Solana Devnet.
          </h2>

          <div className="manifesto-copy">
            <p>
              AURA was built on the conviction that financial privacy is a fundamental human right. You shouldn&apos;t need a cryptography degree just to protect your personal net worth.
            </p>
            <div className="manifesto-quote">
              &ldquo;AURA demonstrates a shielded testnet step between a deposit and a payout.&rdquo;
            </div>
            <p>
              AURA demonstrates a Base Sepolia to Solana Devnet test flow. Public deposits and payouts remain visible; the demo does not guarantee that they cannot be linked.
            </p>
          </div>
        </section>

        </details>
      </main>

      <AuraFooter />

      {/* Modal: Add Money */}
      {activeModal === 'add' && (
        <div className="modal-backdrop" onClick={() => setActiveModal('none')}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SparkleIcon size={14} color="var(--violet)" />
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Add Funds to Private Balance
                </span>
              </div>
              <button type="button" className="modal-close" onClick={() => setActiveModal('none')} title="Close">
                <CloseIcon size={14} />
              </button>
            </div>
            <div className="modal-body">
              <form onSubmit={handleDepositSubmit}>
                {depositError && (
                  <div style={{ background: 'var(--danger-light)', color: 'var(--danger)', padding: '12px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, fontWeight: 600 }}>
                    <div style={{ marginBottom: pendingDepositTransfer ? 8 : 0 }}>{depositError}</div>
                    {pendingDepositTransfer && (
                      <button
                        type="button"
                        onClick={() => {
                          clearPendingDepositTransfer?.()
                          setDepositError(null)
                        }}
                        style={{
                          background: '#ffffff',
                          color: 'var(--danger)',
                          border: '1px solid var(--danger)',
                          borderRadius: 6,
                          padding: '6px 12px',
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: 'pointer',
                          marginTop: 4,
                        }}
                      >
                        Discard Stuck Transfer & Start Fresh
                      </button>
                    )}
                  </div>
                )}
                {pendingDepositTransfer && !depositError && depositStatus === 'idle' && (
                  <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', color: '#5b21b6', padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span>A previous ${pendingDepositTransfer.amount.toFixed(2)} transfer is pending completion.</span>
                    <button
                      type="button"
                      onClick={() => {
                        clearPendingDepositTransfer?.()
                      }}
                      style={{
                        background: '#ffffff',
                        color: '#6d28d9',
                        border: '1px solid #c4b5fd',
                        borderRadius: 6,
                        padding: '4px 10px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Clear & Start Fresh
                    </button>
                  </div>
                )}
                {depositStatus === 'idle' ? (
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#191820', marginBottom: 18 }}>
                    Send ${depositAmount} on Base Sepolia. AURA verifies the transfer, allocates matching confirmed Zcash inventory, then updates your Private Balance.
                  </div>
                ) : (
                  <div
                    className="modal-status-badge deposit-progress"
                    style={{
                      display: 'block',
                      background: depositStatus === 'done' ? 'var(--green-light)' : '#fbfaff',
                      border: depositStatus === 'done' ? '1px solid #bbf7d0' : '1px solid #e9e5f5',
                      padding: '16px',
                      marginBottom: 16,
                      borderRadius: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: depositStatus === 'done' ? 'var(--green)' : 'var(--violet)' }}>
                        {depositStatus === 'done' ? (
                          <>
                            <CheckIcon size={16} color="var(--green)" />
                            <span>Added to Private Balance!</span>
                          </>
                        ) : (
                          <>
                            <RefreshIcon size={14} color="var(--violet)" />
                            <span>Moving into Private Balance...</span>
                          </>
                        )}
                      </strong>
                      <span style={{ fontSize: 11, fontWeight: 700, color: depositStatus === 'done' ? 'var(--green)' : 'var(--violet)' }}>
                        {depositStatus === 'done' ? 'Confirmed ✓' : activeBaseConfirmed ? 'Step 2 of 2' : 'Step 1 of 2'}
                      </span>
                    </div>

                    {/* Step 1: Base Sepolia Public Entry */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: '#ffffff',
                        border: '1px solid #ede9fe',
                        marginBottom: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: activeBaseConfirmed ? 'var(--green)' : '#ede9fe',
                            color: activeBaseConfirmed ? '#ffffff' : 'var(--violet)',
                            fontSize: 11,
                            fontWeight: 800,
                          }}
                        >
                          {activeBaseConfirmed ? '✓' : '1'}
                        </span>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                            Base Sepolia (Public Entry)
                          </div>
                          <div style={{ fontSize: 11, color: activeBaseConfirmed ? 'var(--green)' : '#77727d' }}>
                            {activeBaseConfirmed
                              ? 'Confirmed on-chain ✓'
                              : activeBaseTxHash
                              ? 'Broadcasted · Confirming (2–3s)...'
                              : 'Submitting transaction...'}
                          </div>
                        </div>
                      </div>
                      {activeBaseTxHash && (
                        <a
                          href={`https://sepolia.basescan.org/tx/${activeBaseTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 11,
                            color: 'var(--violet)',
                            textDecoration: 'underline',
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <span>View on BaseScan</span>
                          <span>↗</span>
                        </a>
                      )}
                    </div>

                    {/* Step 2: Zcash Testnet Shielded Step */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: '#ffffff',
                        border: '1px solid #ede9fe',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: activeZcashConfirmed ? 'var(--green)' : activeZcashTxid ? 'var(--violet)' : '#f1eff5',
                            color: activeZcashConfirmed || activeZcashTxid ? '#ffffff' : '#77727d',
                            fontSize: 11,
                            fontWeight: 800,
                          }}
                        >
                          {activeZcashConfirmed ? '✓' : '2'}
                        </span>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
                            {activeInventoryBacked ? 'Private backing (Zcash pool)' : 'Zcash Testnet (Shielded Pool)'}
                          </div>
                          <div style={{ fontSize: 11, color: activeZcashConfirmed ? 'var(--green)' : activeZcashTxid ? 'var(--violet)' : '#77727d' }}>
                            {activeInventoryBacked
                              ? 'Backed by confirmed shielded Zcash inventory ✓'
                              : activeZcashConfirmed
                              ? 'Shielded transaction confirmed on-chain ✓'
                              : activeZcashTxid
                              ? 'Shielded tx broadcasted · Confirming...'
                              : activeBaseConfirmed
                              ? 'Preparing private-balance allocation...'
                              : 'Awaiting Base confirmation'}
                          </div>
                        </div>
                      </div>
                      {activeZcashTxid && (
                        <a
                          href={`https://testnet.cipherscan.app/tx/${activeZcashTxid}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            fontSize: 11,
                            color: 'var(--violet)',
                            textDecoration: 'underline',
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <span>View on Zcash Explorer</span>
                          <span>↗</span>
                        </a>
                      )}
                    </div>

                    {/* Live Protocol Execution Stream */}
                    {depositLogs.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <LiveProtocolStream
                          logs={depositLogs}
                          isLive={depositStatus === 'moving' || depositStatus === 'pending'}
                          summaryStatus={depositStatus === 'done'
                            ? 'SETTLED ✓'
                            : activeInventoryBacked && activeBaseConfirmed
                              ? 'POOL BACKING ALLOCATION'
                              : activeBaseConfirmed
                                ? 'SHIELDING ON ZCASH'
                                : 'BASE CONFIRMING'}
                          maxHeight={160}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="modal-input-group">
                  <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, display: 'block' }}>Select Asset &amp; Network</label>
                  <div className="modal-asset-grid">
                    {PUBLIC_ASSET_CAPABILITIES.map((item) => {
                      const isLive = item.status === 'LIVE'
                      return (
                      <button
                        key={item.symbol}
                        type="button"
                        disabled={!isLive}
                        onClick={() => {
                          if (isLive) setSelectedDepositAsset(item.symbol as AssetSymbol)
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: selectedDepositAsset === item.symbol ? '1.5px solid var(--violet)' : '1px solid #e7e4eb',
                          background: selectedDepositAsset === item.symbol ? 'var(--lav)' : '#fff',
                          cursor: isLive ? 'pointer' : 'not-allowed',
                          opacity: isLive ? 1 : 0.55,
                          textAlign: 'left',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <CryptoIcon name={item.symbol} size={22} />
                          <div>
                            <div style={{ fontWeight: 800, fontSize: 13, color: selectedDepositAsset === item.symbol ? 'var(--violet)' : '#191820' }}>
                              {item.label}
                            </div>
                            <div style={{ fontSize: 10, color: '#77727d' }}>
                              {item.network}
                            </div>
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: 9,
                            fontWeight: 800,
                            padding: '2px 5px',
                            borderRadius: 4,
                            background: isLive ? 'var(--green)' : '#f1eff5',
                            color: isLive ? '#fff' : '#77727d',
                            whiteSpace: 'nowrap',
                            flexShrink: 0,
                          }}
                        >
                          {item.badge}
                        </span>
                      </button>
                      )
                    })}
                  </div>
                </div>

                <div className="modal-input-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ margin: 0 }}>Amount ($)</label>
                    <span style={{ fontSize: 11, color: '#77727d' }}>
                      {publicBalanceKnown ? `Wallet Balance: $${publicUsdcBalance.toFixed(2)} USDC` : 'Wallet Balance: unavailable'}
                    </span>
                  </div>
                  <div style={{ color: '#68636e', fontSize: 11, lineHeight: 1.4, marginBottom: 8 }}>
                    Public Base balance and confirmed private-pool capacity are separate. AURA checks the Zcash backing before sending any Base transfer.
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={() => setDepositAmount(publicUsdcBalance.toFixed(2))}
                      disabled={!publicBalanceKnown}
                      style={{
                        padding: '0 12px',
                        border: '1px solid #e7e4eb',
                        borderRadius: 8,
                        background: '#f4f2f7',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'pointer',
                        color: 'var(--violet, #6b55df)',
                      }}
                    >
                      MAX
                    </button>
                  </div>
                  {publicBalanceKnown && parseFloat(depositAmount) > publicUsdcBalance && (
                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--danger-light)', padding: '6px 10px', borderRadius: 6 }}>
                      <small style={{ color: 'var(--danger)', fontWeight: 600 }}>
                         Exceeds wallet balance (${publicUsdcBalance.toFixed(2)} max).
                      </small>
                      <small style={{ color: '#77727d', fontSize: 10 }}>Only funds confirmed on Base Sepolia can be deposited.</small>
                    </div>
                  )}
                  <div className="modal-amount-presets">
                    {['1.00', '5.00', '10.00', '25.00', '50.00', '100.00'].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setDepositAmount(preset)}
                        style={{
                          border: '1px solid #e7e4eb',
                          borderRadius: 6,
                          background: depositAmount === preset ? '#ede9fe' : '#fff',
                          borderColor: depositAmount === preset ? 'var(--violet, #6b55df)' : '#e7e4eb',
                          padding: '6px 0',
                          textAlign: 'center',
                          fontSize: 11,
                          fontWeight: 600,
                          color: depositAmount === preset ? 'var(--violet, #6b55df)' : '#625c6c',
                          cursor: 'pointer',
                        }}
                      >
                        ${preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Pre-Confirmation Quote Review */}
                <div style={{ background: '#fbfafc', border: '1px solid #e7e4eb', borderRadius: 10, padding: '12px 14px', margin: '16px 0', fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: '#77727d' }}>Deposit:</span>
                    <strong style={{ color: '#191820' }}>${depositAmount} {selectedDepositAsset} (Base)</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: '#77727d' }}>Private Balance Added:</span>
                    <strong style={{ color: 'var(--green)' }}>
                      ≈ ${Number(depositAmount || 0).toFixed(2)} (Shielded)
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: '#77727d' }}>Route:</span>
                    <strong style={{ color: '#191820' }}>Test route · no simulated provider fee</strong>
                  </div>
                  <div style={{ borderTop: '1px dashed #e7e4eb', paddingTop: 6, marginTop: 6, fontSize: 10, color: '#77727d' }}>
                    *Aura operates the pre-funded Zcash Testnet private state for this demo. The ZEC balance is real on-chain state; this is not self-custody and does not guarantee unlinkability.
                  </div>
                </div>

                {depositStatus === 'done' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveModal('none')
                      setDepositStatus('idle')
                    }}
                    className="modal-action-btn"
                  >
                    Done — Close
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="modal-action-btn"
                    disabled={
                      depositStatus === 'moving' ||
                      !publicBalanceKnown ||
                      parseFloat(depositAmount) <= 0 ||
                      parseFloat(depositAmount) > publicUsdcBalance ||
                      isNaN(parseFloat(depositAmount))
                    }
                  >
                    {depositStatus === 'moving' ? 'Verifying Testnet Deposit...' : `Add $${depositAmount} to AURA Private Balance · Testnet →`}
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Withdraw */}
      {activeModal === 'withdraw' && (
        <div className="modal-backdrop" onClick={() => setActiveModal('none')}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <RefreshIcon size={14} color="var(--violet)" />
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Withdraw to Public Wallet
                </span>
              </div>
              <button type="button" className="modal-close" onClick={() => setActiveModal('none')} title="Close">
                <CloseIcon size={14} />
              </button>
            </div>
            <div className="modal-body">
              <form onSubmit={handleWithdrawSubmit}>
                {withdrawError && (
                  <div style={{ background: 'var(--danger-light)', color: 'var(--danger)', padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, fontWeight: 600 }}>
                    {withdrawError}
                  </div>
                )}
                {withdrawStatus === 'done' ? (
                  <div className="modal-status-badge" style={{ background: 'var(--green-light)', color: 'var(--green)', padding: '16px', marginBottom: 16 }}>
                    <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
                      <CheckIcon size={16} color="var(--green)" />
                      <span>Withdrawal Completed &amp; Confirmed!</span>
                    </strong>
                    <span style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                      Withdrew ${withdrawAmount} {selectedWithdrawAsset} to {selectedWithdrawChain.toUpperCase()} address.
                    </span>
                    {withdrawTx?.legs?.delivery?.txHash && (
                      <a
                        href={canonicalExplorerUrl(selectedWithdrawChain, withdrawTx.legs.delivery.txHash, withdrawTx.legs.delivery.explorerUrl)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, color: 'var(--violet)', textDecoration: 'underline', marginTop: 6, display: 'inline-block', fontWeight: 600 }}
                      >
                        Inspect on {selectedWithdrawChain === 'solana' ? 'Solscan' : 'BaseScan'} ↗
                      </a>
                    )}
                  </div>
                ) : withdrawStatus === 'pending' ? (
                  <div className="modal-status-badge" style={{ background: 'var(--warning-light)', color: 'var(--warning)', padding: '16px', marginBottom: 16 }}>
                    <strong style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                      <RefreshIcon size={14} color="var(--warning)" />
                      <span>Settlement Broadcast · Finalization in Progress</span>
                    </strong>
                    <span style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                      Payout transaction broadcast to {selectedWithdrawChain.toUpperCase()}. Awaiting final block confirmation.
                    </span>
                    {withdrawTx?.legs?.delivery?.txHash && (
                      <a
                        href={canonicalExplorerUrl(selectedWithdrawChain, withdrawTx.legs.delivery.txHash, withdrawTx.legs.delivery.explorerUrl)}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, color: 'var(--warning)', textDecoration: 'underline', marginTop: 6, display: 'inline-block', fontWeight: 600 }}
                      >
                        Inspect on {selectedWithdrawChain === 'solana' ? 'Solscan' : 'BaseScan'} ↗
                      </a>
                    )}
                  </div>
                ) : withdrawStatus === 'sending' ? (
                  <div className="modal-status-badge" style={{ padding: '14px', marginBottom: 16 }}>
                    Sending from Aura&apos;s server-operated testnet wallet → {selectedWithdrawChain.toUpperCase()}...
                  </div>
                ) : null}

                <div className="modal-input-group">
                  <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, display: 'block' }}>Asset</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                    {PUBLIC_DESTINATION_ASSET_OPTIONS.map(({ symbol: asset, status }) => (
                      <button
                        key={asset}
                        type="button"
                        disabled={status !== 'LIVE'}
                        className={`aura-chip ${selectedWithdrawAsset === asset ? 'active' : ''}`}
                        onClick={() => {
                          if (status !== 'LIVE') return
                          setSelectedWithdrawAsset(asset)
                          setSelectedWithdrawChain('solana')
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          padding: '10px 8px',
                          borderRadius: 10,
                          fontWeight: 700,
                          border: selectedWithdrawAsset === asset ? '1.5px solid var(--violet)' : '1px solid #e7e4eb',
                          background: selectedWithdrawAsset === asset ? 'var(--lav)' : '#fff',
                          color: selectedWithdrawAsset === asset ? 'var(--violet)' : '#191820',
                          opacity: status === 'LIVE' ? 1 : 0.55,
                          cursor: status === 'LIVE' ? 'pointer' : 'not-allowed',
                        }}
                      >
                        <CryptoIcon name={asset} size={18} />
                        <span>{asset}{status !== 'LIVE' ? ' · Coming next' : ''}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="modal-input-group">
                  <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, display: 'block' }}>Destination Network</label>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {DEMO_DESTINATION_NETWORKS.slice(0, 3).map((item) => {
                      const isLive = item.status === 'LIVE'
                      return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={!isLive}
                        onClick={() => {
                          if (isLive) {
                            const chain = item.id as ChainId
                            setSelectedWithdrawChain(chain)
                            setSelectedWithdrawAsset(chain === 'solana' ? 'SOL' : 'USDC')
                          }
                        }}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 6,
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: selectedWithdrawChain === item.id ? '1.5px solid var(--violet)' : '1px solid #e7e4eb',
                          background: selectedWithdrawChain === item.id ? 'var(--lav)' : '#fff',
                          cursor: isLive ? 'pointer' : 'not-allowed',
                          opacity: isLive ? 1 : 0.55,
                          textAlign: 'left',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                          <CryptoIcon name={item.icon} size={20} />
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 800,
                              padding: '1px 5px',
                              borderRadius: 4,
                              background: isLive ? 'var(--green)' : '#f1eff5',
                              color: isLive ? '#fff' : '#77727d',
                            }}
                          >
                            {isLive ? 'TESTNET' : 'COMING NEXT'}
                          </span>
                        </div>
                        <strong style={{ fontSize: 12, color: selectedWithdrawChain === item.id ? 'var(--violet)' : '#191820', marginTop: 2 }}>
                          {item.label}
                        </strong>
                      </button>
                      )
                    })}
                  </div>
                </div>

                <div className="modal-input-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ margin: 0 }}>Amount ($)</label>
                    <span style={{ fontSize: 11, color: '#77727d' }}>
                      Available: <strong style={{ color: '#191820' }}>
                        {privateBalanceUnavailable ? 'unavailable' : `$${(privateBalance.availableToSendUsd ?? privateBalance.totalUsd).toFixed(2)}`}
                      </strong>
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      disabled={privateBalanceUnavailable}
                      onClick={() => {
                        const available = privateBalance.availableToSendUsd ?? privateBalance.totalUsd ?? 0
                        setWithdrawAmount(Math.max(0, Math.floor(available * 100) / 100).toFixed(2))
                      }}
                      style={{
                        padding: '0 12px',
                        border: '1px solid #e7e4eb',
                        borderRadius: 8,
                        background: '#f4f2f7',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: privateBalanceUnavailable ? 'not-allowed' : 'pointer',
                        opacity: privateBalanceUnavailable ? 0.55 : 1,
                        color: 'var(--violet, #6b55df)',
                      }}
                      title="Use the available private balance"
                    >
                      MAX
                    </button>
                  </div>
                  {!privateBalanceUnavailable && parseFloat(withdrawAmount) > (privateBalance.availableToSendUsd ?? privateBalance.totalUsd) && (
                    <small style={{ color: 'var(--danger)', display: 'block', marginTop: 4 }}>
                      Amount exceeds available balance (${(privateBalance.availableToSendUsd ?? privateBalance.totalUsd ?? 0).toFixed(2)} max).
                    </small>
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {['1.00', '2.50', '5.00', '10.00', '25.00', '100.00'].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        disabled={privateBalanceUnavailable}
                        onClick={() => setWithdrawAmount(preset)}
                        style={{
                          border: '1px solid #e7e4eb',
                          borderRadius: 6,
                          background: withdrawAmount === preset ? '#ede9fe' : '#fff',
                          borderColor: withdrawAmount === preset ? 'var(--violet, #6b55df)' : '#e7e4eb',
                          padding: '3px 8px',
                          fontSize: 11,
                          fontWeight: 600,
                          color: withdrawAmount === preset ? 'var(--violet, #6b55df)' : '#625c6c',
                          cursor: privateBalanceUnavailable ? 'not-allowed' : 'pointer',
                          opacity: privateBalanceUnavailable ? 0.55 : 1,
                        }}
                      >
                        ${preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Destination Address Field */}
                <div className="modal-input-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ margin: 0 }}>Destination Public Wallet</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {selectedWithdrawChain === 'base' && wallet.connected && !wallet.isDemoWallet && (
                        <button
                          type="button"
                          onClick={() => setWithdrawDestination(wallet.address)}
                          style={{
                            background: '#f0edff',
                            border: '1px solid #d9d0ff',
                            color: 'var(--violet)',
                            borderRadius: 4,
                            padding: '2px 6px',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          Use Connected Wallet
                        </button>
                      )}
                      <span style={{ fontSize: 10, background: 'var(--green-light)', color: 'var(--green-dark)', padding: '2px 8px', borderRadius: 4, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ZapIcon size={10} color="var(--green-dark)" />
                        <span>Route → {selectedWithdrawChain.toUpperCase()}</span>
                      </span>
                    </div>
                  </div>
                  <input
                    type="text"
                    placeholder={
                      selectedWithdrawChain === 'solana'
                        ? 'Enter Solana wallet address (Base58, e.g. 7EcPnR...)'
                        : 'Enter Base / EVM address (0x...) or leave blank for connected wallet'
                    }
                    value={withdrawDestination}
                    onChange={(e) => {
                      const val = e.target.value
                      setWithdrawDestination(val)
                      const clean = val.trim()
                      if (clean.startsWith('0x')) {
                        setSelectedWithdrawChain('base')
                      } else if (/^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(clean)) {
                        setSelectedWithdrawChain('solana')
                      }
                    }}
                    style={{ width: '100%', fontFamily: 'var(--font-ui)', fontSize: 12 }}
                  />
                  {selectedWithdrawChain === 'solana' && !withdrawDestination && (
                    <small style={{ color: 'var(--warning)', display: 'block', marginTop: 4, fontSize: 11 }}>
                      Please provide a valid Solana Devnet recipient address.
                    </small>
                  )}
                </div>

                {withdrawStatus === 'done' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActiveModal('none')
                      setWithdrawStatus('idle')
                    }}
                    className="modal-action-btn"
                  >
                    Done — Close
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="modal-action-btn"
                    disabled={
                      withdrawStatus === 'sending' ||
                      privateBalanceUnavailable ||
                      parseFloat(withdrawAmount) <= 0 ||
                      parseFloat(withdrawAmount) > (privateBalance.availableToSendUsd ?? privateBalance.totalUsd) ||
                      isNaN(parseFloat(withdrawAmount))
                    }
                  >
                    {withdrawStatus === 'sending' ? 'Withdrawing...' : `Withdraw $${withdrawAmount} to Wallet →`}
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
