/**
 * Section 13: What Can The Recipient See? Card
 * Transparent breakdown for non-crypto users and jury members.
 */

'use client'

import React from 'react'
import { CheckIcon, ShieldIcon } from '@/components/aura-icons'

type Visibility = 'visible' | 'not_directly_shared' | 'may_be_inferred'

export function RecipientVisibilityCard() {
  const items = [
    { label: 'Amount received', visibility: 'visible' as const, note: 'The recipient can see the amount paid' },
    { label: 'Asset received', visibility: 'visible' as const, note: 'SOL on Solana Devnet in this demo' },
    { label: 'Destination wallet', visibility: 'visible' as const, note: 'The recipient sees their own wallet address' },
    { label: 'Your main wallet address', visibility: 'not_directly_shared' as const, note: 'AURA does not send from your main wallet to the recipient' },
    { label: 'Your total balance', visibility: 'not_directly_shared' as const, note: 'Not shared as part of the payout' },
    { label: 'Where the money came from', visibility: 'may_be_inferred' as const, note: 'Public entry, exit, timing, and amount can still create a link' },
    { label: 'Your transaction history', visibility: 'may_be_inferred' as const, note: 'Not handed to the recipient, but public-chain analysis may reveal patterns' },
  ]

  return (
    <div
      style={{
        background: '#ffffff',
        border: '1.5px solid #d9d0ff',
        borderRadius: 16,
        padding: '24px',
        boxShadow: '0 4px 20px rgba(107, 85, 223, 0.08)',
        margin: '24px 0',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--lav)', display: 'grid', placeItems: 'center' }}>
            <ShieldIcon size={16} color="var(--violet)" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: 'var(--ink)' }}>
              What can the recipient see?
            </h3>
            <small style={{ color: 'var(--muted)', fontSize: 12 }}>
              What the recipient sees in this testnet demo
            </small>
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            background: 'var(--green-light)',
            color: 'var(--green-dark)',
            padding: '3px 8px',
            borderRadius: 6,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          No direct wallet handoff
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
        {items.map((item, idx) => (
          <div
            key={idx}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderRadius: 10,
              background: item.visibility === 'visible' ? '#f9fafb' : '#fcfbfe',
              border: `1px solid ${item.visibility === 'visible' ? '#e5e7eb' : '#ebdfff'}`,
            }}
          >
            <div>
              <strong style={{ fontSize: 13, color: '#191820', display: 'block' }}>
                {item.label}
              </strong>
              <small style={{ fontSize: 11, color: item.visibility === 'visible' ? '#6b7280' : 'var(--violet)' }}>
                {item.note}
              </small>
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                padding: '3px 8px',
                borderRadius: 6,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                background: item.visibility === 'visible' ? '#f3f4f6' : item.visibility === 'may_be_inferred' ? '#fff8e8' : 'var(--lav)',
                color: item.visibility === 'visible' ? '#374151' : item.visibility === 'may_be_inferred' ? '#7a571f' : 'var(--violet)',
              }}
            >
              {item.visibility === 'visible' ? (
                <>
                  <CheckIcon size={12} color="var(--green-dark)" />
                  <span>VISIBLE</span>
                </>
              ) : (
                <>
                  <span>{item.visibility === 'may_be_inferred' ? 'MAY BE INFERRED' : 'NOT DIRECTLY SHARED'}</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
