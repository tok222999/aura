/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useAura } from '@/lib/context/aura-context'
import { zcashEnclaveService } from '@/lib/services/zcash-enclave-service'
import {
  SparkleIcon,
  CloseIcon,
  ShieldIcon,
  RefreshIcon,
  CheckIcon,
  ArrowRightIcon,
  ZapIcon,
  SlidersIcon,
  ExternalLinkIcon,
} from './aura-icons'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { canonicalExplorerUrl } from '@/lib/utils/explorer-links'
import { DEMO_DEPOSIT_AMOUNT_USD, DEMO_PAYOUT_AMOUNT_USD, DEMO_RUN_TARGET } from '@/lib/services/demo-capacity'
import { AURA_ROUTE_MATRIX } from '@/lib/config/capabilities'
import { buildPipelineState } from '@/lib/utils/pipeline-state'

const DEMO_PREFLIGHT_AMOUNT_USD = DEMO_DEPOSIT_AMOUNT_USD

export interface LiveExecutionLogPanelProps {
  embedded?: boolean
  initialOpen?: boolean
  onClose?: () => void
}

export function LiveExecutionLogPanel({ embedded = false, initialOpen = false, onClose }: LiveExecutionLogPanelProps) {
  const { wallet, privateBalance, transactions } = useAura()
  const privateBalanceAvailable = privateBalance.zcashStateSynced === true && privateBalance.onChainZecBackedUsd != null
  const privateBalanceLabel = privateBalanceAvailable ? `$${privateBalance.totalUsd.toFixed(2)}` : 'unavailable'
  const [isOpen, setIsOpen] = useState(initialOpen || embedded)
  const [isMinimized, setIsMinimized] = useState(false)

  // Activity and Live status must point to the same verified payout. A newer
  // failed retry must not hide an already-finalized destination delivery.
  const latestDeposit = useMemo(
    () => transactions.filter((t) => t.type === 'deposit' || t.type === 'receive').sort((a, b) => b.createdAt - a.createdAt)[0],
    [transactions],
  )
  const sendTransactions = useMemo(
    () => transactions.filter((t) => t.type === 'send' || t.type === 'withdraw').sort((a, b) => b.createdAt - a.createdAt),
    [transactions],
  )
  const latestSend = sendTransactions.find((tx) => hasCompletedDestinationDelivery(tx)) || sendTransactions[0]

  useEffect(() => {
    if (initialOpen) {
      setIsOpen(true)
      setIsMinimized(false)
    }
  }, [initialOpen])
  const [modalTab, setModalTab] = useState<'pipeline' | 'telemetry'>('pipeline')
  
  const computedStepIndex = useMemo(() => {
    if (hasCompletedDestinationDelivery(latestSend)) return 6
    if (latestSend) return 5
    if (privateBalanceAvailable && privateBalance.totalUsd > 0) return 3
    if (latestDeposit?.legs?.shielded?.status === 'confirmed') return 2
    if (latestDeposit) return 1
    return 0
  }, [latestDeposit, latestSend, privateBalance.totalUsd, privateBalanceAvailable])

  const [activeStepIndex, setActiveStepIndex] = useState<number>(computedStepIndex)
  const [isCheckingStatus, setIsCheckingStatus] = useState(false)

  useEffect(() => {
    if (!isCheckingStatus) {
      setActiveStepIndex(computedStepIndex)
    }
  }, [computedStepIndex, isCheckingStatus])

  const [statusLogs, setStatusLogs] = useState<Array<{ time: string; tag: string; message: string; color?: string }>>([])
  const [selectedDetailStep, setSelectedDetailStep] = useState<any | null>(null)
  
  const [auditStatus, setAuditStatus] = useState<{
    loading: boolean
    passed?: number
    total?: number
    allPassed?: boolean
    timestamp?: number
  }>({ loading: false })
  const canRunAudit = process.env.NODE_ENV !== 'production'

  const [preflightStatus, setPreflightStatus] = useState<{
    loading: boolean
    data?: any
    error?: string
    timestamp?: number
  }>({ loading: false })

  const getPreflightAuthHeaders = async () => {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const authorization = await zcashEnclaveService.signVaultActionLocally('read_preflight')
    setEnclaveFingerprint(enclave.fingerprint)
    return {
      'x-aura-enclave-fingerprint': enclave.fingerprint,
      'x-aura-auth-timestamp': String(authorization.clientTimestamp),
      'x-aura-auth-nonce': authorization.nonce,
      'x-aura-auth-public-key': authorization.authPublicKey,
      'x-aura-auth-signature': authorization.signature,
    }
  }

  const runPreflightCheck = async () => {
    setPreflightStatus({ loading: true })
    try {
      const authHeaders = await getPreflightAuthHeaders()
      const res = await fetch(`/api/preflight?amountUsd=${DEMO_PREFLIGHT_AMOUNT_USD}&ts=${Date.now()}`, {
        headers: authHeaders,
        cache: 'no-store',
      })
      const json = await res.json()
      if (json.success && json.checks) {
        window.dispatchEvent(new CustomEvent('aura:demo-readiness', {
          detail: { ready: (json.readyForRequestedRun ?? json.allReady) === true },
        }))
        setPreflightStatus({
          loading: false,
          data: json,
          timestamp: Date.now(),
        })
        addLog(
          'PREFLIGHT',
          `Preflight for $${DEMO_PREFLIGHT_AMOUNT_USD} demo run: ${(json.readyForRequestedRun ?? json.allReady) ? 'ready' : 'not ready'} · capacity ${json.demoCapacity?.runsAvailable ?? 0}/${json.demoCapacity?.targetRuns ?? 3} full runs (${json.durationMs} ms).`,
          (json.readyForRequestedRun ?? json.allReady) ? '#34d399' : 'var(--warning)'
        )
      } else {
        window.dispatchEvent(new CustomEvent('aura:demo-readiness', { detail: { ready: false } }))
        setPreflightStatus({ loading: false, error: 'Preflight warning' })
      }
    } catch (err: any) {
      window.dispatchEvent(new CustomEvent('aura:demo-readiness', { detail: { ready: false } }))
      setPreflightStatus({ loading: false, error: err?.message || 'Preflight error' })
    }
  }

  const [enclaveFingerprint, setEnclaveFingerprint] = useState('vault_local_enclave')
  const logContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      let cancelled = false
      void zcashEnclaveService.getOrCreateEnclaveKey().then((enclave) => {
        if (cancelled) return
        setEnclaveFingerprint(enclave.fingerprint)
        const pol = privateBalance.privacyPolicy || 'private'
        setStatusLogs([
          { time: new Date().toLocaleTimeString(), tag: 'ACCOUNT', message: `Account namespace loaded: ${enclave.fingerprint}`, color: 'var(--info)' },
          { time: new Date().toLocaleTimeString(), tag: 'BALANCE', message: `${transactions.length} recorded transaction(s); displayed balance ${privateBalanceLabel}.`, color: '#a78bfa' },
          { time: new Date().toLocaleTimeString(), tag: 'POLICY', message: `Selected privacy timing: ${pol}.`, color: '#fbbf24' },
        ])
      }).catch((error) => {
        if (!cancelled) addLog('ERROR', error instanceof Error ? error.message : 'Vault could not be opened.', 'var(--danger)')
      })
      return () => { cancelled = true }
    }
  }, [privateBalance.totalUsd, privateBalance.privacyPolicy, privateBalanceLabel, transactions.length])

  // Scroll to bottom of logs on update
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [statusLogs])

  const runAuditVerification = async () => {
    setAuditStatus({ loading: true })
    try {
      const res = await fetch('/api/audit/test-runner', { method: 'POST' })
      const json = await res.json()
      if (json.success && json.summary) {
        setAuditStatus({
          loading: false,
          passed: json.summary.passed,
          total: json.summary.total,
          allPassed: json.summary.allPassed,
          timestamp: Date.now(),
        })
        addLog('AUDIT', `${json.summary.passed}/${json.summary.total} automated checks passed. This is not a security audit or proof of live-chain execution.`, json.summary.allPassed ? '#34d399' : 'var(--danger)')
      } else {
        setAuditStatus({ loading: false, allPassed: false })
      }
    } catch {
      setAuditStatus({ loading: false, allPassed: false })
    }
  }

  const addLog = (tag: string, message: string, color?: string) => {
    const time = new Date().toLocaleTimeString()
    setStatusLogs((prev) => [...prev.slice(-25), { time, tag, message, color }])
  }

  // Check network readiness and show the transaction records already in the ledger.
  const runReadinessAndStatusCheck = async () => {
    if (isCheckingStatus) return
    setIsCheckingStatus(true)
    setStatusLogs([])
    try {
    const authHeaders = await getPreflightAuthHeaders()
    addLog('PREFLIGHT', 'Checking the current testnet connections and configured balances.', 'var(--info)')
    const res = await fetch(`/api/preflight?amountUsd=${DEMO_PREFLIGHT_AMOUNT_USD}`, {
      cache: 'no-store',
      headers: authHeaders,
    })
    const report = await res.json()
    if (!res.ok || !report.success || !report.checks) {
      throw new Error(report.message || report.error || 'The readiness check did not complete.')
    }
    setPreflightStatus({ loading: false, data: report, timestamp: Date.now() })
    window.dispatchEvent(new CustomEvent('aura:demo-readiness', {
      detail: { ready: (report.readyForRequestedRun ?? report.allReady) === true },
    }))
    const checks = report.checks
    addLog('BASE', `Base Sepolia: ${checks.baseSepolia.status}; block ${checks.baseSepolia.blockNumber || 'unavailable'}; demo USDC ${checks.baseSepolia.demoWallet.usdcBalance ?? 'unavailable'}.`, checks.baseSepolia.status === 'ready' ? 'var(--green)' : 'var(--warning)')
    const zcashBalanceLabel = checks.zcashTestnet.balanceScope === 'shared-relayer'
      ? 'AURA test-account readiness balance'
      : 'active tenant balance'
    const zcashSpendableLabel = checks.zcashTestnet.spendableBalanceZec ??
      (checks.zcashTestnet.balanceAvailable ? 'available' : 'unavailable')
    const zcashShieldedLabel = checks.zcashTestnet.shieldedBalanceZec ??
      (checks.zcashTestnet.balanceAvailable ? 'available' : 'unavailable')
    addLog('ZCASH', `Zcash Testnet: ${checks.zcashTestnet.status}; tool ${checks.zcashTestnet.binaryAvailable ? 'ready' : 'unavailable'}; ${zcashBalanceLabel} ${zcashSpendableLabel} ZEC, private ${zcashShieldedLabel} ZEC.`, checks.zcashTestnet.status === 'ready' ? 'var(--green)' : 'var(--warning)')
    addLog('SOLANA', `Solana Devnet: ${checks.solanaDevnet.status}; AURA test balance ${checks.solanaDevnet.solBalance ?? 'unavailable'} SOL.`, checks.solanaDevnet.status === 'ready' ? 'var(--green)' : 'var(--warning)')
    addLog('RATES', `Conversion rates: ${checks.settlementRates.status}; ZEC $${checks.settlementRates.zecUsd ?? 'unavailable'} · SOL $${checks.settlementRates.solUsd ?? 'unavailable'}.`, checks.settlementRates.status === 'ready' ? 'var(--green)' : 'var(--warning)')
    addLog('CAPACITY', `Full demo capacity: ${report.demoCapacity?.runsAvailable ?? 0}/${report.demoCapacity?.targetRuns ?? 3} runs ready.`, report.demoCapacity?.readyForThreeFullDemoRuns ? 'var(--green)' : 'var(--warning)')
    const requestedRunReady = report.readyForRequestedRun ?? report.allReady
    addLog('ROUTE', `End-to-end readiness for a $${DEMO_PREFLIGHT_AMOUNT_USD} demo run: ${requestedRunReady ? 'ready' : 'not ready'} · capacity ${report.demoCapacity?.runsAvailable ?? 0}/${report.demoCapacity?.targetRuns ?? 3} full runs. No transaction was sent by this check.`, requestedRunReady ? 'var(--green)' : 'var(--danger)')

    // Show real transaction evidence only; a readiness check does not advance a payment.
    if (latestDeposit) {
      addLog('DEPOSIT', `Deposit ${latestDeposit.status}: $${latestDeposit.fromAmount.toFixed(2)}.`, latestDeposit.status === 'completed' ? 'var(--green)' : latestDeposit.status === 'failed' ? 'var(--danger)' : 'var(--warning)')
      if (latestDeposit.legs?.deposit?.txHash && /^0x[a-fA-F0-9]{64}$/.test(latestDeposit.legs.deposit.txHash)) {
        addLog('BASE TX', latestDeposit.legs.deposit.txHash, 'var(--info)')
      }
      if (latestDeposit.legs?.shielded?.txHash && /^[a-fA-F0-9]{64}$/.test(latestDeposit.legs.shielded.txHash)) {
        addLog('ZCASH TX', latestDeposit.legs.shielded.txHash, 'var(--info)')
      }
    }

    if (latestSend) {
      const payoutAmount = latestSend.toAsset === 'SOL'
        ? `${latestSend.toAmount.toFixed(5)} SOL (≈ $${latestSend.fromAmount.toFixed(2)})`
        : `$${latestSend.toAmount.toFixed(2)} ${latestSend.toAsset}`
      addLog('PAYOUT', `Spend #${latestSend.id}: ${payoutAmount} to ${latestSend.recipientAddress?.slice(0, 8)}... (${latestSend.status})`, '#a78bfa')
    }

    // Use the same canonical state that powers the visible pipeline.
    const pipeline = buildPipelineState({
      deposit: latestDeposit,
      spend: latestSend,
      privateBalanceUsd: privateBalance.totalUsd,
      privateBalanceSynced: privateBalanceAvailable,
    })
    const activeStage = pipeline.destination.status === 'finalized' ? 6
      : pipeline.destination.status !== 'idle' ? 5
      : pipeline.spend.status !== 'idle' ? 4
      : pipeline.privateBalance.status === 'confirmed' ? 3
      : pipeline.shielding.status !== 'idle' ? 2
      : pipeline.entry.status !== 'idle' ? 1
      : 0
    setActiveStepIndex(activeStage)
    if (pipeline.destination.status === 'finalized') {
      addLog('DELIVERY', 'Recipient transaction is finalized on-chain.', 'var(--green)')
    } else if (pipeline.destination.status === 'failed') {
      addLog('DELIVERY FAILED', 'The destination-chain transaction failed. Check the transaction record before retrying.', 'var(--danger)')
    } else if (pipeline.spend.status === 'confirmed') {
      addLog('PRIVATE PAYMENT', 'The private Zcash payment is confirmed; destination confirmation is still pending.', 'var(--green)')
    } else if (pipeline.privateBalance.status === 'confirmed') {
      addLog('PRIVATE STATE', `Confirmed ZEC-backed balance: ${privateBalanceLabel}.`, 'var(--green)')
    } else if (pipeline.entry.status !== 'idle') {
      addLog('SYNCING', 'The route is waiting for the next confirmed pipeline stage.', '#fbbf24')
    } else {
      addLog('LEDGER', `Current displayed balance: ${privateBalanceLabel}.`, 'var(--info)')
    }
    } catch (error) {
      setPreflightStatus({ loading: false, error: error instanceof Error ? error.message : 'Readiness check failed.' })
      addLog('PREFLIGHT FAILED', error instanceof Error ? error.message : 'Readiness check failed.', 'var(--danger)')
    }
    setIsCheckingStatus(false)
  }

  const modeLabel = 'TESTNET READINESS & TRANSACTION STATUS'

  const hasDepositRecord = !!latestDeposit
  const depositTxDisplay = latestDeposit?.legs?.deposit?.txHash
  const isDepositRealHash = depositTxDisplay && /^0x[a-fA-F0-9]{64}$/.test(depositTxDisplay)
  const depositExplorerUrl = latestDeposit?.legs?.deposit?.explorerUrl || (isDepositRealHash ? `https://sepolia.basescan.org/tx/${depositTxDisplay}` : undefined)
  const depositAmount = latestDeposit?.fromAmount || 0
  const depositAmountDisplay = hasDepositRecord ? `$${depositAmount.toFixed(2)} ${latestDeposit?.fromAsset || 'USDC'}` : '$0.00 USDC'

  const solanaRecipient = latestSend?.recipientAddress || (latestSend?.toAddress || '')
  const deliveryTxDisplay = latestSend?.legs?.delivery?.txHash
  const isDeliveryRealTx = Boolean(deliveryTxDisplay && (
    latestSend?.toChain === 'solana'
      ? /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(deliveryTxDisplay)
      : latestSend?.toChain === 'base'
        ? /^0x[a-fA-F0-9]{64}$/.test(deliveryTxDisplay)
        : false
  ))
  const deliveryNetworkLabel = latestSend?.toChain === 'solana' ? 'Solana Devnet' : 'Base Sepolia'
  const deliveryExplorerUrl = canonicalExplorerUrl(
    latestSend?.toChain,
    deliveryTxDisplay,
    latestSend?.legs?.delivery?.explorerUrl,
  )
  const deliveryAmount = latestSend?.toAmount || 0
  const deliveryAmountDisplay = latestSend
    ? latestSend.toAsset === 'SOL'
      ? `${deliveryAmount.toFixed(5)} SOL (≈ $${latestSend.fromAmount.toFixed(2)})`
      : `$${deliveryAmount.toFixed(2)} ${latestSend.toAsset}`
    : '$0.00 USDC'
  const deliveryLegStatus = latestSend?.legs?.delivery?.status
  const deliveryConfirmed = hasCompletedDestinationDelivery(latestSend) && isDeliveryRealTx
  const deliveryFinalized = deliveryConfirmed && latestSend?.toChain === 'solana'
  const deliveryFailed = deliveryLegStatus === 'failed'
  // A delivery leg can be reserved before the private Zcash spend confirms.
  // That is not a submitted public payout until a real destination tx exists.
  const deliveryProcessing = Boolean(
    isDeliveryRealTx ||
    (latestSend?.legs?.shielded?.status === 'confirmed' && (
      deliveryLegStatus === 'pending' || deliveryLegStatus === 'broadcasting' || deliveryLegStatus === 'in_progress'
    )),
  )

  // Real Zcash transaction commitment / hash
  const zcashTxHash = latestDeposit?.legs?.shielded?.txHash
  const isRealZcashTx = zcashTxHash && /^[0-9a-fA-F]{64}$/.test(zcashTxHash)
  const zcashExplorerUrl = isRealZcashTx ? `https://testnet.zcashblockexplorer.com/tx/${zcashTxHash}` : undefined

  // Balance breakdown for honest accounting
  const totalUsd = privateBalanceAvailable ? privateBalance.totalUsd : 0
  const prevBal = Math.max(0, totalUsd - depositAmount)
  const vaultBalanceBreakdown = depositAmount > 0 && prevBal > 0
    ? `Total: $${totalUsd.toFixed(2)} (Previous: $${prevBal.toFixed(2)} + New Deposit: $${depositAmount.toFixed(2)})`
    : `Total: $${totalUsd.toFixed(2)} Shielded`

  // Legacy calculations retained for detailed telemetry; the visible pipeline below is canonical.
  const legacyPipelineSteps = [
    {
      num: 1,
      title: hasDepositRecord
        ? (latestDeposit.legs?.deposit?.status === 'confirmed' && isDepositRealHash
            ? `Deposit confirmed on Base Sepolia (${depositAmountDisplay})`
            : latestDeposit.legs?.deposit?.status === 'failed'
            ? `Deposit failed on Base Sepolia`
            : `Deposit confirming on Base Sepolia (${depositAmountDisplay})`)
        : 'Awaiting deposit on Base Sepolia',
      network: 'Base Sepolia',
      detail: hasDepositRecord ? `${depositAmountDisplay} entry on Base Sepolia` : 'No incoming deposit detected yet on Base Sepolia',
      txHash: isDepositRealHash ? depositTxDisplay : undefined,
      explorerUrl: depositExplorerUrl,
      status: hasDepositRecord
        ? (latestDeposit.legs?.deposit?.status === 'confirmed' && isDepositRealHash
            ? 'CONFIRMED'
            : latestDeposit.legs?.deposit?.status === 'failed'
            ? 'FAILED'
            : 'CONFIRMING')
        : 'IDLE',
      statusColor: hasDepositRecord
        ? (latestDeposit.legs?.deposit?.status === 'confirmed' && isDepositRealHash
            ? 'var(--green)'
            : latestDeposit.legs?.deposit?.status === 'failed'
            ? 'var(--danger)'
            : 'var(--warning)')
        : '#94a3b8',
      desc: hasDepositRecord ? 'Source deposit status is taken from the transaction record.' : 'No source deposit is recorded yet.',
      timestamp: latestDeposit?.legs?.deposit?.timestamp ? new Date(latestDeposit.legs.deposit.timestamp).toLocaleString() : 'Awaiting entry',
    },
    {
      num: 2,
      title: hasDepositRecord && latestDeposit?.legs?.deposit?.status === 'confirmed' && isDepositRealHash ? 'Deposit verified; private step awaiting proof' : 'Waiting for confirmed deposit',
      network: 'AURA Router',
      detail: hasDepositRecord && latestDeposit?.legs?.deposit?.status === 'confirmed' && isDepositRealHash ? 'AURA accepted the confirmed deposit; this is not a separate on-chain transaction.' : 'No confirmed deposit to route yet.',
      txHash: undefined,
      explorerUrl: undefined,
      status: hasDepositRecord && latestDeposit?.legs?.deposit?.status === 'confirmed' && isDepositRealHash ? 'PROCESSING' : 'IDLE',
      statusColor: hasDepositRecord && latestDeposit?.legs?.deposit?.status === 'confirmed' && isDepositRealHash ? 'var(--warning)' : '#94a3b8',
      desc: 'Routing is application processing, not a chain confirmation.',
      timestamp: latestDeposit?.legs?.deposit?.timestamp ? new Date(latestDeposit.legs.deposit.timestamp).toLocaleString() : 'No route proof',
    },
    {
      num: 3,
      title: latestDeposit?.legs?.shielded?.status === 'confirmed' && isRealZcashTx
        ? `Tenant Zcash transaction confirmed (${depositAmountDisplay})`
        : latestDeposit?.legs?.shielded?.status === 'failed'
        ? 'Zcash shielding failed'
        : latestDeposit?.legs?.shielded?.status === 'broadcasting' || latestDeposit?.legs?.shielded?.status === 'in_progress'
        ? `Waiting for tenant Zcash confirmation (${depositAmountDisplay})...`
        : 'Waiting for a real Zcash transaction',
      network: 'Zcash Testnet',
      detail: isRealZcashTx ? `Zcash Testnet transaction ${zcashTxHash}` : 'No confirmed Zcash transaction is recorded.',
      txHash: isRealZcashTx ? zcashTxHash : undefined,
      explorerUrl: zcashExplorerUrl,
      status: latestDeposit?.legs?.shielded?.status === 'confirmed' && isRealZcashTx
        ? 'CONFIRMED'
        : latestDeposit?.legs?.shielded?.status === 'failed'
        ? 'FAILED'
        : latestDeposit?.legs?.shielded?.status === 'broadcasting' || latestDeposit?.legs?.shielded?.status === 'in_progress'
        ? 'PROCESSING'
        : 'IDLE',
      statusColor: latestDeposit?.legs?.shielded?.status === 'confirmed' && isRealZcashTx
        ? 'var(--green)'
        : latestDeposit?.legs?.shielded?.status === 'failed'
        ? 'var(--danger)'
        : latestDeposit?.legs?.shielded?.status === 'broadcasting' || latestDeposit?.legs?.shielded?.status === 'in_progress'
        ? 'var(--warning)'
        : '#94a3b8',
      desc: 'This confirms a real Zcash Testnet transaction from AURA-operated private inventory. It does not prove perfect unlinkability.',
      timestamp: latestDeposit?.legs?.shielded?.timestamp ? new Date(latestDeposit.legs.shielded.timestamp).toLocaleString() : 'No confirmation recorded',
    },
    {
      num: 4,
      title: 'Local account identifier',
      network: 'Browser',
      detail: `Account: ${enclaveFingerprint}`,
      txHash: undefined,
      explorerUrl: undefined,
      status: 'INFO',
      statusColor: '#94a3b8',
      desc: 'This is an account identifier, not a blockchain transaction or proof of a private balance.',
      timestamp: 'Local account metadata',
    },
    {
      num: 5,
      title: `Private Balance recorded ($${totalUsd.toFixed(2)})`,
      network: 'AURA records',
      detail: vaultBalanceBreakdown,
      txHash: undefined,
      explorerUrl: undefined,
      status: totalUsd > 0 ? 'RECORDED' : 'IDLE',
      statusColor: totalUsd > 0 ? '#6366f1' : '#94a3b8',
      desc: 'This is the balance recorded by AURA after confirmed chain data; it is not a separate blockchain transaction.',
      timestamp: 'Live state',
    },
    {
      num: 6,
      title: latestSend
        ? 'Client authorization accepted by the server'
        : 'Local spend authorization',
      network: 'WebCrypto Keystore',
      detail: latestSend
        ? 'The request passed client-signature validation; this value is not a chain transaction.'
        : 'A local signature is requested when a payment is submitted.',
      txHash: undefined,
      explorerUrl: undefined,
      status: latestSend ? 'AUTHORIZED' : 'READY',
      statusColor: latestSend ? 'var(--green)' : '#77727d',
      desc: 'Browser authorization is separate from the private Zcash step and the public payout.',
      timestamp: latestSend ? 'Signed locally' : 'Ready',
    },
    {
      num: 7,
      title: latestSend
        ? (deliveryConfirmed
            ? `${deliveryNetworkLabel} payout confirmed (${deliveryAmountDisplay})`
            : deliveryFailed
            ? `${deliveryNetworkLabel} payout failed`
            : latestSend.status === 'failed'
              ? 'Payment stopped before recipient payout'
              : deliveryProcessing
                ? `${deliveryNetworkLabel} payout in progress (${deliveryAmountDisplay})...`
                : 'Waiting for confirmed Zcash spend before payout')
        : 'Awaiting payout dispatch',
      network: deliveryNetworkLabel,
      detail: latestSend
        ? (deliveryConfirmed
            ? `Settlement transaction confirmed on ${deliveryNetworkLabel}`
            : deliveryFailed
              ? 'Destination-chain transaction failed.'
              : deliveryProcessing
                ? `AURA testnet route is processing payout on ${deliveryNetworkLabel}`
                : 'No destination transaction has been submitted.')
        : 'Awaiting payout dispatch',
      txHash: isDeliveryRealTx ? deliveryTxDisplay : undefined,
      explorerUrl: deliveryExplorerUrl,
      status: deliveryConfirmed
        ? 'CONFIRMED'
        : deliveryFailed
        ? 'FAILED'
        : deliveryProcessing
        ? 'PROCESSING'
        : 'IDLE',
      statusColor: latestSend
        ? (deliveryConfirmed
            ? 'var(--green)'
            : deliveryFailed
            ? 'var(--danger)'
            : deliveryProcessing
              ? 'var(--warning)'
              : '#94a3b8')
        : '#94a3b8',
      desc: 'Destination status is taken from the recorded chain transaction.',
      timestamp: latestSend?.legs?.delivery?.timestamp ? new Date(latestSend.legs.delivery.timestamp).toLocaleString() : 'No delivery timestamp',
    },
    {
      num: 8,
      title: latestSend
        ? (deliveryConfirmed
            ? `Payment delivered to recipient — ${deliveryFinalized ? 'Transaction finalized' : 'Transaction confirmed'}`
            : deliveryFailed
            ? 'Destination payout failed'
            : latestSend.status === 'failed'
              ? 'Payment stopped before destination payout'
              : deliveryProcessing
                ? `Delivering payment to recipient on ${deliveryNetworkLabel}...`
                : 'Waiting for confirmed shielded spend')
        : 'Awaiting destination payout execution',
      network: deliveryNetworkLabel,
      detail: latestSend
        ? (deliveryConfirmed
            ? `${deliveryAmountDisplay} ${deliveryFinalized ? 'finalized' : 'confirmed'} on ${deliveryNetworkLabel} to recipient`
            : deliveryFailed
            ? 'Payout transaction failed during broadcast'
            : deliveryProcessing
              ? `Destination payout in progress on ${deliveryNetworkLabel}`
              : 'Destination transaction has not been submitted.')
        : 'Ready to dispatch once spend is executed',
      txHash: isDeliveryRealTx ? deliveryTxDisplay : undefined,
      explorerUrl: deliveryExplorerUrl,
      status: deliveryConfirmed
        ? (deliveryFinalized ? 'FINALIZED' : 'CONFIRMED')
        : deliveryFailed
        ? 'FAILED'
        : deliveryProcessing
        ? 'PROCESSING'
        : 'IDLE',
      statusColor: deliveryConfirmed
        ? 'var(--green)'
        : deliveryFailed
        ? 'var(--danger)'
        : deliveryProcessing
        ? 'var(--warning)'
        : '#94a3b8',
      desc: 'The recipient receives the payout without a direct public wallet-to-wallet payment. Timing and amounts may still connect the activity.',
      timestamp: latestSend?.legs?.delivery?.timestamp ? new Date(latestSend.legs.delivery.timestamp).toLocaleString() : 'No delivery timestamp',
    },
  ]

  const canonicalPipeline = buildPipelineState({
    deposit: latestDeposit,
    spend: latestSend,
    privateBalanceUsd: privateBalance.totalUsd,
    privateBalanceSynced: privateBalanceAvailable,
  })
  const stage = (state: { status: string; hash?: string }, network: string, timestamp?: number, recovering = false) => ({
    network,
    txHash: state.hash,
    explorerUrl: state.hash ? network.includes('Base')
      ? `https://sepolia.basescan.org/tx/${state.hash}`
      : network.includes('Solana')
        ? `https://solscan.io/tx/${state.hash}?cluster=devnet`
        : `https://testnet.cipherscan.app/tx/${state.hash}` : undefined,
    status: recovering && state.status === 'processing' ? 'BROADCASTED' : state.status === 'confirmed' ? 'CONFIRMED' : state.status === 'finalized' ? 'FINALIZED' : state.status === 'failed' ? 'FAILED' : state.status === 'processing' ? 'PROCESSING' : 'IDLE',
    statusColor: recovering && state.status === 'processing' ? 'var(--green)' : state.status === 'confirmed' || state.status === 'finalized' ? 'var(--green)' : state.status === 'failed' ? 'var(--danger)' : state.status === 'processing' ? 'var(--warning)' : '#94a3b8',
    timestamp: timestamp ? new Date(timestamp).toLocaleString() : 'Awaiting confirmation',
  })
  const pipelineSteps = [
    { num: 1, title: 'Base deposit confirmed', detail: canonicalPipeline.entry.hash || 'Waiting for the public entry receipt', desc: 'Public entry verified on Base Sepolia.', ...stage(canonicalPipeline.entry, 'Base Sepolia', latestDeposit?.legs?.deposit?.timestamp) },
    { num: 2, title: 'Private Zcash step confirmed', detail: canonicalPipeline.shielding.hash || 'Waiting for the private balance step', desc: 'The private Zcash step is confirmed on Zcash Testnet.', ...stage(canonicalPipeline.shielding, 'Zcash Testnet', latestDeposit?.legs?.shielded?.timestamp) },
    { num: 3, title: 'Private Balance updated', detail: canonicalPipeline.privateBalance.status === 'confirmed' ? `$${canonicalPipeline.privateBalance.usd.toFixed(2)} backed by Zcash` : 'Waiting for confirmed balance data', desc: 'AURA reads the balance after the confirmed private step.', ...stage(canonicalPipeline.privateBalance, 'AURA Private Balance') },
    { num: 4, title: 'Private Zcash payment', detail: canonicalPipeline.spend.hash || (canonicalPipeline.destination.status === 'finalized' ? 'Inventory-backed payout; Zcash settlement continues asynchronously' : 'Pay has not created the private payment'), desc: canonicalPipeline.destination.status === 'finalized' ? 'The payout is finalized; Zcash settlement/reconciliation continues asynchronously.' : 'The private payment confirmation is checked before the public payout is treated as complete.', ...stage(canonicalPipeline.spend, 'Zcash Testnet', latestSend?.legs?.shielded?.timestamp, canonicalPipeline.destination.status === 'finalized') },
    { num: 5, title: 'Public payout submitted', detail: latestSend?.recipientAddress || 'Waiting for the destination payout', desc: 'The payout is sent after the private payment confirms.', ...stage(canonicalPipeline.destination, 'Solana Devnet', latestSend?.legs?.delivery?.timestamp) },
    { num: 6, title: 'Destination payment confirmed', detail: canonicalPipeline.destination.hash || 'Waiting for destination confirmation', desc: 'This is the final recipient-facing network receipt.', ...stage(canonicalPipeline.destination, 'Solana Devnet', latestSend?.legs?.delivery?.timestamp) },
  ]

  const stage1Status = hasDepositRecord
    ? (latestDeposit.legs?.deposit?.status === 'confirmed' && isDepositRealHash
        ? 'Confirmed'
        : latestDeposit.legs?.deposit?.status === 'failed'
        ? 'Failed'
        : 'Confirming')
    : 'Not Initiated'

  const stage2Status = hasDepositRecord
    ? (latestDeposit?.legs?.shielded?.status === 'confirmed' && isRealZcashTx
        ? 'Confirmed'
        : latestDeposit?.legs?.shielded?.status === 'failed'
        ? 'Failed'
        : latestDeposit?.legs?.shielded?.status === 'broadcasting' || latestDeposit?.legs?.shielded?.status === 'in_progress'
        ? 'Processing'
        : 'Not Initiated')
    : 'Not Initiated'

  const stage3Status = deliveryFinalized
    ? 'Finalized'
    : deliveryConfirmed
    ? 'Confirmed'
    : deliveryFailed
    ? 'Failed'
    : deliveryProcessing
    ? 'Processing'
    : 'Not Initiated'

  const renderJuryProofBar = () => {
    const getBadgeStyle = (status: string) => {
      if (status === 'Confirmed') return { bg: 'var(--green-light)', color: 'var(--green)', border: 'var(--green)' }
      if (status === 'Confirming' || status === 'Shielding' || status === 'Processing') return { bg: 'var(--warning-light)', color: 'var(--warning)', border: 'var(--warning)' }
      if (status === 'Failed') return { bg: 'var(--danger-light)', color: 'var(--danger)', border: 'var(--danger)' }
      return { bg: '#f1eff5', color: '#77727d', border: '#e7e4eb' }
    }

    const s1 = getBadgeStyle(stage1Status)
    const s2 = getBadgeStyle(stage2Status)
    const s3 = getBadgeStyle(stage3Status)

    return (
      <div
        style={{
          background: 'linear-gradient(135deg, #f8f6fc 0%, #f1ecfa 100%)',
          border: '1.5px solid #d9d0ff',
          borderRadius: 14,
          padding: '14px 18px',
          marginBottom: 20,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            3-Stage Proof Bar (Public Entry → Private State → Public Exit)
          </span>
          <span style={{ fontSize: 10, color: '#77727d', fontWeight: 600 }}>
            Chain status requires a real transaction hash and confirmation
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr auto 1fr', alignItems: 'center', gap: 10 }}>
          {/* Stage 1: Public Entry */}
          <div
            onClick={() => {
              if (depositExplorerUrl) window.open(depositExplorerUrl, '_blank')
              else if (pipelineSteps[0]) setSelectedDetailStep(pipelineSteps[0])
            }}
            style={{
              background: '#fff',
              border: `1.5px solid ${s1.border}`,
              borderRadius: 10,
              padding: '10px 12px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: '#6b55df', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                PUBLIC ENTRY
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: s1.bg,
                  color: s1.color,
                }}
              >
                {stage1Status}
              </span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#191820' }}>Base Sepolia</div>
            <div style={{ fontSize: 11, color: '#77727d', marginTop: 2 }}>{depositAmountDisplay} deposit</div>
          </div>

          {/* Connecting Arrow */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ArrowRightIcon size={16} color={stage1Status === 'Confirmed' ? 'var(--green)' : 'var(--violet)'} />
          </div>

          {/* Stage 2: Private State */}
          <div
            onClick={() => {
              if (zcashExplorerUrl) window.open(zcashExplorerUrl, '_blank')
              else if (pipelineSteps[2]) setSelectedDetailStep(pipelineSteps[2])
            }}
            style={{
              background: '#fff',
              border: `1.5px solid ${s2.border}`,
              borderRadius: 10,
              padding: '10px 12px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: '#6b55df', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                PRIVATE STATE
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: s2.bg,
                  color: s2.color,
                }}
              >
                {stage2Status}
              </span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#191820' }}>Zcash Testnet</div>
            <div style={{ fontSize: 11, color: '#77727d', marginTop: 2 }}>Shielded Pool</div>
          </div>

          {/* Connecting Arrow */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ArrowRightIcon size={16} color={stage2Status === 'Confirmed' ? 'var(--green)' : 'var(--violet)'} />
          </div>

          {/* Stage 3: Public Exit */}
          <div
            onClick={() => {
              if (deliveryExplorerUrl) window.open(deliveryExplorerUrl, '_blank')
              else if (pipelineSteps[5]) setSelectedDetailStep(pipelineSteps[5])
            }}
            style={{
              background: '#fff',
              border: `1.5px solid ${s3.border}`,
              borderRadius: 10,
              padding: '10px 12px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: '#6b55df', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                PUBLIC EXIT
              </span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: s3.bg,
                  color: s3.color,
                }}
              >
                {stage3Status}
              </span>
            </div>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#191820' }}>{deliveryNetworkLabel}</div>
            <div style={{ fontSize: 11, color: '#77727d', marginTop: 2 }}>{deliveryAmountDisplay} payout</div>
          </div>
        </div>
      </div>
    )
  }

  // Embedded View Rendering (inside page container)
  if (embedded) {
    return (
      <div
        className="live-execution-log-embedded"
        style={{
          background: '#fff',
          border: '1px solid #d9d0ff',
          borderRadius: 16,
          padding: 20,
          margin: '24px 0',
          boxShadow: '0 4px 20px rgba(107, 85, 223, 0.08)',
        }}
      >
        {/* Header Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#94a3b8',
                boxShadow: '0 0 10px #94a3b8',
                display: 'inline-block',
              }}
            />
            <div>
              <strong style={{ fontSize: 15, color: '#191820', display: 'flex', alignItems: 'center', gap: 6 }}>
                Live Execution Log &amp; Jury Telemetry
                <span style={{ fontSize: 10, fontWeight: 800, background: '#f1eff5', color: '#655e71', padding: '2px 8px', borderRadius: 4 }}>
                  STATUS VIEW
                </span>
              </strong>
              <small style={{ color: '#77727d', fontSize: 11 }}>
                Recorded transaction states and current network readiness
              </small>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={runReadinessAndStatusCheck}
              disabled={isCheckingStatus}
              style={{
                background: isCheckingStatus ? 'var(--warning)' : 'var(--violet)',
                color: '#fff',
                border: 0,
                borderRadius: 8,
                padding: '6px 12px',
                fontSize: 11,
                fontWeight: 700,
                cursor: isCheckingStatus ? 'wait' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <ZapIcon size={12} color="#fff" />
              <span>{isCheckingStatus ? 'Checking readiness...' : 'Check readiness &amp; status'}</span>
            </button>
          </div>
        </div>

        {/* 3-Stage Jury Proof Bar */}
        {renderJuryProofBar()}

        {/* Six-stage visual pipeline */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8, marginBottom: 16 }}>
          {pipelineSteps.map((s) => {
    const isStepConfirmed = s.status === 'CONFIRMED'
            const isStepConfirming = s.status === 'CONFIRMING' || s.status === 'SHIELDING' || s.status === 'PROCESSING'
            const isStepFailed = s.status === 'FAILED'
            const isCurrent = activeStepIndex === s.num && isCheckingStatus
            return (
              <div
                key={s.num}
                style={{
                  background: isCurrent ? 'var(--warning-light)' : isStepConfirmed ? '#fbfafc' : isStepFailed ? 'var(--danger-light)' : '#faf9fc',
                  border: `1px solid ${isCurrent ? 'var(--warning)' : isStepConfirmed ? 'var(--green-border)' : isStepFailed ? 'var(--danger-border)' : '#e7e4eb'}`,
                  borderRadius: 10,
                  padding: '10px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  transition: 'all 0.2s ease',
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: isStepConfirmed ? 'var(--green-dark)' : isStepFailed ? 'var(--danger)' : isStepConfirming ? 'var(--warning)' : '#77727d' }}>
                      {isStepConfirmed ? '✓ ' : isStepFailed ? '✕ ' : isStepConfirming ? '● ' : ''}Step {s.num}: {s.title}
                    </span>
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 800,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: isStepConfirmed ? 'var(--green-light)' : isStepFailed ? 'var(--danger-light)' : isStepConfirming ? 'var(--warning-light)' : '#f1eff5',
                        color: s.statusColor || '#77727d',
                      }}
                    >
                      {s.status}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#191820', fontWeight: 600 }}>{s.detail}</div>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => setSelectedDetailStep(s)}
                    style={{
                      background: '#fcfbfe',
                      border: '1px solid #d9d0ff',
                      borderRadius: 4,
                      padding: '2px 8px',
                      fontSize: 10,
                      fontWeight: 700,
                      color: 'var(--violet, #6b55df)',
                      cursor: 'pointer',
                    }}
                  >
                    View Details
                  </button>

                  {s.explorerUrl && isStepConfirmed && (
                    <a
                      href={s.explorerUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 10,
                        color: 'var(--violet)',
                        fontWeight: 700,
                        textDecoration: 'none',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <ExternalLinkIcon size={11} color="var(--violet)" />
                        {s.network.includes('Base') ? 'BaseScan Sepolia' : s.network.includes('Solana') ? 'SolScan Devnet' : 'Zcash Testnet'}
                      </span>
                    </a>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Real-Time Protocol Stream Feed */}
        <div
          ref={logContainerRef}
          style={{
            background: '#191820',
            borderRadius: 12,
            padding: 12,
            color: '#d4ccff',
            fontFamily: 'var(--font-ui)',
            fontSize: 11,
            lineHeight: 1.5,
            maxHeight: 140,
            overflowY: 'auto',
            boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 4, marginBottom: 8 }}>
              <span style={{ color: '#a78bfa', fontWeight: 700 }}>READINESS &amp; STATUS</span>
            <span style={{ color: '#9ca3af', fontSize: 9 }}>CHECK ON DEMAND</span>
          </div>

          {statusLogs.map((log, idx) => (
            <div key={idx} style={{ marginTop: 2, color: log.color || '#9ca3af' }}>
              <span style={{ opacity: 0.6 }}>[{log.time}]</span> &gt; <span style={{ fontWeight: 700 }}>[{log.tag}]</span> {log.message}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Floating / Persistent Dock Mode
  return (
    <>
      {/* Floating Trigger Button (Bottom Right, placed beside Demo Walkthrough) */}
      {!isOpen && (
        <button
          type="button"
          className="live-execution-trigger"
          onClick={() => setIsOpen(true)}
          style={{
            position: 'fixed',
            bottom: 24,
            right: 216,
            zIndex: 999,
            background: 'var(--ink)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 30,
            padding: '9px 16px',
            fontSize: 12,
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--green)',
              boxShadow: '0 0 6px rgba(0, 153, 102, 0.35)',
              display: 'inline-block',
            }}
          />
          <span>Demo execution log · 6 steps</span>
        </button>
      )}

      {/* Floating Dock Modal */}
      {isOpen && (
        <div className="modal-backdrop" onClick={() => setIsOpen(false)} style={{ zIndex: 1200 }}>
          <div
            className="modal-window"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 840,
              width: '95%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              padding: 0,
              overflow: 'hidden',
              borderRadius: 20,
              boxShadow: '0 25px 60px rgba(25, 24, 32, 0.35)',
            }}
          >
            {/* Header */}
            <div
              style={{
                background: 'linear-gradient(135deg, #191820 0%, #2f274a 100%)',
                padding: '20px 24px',
                color: '#fff',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--green-border)',
                      boxShadow: '0 0 10px var(--green-border)',
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--green-border)',
                    }}
                  >
                    {modeLabel}
                  </span>
                </div>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#fff' }}>
                  Network Readiness &amp; Transaction Status
                </h3>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: '#beb7d6' }}>
                  Current network checks and recorded public → private → public transaction states
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  onClick={runReadinessAndStatusCheck}
                  disabled={isCheckingStatus}
                  style={{
                    background: isCheckingStatus ? 'var(--warning)' : 'rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: 8,
                    padding: '6px 12px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: isCheckingStatus ? 'wait' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <ZapIcon size={12} color="#fff" />
                  <span>{isCheckingStatus ? 'Checking readiness...' : 'Check readiness &amp; status'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false)
                    onClose?.()
                  }}
                  style={{
                    background: 'rgba(255, 255, 255, 0.12)',
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
            </div>

            {/* Clean Tab Navigation */}
            <div
              style={{
                display: 'flex',
                borderBottom: '1px solid #e7e4eb',
                background: '#fff',
                padding: '0 24px',
                gap: 20,
              }}
            >
              <button
                type="button"
                onClick={() => setModalTab('pipeline')}
                style={{
                  padding: '12px 4px',
                  fontSize: 13,
                  fontWeight: 700,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: modalTab === 'pipeline' ? 'var(--violet)' : '#77727d',
                  borderBottom: modalTab === 'pipeline' ? '2px solid var(--violet)' : '2px solid transparent',
                  transition: 'all 0.15s ease',
                }}
              >
                Pipeline Verification (6 Steps)
              </button>
              <button
                type="button"
                onClick={() => setModalTab('telemetry')}
                style={{
                  padding: '12px 4px',
                  fontSize: 13,
                  fontWeight: 700,
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  color: modalTab === 'telemetry' ? 'var(--violet)' : '#77727d',
                  borderBottom: modalTab === 'telemetry' ? '2px solid var(--violet)' : '2px solid transparent',
                  transition: 'all 0.15s ease',
                }}
              >
                System Telemetry &amp; Diagnostics
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: 24, overflowY: 'auto', flex: 1, background: '#faf9fc' }}>
              {modalTab === 'pipeline' ? (
                <>
                  {/* 3-Stage Jury Proof Bar */}
                  {renderJuryProofBar()}

              {/* Multi-Chain Route Matrix */}
              <div
                style={{
                  background: '#fff',
                  border: '1px solid #d9d0ff',
                  borderRadius: 14,
                  padding: '16px 18px',
                  marginBottom: 20,
                  boxShadow: '0 2px 8px rgba(107, 85, 223, 0.06)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    Multi-Chain Route Matrix
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--green)', color: '#fff', padding: '2px 8px', borderRadius: 4 }}>
                1 ENABLED · 3 PLANNED
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
                  {AURA_ROUTE_MATRIX.map((r) => (
                    <div
                      key={r.route}
                      style={{
                        background: r.isLive ? 'var(--lav)' : '#faf9fc',
                        border: `1px solid ${r.isLive ? '#c7b9fa' : '#e7e4eb'}`,
                        borderRadius: 8,
                        padding: '8px 10px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 11,
                      }}
                    >
                      <span style={{ fontWeight: r.isLive ? 700 : 500, color: r.isLive ? 'var(--ink)' : '#77727d' }}>
                        {r.route}
                      </span>
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 800,
                          padding: '1px 5px',
                          borderRadius: 4,
                          background: r.isLive ? 'var(--green)' : '#eee',
                          color: r.isLive ? '#fff' : '#77727d',
                          marginLeft: 6,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {r.badge}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Six-stage pipeline grid */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#77727d', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                  End-to-End Pipeline Telemetry (6 Steps)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 10 }}>
                  {pipelineSteps.map((s) => {
                    const isStepConfirmed = s.status === 'CONFIRMED'
                    const isStepConfirming = s.status === 'CONFIRMING' || s.status === 'SHIELDING' || s.status === 'PROCESSING'
                    const isStepFailed = s.status === 'FAILED'
                    const isCurrent = activeStepIndex === s.num && isCheckingStatus
                    return (
                      <div
                        key={s.num}
                        style={{
                          background: isCurrent ? 'var(--warning-light)' : isStepConfirmed ? '#fff' : isStepFailed ? 'var(--danger-light)' : '#faf9fc',
                          border: `1px solid ${isCurrent ? 'var(--warning)' : isStepConfirmed ? 'var(--green-border)' : isStepFailed ? 'var(--danger-border)' : '#e7e4eb'}`,
                          borderRadius: 12,
                          padding: '12px 14px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.02)',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: isStepConfirmed ? 'var(--green-dark)' : isStepFailed ? 'var(--danger)' : isStepConfirming ? 'var(--warning)' : 'var(--violet)' }}>
                              {isStepConfirmed ? '✓ ' : isStepFailed ? '✕ ' : isStepConfirming ? '● ' : ''}STEP {s.num}: {s.title}
                            </span>
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 800,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: isStepConfirmed ? 'var(--green-light)' : isStepFailed ? 'var(--danger-light)' : isStepConfirming ? 'var(--warning-light)' : '#f1eff5',
                                color: s.statusColor || '#77727d',
                              }}
                            >
                              {s.status}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#191820', marginBottom: 2 }}>
                            {s.detail}
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#77727d', marginTop: 4 }}>
                          {s.desc}
                        </div>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => setSelectedDetailStep(s)}
                            style={{
                              background: '#fcfbfe',
                              border: '1px solid #d9d0ff',
                              borderRadius: 4,
                              padding: '2px 8px',
                              fontSize: 10,
                              fontWeight: 700,
                              color: 'var(--violet, #6b55df)',
                              cursor: 'pointer',
                            }}
                          >
                            View Details
                          </button>

                          {s.explorerUrl && isStepConfirmed && (
                            <a
                              href={s.explorerUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 10,
                                color: 'var(--violet)',
                                fontWeight: 700,
                                textDecoration: 'none',
                              }}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <ExternalLinkIcon size={11} color="var(--violet)" />
                                {s.network.includes('Base') ? 'BaseScan Sepolia' : s.network.includes('Solana') ? 'SolScan Devnet' : 'Zcash Testnet'}
                              </span>
                            </a>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

                </>
              ) : (
                <>
                  {/* Keystore & Protocol Telemetry Summary */}
                  <div
                    style={{
                      background: '#fff',
                      border: '1px solid #e7e4eb',
                      borderRadius: 14,
                      padding: '16px 18px',
                      marginBottom: 16,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 }}>
                      Browser Authorization &amp; Demo Wallet
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, fontSize: 12 }}>
                      <div style={{ background: '#faf9fc', border: '1px solid #eee', borderRadius: 8, padding: '10px 12px' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#77727d', textTransform: 'uppercase', display: 'block' }}>Browser Authorization</span>
                        <strong style={{ color: '#191820', display: 'block', marginTop: 2 }}>Local ECDSA key; does not custody demo funds</strong>
                      </div>
                      <div style={{ background: '#faf9fc', border: '1px solid #eee', borderRadius: 8, padding: '10px 12px' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#77727d', textTransform: 'uppercase', display: 'block' }}>Account Fingerprint</span>
                        <code style={{ color: 'var(--violet)', fontSize: 11, fontWeight: 700, display: 'block', marginTop: 2 }}>{enclaveFingerprint}</code>
                      </div>
                      <div style={{ background: '#faf9fc', border: '1px solid #eee', borderRadius: 8, padding: '10px 12px' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#77727d', textTransform: 'uppercase', display: 'block' }}>Zcash test wallet</span>
                        <code style={{ color: 'var(--green)', fontSize: 11, fontWeight: 700, display: 'block', marginTop: 2, wordBreak: 'break-all' }}>
                          AURA test account
                        </code>
                      </div>
                      <div style={{ background: '#faf9fc', border: '1px solid #eee', borderRadius: 8, padding: '10px 12px' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#77727d', textTransform: 'uppercase', display: 'block' }}>Buffer Policy &amp; Transactions</span>
                        <strong style={{ color: '#191820', display: 'block', marginTop: 2 }}>
                          {(privateBalance.privacyPolicy || 'private').toUpperCase()} · {transactions.length} recorded transaction(s)
                        </strong>
                      </div>
                    </div>
                  </div>

                  {/* Real-Time Live Activity Timeline */}
                  <div
                    style={{
                      background: '#fff',
                      border: '1px solid #e7e4eb',
                      borderRadius: 14,
                      padding: '16px 18px',
                      marginBottom: 16,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: '#191820', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                        Readiness Check &amp; Transaction Status
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--green-light)', color: 'var(--green)', padding: '2px 8px', borderRadius: 4 }}>
                        LATEST CHECK
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 180, overflowY: 'auto' }}>
                      {statusLogs.map((log, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            alignItems: 'baseline',
                            gap: 10,
                            padding: '6px 10px',
                            background: '#faf9fc',
                            border: '1px solid #f0edf5',
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        >
                          <span style={{ fontSize: 10, color: '#77727d', fontFamily: 'var(--font-ui)' }}>{log.time}</span>
                          <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--lav)', color: 'var(--violet)', padding: '1px 6px', borderRadius: 4 }}>
                            {log.tag}
                          </span>
                          <span style={{ color: '#191820', fontWeight: 500, flex: 1 }}>{log.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Multi-Chain Testnet Preflight Verifier */}
                  <div
                    style={{
                      background: '#fff',
                      border: '1px solid #e7e4eb',
                      borderRadius: 14,
                      padding: '16px 18px',
                      marginBottom: 16,
                      boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <strong style={{ fontSize: 13, color: '#191820', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>Demo readiness check</span>
                          {preflightStatus.data?.allReady && preflightStatus.data?.scope === 'active-tenant' && (
                            <span style={{ fontSize: 10, fontWeight: 800, background: 'var(--green-light)', color: 'var(--green)', padding: '1px 6px', borderRadius: 4 }}>
                              TENANT READY
                            </span>
                          )}
                        </strong>
                        <small style={{ color: '#77727d', fontSize: 11 }}>
                          Checks the three networks, testnet funds, and rates needed for this demo route.
                        </small>
                      </div>

                      <button
                        type="button"
                        onClick={runPreflightCheck}
                        disabled={preflightStatus.loading}
                        style={{
                          background: 'var(--lav, #f0edff)',
                          color: 'var(--violet, #6b55df)',
                          border: '1px solid #d9d0ff',
                          borderRadius: 8,
                          padding: '6px 12px',
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: preflightStatus.loading ? 'wait' : 'pointer',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <RefreshIcon size={12} color="var(--violet)" />
                        <span>{preflightStatus.loading ? 'Pinging RPCs...' : 'Run Preflight Check'}</span>
                      </button>
                    </div>

                    {preflightStatus.data && (
                      <div
                        style={{
                          marginTop: 10,
                          padding: '10px 12px',
                          borderRadius: 8,
                          border: `1px solid ${preflightStatus.data.readyForRequestedRun ? 'var(--green-border)' : '#e7e4eb'}`,
                          background: preflightStatus.data.readyForRequestedRun ? 'var(--green-light)' : '#faf9fc',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                          <strong style={{ fontSize: 11, color: '#191820' }}>Requested demo route</strong>
                          <span style={{ fontSize: 10, fontWeight: 800, color: preflightStatus.data.readyForRequestedRun ? 'var(--green)' : 'var(--warning)' }}>
                            {preflightStatus.data.readyForRequestedRun ? 'READY' : 'WAITING'}
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 4, marginTop: 6, fontSize: 10, color: '#77727d' }}>
                           <span>Account: {preflightStatus.data.scope === 'active-tenant' ? 'active' : 'missing'}</span>
                           <span>Ready balance: {preflightStatus.data.tenantBalance?.privateReadyForPayout ? 'ready' : 'not ready'}</span>
                          <span>Add Money: {preflightStatus.data.readyForAddMoney ? 'ready' : 'waiting'}</span>
                          <span>Pay: {preflightStatus.data.tenantPayReady ? 'ready' : 'waiting'}</span>
                        </div>
                      </div>
                    )}

                    {preflightStatus.data && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 10, paddingTop: 10, borderTop: '1px dashed #e7e4eb' }}>
                        <div style={{ background: '#faf9fc', borderRadius: 8, padding: '8px 10px', border: '1px solid #eee' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: '#191820' }}>
                            <span>Base Sepolia</span>
                            <span style={{ color: preflightStatus.data.checks?.baseSepolia?.status === 'ready' ? 'var(--green)' : 'var(--warning)' }}>
                              {preflightStatus.data.checks?.baseSepolia?.status || 'unknown'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: '#77727d', marginTop: 2 }}>
                            RPC {preflightStatus.data.checks?.baseSepolia?.latencyMs}ms · key {preflightStatus.data.checks?.baseSepolia?.demoWallet?.relayerKeyConfigured ? 'ready' : 'missing'} · {preflightStatus.data.checks?.baseSepolia?.demoWallet?.usdcBalance ?? 'unavailable'} USDC / {preflightStatus.data.checks?.baseSepolia?.demoWallet?.ethBalance ?? 'unavailable'} ETH
                          </div>
                        </div>

                        <div style={{ background: '#faf9fc', borderRadius: 8, padding: '8px 10px', border: '1px solid #eee' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: '#191820' }}>
                            <span>Demo capacity</span>
                            <span style={{ color: preflightStatus.data.demoCapacity?.readyForThreeFullDemoRuns ? 'var(--green)' : 'var(--warning)' }}>
                              {preflightStatus.data.demoCapacity?.readyForThreeFullDemoRuns ? 'ready' : 'limited'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: '#77727d', marginTop: 2 }}>
                            {preflightStatus.data.demoCapacity?.runsAvailable ?? 0}/{preflightStatus.data.demoCapacity?.targetRuns ?? DEMO_RUN_TARGET} full demo runs available · this run: ${DEMO_PREFLIGHT_AMOUNT_USD} deposit / ${DEMO_PAYOUT_AMOUNT_USD.toFixed(2)} payout
                          </div>
                        </div>

                        <div style={{ background: '#faf9fc', borderRadius: 8, padding: '8px 10px', border: '1px solid #eee' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: '#191820' }}>
                            <span>Settlement rates</span>
                            <span style={{ color: preflightStatus.data.checks?.settlementRates?.status === 'ready' ? 'var(--green)' : 'var(--warning)' }}>
                              {preflightStatus.data.checks?.settlementRates?.status || 'unknown'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: '#77727d', marginTop: 2 }}>
                            ZEC ${preflightStatus.data.checks?.settlementRates?.zecUsd ?? '—'} · SOL ${preflightStatus.data.checks?.settlementRates?.solUsd ?? '—'} · {preflightStatus.data.checks?.settlementRates?.latencyMs ?? '—'}ms
                          </div>
                        </div>

                        <div style={{ background: '#faf9fc', borderRadius: 8, padding: '8px 10px', border: '1px solid #eee' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: '#191820' }}>
                            <span>Zcash Testnet</span>
                            <span style={{ color: preflightStatus.data.checks?.zcashTestnet?.status === 'ready' ? 'var(--green)' : 'var(--warning)' }}>
                              {preflightStatus.data.checks?.zcashTestnet?.status || 'unknown'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: '#77727d', marginTop: 2 }}>
                            Zcash tool {preflightStatus.data.checks?.zcashTestnet?.binaryAvailable ? 'ready' : 'missing'} · spendable {preflightStatus.data.checks?.zcashTestnet?.spendableBalanceZec ?? '—'} ZEC · private {preflightStatus.data.checks?.zcashTestnet?.shieldedBalanceZec ?? '—'} ZEC · {preflightStatus.data.checks?.zcashTestnet?.latencyMs}ms
                          </div>
                        </div>

                        <div style={{ background: '#faf9fc', borderRadius: 8, padding: '8px 10px', border: '1px solid #eee' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700, color: '#191820' }}>
                            <span>Solana Devnet</span>
                            <span style={{ color: preflightStatus.data.checks?.solanaDevnet?.status === 'ready' ? 'var(--green)' : 'var(--warning)' }}>
                              {preflightStatus.data.checks?.solanaDevnet?.status || 'unknown'}
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: '#77727d', marginTop: 2 }}>
                            Key {preflightStatus.data.checks?.solanaDevnet?.relayerKeyConfigured ? 'ready' : 'missing'} · recipient {preflightStatus.data.checks?.solanaDevnet?.demoRecipientReady ? 'ready' : 'missing'} · {preflightStatus.data.checks?.solanaDevnet?.solBalance ?? 'unavailable'} SOL · {preflightStatus.data.checks?.solanaDevnet?.latencyMs ?? '—'}ms
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Cryptographic Invariants Audit Runner */}
                  <div
                    style={{
                      background: '#fff',
                      border: '1px solid #e7e4eb',
                      borderRadius: 14,
                      padding: '16px 18px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.02)',
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: 13, color: '#191820', display: 'block' }}>
                        Cryptographic &amp; Accounting Audit
                      </strong>
                      <small style={{ color: '#77727d', fontSize: 11 }}>
                        Live test suite verifying BIP-39 checksums, CAS replay attacks, and tenant isolation and authorization invariants.
                      </small>
                      {auditStatus.passed !== undefined && (
                        <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: auditStatus.allPassed ? 'var(--green)' : 'var(--danger)' }}>
                          {auditStatus.allPassed
                            ? `✓ ${auditStatus.passed}/${auditStatus.total} Prototype Checks Passed`
                            : `${auditStatus.passed}/${auditStatus.total} Invariants Passed`}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={runAuditVerification}
                      disabled={auditStatus.loading || !canRunAudit}
                      style={{
                        background: canRunAudit ? 'var(--violet, #6b55df)' : '#e7e4eb',
                        color: canRunAudit ? '#fff' : '#77727d',
                        border: 0,
                        borderRadius: 8,
                        padding: '8px 14px',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: auditStatus.loading ? 'wait' : canRunAudit ? 'pointer' : 'not-allowed',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        flexShrink: 0,
                      }}
                    >
                      <RefreshIcon size={12} color={canRunAudit ? '#fff' : '#77727d'} />
                        <span>{auditStatus.loading
                          ? 'Auditing...'
                          : auditStatus.total !== undefined
                            ? `${auditStatus.total} checks · run locally`
                            : 'Run checks locally'}</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                padding: '12px 24px',
                background: '#fff',
                borderTop: '1px solid #e7e4eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 11,
                color: '#77727d',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <ShieldIcon size={12} color="var(--violet)" /> Testnet demo · server-run test wallets · never use real funds
              </span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                style={{
                  background: 'transparent',
                  border: 0,
                  color: 'var(--violet)',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step Detail Modal */}
      {selectedDetailStep && (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedDetailStep(null)}
          style={{ zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'fixed', inset: 0, background: 'rgba(25, 24, 32, 0.65)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="modal-window"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 540,
              width: '92%',
              background: '#fff',
              borderRadius: 16,
              padding: 0,
              overflow: 'hidden',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.25)',
              border: '1px solid #e7e4eb',
            }}
          >
            {/* Header */}
            <div
              style={{
                background: 'linear-gradient(135deg, #191820 0%, #2f274a 100%)',
                padding: '20px 24px',
                color: '#fff',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#d4ccff', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
                  Step {selectedDetailStep.num} Telemetry Inspector
                </div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>
                  {selectedDetailStep.title}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDetailStep(null)}
                style={{
                  background: 'rgba(255, 255, 255, 0.15)',
                  border: 0,
                  color: '#fff',
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                title="Close"
              >
                <CloseIcon size={14} color="#fff" />
              </button>
            </div>

            {/* Content */}
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Network and Status badges */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontSize: 11, color: '#77727d', fontWeight: 600, display: 'block' }}>Network</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#191820' }}>{selectedDetailStep.network}</span>
                </div>
                <div>
                  <span style={{ fontSize: 11, color: '#77727d', fontWeight: 600, display: 'block' }}>Status</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: selectedDetailStep.status === 'CONFIRMED' || selectedDetailStep.status === 'SHIELDED' ? 'var(--green-light)' : 'var(--warning-light)',
                      color: selectedDetailStep.statusColor || 'var(--green)',
                    }}
                  >
                    {selectedDetailStep.status}
                  </span>
                </div>
                <div>
                  <span style={{ fontSize: 11, color: '#77727d', fontWeight: 600, display: 'block' }}>Timestamp / Execution</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#191820' }}>{selectedDetailStep.timestamp || 'Real-time verified'}</span>
                </div>
              </div>

              {/* Detail description */}
              <div style={{ background: '#faf9fc', border: '1px solid #e7e4eb', borderRadius: 10, padding: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--violet)', marginBottom: 4 }}>Action Summary</div>
                <div style={{ fontSize: 13, color: '#191820', fontWeight: 600, marginBottom: 6 }}>{selectedDetailStep.detail}</div>
                <div style={{ fontSize: 12, color: '#77727d' }}>{selectedDetailStep.desc}</div>
              </div>

              {/* Transaction Hash / Key Commitment */}
              {selectedDetailStep.txHash && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#77727d', marginBottom: 4 }}>
                    {selectedDetailStep.network.includes('Zcash') ? 'Shielded Commitment / Keystore Address' : 'Transaction Hash / Commitment'}
                  </div>
                  <div
                    style={{
                      background: '#191820',
                      color: '#6ee7b7',
                      fontFamily: 'var(--font-ui)',
                      fontSize: 11,
                      padding: '10px 12px',
                      borderRadius: 8,
                      wordBreak: 'break-all',
                      lineHeight: 1.4,
                    }}
                  >
                    {selectedDetailStep.txHash}
                  </div>
                </div>
              )}

              {/* Explorer Link */}
              {selectedDetailStep.explorerUrl && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8 }}>
                  <a
                    href={selectedDetailStep.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      background: 'var(--lav, #f3f0fd)',
                      color: 'var(--violet, #6b55df)',
                      border: '1px solid #d9d0ff',
                      borderRadius: 8,
                      padding: '8px 14px',
                      fontSize: 12,
                      fontWeight: 700,
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span>View on Testnet Explorer ↗</span>
                  </a>
                </div>
              )}
            </div>

            {/* Footer */}
            <div
              style={{
                padding: '12px 24px',
                background: '#faf9fc',
                borderTop: '1px solid #e7e4eb',
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              <button
                type="button"
                onClick={() => setSelectedDetailStep(null)}
                style={{
                  background: 'var(--violet, #6b55df)',
                  color: '#fff',
                  border: 0,
                  borderRadius: 8,
                  padding: '6px 16px',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
