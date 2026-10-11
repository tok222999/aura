/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React, { useState } from 'react'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import {
  ShieldIcon,
  ZapIcon,
  ArrowRightIcon,
  CodeIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
} from '@/components/aura-icons'
import Link from 'next/link'

export default function AuraPayPage() {
  const [copiedCode, setCopiedCode] = useState(false)

  const embedSnippet = `<!-- Prototype Preview — not executable -->
<!-- Aura Pay Checkout integration is planned for a future release. -->
<!-- No public SDK script or copy-paste button is available yet. -->`

  const handleCopy = () => {
    if (typeof navigator !== 'undefined') {
      navigator.clipboard?.writeText(embedSnippet)
      setCopiedCode(true)
      setTimeout(() => setCopiedCode(false), 2000)
    }
  }

  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          {/* Header */}
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · MERCHANT CHECKOUT · COMING NEXT
            </small>
            <h1>Aura Pay Checkout</h1>
            <p>
              Planned merchant checkout: customers would pay with supported testnet assets while a future business flow routes money through a Private Balance. This page is a preview; it does not send payments.
            </p>
          </div>

          {/* Visual Route Flow */}
          <div className="visual-flow" style={{ marginBottom: 24 }}>
            <span>PLANNED CUSTOMER CHECKOUT</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span className="visual-flow-highlight">PLANNED AURA PRIVATE BALANCE</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span>MERCHANT BALANCE (ROADMAP)</span>
          </div>

          {/* Roadmap-only surface: no live checkout controls */}
          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto 24px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, borderBottom: '1px solid #e7e4eb', paddingBottom: 14 }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet, #6b55df)', letterSpacing: '0.06em' }}>
                  MERCHANT CHECKOUT SPECIFICATION
                </span>
                <h3 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 800, color: '#191820' }}>
                  Preview What Your Customers Would See
                </h3>
              </div>
              <span className="platform-tag" style={{ background: '#f5f3ff', color: 'var(--violet)', border: '1px solid #ddd6fe' }}>COMING NEXT</span>
            </div>

            <div style={{ background: '#fcfbfe', border: '1px solid #e7e4eb', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#77727d', marginBottom: 18 }}>
              <strong style={{ color: '#191820' }}>Roadmap Preview:</strong> Aura Pay Checkout is scheduled for future release. The preview below illustrates the intended merchant flow.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 20 }}>
              {['Merchant checkout', 'Private Balance routing', 'Embedded payment UI'].map((item) => (
                <div key={item} style={{ padding: '14px 16px', borderRadius: 12, border: '1px solid #e7e4eb', background: '#fff', color: '#625c6c', fontSize: 12, fontWeight: 700 }}>
                  {item}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#77727d' }}>Nothing on this page sends money. It is a product preview.</span>
              <Link href="/how-privacy-works" className="btn-primary" style={{ padding: '10px 18px', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
                Learn More →
              </Link>
            </div>
          </div>

          {/* Value Propositions for Merchants */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 20, marginBottom: 36, textAlign: 'left' }}>
            <div className="diagram-card" style={{ padding: 22 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: '#ede9fe', display: 'grid', placeItems: 'center', color: 'var(--violet, #6b55df)', marginBottom: 12 }}>
                <ShieldIcon size={20} />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: '0 0 6px', color: '#191820' }}>
                Separate Business Reserves
              </h3>
              <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: 0 }}>
                Public payment patterns can reveal or help infer operational balances and sales activity. Aura&apos;s planned model would separate business reserves from individual payment transactions.
              </p>
            </div>

            <div className="diagram-card" style={{ padding: 22 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--green-dim)', display: 'grid', placeItems: 'center', color: 'var(--green)', marginBottom: 12 }}>
                <ZapIcon size={20} />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: '0 0 6px', color: '#191820' }}>
                Planned Multi-Chain Checkout
              </h3>
              <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: 0 }}>
                The planned flow supports checkout across selected testnet networks. No merchant payment or settlement is executed here.
              </p>
            </div>

            <div className="diagram-card" style={{ padding: 22 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(25, 24, 32, 0.05)', display: 'grid', placeItems: 'center', color: 'var(--ink)', marginBottom: 12 }}>
                <CodeIcon size={20} />
              </div>
              <h3 style={{ fontSize: 16, fontWeight: 800, margin: '0 0 6px', color: '#191820' }}>
                Planned Embed Model
              </h3>
              <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: 0 }}>
                The snippet below is an illustrative integration shape, not a live SDK. Merchant APIs and payment routing remain roadmap work.
              </p>
            </div>
          </div>

          {/* 3-Minute Developer Integration Snippet */}
          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto 24px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em' }}>
                  DEVELOPER INTEGRATION
                </span>
                <h3 style={{ margin: '4px 0 0', fontSize: 17, fontWeight: 800, color: '#191820' }}>
                  Example Embed Shape
                </h3>
                <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: '#77727d' }}>
                  Illustrative code only · no live SDK is published
                </span>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                style={{
                  background: copiedCode ? 'var(--green-light)' : '#fff',
                  border: '1px solid #e7e4eb',
                  borderRadius: 6,
                  padding: '6px 12px',
                  fontSize: 11,
                  fontWeight: 700,
                  color: copiedCode ? 'var(--green-dark)' : '#191820',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                {copiedCode ? (
                  <>
                    <CheckIcon size={12} color="var(--green-dark)" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <CopyIcon size={12} color="#191820" />
                    <span>Copy preview</span>
                  </>
                )}
              </button>
            </div>

            <pre
              style={{
                background: '#191820',
                color: '#e2e8f0',
                padding: '16px 20px',
                borderRadius: 10,
                fontSize: 12,
                fontFamily: 'var(--font-ui)',
                overflowX: 'auto',
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              {embedSnippet}
            </pre>
          </div>

          {/* Comparison Table */}
          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto', textAlign: 'left' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 800, color: '#191820' }}>
              Standard Crypto Merchant vs. Aura Pay Checkout
            </h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ background: 'rgba(223, 85, 85, 0.06)', borderRadius: 12, padding: '16px 18px', border: '1px solid rgba(223, 85, 85, 0.2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <CloseIcon size={12} color="#c53b3b" />
                  <strong style={{ fontSize: 13, color: '#c53b3b' }}>
                    Standard Crypto Gateway
                  </strong>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#681c1c', lineHeight: 1.6 }}>
                  <li>May expose a payment address and its public history.</li>
                  <li>Timing and amounts can reveal or help infer activity.</li>
                  <li>A buyer does not automatically receive proof of total reserves.</li>
                  <li>Requires custodying multiple volatile tokens.</li>
                </ul>
              </div>

              <div style={{ background: 'rgba(76, 168, 135, 0.08)', borderRadius: 12, padding: '16px 18px', border: '1px solid rgba(76, 168, 135, 0.25)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <CheckIcon size={12} color="var(--green-dark)" />
                  <strong style={{ fontSize: 13, color: 'var(--green-dark)' }}>
                    Planned Aura Pay Checkout
                  </strong>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#1b4d3a', lineHeight: 1.6 }}>
                  <li>Goal: create a single-use payment request for each invoice.</li>
                  <li>Goal: reduce direct exposure of merchant wallet history.</li>
                  <li>On-chain metadata may still allow transaction correlation.</li>
                  <li>Merchant custody and settlement are not implemented yet.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </main>

      <AuraFooter />
    </>
  )
}
