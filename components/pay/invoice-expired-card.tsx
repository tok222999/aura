'use client'

import React from 'react'
import Link from 'next/link'
import { CloseIcon } from '@/components/aura-icons'

export function InvoiceExpiredCard() {
  return (
    <div>
      <div
        style={{
          background: 'var(--danger-light)',
          border: '1px solid var(--danger-border)',
          borderRadius: 14,
          padding: '24px 20px',
          textAlign: 'center',
          marginBottom: 20,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'var(--danger)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 12px',
          }}
        >
          <CloseIcon size={20} color="#fff" />
        </div>
        <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: 'var(--danger)' }}>
          Payment Route Expired
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--danger)', lineHeight: 1.5 }}>
          This single-use private payment request has expired. To maintain forward secrecy and prevent link interception, time-limited requests cannot be paid after expiration.
        </p>
      </div>

      <div
        style={{
          background: '#fbfafc',
          border: '1px solid #e7e4eb',
          borderRadius: 12,
          padding: '14px 16px',
          fontSize: 12,
          color: '#56515d',
          lineHeight: 1.6,
          marginBottom: 20,
        }}
      >
        <strong style={{ color: '#191820', display: 'block', marginBottom: 4 }}>
          Why do requests expire?
        </strong>
        To prevent payment replay and protect recipient privacy, expired one-time payment routes are deactivated. Please ask the recipient to generate a fresh payment link.
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Link
          href="/receive"
          style={{
            flex: 1,
            width: '100%',
            padding: '12px',
            borderRadius: 10,
            border: 0,
            background: 'var(--violet, #6b55df)',
            color: '#fff',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            textDecoration: 'none',
            textAlign: 'center',
          }}
        >
          Create Fresh Request →
        </Link>

      </div>
    </div>
  )
}
