/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { useAura } from '@/lib/context/aura-context'
import { AssetSymbol, ChainId } from '@/lib/types/aura'
import { ArrowRightIcon, AlertTriangleIcon } from '@/components/aura-icons'
import { InvoiceSettledCard } from '@/components/pay/invoice-settled-card'
import { InvoiceExpiredCard } from '@/components/pay/invoice-expired-card'
import { InvoiceFormCard } from '@/components/pay/invoice-form-card'
import { createPaymentAuthorizationMessage, createPaymentPreparationMessage, createPaymentRecoveryAuthorizationMessage } from '@/lib/crypto/payment-authorization'

export default function PayInvoicePage() {
  const params = useParams()
  const requestId = (params?.id as string) || 'req_live'
  const { refreshTransactions } = useAura()

  const [requestState, setRequestState] = useState<'loading' | 'active' | 'processing' | 'consumed' | 'expired' | 'not_found' | 'unsupported'>('loading')
  const [selectedPayAsset, setSelectedPayAsset] = useState<AssetSymbol>('USDC')
  const [selectedPayChain, setSelectedPayChain] = useState<ChainId>('base')
  const [payAmount, setPayAmount] = useState('50.00')
  const [isFixedAmount, setIsFixedAmount] = useState(false)
  const [isFixedAsset, setIsFixedAsset] = useState(false)
  const [isFixedChain, setIsFixedChain] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [txHash, setTxHash] = useState('')
  const [paymentAddress, setPaymentAddress] = useState('')
  const [paymentTokenAddress, setPaymentTokenAddress] = useState('')
  const [rateUsdAtCreation, setRateUsdAtCreation] = useState<number | undefined>()
  const [minimumPaymentAmount, setMinimumPaymentAmount] = useState(0.1)
  const [payerPrepared, setPayerPrepared] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Server-Enforced Replay Protection & Request Status
  useEffect(() => {
    let isMounted = true
    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/requests/${requestId}`, { cache: 'no-store' })
        if (res.status === 404) {
          if (isMounted) setRequestState('not_found')
          return
        }
        if (res.status === 409) {
          const unsupported = await res.json().catch(() => ({}))
          if (isMounted && unsupported.error === 'ROUTE_NOT_ENABLED') {
            setErrorMessage(unsupported.message || 'This payment route is not enabled in the working demo.')
            setRequestState('unsupported')
            return
          }
        }
        if (!res.ok) {
          throw new Error(`Request status check failed (${res.status}).`)
        }
        const json = await res.json()
        if (isMounted) {
          if (!json.success || !json.data) {
            throw new Error('The server did not return a valid payment request.')
          }
          if (json.data.status === 'consumed') {
            setRequestState(json.data.settlementStatus === 'completed' ? 'consumed' : 'processing')
            if (json.data.txHash) setTxHash(json.data.txHash)
          } else if (json.data.status === 'expired') {
            setRequestState('expired')
          } else {
            setRequestState('active')
            setPayerPrepared(Boolean(json.data.payerBound))
            if (Number.isFinite(json.data.minimumAmount)) setMinimumPaymentAmount(Number(json.data.minimumAmount))
            setPaymentAddress(json.data.paymentAddress || '')
            setPaymentTokenAddress(json.data.tokenAddress || '')
            setRateUsdAtCreation(Number.isFinite(json.data.rateUsdAtCreation) ? json.data.rateUsdAtCreation : undefined)
            if (json.data.amount && json.data.amount > 0) {
              setPayAmount(json.data.amount.toFixed(2))
              // Fixed invoices authorize the exact invoice amount. Keep the
              // preparation message aligned with the server-side terms.
              setMinimumPaymentAmount(Number(json.data.amount))
              setIsFixedAmount(true)
            } else {
              setIsFixedAmount(false)
            }
            if (json.data.asset) {
              setSelectedPayAsset(json.data.asset)
              setIsFixedAsset(true)
            }
            if (json.data.chain) {
              setSelectedPayChain(json.data.chain)
              setIsFixedChain(true)
            }
          }
        }
      } catch (err) {
        console.warn('Could not fetch server request status', err)
      }
    }
    checkStatus()
    const interval = setInterval(checkStatus, 5000)
    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [requestId])

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault()
    if (requestState !== 'active') return
    const amt = Number(payAmount)
    if (!Number.isFinite(amt) || amt <= 0 || Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-7) {
      setErrorMessage('Enter a valid amount with no more than two decimal places.')
      return
    }
    if (selectedPayChain === 'base' && selectedPayAsset === 'USDC' && !payerPrepared) {
      setErrorMessage('Prepare the paying wallet before sending a Base payment.')
      return
    }
    if (!txHash.trim()) {
      setErrorMessage('Send the funds to the specified address first, then enter the network transaction code.')
      return
    }

    setIsSubmitting(true)
    setRequestState('processing')
    setErrorMessage(null)

    try {
      const normalizedChain = String(selectedPayChain || 'base').toLowerCase().includes('sol') ? 'solana' : 'base'
      const authorizationMessage = createPaymentAuthorizationMessage({
        requestId,
        txHash: txHash.trim(),
        amountCents: Math.round(amt * 100),
        asset: selectedPayAsset,
        chain: normalizedChain,
      })
      let payerSignature = ''
      let payerPublicKey = ''

      if (normalizedChain === 'base') {
        const ethereum = (window as unknown as {
          ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
        }).ethereum
        if (!ethereum) throw new Error('Base payment needs the wallet that sent the transfer (MetaMask or Coinbase Wallet).')
        const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[]
        payerPublicKey = accounts?.[0] || ''
        if (!payerPublicKey) throw new Error('Connect the wallet that sent the payment, then try again.')
        const messageHex = `0x${Array.from(new TextEncoder().encode(authorizationMessage), byte => byte.toString(16).padStart(2, '0')).join('')}`
        payerSignature = await ethereum.request({ method: 'personal_sign', params: [messageHex, payerPublicKey] }) as string
      } else {
        const solana = (window as unknown as {
          solana?: {
            publicKey?: { toString: () => string }
            connect: () => Promise<{ publicKey: { toString: () => string } }>
            signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array; publicKey?: { toString: () => string } }>
          }
        }).solana
        if (!solana?.signMessage) throw new Error('Solana payment needs Phantom to sign the invoice confirmation.')
        const connected = solana.publicKey ? { publicKey: solana.publicKey } : await solana.connect()
        const signed = await solana.signMessage(new TextEncoder().encode(authorizationMessage), 'utf8')
        payerPublicKey = signed.publicKey?.toString() || connected.publicKey.toString()
        payerSignature = btoa(String.fromCharCode(...signed.signature))
      }

      // Execute atomic consumption on server
      const res = await fetch(`/api/requests/${requestId}/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payAsset: selectedPayAsset,
          payChain: normalizedChain,
          payAmount: amt,
          txHash: txHash.trim(),
          payerSignature,
          ...(normalizedChain === 'solana' ? { payerPublicKey } : {}),
        }),
      })

      const json = await res.json()

      if (res.status === 409 || json.error === 'REQUEST_ALREADY_CONSUMED') {
        setRequestState('consumed')
        if (json.txHash) setTxHash(json.txHash)
        setErrorMessage(json.message || `Invoice Replay Blocked: Payment request #${requestId} has already been settled and consumed.`)
        return
      }

      if (res.status === 410 || json.error === 'REQUEST_EXPIRED') {
        setRequestState('expired')
        setErrorMessage(json.message || 'Payment rejected. This payment request has expired.')
        return
      }

      if (!res.ok || !json.success) {
        setErrorMessage(json.message || json.error || 'Payment execution failed')
        setRequestState('active')
        return
      }

      // Show only a real network transaction hash, never an internal record ID.
      setTxHash(json.txHash || json.transaction?.legs?.delivery?.txHash || json.transaction?.legs?.shielded?.txHash || '')
      setRequestState(json.transaction?.status === 'completed' ? 'consumed' : 'processing')
      setErrorMessage(json.transaction?.status === 'completed'
        ? null
        : 'Source payment is confirmed. Waiting for the shielded Zcash testnet payout to confirm.')
      await refreshTransactions()
    } catch (err) {
      console.error('Payment error', err)
      setErrorMessage(err instanceof Error ? err.message : 'Network connection error')
      setRequestState('active')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handlePrepare = async () => {
    if (requestState !== 'active' || selectedPayChain !== 'base' || selectedPayAsset !== 'USDC') return
    setIsSubmitting(true)
    setErrorMessage(null)
    try {
      const ethereum = (window as unknown as {
        ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
      }).ethereum
      if (!ethereum) throw new Error('Preparation needs the Base wallet that will send the payment.')
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      const payerAddress = accounts?.[0] || ''
      if (!/^0x[0-9a-f]{40}$/i.test(payerAddress)) throw new Error('Connect the wallet that will send the payment.')
      const preparationAmount = isFixedAmount ? Number(payAmount) : minimumPaymentAmount
      if (!Number.isFinite(preparationAmount) || preparationAmount <= 0 ||
        Math.abs(preparationAmount * 100 - Math.round(preparationAmount * 100)) > 1e-7) {
        throw new Error('This invoice does not contain a valid preparation amount.')
      }
      const message = createPaymentPreparationMessage({
        requestId,
        minimumAmountCents: Math.round(preparationAmount * 100),
        asset: selectedPayAsset,
        chain: 'base',
        payerAddress,
      })
      const messageHex = `0x${Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('')}`
      const payerSignature = await ethereum.request({ method: 'personal_sign', params: [messageHex, payerAddress] }) as string
      const res = await fetch(`/api/requests/${requestId}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payerAddress, payerSignature }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.message || json.error || 'Could not prepare this payment wallet.')
      setPayerPrepared(true)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Payment preparation failed.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRecover = async () => {
    if (requestState !== 'active' || selectedPayChain !== 'base' || selectedPayAsset !== 'USDC') return
    setIsSubmitting(true)
    setRequestState('processing')
    setErrorMessage(null)
    try {
      const ethereum = (window as unknown as {
        ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }
      }).ethereum
      if (!ethereum) throw new Error('Payment recovery needs the wallet that sent the Base transfer.')
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      const payerAddress = accounts?.[0] || ''
      if (!/^0x[0-9a-f]{40}$/i.test(payerAddress)) throw new Error('Connect the wallet that sent the payment, then try again.')
      const amount = Number(payAmount)
      if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
        throw new Error('Enter a valid invoice amount before starting recovery.')
      }
      const recoveryMessage = createPaymentRecoveryAuthorizationMessage({
        requestId,
        amountCents: Math.round(amount * 100),
        asset: selectedPayAsset,
        chain: 'base',
        payerAddress,
      })
      const messageHex = `0x${Array.from(new TextEncoder().encode(recoveryMessage), byte => byte.toString(16).padStart(2, '0')).join('')}`
      const payerSignature = await ethereum.request({ method: 'personal_sign', params: [messageHex, payerAddress] }) as string
      const res = await fetch(`/api/requests/${requestId}/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payAsset: selectedPayAsset,
          payChain: 'base',
          payAmount: amount,
          payerSignature,
          recoveryPayerAddress: payerAddress,
        }),
      })
      const json = await res.json()
      if (res.status === 409 || json.error === 'REQUEST_ALREADY_CONSUMED') {
        setRequestState('consumed')
        if (json.txHash) setTxHash(json.txHash)
        setErrorMessage(json.message || 'This payment request was already settled.')
        return
      }
      if (res.status === 410 || json.error === 'REQUEST_EXPIRED') {
        setRequestState('expired')
        setErrorMessage(json.message || 'This payment request has expired.')
        return
      }
      if (!res.ok || !json.success) {
        setErrorMessage(json.message || json.error || 'No matching payment was found.')
        setRequestState('active')
        return
      }
      setTxHash(json.txHash || json.transaction?.legs?.shielded?.txHash || '')
      setRequestState(json.transaction?.status === 'completed' ? 'consumed' : 'processing')
      setErrorMessage(json.transaction?.status === 'completed' ? null : 'Payment recovered. Waiting for the private Zcash step to confirm.')
      await refreshTransactions()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Payment recovery failed.')
      setRequestState('active')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · TESTNET CHECKOUT
            </small>
            <h1>Single-Use Invoice Checkout</h1>
            <p>Pay the exact amount on the selected test network. AURA verifies it before sending the recipient payout.</p>
          </div>

          <div className="visual-flow" style={{ marginBottom: 28 }}>
            <span>PUBLIC ENTRY ({selectedPayChain.toUpperCase()})</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span className="visual-flow-highlight">AURA PRIVATE BALANCE (Zcash Testnet)</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span>RECIPIENT&apos;S PAYOUT</span>
          </div>

          <div className="form-card" style={{ maxWidth: 540, margin: '0 auto', textAlign: 'left' }}>
            {requestState === 'loading' && (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: '#77727d' }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    border: '3px solid #f0edff',
                    borderTopColor: 'var(--violet, #6b55df)',
                    margin: '0 auto 16px',
                    animation: 'spin 1s linear infinite',
                  }}
                />
                <strong style={{ display: 'block', fontSize: 14, color: '#191820', marginBottom: 4 }}>
                  Verifying Invoice Route...
                </strong>
                <span style={{ fontSize: 12 }}>Checking single-use invoice status and cryptographic destination</span>
              </div>
            )}

            {requestState === 'not_found' && (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(223, 85, 85, 0.1)', color: '#c53b3b', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                  <AlertTriangleIcon size={24} color="#c53b3b" />
                </div>
                <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#191820' }}>
                  Invoice Not Found (404)
                </h3>
                <p style={{ margin: '0 0 20px', fontSize: 13, color: '#77727d', lineHeight: 1.5 }}>
                  This payment request ID (<code style={{ fontFamily: 'var(--font-ui)', background: '#f3f2f5', padding: '2px 6px', borderRadius: 4 }}>{requestId}</code>) does not exist, has expired, or was created in a separate session.
                </p>
                <Link
                  href="/receive"
                  style={{
                    display: 'inline-block',
                    padding: '10px 18px',
                    background: 'var(--violet)',
                    color: '#fff',
                    borderRadius: 8,
                    fontWeight: 700,
                    fontSize: 13,
                    textDecoration: 'none',
                  }}
                >
                  Create New Payment Request →
                </Link>
              </div>
            )}

            {requestState === 'unsupported' && (
              <div style={{ padding: '36px 20px', textAlign: 'center' }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(107, 85, 223, 0.1)', color: 'var(--violet)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                  <AlertTriangleIcon size={24} color="var(--violet)" />
                </div>
                <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800, color: '#191820' }}>
                  Route Not Enabled
                </h3>
                <p style={{ margin: 0, fontSize: 13, color: '#77727d', lineHeight: 1.5 }}>
                  {errorMessage || 'The working demo accepts Base Sepolia USDC entry only. Other networks are coming next.'}
                </p>
              </div>
            )}

            {requestState === 'consumed' && (
              <InvoiceSettledCard txHash={txHash} />
            )}

            {requestState === 'expired' && (
              <InvoiceExpiredCard />
            )}

            {requestState === 'processing' && (
              <div style={{ padding: '30px 20px', textAlign: 'center' }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: '50%',
                    border: '3px solid #f0edff',
                    borderTopColor: 'var(--violet, #6b55df)',
                    margin: '0 auto 16px',
                    animation: 'spin 1s linear infinite',
                  }}
                />
                <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 800 }}>
                  Payment received; preparing the recipient payout
                </h3>
                <p style={{ margin: 0, fontSize: 13, color: '#77727d', lineHeight: 1.5 }}>
                  The source transfer is confirmed. The one-time request will show as complete only after the private Zcash step confirms.
                </p>
              </div>
            )}

            {requestState === 'active' && (
              <InvoiceFormCard
                requestId={requestId}
                payAmount={payAmount}
                setPayAmount={setPayAmount}
                isFixedAmount={isFixedAmount}
                isFixedAsset={isFixedAsset}
                isFixedChain={isFixedChain}
                selectedPayAsset={selectedPayAsset}
                setSelectedPayAsset={setSelectedPayAsset}
                selectedPayChain={selectedPayChain}
                setSelectedPayChain={setSelectedPayChain}
                paymentAddress={paymentAddress}
                paymentTokenAddress={paymentTokenAddress}
                rateUsdAtCreation={rateUsdAtCreation}
                minimumPaymentAmount={minimumPaymentAmount}
                payerPrepared={payerPrepared}
                txHash={txHash}
                setTxHash={setTxHash}
                isSubmitting={isSubmitting}
                errorMessage={errorMessage}
                handlePay={handlePay}
                handlePrepare={handlePrepare}
                handleRecover={handleRecover}
              />
            )}
          </div>
        </div>
      </main>

      <AuraFooter />
    </>
  )
}
