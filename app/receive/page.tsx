/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import { useState, useEffect } from 'react'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { useAura } from '@/lib/context/aura-context'
import { ArrowRightIcon } from '@/components/aura-icons'
import { AssetSymbol } from '@/lib/types/aura'
import { MerchantCheckoutModal } from '@/components/merchant-checkout-modal'
import { ReceivePersonalTab } from '@/components/receive/receive-personal-tab'
import { ReceiveMerchantTab } from '@/components/receive/receive-merchant-tab'
import { zcashEnclaveService } from '@/lib/services/zcash-enclave-service'
import { canonicalizePaymentRequestIntent, canonicalizePaymentRequestUpdate } from '@/lib/crypto/request-authorization'

export default function ReceivePage() {
  const MANAGEMENT_STATE_KEY = 'aura_receive_management_state_v1'
  const { refreshTransactions, privateBalance } = useAura()
  const [requestedAmount, setRequestedAmount] = useState('')
  const [requestedAsset, setRequestedAsset] = useState<AssetSymbol>('USDC')
  const [requestedNetwork, setRequestedNetwork] = useState('Base')
  const [expiryOption, setExpiryOption] = useState<'1h' | '24h' | '72h'>('72h')
  const [requestId, setRequestId] = useState('')
  const [requestOwnerToken, setRequestOwnerToken] = useState('')
  const [routeStatus, setRouteStatus] = useState<'active' | 'processing' | 'consumed' | 'expired'>('active')
  const [isPublished, setIsPublished] = useState(false)
  const [settlementStatus, setSettlementStatus] = useState<'pending' | 'completed' | 'failed' | null>(null)
  const [copied, setCopied] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isRevoking, setIsRevoking] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [requestError, setRequestError] = useState<string | null>(null)

  // Merchant Checkout Widget State
  const [merchantProduct, setMerchantProduct] = useState('Pro Membership')
  const [merchantPrice, setMerchantPrice] = useState('49.00')
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.origin) {
      setBaseUrl(window.location.origin)
    }
  }, [])

  const getManagementAuthorization = async (action: 'share' | 'update' | 'revoke', signedTerms?: string) => {
    if (requestOwnerToken) return { ownerToken: requestOwnerToken }
    if (!requestId) throw new Error('No payment request is selected.')
    const authorization = await zcashEnclaveService.signVaultActionLocally(
      'manage_request',
      signedTerms ? `${requestId}:${action}:${signedTerms}` : `${requestId}:${action}`,
    )
    return {
      enclaveFingerprint: authorization.enclaveFingerprint,
      clientTimestamp: authorization.clientTimestamp,
      nonce: authorization.nonce,
      authPublicKey: authorization.authPublicKey,
      signature: authorization.signature,
    }
  }

  // Restore the owner capability after a refresh without placing the bearer
  // token in plaintext localStorage. The recovery phrase is the local key;
  // server-side tenant ownership remains unchanged.
  useEffect(() => {
    let active = true
    const restore = async () => {
      if (typeof window === 'undefined') return
      const raw = localStorage.getItem(MANAGEMENT_STATE_KEY)
      if (!raw) return
      const plain = await zcashEnclaveService.decryptLocalManagementState(raw)
      let restored = false
      try {
        const saved = plain ? JSON.parse(plain) as {
          requestId?: unknown
          requestOwnerToken?: unknown
          requestedAmount?: unknown
          requestedAsset?: unknown
          requestedNetwork?: unknown
          expiryOption?: unknown
          routeStatus?: unknown
          isPublished?: unknown
        } : null
        if (saved && typeof saved.requestId === 'string' && typeof saved.requestOwnerToken === 'string' && saved.requestId && saved.requestOwnerToken) {
          setRequestId(saved.requestId)
          setRequestOwnerToken(saved.requestOwnerToken)
          if (typeof saved.requestedAmount === 'string') setRequestedAmount(saved.requestedAmount)
          if (saved.requestedAsset === 'USDC' || saved.requestedAsset === 'USDT' || saved.requestedAsset === 'ETH' || saved.requestedAsset === 'SOL' || saved.requestedAsset === 'ZEC') setRequestedAsset(saved.requestedAsset)
          if (typeof saved.requestedNetwork === 'string') setRequestedNetwork(saved.requestedNetwork)
          if (saved.expiryOption === '1h' || saved.expiryOption === '24h' || saved.expiryOption === '72h') setExpiryOption(saved.expiryOption)
          if (saved.routeStatus === 'active' || saved.routeStatus === 'processing' || saved.routeStatus === 'consumed' || saved.routeStatus === 'expired') setRouteStatus(saved.routeStatus)
          if (typeof saved.isPublished === 'boolean') setIsPublished(saved.isPublished)
          restored = true
        }
      } catch {}
      if (!active || restored) return

      // If localStorage/IndexedDB was wiped, recover the tenant's active
      // request list with a fresh tenant signature instead of losing the
      // management capability forever.
      try {
        const authorization = await zcashEnclaveService.signVaultActionLocally('list_requests')
        const response = await fetch('/api/requests', {
          headers: {
            'x-aura-enclave-fingerprint': authorization.enclaveFingerprint,
            'x-aura-auth-timestamp': String(authorization.clientTimestamp),
            'x-aura-auth-nonce': authorization.nonce,
            'x-aura-auth-public-key': authorization.authPublicKey,
            'x-aura-auth-signature': authorization.signature,
          },
          cache: 'no-store',
        })
        const json = await response.json().catch(() => ({}))
        const recovered = Array.isArray(json.requests)
          ? json.requests.find((request: any) => request?.status === 'active')
          : null
        if (!active || !response.ok || !recovered?.id) return
        setRequestId(String(recovered.id))
        setRequestOwnerToken('')
        setRequestedAmount(recovered.amount === undefined ? '' : Number(recovered.amount).toFixed(2))
        if (recovered.asset === 'USDC' || recovered.asset === 'USDT' || recovered.asset === 'ETH' || recovered.asset === 'SOL' || recovered.asset === 'ZEC') setRequestedAsset(recovered.asset)
        setRequestedNetwork(String(recovered.chain || 'base') === 'solana' ? 'Solana' : 'Base')
        setRouteStatus(recovered.status)
        setIsPublished(Boolean(recovered.sharedAt))
      } catch {
        // No local capability and no recoverable tenant signature; show the
        // normal empty Receive state without inferring a request.
      }
    }
    void restore()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !requestId || !requestOwnerToken) return
    const state = JSON.stringify({ requestId, requestOwnerToken, requestedAmount, requestedAsset, requestedNetwork, expiryOption, routeStatus, isPublished })
    void zcashEnclaveService.encryptLocalManagementState(state)
      .then((encrypted) => localStorage.setItem(MANAGEMENT_STATE_KEY, encrypted))
      .catch(() => {})
  }, [requestId, requestOwnerToken, requestedAmount, requestedAsset, requestedNetwork, expiryOption, routeStatus, isPublished])

  // Sync route status from persistent server with live polling (Points 2 & 3)
  useEffect(() => {
    let isMounted = true
    const checkStatus = async () => {
      if (!requestId) return
      try {
        const res = await fetch(`/api/requests/${requestId}`, { cache: 'no-store' })
        const json = await res.json()
        if (isMounted && json.success && json.data) {
          const nextStatus = json.data.status as typeof routeStatus
          const becameConsumed = routeStatus !== 'consumed' && nextStatus === 'consumed'
          setRouteStatus(nextStatus)
          setIsPublished(Boolean(json.data.sharedAt))
          if (nextStatus === 'consumed') {
            setSettlementStatus(json.data.settlementStatus || 'pending')
          } else {
            setSettlementStatus(null)
          }
          if (becameConsumed) {
            await refreshTransactions()
          }
        }
      } catch {}
    }

    checkStatus()
    // Poll while active or processing so other browsers/devices paying reflect live
    const interval = setInterval(() => {
      if (routeStatus === 'active' || routeStatus === 'processing' || (routeStatus === 'consumed' && settlementStatus !== 'completed' && settlementStatus !== 'failed')) {
        checkStatus()
      }
    }, 2500)

    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [requestId, routeStatus, settlementStatus, refreshTransactions])

  // Live sync form inputs to active server invoice so QR code and checkout page match what's on screen (Point 2)
  useEffect(() => {
    if (!requestId || routeStatus !== 'active' || isPublished) return
    const debounceTimer = setTimeout(async () => {
      try {
        const hours = expiryOption === '1h' ? 1 : expiryOption === '24h' ? 24 : 72
        const amt = requestedAmount.trim() === '' ? null : Number(requestedAmount)
        if (amt !== null && (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000)) {
          setRequestError('Amount must be greater than 0 and no more than 1,000,000.')
          return
        }
        const updateTerms = canonicalizePaymentRequestUpdate({
          amount: amt,
          asset: requestedAsset,
          chain: requestedNetwork.toLowerCase().includes('sol') ? 'solana' : 'base',
          expiryHours: hours,
          bufferMode: privateBalance.privacyPolicy || 'private',
        })
        const res = await fetch(`/api/requests/${requestId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(await getManagementAuthorization('update', updateTerms)),
            amount: amt,
            asset: requestedAsset,
            chain: requestedNetwork.toLowerCase().includes('sol') ? 'solana' : 'base',
            expiryHours: hours,
            bufferMode: privateBalance.privacyPolicy || 'private',
          }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.success) {
          throw new Error(json.message || json.error || 'Could not update the request.')
        }
        setRequestError(null)
      } catch (err) {
        console.warn('Failed to sync invoice parameters', err)
        setRequestError(err instanceof Error ? err.message : 'Could not update the request.')
      }
    }, 400)

    return () => clearTimeout(debounceTimer)
  }, [requestId, requestOwnerToken, requestedAmount, requestedAsset, requestedNetwork, expiryOption, routeStatus, isPublished, privateBalance.privacyPolicy])

  // Opaque request URL without leaky sensitive parameters
  const generatedUrl = requestId ? `${baseUrl || 'https://aura.money'}/pay/${requestId}` : ''

  const handleGenerateFresh = async () => {
    setIsGenerating(true)
    setRequestError(null)
    setRequestId('')
    setRequestOwnerToken('')
    setIsPublished(false)
    if (typeof window !== 'undefined') localStorage.removeItem(MANAGEMENT_STATE_KEY)
    try {
      const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
      const hours = expiryOption === '1h' ? 1 : expiryOption === '24h' ? 24 : 72
      const amt = requestedAmount.trim() === '' ? undefined : Number(requestedAmount)
      if (amt !== undefined && (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000)) {
        throw new Error('Amount must be greater than 0 and no more than 1,000,000.')
      }
      const requestChain = requestedNetwork.toLowerCase().includes('sol') ? 'solana' : 'base'
      const authorization = await zcashEnclaveService.signVaultActionLocally(
        'create_request',
        canonicalizePaymentRequestIntent({ amount: amt, asset: requestedAsset, chain: requestChain, expiryHours: hours, bufferMode: privateBalance.privacyPolicy || 'private' }),
      )
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aura-enclave-fingerprint': enclave.fingerprint,
        },
        body: JSON.stringify({
          amount: amt,
          asset: requestedAsset,
          chain: requestChain,
          expiryHours: hours,
          bufferMode: privateBalance.privacyPolicy || 'private',
          ...authorization,
          enclaveFingerprint: enclave.fingerprint,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.message || json.error || 'Could not create a real Zcash payment address.')
      }
      if (json.success && json.id) {
        setRequestId(json.id)
        setRequestOwnerToken(json.ownerToken)
        setRouteStatus('active')
        setSettlementStatus(null)
        setIsPublished(false)
      }
    } catch (err) {
      console.error('Failed to create payment request', err)
      setRequestError(err instanceof Error ? err.message : 'Could not create a payment request.')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleCopy = async () => {
    if (!requestId || !generatedUrl) return
    try {
      const shareRes = await fetch(`/api/requests/${requestId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await getManagementAuthorization('share')),
      })
      const shareJson = await shareRes.json().catch(() => ({}))
      if (!shareRes.ok || !shareJson.success) throw new Error(shareJson.message || shareJson.error || 'Could not lock the shared request.')
      setIsPublished(true)
      await navigator.clipboard?.writeText(generatedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'Could not share the payment request.')
    }
  }

  const handleRevoke = async () => {
    if (!requestId || isRevoking) return
    if (!window.confirm('Revoke this payment request now?')) return
    setIsRevoking(true)
    try {
      const res = await fetch(`/api/requests/${requestId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await getManagementAuthorization('revoke')),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.message || json.error || 'Could not revoke the request.')
      setRouteStatus('expired')
      setSettlementStatus(null)
      localStorage.removeItem(MANAGEMENT_STATE_KEY)
      setRequestError(null)
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'Could not revoke the request.')
    } finally {
      setIsRevoking(false)
    }
  }

  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · RECEIVE PRIVATELY
            </small>
            <h1>Get paid without exposing your wallet.</h1>
            <p>Create a one-time payment link or QR. Your client pays the request without seeing your main wallet or its history.</p>
            <p style={{ maxWidth: 660, margin: '10px auto 0', color: 'var(--muted)', fontSize: 12 }}>
              Prototype status: the payer still confirms the transfer and provides its transaction proof. One-click checkout is planned, not live yet.
            </p>
            {/* Consumer-facing story first; technical routing stays available below. */}
            <div className="visual-flow" style={{ marginTop: 20, marginBottom: 0 }}>
              <span>CREATE PRIVATE REQUEST</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span>SHARE LINK / QR</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span>PAYMENT</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span className="visual-flow-highlight">PRIVATE BALANCE</span>
            </div>
          </div>

          <details
            style={{
              maxWidth: 660,
              margin: '0 auto 24px',
              border: '1px solid var(--line)',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.72)',
              padding: '0 14px',
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                padding: '11px 0',
                color: 'var(--ink)',
                fontSize: 12,
                fontWeight: 800,
                listStyle: 'none',
              }}
            >
              How the test route works
            </summary>
            <div style={{ padding: '0 0 12px', color: 'var(--muted)', fontSize: 11, lineHeight: 1.55 }}>
              <p style={{ margin: '0 0 6px' }}>
                Current jury demo route: Base Sepolia USDC → AURA-operated Zcash Testnet inventory → confirmed Private Balance.
              </p>
              <p style={{ margin: 0 }}>
                Public entry remains visible; this page does not claim unlinkability or self-custody.
              </p>
            </div>
          </details>

          <div className="form-card receive-center-card" style={{ maxWidth: 660, margin: '0 auto' }}>
            <ReceivePersonalTab
              routeStatus={routeStatus}
              published={isPublished}
              settlementStatus={settlementStatus}
              requestId={requestId}
              expiryOption={expiryOption}
              setExpiryOption={(opt) => setExpiryOption(opt as any)}
              generatedUrl={generatedUrl}
              requestedAsset={requestedAsset}
              setRequestedAsset={setRequestedAsset}
              requestedNetwork={requestedNetwork}
              setRequestedNetwork={setRequestedNetwork}
              requestedAmount={requestedAmount}
              setRequestedAmount={setRequestedAmount}
              copied={copied}
              isGenerating={isGenerating}
              handleGenerateFresh={handleGenerateFresh}
              handleCopy={handleCopy}
              handleRevoke={handleRevoke}
              isRevoking={isRevoking}
            />

            <details
              style={{
                marginTop: 24,
                borderTop: '1px solid var(--line)',
                paddingTop: 14,
              }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  color: 'var(--muted)',
                  fontSize: 12,
                  fontWeight: 800,
                  listStyle: 'none',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span>Coming next · Merchant Checkout</span>
                  <span style={{ fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--violet)' }}>Preview only</span>
                </span>
              </summary>
              <div style={{ paddingTop: 16 }}>
              <ReceiveMerchantTab
                merchantProduct={merchantProduct}
                setMerchantProduct={setMerchantProduct}
                merchantPrice={merchantPrice}
                setMerchantPrice={setMerchantPrice}
                onOpenCheckoutPreview={() => setIsCheckoutOpen(true)}
              />
              </div>
            </details>
          </div>
        </div>
        {requestError && (
          <p role="alert" className="form-error" style={{ maxWidth: 760, margin: '12px auto' }}>
            {requestError}
          </p>
        )}
      </main>

      <MerchantCheckoutModal
        isOpen={isCheckoutOpen}
        onClose={() => setIsCheckoutOpen(false)}
        productName={merchantProduct}
        priceUsd={parseFloat(merchantPrice) || 49}
        merchantName="gio"
      />

      <AuraFooter />
    </>
  )
}
