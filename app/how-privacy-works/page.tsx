/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import { AuraHeader } from '@/components/aura-header'
import { AuraFooter } from '@/components/aura-footer'
import { ArrowRightIcon, SparkleIcon } from '@/components/aura-icons'
import { RecipientVisibilityCard } from '@/components/recipient-visibility-card'

export default function HowPrivacyWorksPage() {
  return (
    <>
      <AuraHeader />

      <main className="app-shell-main">
        <div className="app-view-wrap">
          <div className="app-view-header">
            <small className="eyebrow">
              <i></i> AURA · ARCHITECTURE
            </small>
            <h1>How Privacy Works</h1>
            <p>
              The simple version: your main wallet funds a Private Balance, then AURA checks the payment before it leaves. The demo proves that middle step with a real private Zcash Testnet transaction. The public entry and payment can still be visible, so this is not a promise of perfect unlinkability or self-custody.
            </p>
            {/* 10-Second Visual Flow */}
            <div className="visual-flow" style={{ marginTop: 22, marginBottom: 0 }}>
              <span>PUBLIC WALLET</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span className="visual-flow-highlight">PRIVATE BALANCE</span>
              <ArrowRightIcon size={12} color="var(--violet)" />
              <span>PAYMENT</span>
            </div>
          </div>

          <div style={{ maxWidth: 660, margin: '0 auto' }}>

            {/* Visual Comparison: Normal Crypto vs Aura */}
            <div className="diagram-compare-wrap">
              <div className="diagram-card">
                <small className="diagram-badge diagram-badge-danger">
                  Normal Public Crypto
                </small>
                <h3 className="diagram-card-title">Direct Wallet Exposure</h3>
                <p className="diagram-card-desc">
                  A direct payment exposes the wallet address you paid from, so a recipient can inspect the public balance and transaction history tied to that address.
                </p>

                <div className="diagram-flow-chain">
                  <span>Main Wallet</span>
                  <ArrowRightIcon size={12} color="var(--danger)" />
                  <span>Direct Transfer</span>
                  <ArrowRightIcon size={12} color="var(--danger)" />
                  <span>Recipient</span>
                </div>
                <small className="diagram-verdict diagram-verdict-danger">
                  Permanent link recorded on public block explorers.
                </small>
              </div>

              <div className="diagram-card card-aura">
                <small className="diagram-badge diagram-badge-success">
                  <SparkleIcon size={11} color="var(--green)" />
                  <span>Aura Private Balance</span>
                </small>
                <h3 className="diagram-card-title">Decoupled Payment Flow</h3>
                <p className="diagram-card-desc">
                  The recipient gets the payment; your main wallet is not the direct sender. Public timing and amount data may still make the route linkable.
                </p>

                <div className="diagram-flow-chain diagram-flow-aura">
                  <span>Main Wallet</span>
                  <ArrowRightIcon size={12} color="var(--violet)" />
                  <span className="diagram-flow-accent">Private Balance</span>
                  <ArrowRightIcon size={12} color="var(--violet)" />
                  <span>Recipient</span>
                </div>
                <small className="diagram-verdict diagram-verdict-success">
                  The recipient gets the payment; your main wallet is not the direct sender.
                </small>
              </div>
            </div>

            {/* Section 13: What Can The Recipient See? Card */}
            <RecipientVisibilityCard />

            {/* The 3 Transaction Zones */}
            <div className="how-privacy-pillars">
              <div className="how-pillar">
                <span className="how-pillar-num">01 / Public Entry</span>
                <strong className="how-pillar-title">May be visible</strong>
                <p>
                  Your source address, deposit amount, timestamp, and route deposit address exist on the public entry chain.
                </p>
              </div>

              <div className="how-pillar how-pillar-featured">
                <span className="how-pillar-num how-pillar-num-accent">02 / Private Balance</span>
                  <strong className="how-pillar-title">Private balance + Zcash inventory</strong>
                <p>
                  AURA presents a Private Balance between the public wallet and the payment. In this demo it is backed by a confirmed Zcash Testnet step; custody and privacy limits are explained below.
                </p>
              </div>

              <div className="how-pillar">
                <span className="how-pillar-num">03 / Public Exit</span>
                <strong className="how-pillar-title">May be visible</strong>
                <p>
                  The recipient gets the payment. Your main wallet is not the direct sender, while the recipient-chain amount and time remain public.
                </p>
              </div>
            </div>

            {/* What Can Still Correlate vs How Aura Mitigates */}
            <div className="how-dual-cards">
              <div className="how-dual-card how-dual-danger">
                <h4>What Can Still Correlate You</h4>
                <ul>
                  <li>Immediate pass-through (depositing and exiting within seconds).</li>
                  <li>Identical transaction amounts (e.g. depositing $500 and paying exactly $500).</li>
                  <li>Reusing the exact same public address or payment link.</li>
                  <li>Network-level and IP metadata at provider boundaries.</li>
                </ul>
              </div>

              <div className="how-dual-card how-dual-success">
                <h4>What This Prototype Actually Does</h4>
                <ul>
                  <li>Tracks the balance in AURA&apos;s records and checks it against the live Zcash Testnet inventory.</li>
                  <li>Optional 1-day and 3-day waits before a recorded balance can be spent.</li>
                  <li>Creates single-use Receive Requests with a fresh Zcash Testnet receiver.</li>
                  <li>Shows warnings about visible amounts and timing before supported payments.</li>
                  <li>These steps do not establish user custody or prove transaction unlinkability.</li>
                </ul>
              </div>
            </div>

            {/* Technical boundary comes after the product explanation. */}
            <div className="truth-quote-box">
              &ldquo;AURA tracks the balance in its records and checks it against the live Zcash Testnet inventory. The testnet wallet is operated by the server; perfect unlinkability is not proven.&rdquo;
            </div>

            {/* Client authorization limits */}
            <div className="how-custody-card">
              <h4>Client Authorization &amp; Demo Data Handling</h4>
                <p>
                  Client authorization keys and intent signatures are generated locally in your browser. The current demo settles through a server-operated Zcash Testnet wallet; local authorization does not make this testnet flow self-custodial or guarantee zero tracking.
                </p>
            </div>

          </div>
        </div>
      </main>

      <AuraFooter />
    </>
  )
}
