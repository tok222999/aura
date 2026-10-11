'use client'

import React from 'react'

export type CryptoSymbol =
  | 'USDC'
  | 'USDT'
  | 'ETH'
  | 'SOL'
  | 'ZEC'
  | 'BTC'
  | 'base'
  | 'Base'
  | 'solana'
  | 'Solana'
  | 'ethereum'
  | 'Ethereum'
  | 'arbitrum'
  | 'Arbitrum'
  | 'polygon'
  | 'Polygon'
  | 'matic'
  | 'MATIC'
  | 'avax'
  | 'AVAX'
  | 'op'
  | 'OP'
  | 'optimism'
  | 'Optimism'
  | 'ton'
  | 'TON'
  | 'zcash'
  | 'Zcash'

interface CryptoIconProps {
  name: CryptoSymbol | string
  size?: number
  className?: string
}

/**
 * 100% Official Cryptocurrency & Network Vector Icons
 * Direct reference to real SVGs downloaded from official blockchain and cryptocurrency-icons repositories.
 */
const OFFICIAL_ICON_MAP: Record<string, string> = {
  USDC: '/icons/usdc.svg',
  'USD COIN': '/icons/usdc.svg',
  USDT: '/icons/usdt.svg',
  TETHER: '/icons/usdt.svg',
  ETH: '/icons/eth.svg',
  ETHEREUM: '/icons/eth.svg',
  SOL: '/icons/sol.svg',
  SOLANA: '/icons/sol.svg',
  ZEC: '/icons/zec.svg',
  ZCASH: '/icons/zec.svg',
  BTC: '/icons/btc.svg',
  BITCOIN: '/icons/btc.svg',
  BASE: '/icons/base.svg',
  ARBITRUM: '/icons/arb.svg',
  ARB: '/icons/arb.svg',
  OP: '/icons/op.svg',
  OPTIMISM: '/icons/op.svg',
  POLYGON: '/icons/matic.svg',
  MATIC: '/icons/matic.svg',
  POL: '/icons/matic.svg',
  AVAX: '/icons/avax.svg',
  AVALANCHE: '/icons/avax.svg',
  METAMASK: '/icons/metamask.svg',
  PHANTOM: '/icons/phantom.svg',
  COINBASE: '/icons/coinbase.svg',
  COINBASEWALLET: '/icons/coinbase.svg',
  'COINBASE WALLET': '/icons/coinbase.svg',
  WALLETCONNECT: '/icons/walletconnect.svg',
}

export function CryptoIcon({ name, size = 20, className = '' }: CryptoIconProps) {
  const norm = (name || '').toUpperCase().trim()
  const iconPath = OFFICIAL_ICON_MAP[norm]

  if (iconPath) {
    return (
      <img
        src={iconPath}
        alt={`${norm} official icon`}
        width={size}
        height={size}
        className={className}
        loading="eager"
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          flexShrink: 0,
          borderRadius: '50%',
          display: 'inline-block',
          verticalAlign: 'middle',
        }}
      />
    )
  }

  // Graceful fallback for unlisted assets: use a quiet text monogram,
  // never a decorative glyph that looks like a generated placeholder.
  const cleanLabel = norm.replace(/[^A-Z0-9]/g, '')
  const fallbackLabel = cleanLabel === 'TON' ? 'TON' : cleanLabel.slice(0, 2) || '—'

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#ede8ff',
        color: '#6b55df',
      fontFamily: 'var(--font-ui)',
      fontSize: Math.max(9, size * 0.38),
        fontWeight: 800,
        flexShrink: 0,
        verticalAlign: 'middle',
      }}
    >
      {fallbackLabel}
    </span>
  )
}
