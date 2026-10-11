import { PrivacyBufferMode } from '@/lib/types/aura'

/** Canonical fields bound by a signed payment-request creation intent. */
export function canonicalizePaymentRequestIntent(input: {
  amount?: number | null | string
  asset: string
  chain: string
  expiryHours: number
  bufferMode?: PrivacyBufferMode
}): string {
  const rawAmount = input.amount === undefined || input.amount === null || input.amount === ''
    ? 'open'
    : Number(input.amount).toFixed(2)
  return `${rawAmount}:${String(input.asset).trim().toUpperCase()}:${String(input.chain).trim().toLowerCase()}:${Math.trunc(Number(input.expiryHours))}:${input.bufferMode || 'private'}`
}

/** Canonical terms bound by a recovered owner's signed invoice update. */
export function canonicalizePaymentRequestUpdate(input: {
  amount?: number | null | string
  asset: string
  chain: string
  expiryHours: number
  bufferMode: PrivacyBufferMode
}): string {
  return canonicalizePaymentRequestIntent(input)
}
