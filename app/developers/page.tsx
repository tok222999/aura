/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React, { useState } from 'react'
import Link from 'next/link'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { CheckIcon, CopyIcon, ArrowRightIcon } from '@/components/aura-icons'

export default function DevelopersPage() {
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null)

  const codeSnippets = {
    embed: `<!-- Prototype Preview — not available for production integration yet -->
<!-- Aura Pay Checkout SDK is planned for a future release. -->
<!-- No executable script or copy-paste merchant embed is published. -->`,

    javascript: `// Prototype Preview — API and SDK are not released yet.
// Use the working guided testnet demo instead of this placeholder.
// A future release will document authorization and settlement callbacks.`,

  }

  const copyCode = (type: string, snippet: string) => {
    if (typeof navigator !== 'undefined') {
      navigator.clipboard?.writeText(snippet)
      setCopiedSnippet(type)
      setTimeout(() => setCopiedSnippet(null), 2000)
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
              <i></i> AURA · SDK &amp; APIS · COMING NEXT
            </small>
            <h1>Aura Developers</h1>
            <p>
              Explore the current testnet endpoints. Aura's production SDK and general-purpose private-payment API are not available yet.
            </p>
          </div>

          {/* Visual Route Flow */}
          <div className="visual-flow" style={{ marginBottom: 24 }}>
            <span>DEVELOPER APP (REST API / SDK)</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span className="visual-flow-highlight">AURA PRIVATE BALANCE (Zcash)</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span>DECOUPLED SETTLEMENT</span>
          </div>

          {/* Platform Vision Banner */}
          <div
            className="form-card"
            style={{
              maxWidth: 660,
              margin: '0 auto 28px',
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 12,
            }}
          >
            <div>
              <strong style={{ fontSize: 14, color: '#191820', display: 'block', marginBottom: 2 }}>
                Planned developer platform
              </strong>
              <span style={{ fontSize: 12, color: '#77727d' }}>
                The working product is the guided testnet demo. A public SDK and API will come later; the current testnet wallet is operated by AURA.
              </span>
            </div>
            <span className="platform-tag" style={{ background: '#f5f3ff', color: 'var(--violet)', border: '1px solid #ddd6fe' }}>
              COMING NEXT
            </span>
          </div>

          {/* Roadmap-only surface: no executable API console */}
          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto 36px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, borderBottom: '1px solid #e7e4eb', paddingBottom: 14, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em' }}>
                  PLANNED DEVELOPER API
                </span>
                <h3 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 800, color: '#191820' }}>
                  Planned API surface
                </h3>
              </div>
              <span className="platform-tag" style={{ background: '#f5f3ff', color: 'var(--violet)', border: '1px solid #ddd6fe' }}>COMING NEXT</span>
            </div>

            <div style={{ background: '#fcfbfe', border: '1px solid #e7e4eb', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#77727d', marginBottom: 18 }}>
              <strong style={{ color: '#191820' }}>Preview only:</strong> AURA Developer SDK and REST APIs are not released yet. The working demo uses its own guided interface; the endpoint list below is reference material, not a public API.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginBottom: 18 }}>
              {['Request authorization', 'Rate discovery', 'Audit endpoints'].map((item) => (
                <div key={item} style={{ padding: '14px 16px', borderRadius: 12, border: '1px solid #e7e4eb', background: '#fff', color: '#625c6c', fontSize: 12, fontWeight: 700 }}>
                  {item}
                </div>
              ))}
            </div>
            <p style={{ color: '#77727d', fontSize: 13, lineHeight: 1.5, margin: '0 0 18px' }}>
              Endpoint contracts, authorization rules, and integrations will be published when this developer product is released.
            </p>
            <Link href="/how-privacy-works" className="btn-primary" style={{ display: 'inline-flex', padding: '10px 18px', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
              Learn More →
            </Link>
          </div>

          {/* Quickstart Code Snippets */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, maxWidth: 660, margin: '0 auto 36px', textAlign: 'left' }}>
            {/* Embed Script */}
            <div className="form-card" style={{ margin: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong style={{ fontSize: 14, color: '#191820' }}>HTML Button Embed · Prototype Preview</strong>
                <button
                  type="button"
                  onClick={() => copyCode('embed', codeSnippets.embed)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--violet)',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {copiedSnippet === 'embed' ? (
                    <>
                      <CheckIcon size={12} color="var(--violet)" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon size={12} color="var(--violet)" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre
                style={{
                  background: '#191820',
                  color: '#e2e8f0',
                  padding: '12px',
                  borderRadius: 8,
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  overflowX: 'auto',
                  lineHeight: 1.5,
                  margin: 0,
                  flex: 1,
                  minHeight: 220,
                }}
              >
                {codeSnippets.embed}
              </pre>
            </div>

            {/* Programmatic JS */}
            <div className="form-card" style={{ margin: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong style={{ fontSize: 14, color: '#191820' }}>JavaScript SDK · Prototype Preview</strong>
                <button
                  type="button"
                  onClick={() => copyCode('javascript', codeSnippets.javascript)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--violet)',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {copiedSnippet === 'javascript' ? (
                    <>
                      <CheckIcon size={12} color="var(--violet)" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <CopyIcon size={12} color="var(--violet)" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre
                style={{
                  background: '#191820',
                  color: '#e2e8f0',
                  padding: '12px',
                  borderRadius: 8,
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  overflowX: 'auto',
                  lineHeight: 1.5,
                  margin: 0,
                  flex: 1,
                  minHeight: 220,
                }}
              >
                {codeSnippets.javascript}
              </pre>
            </div>
          </div>

          {/* API Endpoints Table */}
          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto', textAlign: 'left', padding: '24px 28px' }}>
            <div style={{ marginBottom: 18, borderBottom: '1px solid #e7e4eb', paddingBottom: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em' }}>
                TESTNET DEMO ROUTES · NOT A PUBLIC API
              </span>
              <h3 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 800, color: '#191820' }}>
                Internal route map
              </h3>
              <p style={{ margin: '6px 0 0', color: '#77727d', fontSize: 12, lineHeight: 1.5 }}>
                These routes support the guided testnet prototype only. There is no public production host, SDK, or integration contract yet.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {[
                { method: 'POST', path: '/api/requests', desc: 'Creates a single-use decoupled payment route with fresh key.' },
                { method: 'GET', path: '/api/requests/:id', desc: 'Checks request status, expiry, and fulfillment state.' },
                { method: 'POST', path: '/api/requests/:id/consume', desc: 'Atomically fulfills request using on-chain payment proof.' },
                { method: 'POST', path: '/api/spend', desc: 'Authorizes private vault payout via client authorization signature.' },
                { method: 'GET', path: '/api/rates', desc: 'Fetches real-time multi-asset valuations with benchmark fallback.' },
                { method: 'POST', path: '/api/audit/test-runner', desc: 'Runs isolated accounting and cryptography checks.' },
              ].map((ep, idx, arr) => (
                <div
                  key={ep.path}
                  style={{
                    padding: '14px 0',
                    borderBottom: idx === arr.length - 1 ? 'none' : '1px solid #f0edf4',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        background: ep.method === 'POST' ? 'var(--lav)' : 'var(--green-light)',
                        color: ep.method === 'POST' ? 'var(--violet)' : 'var(--green-dark)',
                        padding: '2px 8px',
                        borderRadius: 6,
                        fontSize: 10,
                        fontWeight: 800,
                        letterSpacing: '0.04em',
                      }}
                    >
                      {ep.method}
                    </span>
                    <code style={{ fontSize: 13, fontWeight: 700, color: '#191820', background: 'transparent' }}>
                      {ep.path}
                    </code>
                  </div>
                  <span style={{ fontSize: 12, color: '#77727d', lineHeight: 1.4, paddingLeft: 2 }}>{ep.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>

      <AuraFooter />
    </>
  )
}
