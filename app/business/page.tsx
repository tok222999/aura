/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React from 'react'
import Link from 'next/link'
import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import {
  ZapIcon,
  ArrowRightIcon,
  BuildingIcon,
  SlidersIcon,
  ShieldIcon,
} from '@/components/aura-icons'

export default function BusinessPage() {
  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          {/* Header */}
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · CORPORATE OPERATIONS · COMING NEXT
            </small>
            <h1>Aura for Business</h1>
            <p>
              AURA starts with a Private Balance for anyone paying from a public wallet. This business surface shows one later use case: separate daily operational spending from core reserves without putting those reserves directly into each payment flow.
            </p>
          </div>

          {/* Visual Route Flow */}
          <div className="visual-flow" style={{ marginBottom: 28 }}>
            <span>COLD RESERVE (Public Balance)</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span className="visual-flow-highlight">PRIVATE WORKING BALANCE (Aura)</span>
            <ArrowRightIcon size={12} color="var(--violet)" />
            <span>SUPPLIERS &amp; PAYROLL</span>
          </div>

          {/* Roadmap-only surface: no live payout controls */}
          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto 36px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, borderBottom: '1px solid #e7e4eb', paddingBottom: 14 }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em' }}>
                  OPERATIONAL DISBURSEMENT SPECIFICATION
                </span>
                <h3 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 800, color: '#191820' }}>
                  Pay a Corporate Invoice Privately
                </h3>
              </div>
              <span className="platform-tag" style={{ background: '#f5f3ff', color: 'var(--violet)', border: '1px solid #ddd6fe' }}>COMING NEXT</span>
            </div>

            <div style={{ background: '#fcfbfe', border: '1px solid #e7e4eb', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#77727d', marginBottom: 18 }}>
              <strong style={{ color: '#191820' }}>Roadmap Preview:</strong> Aura for Business is coming next. This screen is illustrative only; it cannot send a payout or move funds.
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 18 }}>
              {['Fund a working balance', 'Set payout policies', 'Pay suppliers privately'].map((item) => (
                <div key={item} style={{ padding: '14px 16px', borderRadius: 12, border: '1px solid #e7e4eb', background: '#fff', color: '#625c6c', fontSize: 12, fontWeight: 700 }}>
                  {item}
                </div>
              ))}
            </div>
            <p style={{ color: '#77727d', fontSize: 13, lineHeight: 1.5, margin: '0 0 18px' }}>
              Corporate balances, team approvals, supplier routing, policy controls, and payroll are roadmap capabilities. Today&apos;s working product is the individual Private Balance and Pay flow; nothing on this page can submit a payout.
            </p>
            <Link href="/how-privacy-works" className="btn-primary" style={{ display: 'inline-flex', padding: '10px 18px', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
              Learn More →
            </Link>
          </div>

          {/* 4 Pillars of Corporate Privacy */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, maxWidth: 660, margin: '0 auto 36px', textAlign: 'left' }}>
            <div className="diagram-card" style={{ padding: 20 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--violet-dim)', display: 'grid', placeItems: 'center', color: 'var(--violet)', marginBottom: 12 }}>
                <BuildingIcon size={18} />
              </div>
              <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 6px', color: '#191820' }}>
                Separate Operational Spending
              </h3>
              <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: 0 }}>
                Public payments can reveal or help infer operational balances and payment patterns. They do not, by themselves, prove total reserves, burn rate, or runway.
              </p>
            </div>

            <div className="diagram-card" style={{ padding: 20 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--green-dim)', display: 'grid', placeItems: 'center', color: 'var(--green)', marginBottom: 12 }}>
                <SlidersIcon size={18} />
              </div>
              <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 6px', color: '#191820' }}>
                Selective reporting
              </h3>
              <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: 0 }}>
                A future business view could share selected transaction records without publishing the full balance. This is not enabled in the current demo.
              </p>
            </div>

            <div className="diagram-card" style={{ padding: 20 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(25, 24, 32, 0.05)', display: 'grid', placeItems: 'center', color: 'var(--ink)', marginBottom: 12 }}>
                <ZapIcon size={18} />
              </div>
              <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 6px', color: '#191820' }}>
                Batch supplier payouts
              </h3>
              <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: 0 }}>
                A future business flow could send several supplier or contractor payments together while keeping each payment separate. This capability is not enabled in the current demo.
              </p>
            </div>

            <div className="diagram-card" style={{ padding: 20 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--lav)', display: 'grid', placeItems: 'center', color: 'var(--violet)', marginBottom: 12 }}>
                <ShieldIcon size={18} />
              </div>
              <h3 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 6px', color: '#191820' }}>
                Private supplier invoices
              </h3>
              <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: 0 }}>
                Generate a one-time payment request for each supplier invoice without putting the main reserve address into every payment flow.
              </p>
            </div>
          </div>

          {/* Roadmap & Availability Box */}
          <div className="form-card" style={{ maxWidth: 660, margin: '0 auto', textAlign: 'left' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span className="platform-tag">
                Expansion Timeline
              </span>
              <strong style={{ fontSize: 15, color: '#191820' }}>Aura for Business Rollout</strong>
            </div>
            <p style={{ fontSize: 13, color: '#77727d', lineHeight: 1.5, margin: '0 0 16px' }}>
              The core privacy engine is currently live in testnet prototyping. Corporate reserve controls, multi-signature policies, and view-key audit exports are planned roadmap work.
            </p>
            <Link href="/how-privacy-works" className="btn-primary" style={{ display: 'inline-flex', padding: '8px 18px', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
              Learn More →
            </Link>
          </div>
        </div>
      </main>

      <AuraFooter />
    </>
  )
}
