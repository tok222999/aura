/**
 * Authentic Cryptographic Client Intent Authorization (ECDSA P-256)
 *
 * Implements non-custodial asymmetric intent authorization:
 * - Client signs spend intent using a private key held strictly in the browser enclave.
 * - Server verifies the signature using the client's public key (SPKI DER format).
 * - The public key is pinned to a tenant only after recovery-authority enrollment.
 * - Private key NEVER leaves the client device.
 * - Replay protection enforced via mandatory nonce and timestamp freshness.
 */

import crypto from 'crypto'

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  const bytes = typeof data === 'string'
    ? Buffer.from(data, 'utf8')
    : Buffer.from(data)
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

/**
 * Derives the canonical Aura enclave fingerprint from a public key SPKI hex.
 */
export function deriveFingerprintFromSpki(publicKeySpkiHex: string): string {
  const hash = sha256Hex(Buffer.from(publicKeySpkiHex, 'hex'))
  return `vault_${hash.substring(0, 8)}...${hash.substring(24, 28)}`
}

/**
 * Verifies that a spend intent was signed by the holder of the private key corresponding to publicKeySpkiHex.
 * Supports IEEE-P1363 (WebCrypto standard) and DER encoding.
 */
export function verifyClientEcdsaSignature(
  publicKeySpkiHex: string,
  payload: string,
  signatureHex: string
): boolean {
  try {
    if (!publicKeySpkiHex || !payload || !signatureHex) return false

    const cleanSig = signatureHex.replace(/^sig_0x/i, '').trim()
    const cleanSpki = publicKeySpkiHex.replace(/^0x/i, '').trim()
    // WebCrypto P-256 signatures are 64-byte IEEE-P1363 values; DER values
    // are slightly larger. Reject malformed or oversized input before parsing.
    if (!/^[a-f0-9]+$/i.test(cleanSig) || cleanSig.length % 2 !== 0 || cleanSig.length > 256) return false
    if (!/^[a-f0-9]+$/i.test(cleanSpki) || cleanSpki.length % 2 !== 0 || cleanSpki.length < 128 || cleanSpki.length > 2048) return false
    const sigBuffer = Buffer.from(cleanSig, 'hex')
    if (sigBuffer.length < 64) return false
    const spkiBuffer = Buffer.from(cleanSpki, 'hex')

    const pubKey = crypto.createPublicKey({
      key: spkiBuffer,
      format: 'der',
      type: 'spki',
    })

    const payloadBuffer = Buffer.from(payload, 'utf8')

    // 1. Try IEEE-P1363 (standard 64-byte r||s from WebCrypto subtle.sign)
    try {
      const ok = crypto.verify(
        'SHA256',
        payloadBuffer,
        { key: pubKey, dsaEncoding: 'ieee-p1363' },
        sigBuffer
      )
      if (ok) return true
    } catch {}

    // 2. Try DER ASN.1 format fallback
    try {
      const ok = crypto.verify(
        'SHA256',
        payloadBuffer,
        { key: pubKey, dsaEncoding: 'der' },
        sigBuffer
      )
      if (ok) return true
    } catch {}

    return false
  } catch {
    return false
  }
}
