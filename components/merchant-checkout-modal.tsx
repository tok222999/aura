/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React from 'react'
import { CryptoIcon } from './crypto-icon'
import { SparkleIcon, CloseIcon } from './aura-icons'
import { PUBLIC_ASSET_CAPABILITIES } from '@/lib/config/capabilities'

interface MerchantCheckoutModalProps {
  isOpen: boolean
  onClose: () => void
  productName: string
  priceUsd: number
  merchantName?: string
}

export function MerchantCheckoutModal({
  isOpen,
  onClose,
  productName,
  priceUsd,
  merchantName = 'gio',
}: MerchantCheckoutModalProps) {
  if (!isOpen) return null

  const handleResetAndClose = () => {
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={handleResetAndClose} style={{ zIndex: 1200 }}>
      <div
        className="modal-window"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 480, width: '92%', padding: 0, overflow: 'hidden' }}
      >
        {/* Privacy Proof Banner */}
        <div
          style={{
            background: '#e0d7ff',
            borderBottom: '1px solid #c7b9fa',
            padding: '8px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 6,
            fontSize: 11,
          }}
        >
          <span style={{ fontWeight: 800, color: '#3b287e', letterSpacing: '0.04em' }}>
            PUBLIC ENTRY → PRIVATE BALANCE → PUBLIC EXIT
          </span>
          <span style={{ fontWeight: 600, color: '#5b4f8c' }}>
            Main wallet is not used as the recipient-facing payment source.
          </span>
        </div>
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
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'rgba(255, 255, 255, 0.12)',
                padding: '3px 8px',
                borderRadius: 14,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                marginBottom: 6,
                color: '#d4ccff',
              }}
            >
              <SparkleIcon size={12} color="#d4ccff" />
              <span>AURA PAY CHECKOUT · COMING NEXT</span>
            </div>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#fff' }}>
              Checkout Preview
            </h3>
          </div>
          <button
            type="button"
            onClick={handleResetAndClose}
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

        {/* Modal Body */}
        <div style={{ padding: '24px', background: '#fff' }}>
          <>
            <div>
              {/* Product & Merchant Box */}
              <div
                style={{
                  background: '#fbfafc',
                  border: '1px solid #e7e4eb',
                  borderRadius: 12,
                  padding: '16px',
                  marginBottom: 20,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: '#77727d', fontWeight: 600 }}>MERCHANT ORDER</div>
                  <strong style={{ fontSize: 16, color: '#191820', display: 'block', marginTop: 2 }}>
                    {productName || 'Custom Payment'}
                  </strong>
                  <div style={{ fontSize: 11, color: '#77727d', marginTop: 2 }}>
                    Recipient: <span style={{ color: 'var(--violet, #6b55df)', fontWeight: 700 }}>{merchantName}</span> (Roadmap preview)
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#191820' }}>
                    ${priceUsd.toFixed(2)}
                  </div>
                  <small style={{ color: 'var(--green)', fontWeight: 700, fontSize: 10 }}>0% ADDED SURCHARGE</small>
                </div>
              </div>

              {/* Payment Method Selector */}
              <div style={{ marginBottom: 18 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#191820', marginBottom: 8 }}>
                  Planned payment methods · preview only
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {PUBLIC_ASSET_CAPABILITIES.map((opt) => (
                    <button
                      key={`${opt.network}-${opt.symbol}`}
                      type="button"
                      disabled
                      style={{
                        border: '1px solid #e7e4eb',
                        background: '#faf9fc',
                        color: '#77727d',
                        borderRadius: 8,
                        padding: '10px 8px',
                        fontSize: 11,
                        fontWeight: 700,
                        cursor: 'not-allowed',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        opacity: opt.status === 'LIVE' ? 0.8 : 0.55,
                      }}
                    >
                      <CryptoIcon name={opt.symbol} size={16} />
                      <span>{opt.label} · {opt.network}{opt.status !== 'LIVE' ? ' · Coming next' : ''}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Preview Limitation Note */}
              <div
                style={{
                  background: '#f8fafc',
                  border: '1px solid #e2e8f0',
                  borderRadius: 10,
                  padding: '12px 14px',
                  fontSize: 11,
                  color: '#64748b',
                  lineHeight: 1.5,
                  marginBottom: 20,
                }}
              >
                <strong style={{ color: '#1e293b', display: 'block', marginBottom: 2 }}>
                  Preview limitation:
                </strong>
                No payment is sent from this preview. Merchant checkout is a planned product; only the Private Balance flow is part of the working testnet demo.
              </div>

              <button
                type="button"
                disabled
                style={{
                  width: '100%',
                  padding: '14px',
                  borderRadius: 10,
                  border: 0,
                  background: '#f4f2f7',
                  color: '#77727d',
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: 'not-allowed',
                }}
              >
                Merchant checkout · coming next
              </button>
            </div>
            <button type="button" onClick={handleResetAndClose} style={{ width: '100%', marginTop: 10, padding: 12, borderRadius: 10, border: '1px solid #e7e4eb', background: '#fff', color: '#191820', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              Close preview
            </button>
          </>
        </div>
      </div>
    </div>
  )
}
