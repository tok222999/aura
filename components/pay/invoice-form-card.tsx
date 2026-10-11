'use client'

import React from 'react'
import { AssetSymbol, ChainId } from '@/lib/types/aura'
import { CryptoIcon } from '@/components/crypto-icon'
import { SparkleIcon } from '@/components/aura-icons'
import { DEMO_ENTRY_NETWORKS, PUBLIC_ASSET_ROUTE_OPTIONS } from '@/lib/config/capabilities'

interface InvoiceFormCardProps {
  requestId: string
  payAmount: string
  setPayAmount: (val: string) => void
  isFixedAmount: boolean
  isFixedAsset?: boolean
  isFixedChain?: boolean
  selectedPayAsset: AssetSymbol
  setSelectedPayAsset: (asset: AssetSymbol) => void
  selectedPayChain: ChainId
  setSelectedPayChain: (chain: ChainId) => void
  paymentAddress: string
  paymentTokenAddress?: string
  rateUsdAtCreation?: number
  minimumPaymentAmount?: number
  payerPrepared?: boolean
  txHash: string
  setTxHash: (hash: string) => void
  isSubmitting: boolean
  errorMessage: string | null
  handlePay: (e: React.FormEvent) => void
  handlePrepare: () => void
  handleRecover: () => void
}

export function InvoiceFormCard({
  requestId,
  payAmount,
  setPayAmount,
  isFixedAmount,
  isFixedAsset,
  isFixedChain,
  selectedPayAsset,
  setSelectedPayAsset,
  selectedPayChain,
  setSelectedPayChain,
  paymentAddress,
  paymentTokenAddress,
  rateUsdAtCreation,
  minimumPaymentAmount = 0.1,
  payerPrepared = false,
  txHash,
  setTxHash,
  isSubmitting,
  errorMessage,
  handlePay,
  handlePrepare,
  handleRecover,
}: InvoiceFormCardProps) {
  return (
    <form onSubmit={handlePay}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: 14,
          borderBottom: '1px solid #e7e4eb',
          marginBottom: 18,
        }}
      >
        <div>
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet, #6b55df)', letterSpacing: '0.06em' }}>
            REQUEST ID
          </span>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700, color: '#191820' }}>
            {requestId}
          </div>
        </div>
        <span
          style={{
            background: 'var(--green-light)',
            color: 'var(--green-dark)',
            padding: '4px 10px',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 800,
          }}
        >
          ● ACTIVE
        </span>
      </div>

      {errorMessage && (
        <div style={{ background: 'var(--danger-light)', color: 'var(--danger)', padding: '10px 14px', borderRadius: 8, fontSize: 12, marginBottom: 14, fontWeight: 600 }}>
          {errorMessage}
        </div>
      )}

      {/* Amount to Pay */}
      <div className="form-row">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Requested Amount ($)
          </label>
          {isFixedAmount && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--violet, #6b55df)',
                background: '#ede9fe',
                padding: '2px 8px',
                borderRadius: 6,
                letterSpacing: '0.04em',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <SparkleIcon size={11} color="var(--violet)" /> Fixed by Merchant
            </span>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={payAmount}
            readOnly={isFixedAmount}
            onChange={(e) => {
              if (!isFixedAmount) setPayAmount(e.target.value)
            }}
            placeholder="0.00"
            style={{
              width: '100%',
              fontSize: 24,
              fontWeight: 800,
              padding: '12px 16px',
              boxSizing: 'border-box',
              background: isFixedAmount ? '#f8f7fb' : '#fff',
              color: isFixedAmount ? '#2e2a3b' : '#191820',
              cursor: isFixedAmount ? 'not-allowed' : 'text',
              border: isFixedAmount ? '1px solid #dcd8e6' : '1px solid rgba(222, 219, 229, 0.9)',
            }}
          />
        </div>
      </div>

      {/* Pay With Crypto Asset */}
      <div className="form-row" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>
            Pay With Crypto Asset
          </label>
          {isFixedAsset && (
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--violet, #6b55df)', background: '#ede9fe', padding: '2px 8px', borderRadius: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <SparkleIcon size={11} color="var(--violet)" /> Specified by Invoice
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {PUBLIC_ASSET_ROUTE_OPTIONS.map(({ symbol: asset, status }) => (
            <button
              key={asset}
              type="button"
              disabled={(status !== 'LIVE' && !isFixedAsset) || (isFixedAsset && selectedPayAsset !== asset)}
              className={`aura-chip ${selectedPayAsset === asset ? 'active' : ''}`}
              onClick={() => {
                if (!isFixedAsset && status === 'LIVE') {
                  setSelectedPayAsset(asset)
                  if (!isFixedChain && selectedPayChain === 'solana') {
                    setSelectedPayChain('base')
                  }
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '10px 8px',
                borderRadius: 10,
                fontWeight: 700,
                border: selectedPayAsset === asset ? '1.5px solid var(--violet)' : '1px solid #e7e4eb',
                background: selectedPayAsset === asset ? 'var(--lav)' : '#fff',
                color: selectedPayAsset === asset ? 'var(--violet)' : '#191820',
                opacity: (status !== 'LIVE' && !isFixedAsset) || (isFixedAsset && selectedPayAsset !== asset) ? 0.35 : 1,
                cursor: status !== 'LIVE' && !isFixedAsset
                  ? 'not-allowed'
                  : isFixedAsset ? (selectedPayAsset === asset ? 'default' : 'not-allowed') : 'pointer',
              }}
            >
              <CryptoIcon name={asset} size={18} />
              <span>{asset}{status !== 'LIVE' && !isFixedAsset ? ' · Coming next' : ''}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Payment Network */}
      <div className="form-row" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={{ fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: 0 }}>
            Source Blockchain Network
          </label>
          {isFixedChain && (
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--violet, #6b55df)', background: '#ede9fe', padding: '2px 8px', borderRadius: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <SparkleIcon size={11} color="var(--violet)" /> Specified by Invoice
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {DEMO_ENTRY_NETWORKS.filter((net) => net.id === 'base' || net.id === 'solana').map((net) => (
            <button
              key={net.id}
              type="button"
              disabled={(net.id === 'solana' && !isFixedChain) || (isFixedChain && selectedPayChain !== net.id)}
              className={`aura-chip ${selectedPayChain === net.id ? 'active' : ''}`}
              onClick={() => {
                if (!isFixedChain && net.id === 'solana') return
                if (!isFixedChain) {
                  setSelectedPayChain(net.id as ChainId)
                  if (net.id === 'base' && !isFixedAsset && selectedPayAsset === 'SOL') {
                    setSelectedPayAsset('USDC')
                  }
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '10px 8px',
                borderRadius: 10,
                fontWeight: 700,
                border: selectedPayChain === net.id ? '1.5px solid var(--violet)' : '1px solid #e7e4eb',
                background: selectedPayChain === net.id ? 'var(--lav)' : '#fff',
                color: selectedPayChain === net.id ? 'var(--violet)' : '#191820',
                opacity: (net.id === 'solana' && !isFixedChain) || (isFixedChain && selectedPayChain !== net.id) ? 0.35 : 1,
                cursor: net.id === 'solana' && !isFixedChain
                  ? 'not-allowed'
                  : isFixedChain ? (selectedPayChain === net.id ? 'default' : 'not-allowed') : 'pointer',
              }}
            >
              <CryptoIcon name={net.icon} size={18} />
              <span>{net.label}{net.status !== 'LIVE' ? ' · Coming next' : ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 18, padding: 14, border: '1px solid #e7e4eb', borderRadius: 12, background: '#fbfafc' }}>
        <strong style={{ display: 'block', marginBottom: 6, color: '#191820', fontSize: 13 }}>
          Send payment on {selectedPayChain === 'solana' ? 'Solana Devnet' : 'Base Sepolia'}
        </strong>
        <p style={{ margin: '0 0 10px', color: '#56515d', fontSize: 12, lineHeight: 1.5 }}>
          Send exactly {selectedPayChain === 'solana'
            ? (Number.isFinite(rateUsdAtCreation) && (rateUsdAtCreation || 0) > 0
              ? `${(Number(payAmount) / rateUsdAtCreation!).toFixed(9)} SOL`
              : 'wait until the live SOL amount is available')
            : `${Number(payAmount).toFixed(2)} USDC`} to this address, then paste the transaction ID below.
        </p>
        <code style={{ display: 'block', padding: 10, borderRadius: 8, background: '#fff', border: '1px solid #e7e4eb', color: '#191820', fontSize: 11, wordBreak: 'break-all' }}>
          {paymentAddress || 'Loading payment address…'}
        </code>
        {paymentTokenAddress && selectedPayChain === 'base' && (
          <p style={{ margin: '8px 0 0', color: '#77727d', fontSize: 11, wordBreak: 'break-all' }}>
            USDC contract: {paymentTokenAddress}
          </p>
        )}
        <p style={{ margin: '9px 0 0', color: '#77727d', fontSize: 11, lineHeight: 1.45 }}>
          This private link hides the recipient&apos;s main wallet from the payer. The invoice amount, network, expiry, and payment address are still visible to anyone who has the link.
        </p>
        {selectedPayChain === 'base' && selectedPayAsset === 'USDC' && (
          <div style={{ marginTop: 12, padding: 11, borderRadius: 9, background: payerPrepared ? '#effaf5' : '#f7f4ff', border: `1px solid ${payerPrepared ? '#b7e6ce' : '#d8d0ff'}` }}>
            <strong style={{ display: 'block', color: payerPrepared ? '#087443' : 'var(--violet, #6b55df)', fontSize: 12, marginBottom: 4 }}>
              {payerPrepared ? 'Payer wallet prepared' : 'Prepare before sending'}
            </strong>
            <span style={{ display: 'block', color: '#56515d', fontSize: 11, lineHeight: 1.45 }}>
              Bind the sending wallet before payment so AURA can recover a transfer after a browser interruption. Minimum payment: ${minimumPaymentAmount.toFixed(2)}.
            </span>
            {!payerPrepared && (
              <button
                type="button"
                onClick={handlePrepare}
                disabled={isSubmitting}
                style={{ marginTop: 9, padding: '9px 12px', border: 0, borderRadius: 8, background: 'var(--violet, #6b55df)', color: '#fff', fontSize: 11, fontWeight: 800, cursor: isSubmitting ? 'wait' : 'pointer' }}
              >
                Prepare this wallet →
              </button>
            )}
          </div>
        )}
      </div>

      <div className="form-row" style={{ marginTop: 16 }}>
        <label htmlFor="invoice-tx-hash" style={{ display: 'block', marginBottom: 6, fontSize: 11, fontWeight: 800, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          On-chain transaction ID
        </label>
        <input
          id="invoice-tx-hash"
          type="text"
          value={txHash}
          onChange={(event) => setTxHash(event.target.value.trim())}
          placeholder={selectedPayChain === 'solana' ? 'Paste Solana transaction signature' : '0x…'}
          required
          autoComplete="off"
          spellCheck={false}
          style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', border: '1px solid #dcd8e6', borderRadius: 9, fontFamily: 'var(--font-ui)', fontSize: 12 }}
        />
        <small style={{ display: 'block', marginTop: 6, color: '#77727d', lineHeight: 1.45 }}>
          The server checks the confirmed transfer and exact amount. When you continue, your wallet will ask you to sign this invoice; use the same wallet that sent the funds. This form does not send funds for you.
        </small>
        {selectedPayChain === 'base' && selectedPayAsset === 'USDC' && (
          <button
            type="button"
            onClick={handleRecover}
            disabled={isSubmitting}
            style={{
              width: '100%',
              marginTop: 12,
              padding: '10px 12px',
              border: '1px solid #d8d0ff',
              borderRadius: 9,
              background: '#f7f4ff',
              color: 'var(--violet, #6b55df)',
              fontSize: 12,
              fontWeight: 800,
              cursor: isSubmitting ? 'wait' : 'pointer',
            }}
          >
            Browser closed after sending? Recover from this wallet
          </button>
        )}
      </div>

      {/* Submit Button */}
      <button
        type="submit"
        disabled={isSubmitting || (!isFixedAmount && selectedPayChain === 'base' && selectedPayAsset === 'USDC' && !payerPrepared)}
        style={{
          width: '100%',
          marginTop: 24,
          padding: '16px',
          background: 'var(--violet, #6b55df)',
          color: '#fff',
          border: 0,
          borderRadius: 12,
          fontSize: 15,
          fontWeight: 800,
          cursor: isSubmitting ? 'wait' : 'pointer',
          boxShadow: '0 4px 18px rgba(107, 85, 223, 0.3)',
          transition: 'all 0.15s ease',
          opacity: isSubmitting ? 0.8 : 1,
        }}
      >
        {isSubmitting
          ? 'Routing Shielded Payment...'
          : (!isFixedAmount && selectedPayChain === 'base' && selectedPayAsset === 'USDC' && !payerPrepared)
            ? 'Prepare wallet before paying →'
          : `Verify $${payAmount} ${selectedPayAsset} payment →`}
      </button>
    </form>
  )
}
