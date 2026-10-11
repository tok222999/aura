/**
 * TESTNET PROTOTYPE
 * Live Protocol Execution Stream / Telemetry Console
 * Renders real-time human-readable blockchain and enclave execution steps.
 * Adheres strictly to DESIGN_SYSTEM.md (Luxury Editorial Cypherpunk).
 */

'use client'

import React, { useEffect, useRef, useState } from 'react'
import { CheckIcon, SparkleIcon, RefreshIcon, ExternalLinkIcon, CopyIcon } from './aura-icons'

export interface ProtocolLogEntry {
  id: string
  time: string
  tag: string
  message: string
  type?: 'info' | 'success' | 'warning' | 'error' | 'pending'
  explorerUrl?: string
  explorerLabel?: string
}

export interface LiveProtocolStreamProps {
  logs: ProtocolLogEntry[]
  isLive?: boolean
  title?: string
  summaryStatus?: string
  maxHeight?: number | string
  compact?: boolean
}

export function LiveProtocolStream({
  logs,
  isLive = true,
  title = 'Live Protocol Stream',
  summaryStatus,
  maxHeight = 220,
  compact = false,
}: LiveProtocolStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs])

  const copyLogs = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    const text = logs
      .map((l) => `[${l.time}] [${l.tag}] ${l.message}${l.explorerUrl ? ` (${l.explorerUrl})` : ''}`)
      .join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  const getTagColor = (tag: string, type?: string) => {
    if (type === 'success' || tag === 'CONFIRMED' || tag === 'SETTLED' || tag === 'FINALIZED') {
      return { bg: 'rgba(0, 153, 102, 0.15)', text: '#009966', border: 'rgba(0, 153, 102, 0.3)' }
    }
    if (type === 'error' || tag === 'ERROR' || tag === 'FAILED') {
      return { bg: 'rgba(239, 68, 68, 0.15)', text: '#ef4444', border: 'rgba(239, 68, 68, 0.3)' }
    }
    if (tag === 'ZCASH' || tag === 'SHIELDED') {
      return { bg: 'rgba(217, 119, 6, 0.15)', text: '#f59e0b', border: 'rgba(217, 119, 6, 0.3)' }
    }
    if (tag === 'BASE') {
      return { bg: 'rgba(43, 102, 246, 0.15)', text: '#60a5fa', border: 'rgba(43, 102, 246, 0.3)' }
    }
    if (tag === 'SOLANA') {
      return { bg: 'rgba(139, 92, 246, 0.15)', text: '#a78bfa', border: 'rgba(139, 92, 246, 0.3)' }
    }
    if (tag === 'ENCLAVE' || tag === 'SIGN') {
      return { bg: 'rgba(107, 85, 223, 0.15)', text: '#c4b5fd', border: 'rgba(107, 85, 223, 0.3)' }
    }
    return { bg: 'rgba(255, 255, 255, 0.08)', text: '#9ca3af', border: 'rgba(255, 255, 255, 0.12)' }
  }

  if (logs.length === 0) return null

  return (
    <div
      style={{
        background: '#0d0d14',
        border: '1px solid #232134',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 8px 24px rgba(10, 10, 18, 0.35)',
        fontFamily: 'var(--font-ui, system-ui, sans-serif)',
        marginBottom: compact ? 8 : 14,
      }}
    >
      {/* Console Top Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          background: '#141221',
          borderBottom: '1px solid #232134',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: isLive ? '#009966' : '#6b7280',
              boxShadow: isLive ? '0 0 8px #009966' : 'none',
              animation: isLive ? 'pulse 2s infinite' : 'none',
            }}
          />
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#d6d2ea',
            }}
          >
            {title}
          </span>
          {summaryStatus && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: '#9e97c4',
                padding: '1px 6px',
                borderRadius: 4,
                background: 'rgba(255, 255, 255, 0.06)',
              }}
            >
              {summaryStatus}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={copyLogs}
          title="Copy full telemetry log"
          style={{
            background: 'transparent',
            border: 'none',
            color: copied ? '#009966' : '#77727d',
            fontSize: 10,
            fontWeight: 700,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            borderRadius: 4,
            transition: 'color 0.15s ease',
          }}
        >
          {copied ? (
            <>
              <CheckIcon size={11} color="#009966" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <CopyIcon size={11} color="currentColor" />
              <span>Copy Trace</span>
            </>
          )}
        </button>
      </div>

      {/* Log Entries Container */}
      <div
        ref={containerRef}
        style={{
          maxHeight,
          overflowY: 'auto',
          padding: '10px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          background: '#0d0d14',
        }}
      >
        {logs.map((log) => {
          const colors = getTagColor(log.tag, log.type)
          return (
            <div
              key={log.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                fontSize: 11,
                lineHeight: 1.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, flexWrap: 'wrap' }}>
                <span
                  style={{
                    color: '#656073',
                    fontSize: 10,
                    fontFamily: 'monospace',
                    flexShrink: 0,
                    userSelect: 'none',
                  }}
                >
                  [{log.time}]
                </span>

                <span
                  style={{
                    display: 'inline-block',
                    padding: '0 5px',
                    borderRadius: 3,
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: '0.04em',
                    background: colors.bg,
                    color: colors.text,
                    border: `1px solid ${colors.border}`,
                    flexShrink: 0,
                    userSelect: 'none',
                  }}
                >
                  {log.tag}
                </span>

                <span
                  style={{
                    color: '#e4e2ee',
                    wordBreak: 'break-word',
                    flex: 1,
                  }}
                >
                  {log.message}
                </span>
              </div>

              {log.explorerUrl && (
                <div style={{ paddingLeft: 60, marginTop: 1 }}>
                  <a
                    href={log.explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#a78bfa',
                      textDecoration: 'underline',
                      background: 'rgba(167, 139, 250, 0.08)',
                      padding: '2px 8px',
                      borderRadius: 4,
                      border: '1px solid rgba(167, 139, 250, 0.2)',
                    }}
                  >
                    <span>{log.explorerLabel || 'View on Explorer'}</span>
                    <ExternalLinkIcon size={10} color="#a78bfa" />
                  </a>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
