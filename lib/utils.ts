import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { AuraTransaction } from './types/aura'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTimeAgo(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return 'Just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'Yesterday'
  return `${diffDays}d ago`
}

export function formatAuraTx(tx: AuraTransaction) {
  const isPositive = tx.type === 'deposit' || tx.type === 'receive'

  // Extract human USD amount (for send/withdraw, fromAmount is the USD debited from vault)
  let usdAmount = 0
  let asset = tx.toAsset || 'USDC'
  let chain = tx.toChain

  if (tx.type === 'deposit') {
    usdAmount = tx.fromAmount
    asset = tx.fromAsset !== 'ZEC' ? tx.fromAsset : 'USDC'
    chain = tx.fromChain
  } else if (tx.type === 'receive') {
    usdAmount = tx.toAmount || tx.fromAmount || 0
    asset = tx.toAsset && tx.toAsset !== 'ZEC' ? tx.toAsset : (tx.fromAsset !== 'ZEC' ? tx.fromAsset : 'USDC')
    chain = tx.fromChain !== 'zcash' ? tx.fromChain : 'base'
  } else if (tx.type === 'send') {
    usdAmount = tx.fromAmount || (tx.toAsset === 'USDC' || tx.toAsset === 'USDT' ? tx.toAmount : 0)
    asset = tx.toAsset !== 'ZEC' ? tx.toAsset : 'USDC'
    chain = tx.toChain !== 'zcash' ? tx.toChain : 'solana'
  } else if (tx.type === 'withdraw') {
    usdAmount = tx.fromAmount || (tx.toAsset === 'USDC' || tx.toAsset === 'USDT' ? tx.toAmount : 0)
    asset = tx.toAsset !== 'ZEC' ? tx.toAsset : 'USDC'
    chain = tx.toChain !== 'zcash' ? tx.toChain : 'base'
  }

  const capitalizedChain = chain ? chain.charAt(0).toUpperCase() + chain.slice(1) : 'Solana'

  const title =
    tx.type === 'deposit'
      ? `Added +$${usdAmount.toFixed(2)}`
      : tx.type === 'send'
      ? `Sent -$${usdAmount.toFixed(2)}`
      : tx.type === 'receive'
      ? `Received +$${usdAmount.toFixed(2)}`
      : `Withdrew -$${usdAmount.toFixed(2)}`

  const subtitle =
    tx.type === 'deposit'
      ? 'Shielded Vault'
      : tx.type === 'send'
      ? (tx.toAsset === 'SOL' ? `${tx.toAmount} SOL → ${capitalizedChain}` : `${asset} → ${capitalizedChain}`)
      : tx.type === 'receive'
      ? 'Private Balance'
      : `${capitalizedChain} ${asset}`

  const statusLabel =
    tx.status === 'failed'
      ? 'Failed'
      : tx.status === 'completed'
      ? 'Completed'
      : tx.status === 'routing_near'
      ? 'Privacy Buffer'
      : (tx.type === 'send' || tx.type === 'withdraw')
      ? 'Processing'
      : tx.type === 'deposit'
      ? 'Shielded Deposit'
      : tx.type === 'receive'
      ? 'Shielded Received'
      : 'Processing'

  const isShielded = tx.type === 'deposit' || tx.type === 'receive'
  const isPublicPayout = tx.type === 'withdraw'

  let amountFormatted = `${isPositive ? '+' : '-'}$${usdAmount.toFixed(2)}`
  if (!isPositive && tx.toAsset === 'SOL' && tx.toAmount) {
    amountFormatted = `-$${usdAmount.toFixed(2)} (${tx.toAmount} SOL)`
  }

  return {
    isPositive,
    usdAmount,
    asset,
    chain,
    title,
    subtitle,
    amountFormatted,
    statusLabel,
    isShielded,
    isPublicPayout,
    timeAgo: formatTimeAgo(tx.createdAt),
  }
}

/**
 * Validates Ethereum / Base EVM addresses
 */
export function validateEvmAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false
  const clean = address.trim()
  return /^0x[a-fA-F0-9]{40}$/.test(clean)
}

/**
 * Validates Solana public keys (base58, 32-44 chars)
 */
export function validateSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false
  const clean = address.trim()
  return /^[1-9A-HJ-NP-za-km-z]{32,44}$/.test(clean)
}

/**
 * Validates recipient address according to target blockchain
 */
export function validateDestinationAddress(address: string, chain: string): { valid: boolean; error?: string } {
  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    return { valid: false, error: 'Recipient address cannot be empty.' }
  }
  const clean = address.trim()
  if (chain === 'solana') {
    if (!validateSolanaAddress(clean)) {
      return { valid: false, error: 'Invalid Solana address. Must be a valid Base58 public key (32–44 chars).' }
    }
  } else if (chain === 'base' || chain === 'ethereum') {
    if (!validateEvmAddress(clean)) {
      return { valid: false, error: `Invalid ${chain.toUpperCase()} address. Must begin with 0x followed by 40 hex characters.` }
    }
  }
  return { valid: true }
}

/**
 * Generates an unguessable identifier for request IDs and bearer capabilities.
 * It deliberately contains no timestamp and fails closed when a secure random
 * source is unavailable; a predictable fallback would be unsafe for ownerToken.
 */
export function generateSecureId(prefix: string = 'tx'): string {
  const randBytes = new Uint8Array(16)
  const webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(randBytes)
  } else if (typeof window === 'undefined') {
    try {
      const nodeCrypto = eval('require')('crypto') as { randomFillSync?: (bytes: Uint8Array) => Uint8Array }
      if (typeof nodeCrypto.randomFillSync !== 'function') throw new Error('Node secure random source unavailable.')
      nodeCrypto.randomFillSync(randBytes)
    } catch {
      throw new Error('Secure random source unavailable; refusing to create an identifier.')
    }
  } else {
    throw new Error('Secure random source unavailable; refusing to create an identifier.')
  }
  const randHex = Array.from(randBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${prefix}_${randHex}`
}
