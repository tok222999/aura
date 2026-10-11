'use client'

import React from 'react'
import Link from 'next/link'
import { CheckIcon } from '@/components/aura-icons'

interface InvoiceSettledCardProps { txHash: string }

export function InvoiceSettledCard({ txHash }: InvoiceSettledCardProps) {
  return (
    <div>
      <div
        style={{
          background: 'var(--green-light)',
          border: '1px solid #cce8de',
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
            background: 'var(--green)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 12px',
          }}
        >
          <CheckIcon size={22} color="#fff" />
        </div>
        <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#1b4d3e' }}>
          Payment Settled &amp; Request Consumed
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--green-dark)', lineHeight: 1.5 }}>
          The source payment and Zcash shielding are confirmed. This single-use request is consumed to prevent another payment through the same link. The prototype does not prove recipient anonymity or transaction unlinkability.
        </p>

        {txHash && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px dashed #bfe0d4',
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              color: 'var(--green-dark)',
              wordBreak: 'break-all',
            }}
          >
            Settlement TX: {txHash}
          </div>
        )}
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
          Replay Protection Active
        </strong>
        Submitting the same transaction hash or re-visiting this link will reject any subsequent attempts. If you need to make another transfer, request a fresh one-time link from the recipient.
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Link href="/balance" style={{
          flex: 1,
          padding: '12px',
          borderRadius: 10,
          border: 0,
          background: 'var(--violet, #6b55df)',
          color: '#fff',
          fontSize: 13,
          fontWeight: 700,
          textAlign: 'center',
          textDecoration: 'none',
        }}>
          Return to Dashboard →
        </Link>

        <Link href="/receive" style={{
          flex: 1,
          padding: '12px',
          borderRadius: 10,
          border: '1px solid #e7e4eb',
          background: '#fff',
          color: '#56515d',
          fontSize: 13,
          fontWeight: 700,
          textAlign: 'center',
          textDecoration: 'none',
        }}>
          Create a new request
        </Link>
      </div>
    </div>
  )
}
