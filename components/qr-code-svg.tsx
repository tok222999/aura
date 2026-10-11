'use client'

import React, { useMemo } from 'react'
import { encodeQrCode } from '@/lib/crypto/qr-code'

interface QrCodeProps {
  value: string
  size?: number
  className?: string
  style?: React.CSSProperties
}

export function QrCodeSvg({ value, size = 120, className, style }: QrCodeProps) {
  const modules = useMemo(() => {
    try {
      return encodeQrCode(value || 'https://aura.money')
    } catch {
      return []
    }
  }, [value])

  if (!modules.length) {
    return <div style={{ width: size, height: size, background: '#f1f0f4' }} />
  }

  const N = modules.length
  // QR readers expect a four-module quiet zone around the symbol.
  const margin = 4
  const total = N + margin * 2
  const scale = size / total

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ display: 'block', margin: '0 auto', borderRadius: 8, ...style }}
    >
      <rect width={size} height={size} rx={8} fill="#ffffff" />
      {modules.map((row, r) =>
        row.map((cell, c) => {
          if (!cell) return null
          const x = (c + margin) * scale
          const y = (r + margin) * scale
          return (
            <rect
              key={`${r}-${c}`}
              x={x}
              y={y}
              width={scale}
              height={scale}
              fill="#191820"
            />
          )
        })
      )}
    </svg>
  )
}
