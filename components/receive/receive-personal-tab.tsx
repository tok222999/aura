/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React from 'react'
import Link from 'next/link'
import { CryptoIcon } from '@/components/crypto-icon'
import {
  SparkleIcon,
  RefreshIcon,
  CopyIcon,
  CheckIcon,
  ArrowUpRightIcon,
} from '@/components/aura-icons'
import { AssetSymbol } from '@/lib/types/aura'
import { QrCodeSvg } from '@/components/qr-code-svg'
import { NetworkRouteSelector } from '@/components/network-route-selector'
import { DEMO_ENTRY_NETWORKS, PUBLIC_ASSET_ROUTE_OPTIONS } from '@/lib/config/capabilities'

interface ReceivePersonalTabProps {
  routeStatus: 'active' | 'processing' | 'consumed' | 'expired'
  published: boolean
  settlementStatus: 'pending' | 'completed' | 'failed' | null
  requestId: string
  expiryOption: string
  setExpiryOption: (opt: string) => void
  generatedUrl: string
  requestedAsset: AssetSymbol
  setRequestedAsset: (a: AssetSymbol) => void
  requestedNetwork: string
  setRequestedNetwork: (net: string) => void
  requestedAmount: string
  setRequestedAmount: (amt: string) => void
  copied: boolean
  isGenerating: boolean
  handleGenerateFresh: () => void
  handleCopy: () => void
  handleRevoke: () => void
  isRevoking: boolean
}

export function ReceivePersonalTab({
  routeStatus,
  published,
  settlementStatus,
  requestId,
  expiryOption,
  setExpiryOption,
  generatedUrl,
  requestedAsset,
  setRequestedAsset,
  requestedNetwork,
  setRequestedNetwork,
  requestedAmount,
  setRequestedAmount,
  copied,
  isGenerating,
  handleGenerateFresh,
  handleCopy,
  handleRevoke,
  isRevoking,
}: ReceivePersonalTabProps) {
  return (
    <>
      {routeStatus === 'consumed' && (
        <div
          className="modal-status-badge"
          style={{
            background: settlementStatus === 'completed' ? 'var(--green-light)' : settlementStatus === 'failed' ? 'var(--danger-light)' : 'var(--warning-light)',
            color: settlementStatus === 'completed' ? 'var(--green-dark)' : settlementStatus === 'failed' ? 'var(--danger)' : 'var(--warning)',
            padding: '14px 18px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {settlementStatus === 'completed' ? <CheckIcon size={14} color="var(--green-dark)" /> : null}
          <span>
            {settlementStatus === 'completed'
              ? 'Payment received and Zcash shielding confirmed.'
              : settlementStatus === 'failed'
                ? 'Source payment was received, but Zcash shielding failed. Check the transaction details before retrying.'
                : 'Source payment received. Zcash shielding confirmation is still pending.'}
          </span>
        </div>
      )}

      {/* Cryptographic QR Box */}
      <div className="qr-crypto-box" style={{ opacity: routeStatus === 'consumed' || routeStatus === 'expired' ? 0.75 : 1 }}>
        <div className="qr-crypto-content">
          {requestId && published ? (
            <QrCodeSvg
              value={generatedUrl}
              size={110}
              style={{ margin: '0 auto 8px', opacity: routeStatus === 'consumed' || routeStatus === 'expired' ? 0.4 : 1 }}
            />
          ) : (
            <div style={{ width: 110, height: 110, margin: '0 auto 8px', border: '1px dashed #cfc8df', borderRadius: 12, display: 'grid', placeItems: 'center', color: '#77727d', fontSize: 11, textAlign: 'center', padding: 12 }}>
              {requestId ? 'Publish the request to generate a shareable QR code' : 'Create a request to generate a QR code'}
            </div>
          )}
          {!requestId ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--violet, #6b55df)', textTransform: 'uppercase' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--violet, #6b55df)' }} />
              Ready to create
            </div>
          ) : routeStatus === 'active' && published ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--green)', textTransform: 'uppercase' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} />
              Shielded Route Active
            </div>
          ) : routeStatus === 'active' ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--violet, #6b55df)', textTransform: 'uppercase' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--violet, #6b55df)' }} />
              Draft · Publish to activate
            </div>
          ) : routeStatus === 'processing' ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--violet, #6b55df)', textTransform: 'uppercase' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--violet, #6b55df)' }} />
              Incoming Payment Processing...
            </div>
          ) : routeStatus === 'expired' ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--danger)', textTransform: 'uppercase' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--danger)' }} />
              Route Expired
            </div>
          ) : (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: '#888', textTransform: 'uppercase' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#888' }} />
              Route Consumed &bull; Replay Protected
            </div>
          )}
          <div style={{ fontSize: 9, color: '#9188ad', fontFamily: 'var(--font-ui)', marginTop: 3 }}>
            KEY: {requestId || 'NOT CREATED YET'} · {routeStatus === 'expired' ? 'EXPIRED' : routeStatus === 'consumed' ? 'CONSUMED' : routeStatus === 'processing' ? 'PROCESSING' : `SINGLE-USE · EXPIRES ${expiryOption.toUpperCase()}`}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 16, color: '#191820', fontWeight: 800 }}>
          One-Time Private Payment Link
        </strong>
        <button
          type="button"
          onClick={handleGenerateFresh}
          disabled={isGenerating}
          style={{
            background: '#f4efff',
            border: '1px solid #d9d0ff',
            color: 'var(--violet, #6b55df)',
            padding: '5px 12px',
            borderRadius: 8,
            fontSize: 11,
            fontWeight: 700,
            cursor: isGenerating ? 'wait' : 'pointer',
            transition: 'all 0.15s ease',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            opacity: isGenerating ? 0.7 : 1,
          }}
        >
          <RefreshIcon size={12} color="var(--violet)" />
          <span>{isGenerating ? 'Creating...' : 'Create Request'}</span>
        </button>
      </div>

      <p style={{ color: '#77727d', fontSize: 13, margin: '0 0 16px', lineHeight: 1.55 }}>
        Set the terms first. Publish &amp; Copy Link locks this request and activates its QR/payment page.
      </p>

      {/* Link Box */}
      <div style={{ display: 'flex', gap: 10, background: '#fff', border: '1px solid #d9d0ff', borderRadius: 14, padding: '6px 6px 6px 14px', alignItems: 'center', boxShadow: '0 4px 16px rgba(107, 85, 223, 0.08)', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <SparkleIcon size={14} color="var(--violet)" />
          <input
            type="text"
            readOnly
            aria-label="Generated private payment request link"
            value={generatedUrl}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              fontSize: 12,
              fontFamily: 'var(--font-ui)',
              color: '#191820',
              width: '100%',
              outline: 'none',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Link
            href={requestId && published ? `/pay/${requestId}` : '#'}
            target={requestId && published ? '_blank' : undefined}
            style={{
              padding: '10px 14px',
              borderRadius: 10,
              border: '1px solid #d9d0ff',
              background: '#fcfbfe',
              color: requestId && published ? 'var(--violet, #6b55df)' : '#999',
              fontWeight: 700,
              fontSize: 12,
              textDecoration: 'none',
              cursor: requestId && published ? 'pointer' : 'default',
              pointerEvents: requestId && published ? 'auto' : 'none',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>Open Payer View</span>
            <ArrowUpRightIcon size={13} />
          </Link>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!requestId || isGenerating || (published && copied)}
            style={{
              padding: '10px 18px',
              borderRadius: 10,
              border: 'none',
              background: !requestId ? '#e7e4eb' : copied ? 'var(--green)' : 'var(--violet)',
              color: !requestId ? '#77727d' : '#fff',
              fontWeight: 700,
              fontSize: 13,
              cursor: !requestId || (published && copied) ? 'not-allowed' : 'pointer',
              boxShadow: '0 4px 14px rgba(107, 85, 223, 0.25)',
              whiteSpace: 'nowrap',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {copied ? (
              <>
                <CheckIcon size={14} />
                <span>Copied</span>
              </>
            ) : (
              <>
                <CopyIcon size={14} />
                <span>{published ? 'Copy Link' : 'Publish & Copy Link'}</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={handleRevoke}
            disabled={!requestId || routeStatus !== 'active' || isRevoking}
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #f0caca',
              background: '#fffafa',
              color: routeStatus === 'active' ? '#b64c4c' : '#999',
              fontWeight: 700,
              fontSize: 12,
              cursor: !requestId || routeStatus !== 'active' || isRevoking ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {isRevoking ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      </div>

      {/* Request Configuration */}
      <div style={{ background: '#fbfafc', border: '1px solid rgba(222, 219, 229, 0.9)', borderRadius: 16, padding: '20px', textAlign: 'left', marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', color: '#191820', textTransform: 'uppercase', marginBottom: 16 }}>
          Request Configuration
        </div>

        {/* Asset Pills */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#77727d', display: 'block', marginBottom: 8, textTransform: 'uppercase' }}>
            Requested Asset
          </label>
          <div className="aura-chip-group">
            {PUBLIC_ASSET_ROUTE_OPTIONS.map(({ symbol: asset, status }) => (
              <button
                key={asset}
                type="button"
                className={`aura-chip ${requestedAsset === asset ? 'active' : ''}`}
                disabled={published || status !== 'LIVE'}
                title={status !== 'LIVE' ? 'Solana entry is coming next' : undefined}
                onClick={() => {
                  if (published || status !== 'LIVE') return
                  setRequestedAsset(asset)
                  if (asset === 'USDC') setRequestedNetwork('Base')
                }}
              >
                <CryptoIcon name={asset} size={18} />
                <span>{asset}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Network Pills */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#77727d', textTransform: 'uppercase', margin: 0 }}>
              Payer Network
            </label>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--violet)', background: 'var(--lav)', padding: '2px 8px', borderRadius: 6 }}>
              Testnet route: public entry → Private Balance → recipient payout
            </span>
          </div>
              <NetworkRouteSelector
            title="Payer network"
            selectedId={requestedNetwork}
            options={DEMO_ENTRY_NETWORKS.map((option) => ({ ...option, id: option.id === 'base' ? 'Base' : option.id === 'solana' ? 'Solana' : option.id === 'ethereum' ? 'Ethereum' : option.id === 'arbitrum' ? 'Arbitrum' : option.id === 'ton' ? 'TON' : 'Bitcoin' }))}
            disabled={published}
            onSelect={(net) => {
              setRequestedNetwork(net.id)
              setRequestedAsset(net.id === 'Solana' ? 'SOL' : 'USDC')
            }}
            helper="Live entry today: Base Sepolia USDC → Private Balance."
          />

          {/* Upcoming Roadmap Networks */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              background: '#f8f7fa',
              borderRadius: 10,
              border: '1px solid #ebe8f0',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 10.5, fontWeight: 700, color: '#77727d', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Planned networks:
            </span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {[
                { label: 'Ethereum Sepolia', icon: 'ethereum' },
                { label: 'Arbitrum', icon: 'arbitrum' },
                { label: 'Bitcoin', icon: 'bitcoin' },
              ].map((net) => (
                <span
                  key={net.label}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 11,
                    fontWeight: 600,
                    color: '#847f8d',
                    background: '#ffffff',
                    padding: '3px 8px',
                    borderRadius: 6,
                    border: '1px solid #e2dfe8',
                  }}
                >
                  <CryptoIcon name={net.icon} size={13} />
                  <span>{net.label}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Amount & Expiry */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#77727d', display: 'block', marginBottom: 6, textTransform: 'uppercase' }}>
              Amount (Optional)
            </label>
            <input
              type="text"
              placeholder="Open amount (any)"
              value={requestedAmount}
              disabled={published}
              onChange={(e) => setRequestedAmount(e.target.value)}
              style={{
                width: '100%',
                padding: '11px 14px',
                border: '1px solid rgba(222, 219, 229, 0.9)',
                borderRadius: 10,
                fontSize: 13,
                background: '#fff',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#77727d', display: 'block', marginBottom: 6, textTransform: 'uppercase' }}>
              Route Expiry
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <span className="aura-chip active" style={{ padding: '10px 8px', fontSize: 11, minWidth: 'auto', whiteSpace: 'nowrap' }}>
                Single-use ✓
              </span>
              {[
                { id: '1h', label: '1 Hour' },
                { id: '24h', label: '24 Hours' },
                { id: '72h', label: '72 Hours' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={published}
                  className={`aura-chip ${expiryOption === opt.id ? 'active' : ''}`}
                  onClick={() => setExpiryOption(opt.id)}
                  style={{ padding: '10px 8px', fontSize: 11, minWidth: 'auto' }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Test Settlement Flow */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
        <a
          href={published ? generatedUrl : '#'}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 12,
            color: published ? 'var(--violet, #6b55df)' : '#999',
            fontWeight: 700,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span>{published ? 'Open Checkout Page' : 'Publish to open checkout'}</span>
          <ArrowUpRightIcon size={12} color="var(--violet)" />
        </a>

      </div>
    </>
  )
}
