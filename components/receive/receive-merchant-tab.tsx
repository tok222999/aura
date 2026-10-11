/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React, { useState } from 'react'
import { CheckIcon, CopyIcon } from '@/components/aura-icons'

interface ReceiveMerchantTabProps {
  merchantProduct: string
  setMerchantProduct: (p: string) => void
  merchantPrice: string
  setMerchantPrice: (p: string) => void
  onOpenCheckoutPreview: () => void
}

export function ReceiveMerchantTab({
  merchantProduct,
  setMerchantProduct,
  merchantPrice,
  setMerchantPrice,
  onOpenCheckoutPreview,
}: ReceiveMerchantTabProps) {
  const [copiedSnippet, setCopiedSnippet] = useState(false)

  const embedCode = `<!-- Prototype Preview — not executable -->\n<!-- Merchant Checkout integration is planned for a future release. -->\n<!-- No public SDK script or copy-paste payment button is available yet. -->`

  const handleCopySnippet = () => {
    navigator.clipboard?.writeText(embedCode)
    setCopiedSnippet(true)
    setTimeout(() => setCopiedSnippet(false), 2000)
  }

  return (
    <div style={{ textAlign: 'left' }}>
      <strong style={{ display: 'block', fontSize: 17, marginBottom: 6, color: '#191820' }}>
        Embeddable Checkout Preview
      </strong>
      <p style={{ color: '#77727d', fontSize: 13, margin: '0 0 20px', lineHeight: 1.55 }}>
        Planned widget preview: an eventual &ldquo;Pay with Aura&rdquo; button could accept supported public testnet payments. This preview does not send funds or record a merchant payment.
      </p>

      {/* Widget Configurator */}
      <div style={{ background: '#fbfafc', border: '1px solid #e7e4eb', borderRadius: 12, padding: '18px', marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#191820', marginBottom: 12 }}>
          Widget Configuration
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10, marginBottom: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: '#77727d', marginBottom: 4 }}>Item / Service</label>
            <input
              type="text"
              value={merchantProduct}
              onChange={(e) => setMerchantProduct(e.target.value)}
              placeholder="e.g. Pro Membership"
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid #e7e4eb',
                borderRadius: 8,
                fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: '#77727d', marginBottom: 4 }}>Price (USD)</label>
            <input
              type="text"
              value={merchantPrice}
              onChange={(e) => setMerchantPrice(e.target.value)}
              placeholder="49.00"
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid #e7e4eb',
                borderRadius: 8,
                fontSize: 13,
                boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* Interactive Button Preview */}
        <div style={{ borderTop: '1px dashed #e7e4eb', paddingTop: 14 }}>
          <div style={{ fontSize: 11, color: '#77727d', marginBottom: 8, fontWeight: 600 }}>
            INTERACTIVE PREVIEW (No payment sent):
          </div>
          <button
            type="button"
            onClick={onOpenCheckoutPreview}
            style={{
              width: '100%',
              padding: '12px',
              background: 'var(--violet, #6b55df)',
              color: '#fff',
              borderRadius: 8,
              border: 0,
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              boxShadow: '0 6px 16px rgba(107, 85, 223, 0.25)',
            }}
          >
            Pay ${merchantPrice || '49.00'} with Aura (Private Crypto)
          </button>
        </div>
      </div>

      {/* Generated Embed Snippet */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#191820' }}>
            HTML Embed Preview · Planned, not executable
          </span>
          <button
            type="button"
            onClick={handleCopySnippet}
            style={{
              background: 'none',
              border: 0,
              color: 'var(--violet, #6b55df)',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {copiedSnippet ? (
              <>
                <CheckIcon size={12} color="var(--violet)" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <CopyIcon size={12} color="var(--violet)" />
                <span>Copy Preview</span>
              </>
            )}
          </button>
        </div>
        <pre
          style={{
            background: '#191820',
            color: '#e7e4eb',
            padding: '14px',
            borderRadius: 10,
            fontSize: 11,
            fontFamily: 'var(--font-ui)',
            overflowX: 'auto',
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {embedCode}
        </pre>
      </div>

      {/* Roadmap note */}
      <div style={{ borderTop: '1px solid #e7e4eb', paddingTop: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ display: 'grid', placeItems: 'center', width: 24, height: 24, borderRadius: '50%', background: 'var(--green-light)', color: 'var(--green)', flexShrink: 0 }}>
          <CheckIcon size={12} color="var(--green)" />
        </span>
        <p style={{ margin: 0, fontSize: 12, color: '#77727d', lineHeight: 1.5 }}>
          <strong>Preview only:</strong> Merchant checkout is coming next. This screen does not create a payable invoice, send funds, or demonstrate a live merchant payment.
        </p>
      </div>
    </div>
  )
}
