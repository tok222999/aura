'use client'

import { useEffect } from 'react'

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // If it's a chunk load error after deployment, automatically try to reload once
    if (error?.message?.includes('Loading chunk') || error?.name === 'ChunkLoadError') {
      const reloaded = sessionStorage.getItem('aura_chunk_reload')
      if (!reloaded) {
        sessionStorage.setItem('aura_chunk_reload', '1')
        window.location.reload()
      }
    }
  }, [error])

  return (
    <div style={{
      minHeight: '70vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      textAlign: 'center',
      fontFamily: 'var(--font-ui, system-ui, sans-serif)',
    }}>
      <div style={{
        maxWidth: 440,
        background: '#fff',
        border: '1px solid #e7e4eb',
        borderRadius: 16,
        padding: '32px 24px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.06)',
      }}>
        <div style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: '#ede9fe',
          display: 'grid',
          placeItems: 'center',
          margin: '0 auto 16px',
          color: 'var(--violet, #6b55df)',
          fontWeight: 800,
          fontSize: 20,
        }}>
          ↺
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: '#191820', margin: '0 0 8px' }}>
          Session Refresh Needed
        </h2>
        <p style={{ fontSize: 13, color: '#77727d', margin: '0 0 20px', lineHeight: 1.5 }}>
          A new version of the demo was deployed. Refresh to sync with the latest testnet state.
        </p>
        <button
          type="button"
          onClick={() => {
            sessionStorage.removeItem('aura_chunk_reload')
            window.location.reload()
          }}
          style={{
            background: 'var(--violet, #6b55df)',
            color: '#fff',
            border: 0,
            borderRadius: 10,
            padding: '10px 20px',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Refresh Page
        </button>
      </div>
    </div>
  )
}
