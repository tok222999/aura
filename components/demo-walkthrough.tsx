'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useAura } from '@/lib/context/aura-context'
import { UnlinkabilityModal } from './unlinkability-modal'
import { AuraTransaction, PrivacyBufferMode } from '@/lib/types/aura'
import { CloseIcon } from './aura-icons'
import { validateSolanaAddress } from '@/lib/utils'
import { hasCompletedDestinationDelivery } from '@/lib/utils/transaction-finality'
import { DEMO_DEPOSIT_AMOUNT_USD, DEMO_PAYOUT_AMOUNT_USD } from '@/lib/services/demo-capacity'
import { fundingAgeMs, fundingValueUsdAtRate, fundingCorrelationValueUsd } from '@/lib/utils/privacy-risk'
import { zcashEnclaveService } from '@/lib/services/zcash-enclave-service'

// Base Sepolia finality can lag a mined block by several minutes. Keep the
// same deposit intent alive long enough for finality; this never creates a
// second public transfer.
const DEMO_FINALITY_MAX_ATTEMPTS = 360

async function loadControlledSolanaRecipient(): Promise<string> {
  const response = await fetch('/api/wallet/solana-demo', { cache: 'no-store' })
  const payload = await response.json().catch(() => ({}))
  if (
    !response.ok ||
    !payload.success ||
    payload.recipientType !== 'server-persisted-controlled-demo' ||
    typeof payload.recipientPublicKey !== 'string'
  ) {
    throw new Error(payload.error || 'The controlled Solana Devnet demo recipient is unavailable.')
  }
  return payload.recipientPublicKey
}

function isShieldedSpendExpiry(transaction: AuraTransaction | null): boolean {
  if (!transaction) return false
  const text = [
    transaction.status,
    transaction.legs?.shielded?.status,
    transaction.legs?.shielded?.description,
    transaction.legs?.delivery?.description,
  ].filter(Boolean).join(' ').toLowerCase()
  return text.includes('expired') || text.includes('unconfirmed') || text.includes('not mined')
}

export function DemoWalkthrough() {
  const pathname = usePathname()
  const isDemoSurface = ['/', '/balance', '/send', '/receive', '/activity'].includes(pathname)
  const [isOpen, setIsOpen] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [tourMode, setTourMode] = useState<'quick' | 'fresh' | null>(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showInspector, setShowInspector] = useState(false)
  const [lastDemoTx, setLastDemoTx] = useState<AuraTransaction | null>(null)
  const [verifiedReceiptFallback, setVerifiedReceiptFallback] = useState(false)
  const [demoRecipient, setDemoRecipient] = useState('')
  const [sendAttempted, setSendAttempted] = useState(false)
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false)
  const [confirmationAttempt, setConfirmationAttempt] = useState(0)
  const [confirmationTimedOut, setConfirmationTimedOut] = useState(false)
  const [demoGate, setDemoGate] = useState<{
    status: 'idle' | 'checking' | 'ready' | 'blocked' | 'preview'
    message?: string
    quickReady?: boolean
    freshReady?: boolean
  }>({ status: 'idle' })
  const autoTourStartedRef = useRef(false)
  const gateRunRef = useRef(0)
  const autoConfirmDepositRef = useRef('')
  const [stepData, setStepData] = useState<{
    depositHash?: string
    shieldingHash?: string
    spendHash?: string
    sendHash?: string
  }>({})

  const {
    wallet,
    connectWallet,
    executeDeposit,
    executeSend,
    privateBalance,
    setPrivacyPolicy,
    rates,
    transactions,
    resyncBalance,
    refreshDemoWallet,
  } = useAura()

  const demoWalletReady = wallet.isDemoWallet && wallet.connected && wallet.demoCanSend === true

  const publishDemoReadiness = (quickReady: boolean, freshReady: boolean, checking = false) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('aura:demo-readiness', { detail: { quickReady, freshReady, checking } }))
    }
  }

  const startDemoGate = async () => {
    const runId = ++gateRunRef.current
    setIsOpen(true)
    setDemoGate({ status: 'checking' })
    setActionError(null)
    setVerifiedReceiptFallback(false)
    publishDemoReadiness(false, false, true)
    try {
      if (!wallet.isDemoWallet || !wallet.connected) await connectWallet('demo')
      if (refreshDemoWallet) await refreshDemoWallet()
      const requestPreflight = async (demo: 'quick' | 'fresh', amountUsd: number) => {
        const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
        const authorization = await zcashEnclaveService.signVaultActionLocally('read_preflight')
        const bufferMode = demo === 'quick' ? 'fast' : 'private'
        const response = await fetch(`/api/preflight?demo=${demo}&amountUsd=${amountUsd}&bufferMode=${bufferMode}&ts=${Date.now()}`, {
          cache: 'no-store',
          headers: {
            'x-aura-enclave-fingerprint': enclave.fingerprint,
            'x-aura-auth-timestamp': String(authorization.clientTimestamp),
            'x-aura-auth-nonce': authorization.nonce,
            'x-aura-auth-public-key': authorization.authPublicKey,
            'x-aura-auth-signature': authorization.signature,
          },
        })
        const report = await response.json().catch(() => ({}))
        return { response, report }
      }
      // A stale HttpOnly jury cookie can briefly race with a tab that is
      // activating a different assigned tenant. Re-read the server-selected
      // tenant, rotate the local authority for that tenant, then retry the
      // read-only gates once. Never bypass the tenant consistency check.
      let quickResult = await requestPreflight('quick', DEMO_PAYOUT_AMOUNT_USD)
      let freshResult = await requestPreflight('fresh', DEMO_DEPOSIT_AMOUNT_USD)
      if ((quickResult.response.status === 403 && quickResult.report.error === 'JURY_TENANT_MISMATCH' ||
        freshResult.response.status === 403 && freshResult.report.error === 'JURY_TENANT_MISMATCH') && refreshDemoWallet) {
        await refreshDemoWallet()
        quickResult = await requestPreflight('quick', DEMO_PAYOUT_AMOUNT_USD)
        freshResult = await requestPreflight('fresh', DEMO_DEPOSIT_AMOUNT_USD)
      }
      const quickReady = quickResult.response.ok && quickResult.report.success === true && quickResult.report.readyForQuickDemo === true &&
        quickResult.report.scope === 'active-tenant' && quickResult.report.tenantPayReady === true &&
        quickResult.report.privacyScenarioReady === true
      const freshReady = freshResult.response.ok && freshResult.report.success === true && freshResult.report.readyForFreshDemo === true &&
        freshResult.report.scope === 'active-tenant'
      const ready = quickReady || freshReady
      // Preflight reads the server truth, but the walkthrough also renders
      // client-cached transactions and balance. Force that tenant-scoped
      // read to finish before exposing either path; otherwise the first frame
      // can show stale hashes, a missing warning, or a disabled Pay button.
      await resyncBalance(quickReady ? 'fast' : freshReady ? 'private' : undefined)
      if (runId !== gateRunRef.current) return
      if (!ready) {
        setDemoGate({
          status: 'blocked',
          quickReady,
          freshReady,
           message: quickResult.report.message || freshResult.report.message ||
             (quickResult.report.tenantPayReady === true && quickResult.report.privacyScenarioReady !== true
               ? 'Quick Demo is waiting for a real confirmed funding pattern that can show a Privacy Check warning.'
               : 'The live testnet route is not ready for this demo yet. No transaction was started.'),
        })
        return
      }
      setDemoGate({ status: 'ready', quickReady, freshReady })
      publishDemoReadiness(quickReady, freshReady)
    } catch (error) {
      if (runId !== gateRunRef.current) return
      publishDemoReadiness(false, false)
      setDemoGate({
        status: 'blocked',
        message: error instanceof Error ? error.message : 'The live demo readiness check failed. No transaction was started.',
      })
    }
  }

  useEffect(() => {
    if (pathname !== '/balance' || !isDemoSurface || typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('tour') !== '1' || autoTourStartedRef.current) return
    autoTourStartedRef.current = true
    if (params.get('mode') === 'preview') {
      setIsOpen(true)
      setDemoGate({ status: 'preview' })
    } else {
      void startDemoGate()
    }
  }, [pathname, isDemoSurface])

  useEffect(() => {
    if (!isOpen || currentStep !== 5 || demoRecipient) return
    let active = true
    void loadControlledSolanaRecipient().then((recipient) => {
      if (active) setDemoRecipient(recipient)
    }).catch((err) => {
      if (active) setActionError(err instanceof Error ? err.message : 'Could not load the controlled Solana Devnet recipient.')
    })
    return () => { active = false }
  }, [isOpen, currentStep, demoRecipient])

  if (!isDemoSurface) return null

  // Quick uses Fast because the jury inventory is already confirmed on
  // testnet. The Privacy Check still runs; Quick must not wait for a new
  // deposit or misreport the confirmed shared source as a zero balance.
  const demoPolicy: PrivacyBufferMode = tourMode === 'quick'
    ? 'fast'
    : privateBalance.privacyPolicy || 'private'
  const demoPrivatePayoutReady = (demoPolicy === 'fast'
    ? privateBalance.fastAvailableToSendUsd
    : privateBalance.readyToSpendUsd) !== null &&
    (demoPolicy === 'fast'
      ? (privateBalance.fastAvailableToSendUsd ?? 0)
      : (privateBalance.readyToSpendUsd ?? 0)) >= DEMO_PAYOUT_AMOUNT_USD
  // `null` means the authoritative Zcash read is unavailable; do not fall
  // back to a stale ledger total and let the UI imply that Pay is ready.
  const demoPayoutReady = demoPrivatePayoutReady
  const demoPayBufferMode: PrivacyBufferMode = demoPolicy
  const confirmedFunding = transactions
    .filter((transaction) => (transaction.type === 'deposit' || transaction.type === 'receive') && transaction.status === 'completed')
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt))
  const latestFunding = confirmedFunding[0] || null
  const zecUsd = rates.ZEC?.usdPrice || 0
  const latestFundingAmount = latestFunding ? fundingValueUsdAtRate(latestFunding, zecUsd) : 0
  const latestFundingAgeMs = latestFunding ? fundingAgeMs(latestFunding, Date.now()) : Infinity
  const recentFundingTimingRisk = latestFundingAgeMs < 60 * 60 * 1000 && latestFundingAmount > 0
  const demoPolicyWaitMs = {
    fast: 0,
    private: 24 * 60 * 60 * 1000,
    strong: 72 * 60 * 60 * 1000,
    custom: 7 * 24 * 60 * 60 * 1000,
  }[demoPolicy]
  const demoPolicyAgeRisk = latestFunding !== null &&
    demoPolicy !== 'fast' &&
    latestFundingAgeMs >= 60 * 60 * 1000 && latestFundingAgeMs < demoPolicyWaitMs
  const recentAmountMatch = confirmedFunding.some((transaction) => {
    const amount = fundingCorrelationValueUsd(transaction)
    const amountEchoWindow = demoPolicy === 'fast'
      ? 24 * 60 * 60 * 1000
      : demoPolicy === 'custom'
        ? 14 * 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000
    if (!amount || !latestFunding || fundingAgeMs(transaction, Date.now()) >= amountEchoWindow) return false
    const tolerance = Math.min(1.5, Math.max(0.3, amount * 0.02))
    return Math.abs(DEMO_PAYOUT_AMOUNT_USD - amount) <= tolerance
  })
  const demoPrivacyWarnings = [
    confirmedFunding.length > 0 && !recentFundingTimingRisk && !recentAmountMatch
      ? 'AURA confirmed funding history for this balance. No recent timing or amount match is detected, but public entry and exit remain visible.'
      : null,
    recentFundingTimingRisk ? 'A confirmed funding event is still recent, so timing can be compared.' : null,
    demoPolicyAgeRisk ? 'The latest funding event has not aged through the selected privacy window yet; waiting longer separates the balance from the payment more clearly.' : null,
    recentAmountMatch ? `The $${DEMO_PAYOUT_AMOUNT_USD.toFixed(2)} payout closely echoes a recent funding amount.` : null,
    privateBalance.totalUsd > 0 && DEMO_PAYOUT_AMOUNT_USD >= privateBalance.totalUsd * 0.9 ? 'The payout is close to the full Private Balance.' : null,
  ].filter((warning): warning is string => Boolean(warning))

  const steps = [
    {
      step: 1,
      title: 'Here is the problem',
      subtitle: 'Your wallet should not be the direct payment source',
      text: 'A normal payment starts at your main wallet and goes straight to the recipient. AURA gives you a separate Private Balance to spend from instead.',
      cta: 'Continue →',
    },
    {
      step: 2,
      title: 'Add Money',
      subtitle: `Base Sepolia USDC → Private Balance · $${DEMO_DEPOSIT_AMOUNT_USD.toFixed(2)}`,
      text: `Move $${DEMO_DEPOSIT_AMOUNT_USD.toFixed(2)} from your public Base Sepolia wallet into Private Balance. AURA verifies the real deposit before crediting the balance.`,
      cta: demoWalletReady ? 'Add $1.00 →' : 'Preparing demo wallet…',
    },
    {
      step: 3,
      title: 'Private Balance updated',
      subtitle: 'Private Balance updated · spend readiness checked separately',
      text: `The confirmed deposit is now represented in Private Balance (~$${privateBalance.totalUsd.toFixed(2)}). A confirmed balance is not always ready to spend; AURA checks the selected waiting time before Pay.`,
      cta: 'Continue →',
    },
    {
      step: 4,
      title: 'Privacy Check',
      subtitle: 'Privacy is also a payment decision',
      text: `Before Pay, AURA checks whether the amount and timing resemble a recent deposit. ${demoPrivatePayoutReady ? 'An older ready balance is available, so the payout does not spend the fresh deposit immediately.' : 'This fresh deposit has not completed the selected wait. The demo waits for an existing ready balance instead of bypassing the rule.'}`,
      cta: demoPrivacyWarnings.length > 0 ? 'Acknowledge & continue →' : 'Continue to Pay →',
    },
    {
      step: 5,
      title: 'Pay',
      subtitle: `Spend from Private Balance · $${DEMO_PAYOUT_AMOUNT_USD.toFixed(2)}`,
      text: 'This payment spends from the existing ready balance under the selected timing. The fresh deposit is not used as an immediate exit.',
      cta: 'Continue →',
    },
    {
      step: 6,
      title: 'Verify the proof',
      subtitle: 'Real receipts, not an animation',
      text: 'Review the actual Base, Zcash and Solana identifiers. The demo shows what happened on-chain instead of presenting an animation as proof.',
      cta: 'Close Walkthrough',
    },
  ]

  const current = steps[currentStep - 1]

  const startQuickTour = () => {
    const verifiedFunding = confirmedFunding.find((transaction) =>
      transaction.legs?.deposit?.status === 'confirmed' && transaction.legs?.shielded?.status === 'confirmed'
    ) || latestFunding
    setTourMode('quick')
    setPrivacyPolicy('fast')
    setCurrentStep(4)
    setPrivacyAcknowledged(false)
    setActionError(null)
    setVerifiedReceiptFallback(false)
    setStepData({
      depositHash: verifiedFunding?.legs?.deposit?.txHash,
      shieldingHash: verifiedFunding?.legs?.shielded?.txHash,
    })
  }

  const startFreshTour = () => {
    if (!demoGate.freshReady) {
      setActionError('Fresh Add Money is not ready yet: Base, Zcash, and Solana must complete first.')
      return
    }
    setTourMode('fresh')
    setCurrentStep(1)
    setStepData({})
    setPrivacyAcknowledged(false)
    setActionError(null)
  }

  const closeWalkthrough = () => {
    setIsOpen(false)
    setDemoGate({ status: 'idle' })
    setTourMode(null)
    setCurrentStep(1)
    setStepData({})
    setDemoRecipient('')
    setLastDemoTx(null)
    setVerifiedReceiptFallback(false)
    setSendAttempted(false)
    setPrivacyAcknowledged(false)
    setConfirmationAttempt(0)
    setConfirmationTimedOut(false)
    setActionError(null)
  }

  const waitForSendConfirmation = async (transaction: AuraTransaction): Promise<AuraTransaction> => {
    let latest = transaction
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (hasCompletedDestinationDelivery(latest)) return latest
      if (latest.status === 'failed' || latest.legs?.delivery?.status === 'failed') return latest
      if (attempt < 11) {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        const refreshed = await resyncBalance()
        latest = refreshed.find((candidate) => candidate.id === transaction.id) || latest
      }
    }
    return latest
  }

  useEffect(() => {
    if (!isOpen || demoGate.status !== 'ready' || currentStep !== 3 || !stepData.depositHash || isExecuting) return
    if (autoConfirmDepositRef.current === stepData.depositHash) return
    autoConfirmDepositRef.current = stepData.depositHash
    let cancelled = false

    const confirmDeposit = async () => {
      setIsExecuting(true)
      setConfirmationTimedOut(false)
      for (let attempt = 0; attempt < DEMO_FINALITY_MAX_ATTEMPTS; attempt += 1) {
        if (cancelled) return
        setConfirmationAttempt(attempt + 1)
        // Re-submit the same durable deposit intent while Base finality is
        // pending. executeDeposit reuses the persisted tx hash, so this never
        // creates a second public transfer.
        if (attempt % 3 === 0) {
          try {
            const retried = await executeDeposit('USDC', DEMO_DEPOSIT_AMOUNT_USD, 'base')
            if (retried) {
              setStepData((prev) => ({
                ...prev,
                depositHash: retried.legs?.deposit?.txHash || prev.depositHash,
                shieldingHash: retried.legs?.shielded?.txHash || prev.shieldingHash,
              }))
            }
          } catch {
            // The expected pending-finality response keeps the same intent;
            // the next pass checks again without showing a false failure.
          }
        }
        const latestTransactions = await resyncBalance()
        const latestDep = latestTransactions.find((transaction) =>
          transaction.type === 'deposit' && transaction.legs?.deposit?.txHash === stepData.depositHash
        )
        if (latestDep && latestDep.status === 'completed' && latestDep.legs?.shielded?.status === 'confirmed') {
          if (cancelled) return
          setStepData((prev) => ({
            ...prev,
            depositHash: latestDep.legs?.deposit?.txHash || prev.depositHash,
            shieldingHash: latestDep.legs?.shielded?.txHash || prev.shieldingHash,
          }))
          setConfirmationAttempt(0)
          setIsExecuting(false)
          setCurrentStep(4)
          return
        }
        if (attempt < DEMO_FINALITY_MAX_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      if (cancelled) return
      setConfirmationAttempt(0)
      setConfirmationTimedOut(true)
      setActionError('Zcash confirmation is still pending on-chain. No false success was recorded; verify the last receipt and try again later.')
      setIsExecuting(false)
    }

    void confirmDeposit()
    return () => {
      cancelled = true
    }
  }, [currentStep, demoGate.status, executeDeposit, isExecuting, isOpen, resyncBalance, stepData.depositHash])

  const handleAction = async () => {
    setActionError(null)
    setIsExecuting(true)

    if (currentStep === 1) {
      // Explanation first; wallet readiness belongs to the Add Money step.
      setTimeout(() => {
        setIsExecuting(false)
        setCurrentStep(2)
      }, 600)
    } else if (currentStep === 2) {
      try {
        if (!demoWalletReady) {
          await connectWallet('demo')
          if (refreshDemoWallet) await refreshDemoWallet()
          throw new Error('The demo wallet is still preparing. Add Money will unlock automatically when the live balance is ready.')
        }
        const tx = await executeDeposit('USDC', DEMO_DEPOSIT_AMOUNT_USD, 'base')
        if (tx) {
          const depHash = tx.legs.deposit?.txHash
          setStepData((prev) => ({
            ...prev,
            depositHash: depHash,
            shieldingHash: tx.legs?.shielded?.txHash,
          }))
          setIsExecuting(false)
          setCurrentStep(3)
        } else {
          setIsExecuting(false)
        }
      } catch (err) {
        const failure = err as Error & { pendingFinality?: boolean; txHash?: string }
        if (failure.pendingFinality) {
          setStepData((prev) => ({ ...prev, depositHash: failure.txHash || prev.depositHash }))
          setActionError(null)
          setCurrentStep(3)
        } else {
          setActionError(err instanceof Error ? err.message : 'The testnet deposit failed.')
        }
        setIsExecuting(false)
      }
    } else if (currentStep === 3) {
      let confirmed = false
      let confirmedDeposit: AuraTransaction | null = null
      setConfirmationTimedOut(false)
      for (let attempt = 0; attempt < 60; attempt++) {
        setConfirmationAttempt(attempt + 1)
        const latestTransactions = await resyncBalance()
        const latestDep = latestTransactions.find((t) =>
          t.type === 'deposit' &&
          (!stepData.depositHash || t.legs?.deposit?.txHash === stepData.depositHash)
        )
        if (latestDep && latestDep.status === 'completed' && latestDep.legs?.shielded?.status === 'confirmed') {
          confirmed = true
          confirmedDeposit = latestDep
          break
        }
        if (attempt < 59) await new Promise((r) => setTimeout(r, 2000))
      }
      setIsExecuting(false)
      if (!confirmed) {
        setConfirmationTimedOut(true)
        setActionError('Zcash confirmation is still pending on-chain. No false success was recorded; verify the last receipt and try again later.')
        return
      }
      setConfirmationAttempt(0)
      if (confirmedDeposit) {
        setStepData((prev) => ({
          ...prev,
          depositHash: confirmedDeposit.legs?.deposit?.txHash || prev.depositHash,
          shieldingHash: confirmedDeposit.legs?.shielded?.txHash || prev.shieldingHash,
        }))
      }
      setCurrentStep(4)
    } else if (currentStep === 4) {
      if (!demoPrivatePayoutReady) {
        setActionError('Pay stays blocked until a ready Private Balance is available. Wait for the selected time; the demo will not bypass this rule.')
        setIsExecuting(false)
        return
      }
      setPrivacyAcknowledged(true)
      setIsExecuting(false)
      setCurrentStep(5)
    } else if (currentStep === 5) {
      if (demoPrivacyWarnings.length > 0 && !privacyAcknowledged) {
        setActionError('Read and acknowledge the Privacy Check before starting Pay.')
        setIsExecuting(false)
        return
      }
      let recipient = demoRecipient.trim()
      if (!recipient) {
        try {
          recipient = await loadControlledSolanaRecipient()
          setDemoRecipient(recipient)
        } catch (err) {
          setActionError(err instanceof Error ? err.message : 'Could not load the controlled Solana Devnet recipient.')
          setIsExecuting(false)
          return
        }
      }
      if (!validateSolanaAddress(recipient)) {
        setActionError('Enter a valid Solana Devnet address before sending test SOL.')
        setIsExecuting(false)
        return
      }
      if (sendAttempted) {
        if (!lastDemoTx) {
          setActionError('This payout may already have been submitted. Refresh Activity before trying anything else; no duplicate payment will be created.')
          setIsExecuting(false)
          return
        }
        try {
          const settled = await waitForSendConfirmation(lastDemoTx)
          setLastDemoTx(settled)
          setStepData((prev) => ({ ...prev, sendHash: settled.legs?.delivery?.txHash || prev.sendHash, spendHash: settled.legs?.shielded?.txHash || prev.spendHash }))
          setIsExecuting(false)
          if (hasCompletedDestinationDelivery(settled)) {
            setCurrentStep(6)
          } else if (settled.status === 'failed' || settled.legs?.delivery?.status === 'failed') {
            if (isShieldedSpendExpiry(settled)) {
              setVerifiedReceiptFallback(true)
              setActionError('Zcash Testnet did not mine this spend before expiry. No Solana payout was sent.')
            } else {
              setActionError('The Solana payout transaction failed on Devnet. Inspect the transaction ledger.')
            }
          } else {
            setActionError('Payout is still pending on-chain. Press the status button again later; no second payment will be created.')
          }
        } catch (err) {
          setIsExecuting(false)
          setActionError(err instanceof Error ? err.message : 'Could not refresh payout status.')
        }
        return
      }
      if (!demoPayoutReady) {
        setActionError('The confirmed Private Balance is not available for this demo payout yet. Refresh the live balance and try again.')
        setIsExecuting(false)
        return
      }
      const sendStartedAt = Date.now()
      try {
        const tx = await executeSend(
          recipient,
          'SOL',
          DEMO_PAYOUT_AMOUNT_USD,
          'solana',
           demoPayBufferMode
        )
        if (tx) {
          setSendAttempted(true)
          setLastDemoTx(tx)
          const delivHash = tx.legs?.delivery?.txHash
          setStepData((prev) => ({
            ...prev,
            sendHash: delivHash,
            spendHash: tx.legs?.shielded?.txHash,
          }))

          const settledTx = await waitForSendConfirmation(tx)
          setLastDemoTx(settledTx)
          setStepData((prev) => ({ ...prev, sendHash: settledTx.legs?.delivery?.txHash || prev.sendHash, spendHash: settledTx.legs?.shielded?.txHash || prev.spendHash }))
          const settledDeliveryStatus = settledTx.legs?.delivery?.status
          if (settledTx.status === 'failed' || settledDeliveryStatus === 'failed') {
            setIsExecuting(false)
            if (isShieldedSpendExpiry(settledTx)) {
              setVerifiedReceiptFallback(true)
              setActionError('Zcash Testnet did not mine this spend before expiry. No Solana payout was sent.')
            } else {
              setActionError('The Solana payout transaction failed on Devnet. Inspect the transaction ledger.')
            }
            return
          }

          if (!hasCompletedDestinationDelivery(settledTx)) {
            setIsExecuting(false)
            setActionError('Payout is still pending on-chain. Press the status button again later; no second payment will be created.')
            return
          }

          setIsExecuting(false)
           setCurrentStep(6)
        } else {
          setSendAttempted(false)
          setIsExecuting(false)
          setActionError('The payment could not be processed.')
        }
      } catch (err) {
        console.error('Demo send error', err)
        let recoveredPending = false
        const errorCode = typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code || '')
          : ''
        const errorMessage = err instanceof Error ? err.message : String(err || '')
        const shieldedSpendUnconfirmed = errorCode === 'SHIELDED_SPEND_UNCONFIRMED' ||
          /expired|unconfirmed|not mined|shielded spend/i.test(errorMessage)
        setVerifiedReceiptFallback(shieldedSpendUnconfirmed)
        const safeToRetryWithoutLedgerRecord = new Set([
          'LIVE_RATE_UNAVAILABLE',
          'INSUFFICIENT_FUNDS',
          'LEDGER_BUSY',
          'INVALID_AMOUNT',
          'INVALID_AMOUNT_PRECISION',
          'INVALID_RECIPIENT',
          'INVALID_SOLANA_ADDRESS',
          'UNSUPPORTED_CHAIN',
          'UNSUPPORTED_ASSET',
          'UNSUPPORTED_DEMO_ROUTE',
          'SHIELDED_SPEND_UNCONFIRMED',
          'RATE_LIMIT_EXCEEDED',
          'ZCASH_BALANCE_UNAVAILABLE',
          'INSUFFICIENT_READY_ZEC',
          'NOT_MATURE',
          'ZCASH_FEE_ESTIMATE_UNAVAILABLE',
        ])
        try {
          // A lost HTTP response may still have left a durable pending spend.
          // Recover it from the ledger before allowing another attempt.
          const recovered = (await resyncBalance()).find((candidate) =>
            candidate.type === 'send' &&
            candidate.toChain === 'solana' &&
            candidate.recipientAddress === recipient &&
            candidate.createdAt >= sendStartedAt &&
            candidate.status !== 'failed'
          )
          if (recovered) {
            recoveredPending = true
            setSendAttempted(true)
            setLastDemoTx(recovered)
            setStepData((prev) => ({ ...prev, sendHash: recovered.legs?.delivery?.txHash || prev.sendHash, spendHash: recovered.legs?.shielded?.txHash || prev.spendHash }))
            setActionError('Payout request exists but its response was lost. Check status before retrying; no duplicate payment will be created.')
          } else {
            setSendAttempted(safeToRetryWithoutLedgerRecord.has(errorCode) ? false : true)
          }
        } catch {
          // Keep the conservative duplicate-prevention state if the ledger
          // itself cannot be read after an uncertain request.
          setSendAttempted(true)
        }
        if (!recoveredPending) {
          setActionError(shieldedSpendUnconfirmed
            ? 'Zcash Testnet did not mine this spend before expiry. No Solana payout was sent.'
            : errorMessage || 'The Solana testnet transfer failed.')
        }
        setIsExecuting(false)
      }
    } else if (currentStep === 6) {
      setIsExecuting(false)
      closeWalkthrough()
    }
  }

  return (
    <>
      {/* Floating Launcher Button */}
      <div
        className="demo-floating-btn"
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 999,
        }}
      >
        <button
          type="button"
          className="demo-floating-trigger"
          onClick={() => isOpen ? closeWalkthrough() : void startDemoGate()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 16px',
            borderRadius: 24,
            border: '1px solid #e7e4eb',
            background: '#ffffff',
            color: '#191820',
            font: '600 12px var(--font-ui)',
            cursor: 'pointer',
            boxShadow: '0 4px 18px rgba(0, 0, 0, 0.08)',
            transition: 'all 0.2s ease',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--violet, #6b55df)' }} />
          {isOpen ? 'Close Walkthrough' : 'Interactive Demo Tour'}
        </button>
      </div>

      {/* Guided Modal / Drawer */}
      {isOpen && (
        <div
          style={{
            position: 'fixed',
            bottom: 84,
            right: 24,
            width: 440,
            maxWidth: 'calc(100vw - 48px)',
            background: '#fff',
            borderRadius: 20,
            border: '1px solid #dedbe5',
            boxShadow: '0 24px 64px rgba(35, 28, 64, 0.22)',
            zIndex: 1000,
            padding: '26px 28px',
            fontFamily: 'var(--font-ui)',
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid #e7e4eb',
              paddingBottom: 14,
              marginBottom: 16,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  background: 'var(--lav, #f0edff)',
                  color: 'var(--violet, #6b55df)',
                  fontWeight: 800,
                  fontSize: 11,
                  padding: '3px 8px',
                  borderRadius: 6,
                }}
              >
                {demoGate.status === 'preview'
                  ? 'PRODUCT PREVIEW'
                  : demoGate.status === 'ready'
                  ? tourMode === 'quick' ? `STEP ${currentStep - 3} / 3` : tourMode === 'fresh' ? `STEP ${current.step} / 6` : 'CHOOSE A PATH'
                  : 'READINESS CHECK'}
              </span>
              <strong style={{ fontSize: 13, color: '#191820' }}>{demoGate.status === 'preview' ? 'AURA product preview' : demoGate.status === 'ready' ? 'Hackathon Judge Tour' : 'Prepare the live demo'}</strong>
            </div>
            <button
              type="button"
              onClick={closeWalkthrough}
              style={{
                border: 0,
                background: 'transparent',
                color: '#77727d',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 4,
              }}
              title="Close"
            >
              <CloseIcon size={14} color="#77727d" />
            </button>
          </div>

          {demoGate.status === 'preview' ? (
            <div style={{ padding: '18px 4px 4px' }}>
              <h3 style={{ font: '800 21px var(--font-display)', margin: '0 0 10px', color: '#191820' }}>
                See the AURA flow
              </h3>
              <p style={{ color: '#77727d', fontSize: 13, lineHeight: 1.55, margin: '0 0 16px' }}>
                This is a read-only preview. AURA moves value from a public entry, through Private Balance, to a public recipient. No wallet, key, or testnet transaction is used here.
              </p>
              <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                {[
                  ['01', 'Public entry', 'Base Sepolia deposit receipt'],
                  ['02', 'Private Balance', 'Zcash-backed balance with a clear spend policy'],
                  ['03', 'Public payment', 'Solana Devnet payout with a real receipt'],
                ].map(([number, title, detail]) => (
                  <div key={number} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 10px', border: '1px solid #e7e4eb', borderRadius: 9, background: '#fbfafc' }}>
                    <strong style={{ color: 'var(--violet, #6b55df)', fontSize: 11 }}>{number}</strong>
                    <span style={{ color: '#191820', fontWeight: 750, fontSize: 12 }}>{title}</span>
                    <span style={{ color: '#77727d', fontSize: 11 }}>{detail}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void startDemoGate()}
                style={{ width: '100%', padding: '12px', borderRadius: 10, border: 0, background: 'var(--violet, #6b55df)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
              >
                Check live demo readiness →
              </button>
            </div>
          ) : demoGate.status !== 'ready' ? (
            <div style={{ padding: '18px 4px 4px' }}>
              <h3 style={{ font: '800 21px var(--font-display)', margin: '0 0 10px', color: '#191820' }}>
                {demoGate.status === 'checking' ? 'Checking the live route…' : 'DEMO NOT READY'}
              </h3>
              <p style={{ color: '#77727d', fontSize: 13, lineHeight: 1.55, margin: '0 0 16px' }}>
                {demoGate.status === 'checking'
                  ? 'Checking Base Sepolia, Zcash Testnet, Solana Devnet, rates, and the ready Private Balance. No transaction is sent by this check.'
                  : demoGate.message || 'The demo needs a ready account and available balance before the walkthrough can begin.'}
              </p>
              {demoGate.status === 'blocked' && (
                <button
                  type="button"
                  onClick={() => void startDemoGate()}
                  style={{ width: '100%', padding: '12px', borderRadius: 10, border: 0, background: 'var(--violet, #6b55df)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
                >
                  Check readiness again →
                </button>
              )}
            </div>
          ) : tourMode === null ? (
          <div style={{ padding: '12px 0 2px' }}>
            <h3 style={{ font: '800 21px var(--font-display)', margin: '0 0 8px', color: '#191820' }}>
              Choose the jury path
            </h3>
            <p style={{ color: '#77727d', fontSize: 13, lineHeight: 1.55, margin: '0 0 16px' }}>
              The fast path uses an already verified ready Private Balance. The fresh path starts a new Base entry and can take up to 12 minutes.
            </p>
            <button
              type="button"
              onClick={startQuickTour}
              disabled={!demoGate.quickReady}
              style={{ width: '100%', padding: '13px 14px', borderRadius: 10, border: 0, background: 'var(--violet, #6b55df)', color: '#fff', fontWeight: 800, fontSize: 13, cursor: demoGate.quickReady ? 'pointer' : 'not-allowed', opacity: demoGate.quickReady ? 1 : 0.5, marginBottom: 9 }}
            >
              Quick Jury Demo · Private Balance → Pay
            </button>
            <button
              type="button"
              onClick={startFreshTour}
              disabled={!demoGate.freshReady}
              style={{ width: '100%', padding: '13px 14px', borderRadius: 10, border: '1px solid #dedbe5', background: '#fff', color: '#302c36', fontWeight: 750, fontSize: 13, cursor: demoGate.freshReady ? 'pointer' : 'not-allowed', opacity: demoGate.freshReady ? 1 : 0.5 }}
            >
              Optional: Fresh Add Money · up to 12 min →
            </button>
            <p style={{ color: '#77727d', fontSize: 11, lineHeight: 1.45, margin: '12px 0 0' }}>
              {demoGate.quickReady
                ? 'Ready — starts from the existing verified Private Balance.'
                : demoGate.freshReady
                  ? 'Fresh Add Money is ready — it starts a new $1 Base entry.'
                  : 'Unavailable until the $1 entry and finality path are ready.'}
            </p>
          </div>
          ) : (
          <>
          {/* Progress dots */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
            {steps.filter((step) => tourMode === 'quick' ? step.step >= 4 : true).map((s) => (
              <div
                key={s.step}
                onClick={() => s.step <= currentStep && setCurrentStep(s.step)}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: s.step <= currentStep ? 'var(--violet, #6b55df)' : '#e7e4eb',
                  cursor: s.step <= currentStep ? 'pointer' : 'default',
                  transition: 'all 0.2s ease',
                }}
              />
            ))}
          </div>

          {/* Step Body */}
          <div>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: '#6b55df',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                display: 'block',
                marginBottom: 4,
              }}
            >
              {current.subtitle}
            </span>
            <h3
              style={{
                font: '800 20px var(--font-display)',
                margin: '0 0 10px',
                color: '#191820',
                letterSpacing: '-0.03em',
              }}
            >
              {current.title}
            </h3>
            <p style={{ color: '#77727d', fontSize: 13, lineHeight: 1.55, margin: '0 0 18px' }}>
              {current.text}
            </p>

            {currentStep === 2 && !demoWalletReady && (
              <div
                role="status"
                style={{
                  background: '#f8f6ff',
                  border: '1px solid #ded6ff',
                  borderRadius: 10,
                  padding: '10px 12px',
                  marginBottom: 16,
                  color: '#41356f',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                Preparing the funded demo wallet and live Base Sepolia balance. The action unlocks when the server confirms readiness.
              </div>
            )}

            {currentStep === 3 && isExecuting && (
              <div
                role="status"
                style={{
                  background: '#f6f5f8',
                  border: '1px solid #d9d5df',
                  borderRadius: 10,
                  padding: '10px 12px',
                  marginBottom: 16,
                  color: '#56515d',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                <strong style={{ display: 'block', color: '#302c36', marginBottom: 3 }}>Waiting for Zcash confirmation</strong>
                Checking the real shielded transaction ({confirmationAttempt}/{DEMO_FINALITY_MAX_ATTEMPTS} · up to 12 minutes). The same deposit intent is being resumed; no second public transfer is created.
              </div>
            )}

            {currentStep === 3 && confirmationTimedOut && (
              <div
                style={{
                  background: '#f6f5f8',
                  border: '1px solid #d9d5df',
                  borderRadius: 10,
                  padding: '10px 12px',
                  marginBottom: 16,
                  color: '#56515d',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                Live confirmation is still pending. No success was claimed and no second deposit is sent.{' '}
                <a href="/activity?proof=1" style={{ color: 'var(--violet)', fontWeight: 700 }}>Open last verified receipt →</a>
              </div>
            )}

            {currentStep === 4 && (
              <div style={{ background: '#fff8e8', border: '1px solid #f1d79a', borderRadius: 12, padding: 12, marginBottom: 16, fontSize: 12, lineHeight: 1.5, color: '#5f471f' }}>
                <div style={{ display: 'inline-flex', marginBottom: 10, padding: '4px 8px', borderRadius: 6, background: '#191820', color: '#fff', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em' }}>
                  SHIELDED ≠ READY TO PAY
                </div>
                <div
                  role="status"
                  style={{
                    background: demoPrivatePayoutReady ? '#e7f4ef' : '#f8eaec',
                    border: `1px solid ${demoPrivatePayoutReady ? '#b7dfcf' : '#e2b2b7'}`,
                    borderRadius: 9,
                    padding: '9px 10px',
                    marginBottom: 10,
                    color: demoPrivatePayoutReady ? '#067a55' : '#9a4f57',
                  }}
                >
                  <strong style={{ display: 'block', marginBottom: 2 }}>
                    {demoPrivatePayoutReady ? 'READY — balance available' : 'NOT READY — fresh balance is still inside the selected wait'}
                  </strong>
                  <span>
                    {demoPrivatePayoutReady
                      ? 'Pay can use the older, policy-eligible Private Balance.'
                      : 'Pay stays blocked until a ready balance is available; the demo does not bypass this rule.'}
                  </span>
                </div>
                <strong style={{ display: 'block', marginBottom: 4, color: '#7a571f' }}>Privacy Check</strong>
                {demoPrivacyWarnings.length > 0 ? (
                  <>
                    <span>AURA found {demoPrivacyWarnings.length} public-correlation risk{demoPrivacyWarnings.length === 1 ? '' : 's'} before payment:</span>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {demoPrivacyWarnings.map((warning) => <li key={warning}>{warning}</li>)}
                    </ul>
                  </>
                ) : (
                  <span>No recent simple match detected. This is not a privacy guarantee; public entry, exit, timing, and metadata remain visible.</span>
                )}
              </div>
            )}

            {currentStep === 5 && (
              <>
                <label style={{ display: 'block', marginBottom: 16, fontSize: 12, fontWeight: 700, color: '#191820' }}>
                  Controlled Solana Devnet recipient (server-persisted)
                  <input
                    type="text"
                    value={demoRecipient}
                    readOnly
                    disabled={sendAttempted}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Loading the controlled recipient…"
                    style={{
                      display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6,
                      border: '1px solid #dedbe5', borderRadius: 8, padding: '10px 12px',
                      color: '#191820', font: '12px var(--font-ui)',
                      opacity: sendAttempted ? 0.6 : 1,
                    }}
                  />
                </label>
                {verifiedReceiptFallback && (
                  <div
                    role="status"
                    style={{
                      background: '#fff8e8',
                      border: '1px solid #f1d79a',
                      borderRadius: 10,
                      padding: '11px 12px',
                      marginBottom: 16,
                      color: '#5f471f',
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    <strong style={{ display: 'block', color: '#7a571f', marginBottom: 3 }}>Live Zcash route did not confirm</strong>
                    The spend expired before mining. No Solana payout was sent and this walkthrough will not claim a live success.{' '}
                    <a href="/activity?proof=1" style={{ color: 'var(--violet)', fontWeight: 700 }}>Open the verified jury receipt →</a>
                  </div>
                )}
              </>
            )}

            {/* Proof Box on Step 6 */}
            {currentStep === 6 && (
              <>
                <div
                  style={{
                    background: '#fbfafc',
                    border: '1px solid #e7e4eb',
                    borderRadius: 12,
                    padding: 12,
                    marginBottom: 10,
                    fontSize: 11,
                  }}
                >
                  <div style={{ marginBottom: 6, color: '#191820' }}>
                  <strong>Base deposit receipt:</strong>{' '}
                  <span style={{ fontFamily: 'var(--font-ui)', color: '#6b55df' }}>
                    {stepData.depositHash
                        ? `${stepData.depositHash.slice(0, 18)}...`
                        : 'No transaction hash recorded'}
                    </span>
                  </div>
                  <div style={{ marginBottom: 6, color: '#191820' }}>
                    <strong>Zcash shielding txid:</strong>{' '}
                    <span style={{ fontFamily: 'var(--font-ui)', color: 'var(--green)' }}>
                      {stepData.shieldingHash ? `${stepData.shieldingHash.slice(0, 18)}...` : 'No transaction hash recorded'}
                    </span>
                  </div>
                  <div style={{ marginBottom: 6, color: '#191820' }}>
                  <strong>Zcash spend txid:</strong>{' '}
                  <span style={{ fontFamily: 'var(--font-ui)', color: 'var(--green)' }}>
                      {stepData.spendHash ? `${stepData.spendHash.slice(0, 18)}...` : 'No transaction hash recorded'}
                  </span>
                  </div>
                  <div style={{ color: '#191820' }}>
                  <strong>Solana signature:</strong>{' '}
                  <span style={{ fontFamily: 'var(--font-ui)', color: 'var(--violet, #6b55df)' }}>
                    {stepData.sendHash
                        ? (stepData.sendHash.length > 25 ? `${stepData.sendHash.slice(0, 18)}...` : stepData.sendHash)
                        : 'No transaction hash recorded'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowInspector(true)}
                  style={{
                    width: '100%',
                    marginBottom: 14,
                    padding: '10px 14px',
                    background: 'var(--lav, #f0edff)',
                    border: '1px solid var(--line, #d9d0ff)',
                    borderRadius: 8,
                    color: 'var(--violet, #6b55df)',
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Inspect transaction visibility ↗
                </button>
              </>
            )}
          </div>

          {actionError && <p role="alert" className="form-error" style={{ margin: '0 0 12px' }}>{actionError}</p>}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={handleAction}
              disabled={isExecuting || (currentStep === 2 && !demoWalletReady) || (currentStep === 4 && !demoPrivatePayoutReady)}
              style={{
                flex: 1,
                padding: '12px',
                borderRadius: 10,
                border: 0,
                background: 'var(--violet, #6b55df)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 13,
                cursor: isExecuting || (currentStep === 2 && !demoWalletReady) ? 'not-allowed' : 'pointer',
                opacity: isExecuting || (currentStep === 2 && !demoWalletReady) ? 0.62 : 1,
                boxShadow: '0 8px 18px rgba(107, 85, 223, 0.25)',
                transition: 'all 0.2s ease',
              }}
            >
              {isExecuting
                ? 'Processing testnet action…'
                : currentStep === 5 && sendAttempted
                  ? 'Check payout status →'
                  : current.cta}
            </button>
            {currentStep > (tourMode === 'quick' ? 4 : 1) && (
              <button
                type="button"
                onClick={() => setCurrentStep(currentStep - 1)}
                style={{
                  padding: '12px 14px',
                  borderRadius: 10,
                  border: '1px solid #e7e4eb',
                  background: '#fff',
                  color: '#77727d',
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Back
              </button>
            )}
          </div>
          </>
          )}
        </div>
      )}

      <UnlinkabilityModal
        isOpen={showInspector}
        onClose={() => setShowInspector(false)}
        transaction={lastDemoTx}
      />
    </>
  )
}
