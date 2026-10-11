/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 *
 * BIP-39 Standard Cryptographic Mnemonic Implementation
 *
 * Provides production-grade BIP-39 compliant mnemonic generation and validation:
 * - 128-bit cryptographically secure entropy via Web Crypto (crypto.getRandomValues)
 * - SHA-256 checksum computation (4 bits)
 * - 12-word mnemonic derivation from the official 2048-word English dictionary
 * - Full mnemonic validation and key fingerprint derivation
 */

import BIP39_WORDLIST_RAW from './bip39-words.json'

// Official 2048-word BIP-39 English Wordlist
export const BIP39_WORDLIST: readonly string[] = BIP39_WORDLIST_RAW as readonly string[]

/**
 * Pure TypeScript SHA-256 implementation so it runs synchronously and deterministically
 * across both Node.js (backend) and browser (frontend Web Crypto fallback) environments.
 */
export function sha256Sync(bytes: Uint8Array): Uint8Array {
  // Constants
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19

  const len = bytes.length
  const bitLen = len * 8
  const padLen = (len % 64 < 56) ? (56 - (len % 64)) : (120 - (len % 64))
  const totalLen = len + padLen + 8
  const padded = new Uint8Array(totalLen)
  padded.set(bytes)
  padded[len] = 0x80

  // 64-bit length big-endian
  const view = new DataView(padded.buffer)
  view.setUint32(totalLen - 4, bitLen, false)

  const w = new Int32Array(64)
  for (let i = 0; i < totalLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getInt32(i + j * 4, false)
    }
    for (let j = 16; j < 64; j++) {
      const s0 = (rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3))
      const s1 = (rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10))
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7

    for (let j = 0; j < 64; j++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25))
      const ch = ((e & f) ^ (~e & g))
      const temp1 = (h + S1 + ch + K[j] + w[j]) | 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22))
      const maj = ((a & b) ^ (a & c) ^ (b & c))
      const temp2 = (S0 + maj) | 0

      h = g; g = f; f = e; e = (d + temp1) | 0
      d = c; c = b; b = a; a = (temp1 + temp2) | 0
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0, false); outView.setUint32(4, h1, false)
  outView.setUint32(8, h2, false); outView.setUint32(12, h3, false)
  outView.setUint32(16, h4, false); outView.setUint32(20, h5, false)
  outView.setUint32(24, h6, false); outView.setUint32(28, h7, false)
  return out
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/**
 * Synchronous HMAC-SHA256 implementation adhering to RFC 2104.
 */
export function hmacSha256Sync(key: Uint8Array, message: Uint8Array): Uint8Array {
  const BLOCK_SIZE = 64
  const k = new Uint8Array(BLOCK_SIZE)

  if (key.length > BLOCK_SIZE) {
    const hashedKey = sha256Sync(key)
    k.set(hashedKey)
  } else {
    k.set(key)
  }

  const ipad = new Uint8Array(BLOCK_SIZE)
  const opad = new Uint8Array(BLOCK_SIZE)

  for (let i = 0; i < BLOCK_SIZE; i++) {
    ipad[i] = k[i] ^ 0x36
    opad[i] = k[i] ^ 0x5c
  }

  const innerPayload = new Uint8Array(BLOCK_SIZE + message.length)
  innerPayload.set(ipad, 0)
  innerPayload.set(message, BLOCK_SIZE)
  const innerHash = sha256Sync(innerPayload)

  const outerPayload = new Uint8Array(BLOCK_SIZE + 32)
  outerPayload.set(opad, 0)
  outerPayload.set(innerHash, BLOCK_SIZE)
  return sha256Sync(outerPayload)
}

/**
 * Generates a genuine BIP-39 12-word mnemonic from cryptographically secure entropy.
 */
export function generateBip39Mnemonic(): string[] {
  // 128 bits = 16 bytes of cryptographically secure random entropy
  const entropy = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(entropy)
  } else {
    // Node.js fallback
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto')
    const buf = nodeCrypto.randomBytes(16)
    entropy.set(buf)
  }

  // 1. Calculate SHA-256 hash of the entropy
  const hash = sha256Sync(entropy)

  // 2. First 4 bits of hash is the checksum (for 128-bit entropy: 128 / 32 = 4 bits)
  const checksumByte = hash[0]
  const checksumBits = (checksumByte >> 4) & 0x0f

  // 3. Combine 128 bits + 4 bits into 132 bits total
  // We need 12 words of 11 bits each (12 * 11 = 132 bits)
  const bits: number[] = []
  for (let i = 0; i < 16; i++) {
    for (let b = 7; b >= 0; b--) {
      bits.push((entropy[i] >> b) & 1)
    }
  }
  for (let b = 3; b >= 0; b--) {
    bits.push((checksumBits >> b) & 1)
  }

  // 4. Extract 12 indices (each 11 bits) and map to BIP-39 wordlist
  const words: string[] = []
  for (let w = 0; w < 12; w++) {
    let index = 0
    for (let bit = 0; bit < 11; bit++) {
      index = (index << 1) | bits[w * 11 + bit]
    }
    words.push(BIP39_WORDLIST[index])
  }

  return words
}

/**
 * Validates whether a given word list is a genuine BIP-39 mnemonic with valid checksum.
 */
export function validateBip39Mnemonic(words: string[]): boolean {
  if (!words || words.length !== 12) return false

  // 1. Check all words exist in wordlist and retrieve indices
  const indices: number[] = []
  for (const w of words) {
    const clean = w.trim().toLowerCase()
    const idx = BIP39_WORDLIST.indexOf(clean)
    if (idx === -1) return false
    indices.push(idx)
  }

  // 2. Reconstruct 132 bits
  const bits: number[] = []
  for (const idx of indices) {
    for (let b = 10; b >= 0; b--) {
      bits.push((idx >> b) & 1)
    }
  }

  // 3. Extract 128 bits of entropy (16 bytes)
  const entropy = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    let byte = 0
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[i * 8 + b]
    }
    entropy[i] = byte
  }

  // 4. Extract 4-bit checksum
  let checksumExpected = 0
  for (let b = 0; b < 4; b++) {
    checksumExpected = (checksumExpected << 1) | bits[128 + b]
  }

  // 5. Compute SHA-256 and verify
  const hash = sha256Sync(entropy)
  const checksumCalculated = (hash[0] >> 4) & 0x0f

  return checksumExpected === checksumCalculated
}

/**
 * Derives a 512-bit (64-byte) seed from a BIP-39 mnemonic using PBKDF2 with HMAC-SHA512 (2048 iterations).
 */
export function deriveBip39SeedSync(mnemonic: string[], passphrase = ''): Uint8Array {
  const password = mnemonic.join(' ').normalize('NFKD')
  const salt = `mnemonic${passphrase}`.normalize('NFKD')

  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require('crypto')
      return new Uint8Array(nodeCrypto.pbkdf2Sync(password, salt, 2048, 64, 'sha512'))
    } catch (error) {
      throw new Error(`Could not derive the standard BIP-39 seed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error('Synchronous BIP-39 seed derivation is only available in Node.js; use deriveBip39SeedAsync in browsers.')
}

export async function deriveBip39SeedAsync(mnemonic: string[], passphrase = ''): Promise<Uint8Array> {
  const password = mnemonic.join(' ').normalize('NFKD')
  const salt = `mnemonic${passphrase}`.normalize('NFKD')
  const enc = new TextEncoder()

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
      )
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: enc.encode(salt),
          iterations: 2048,
          hash: 'SHA-512',
        },
        key,
        512
      )
      return new Uint8Array(bits)
    } catch (error) {
      if (typeof process !== 'undefined' && process.versions?.node) {
        return deriveBip39SeedSync(mnemonic, passphrase)
      }
      throw new Error(`Could not derive the standard BIP-39 seed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (typeof process === 'undefined' || !process.versions?.node) {
    throw new Error('WebCrypto PBKDF2 is unavailable; refusing non-standard recovery-key derivation.')
  }
  return deriveBip39SeedSync(mnemonic, passphrase)
}

/**
 * Keep the historical browser-only tenant fingerprint stable while deriving
 * actual BIP-39 seeds with the standard PBKDF2-SHA512 implementation above.
 * This value is only an account namespace, never a spendable chain key.
 */
function deriveTenantIdentitySeed(mnemonic: string[]): Uint8Array {
  const password = mnemonic.join(' ')
  const salt = 'mnemonic'
  const enc = new TextEncoder()
  let block = enc.encode(`${password}:${salt}`)
  for (let i = 0; i < 2048; i++) block = sha256Sync(block)
  const seed = new Uint8Array(64)
  seed.set(block, 0)
  seed.set(sha256Sync(new Uint8Array([...block, 0x01])), 32)
  return seed
}

/**
 * Derives the client-side vault identifier from a recovery phrase.
 * This identifier is not a Zcash address or a spendable chain key.
 */
export function deriveClientVaultKeys(mnemonic: string[]): {
  fingerprint: string
  commitmentKeyHex: string
} {
  const seedBytes = deriveTenantIdentitySeed(mnemonic)
  const masterHash = sha256Sync(seedBytes)
  const hex = Array.from(masterHash).map(b => b.toString(16).padStart(2, '0')).join('')

  const fingerprint = `vault_${hex.substring(0, 8)}...${hex.substring(24, 28)}`
  
  const commitmentKeyHex = hex

  return { fingerprint, commitmentKeyHex }
}

/**
 * New tenant namespace derived from the recovery authority itself. Unlike the
 * legacy phrase fingerprint, the server can verify this commitment from the
 * recovery public key and reject first-use tenant squatting.
 */
export function deriveRecoveryTenantIdFromSpki(publicKeySpkiHex: string): string {
  const hex = hashRecoveryPublicKey(publicKeySpkiHex)
  // New recovery-bound identities use 128 bits of the hash. The full hash is
  // retained below for migration/debugging without making the identifier
  // unwieldy in the UI.
  return `vault_r_${hex.substring(0, 32)}`
}

/** Historical 48-bit namespace retained only for recovery migration. */
export function deriveLegacyRecoveryTenantIdFromSpki(publicKeySpkiHex: string): string {
  const hex = hashRecoveryPublicKey(publicKeySpkiHex)
  return `vault_r_${hex.substring(0, 8)}...${hex.substring(24, 28)}`
}

function hashRecoveryPublicKey(publicKeySpkiHex: string): string {
  const clean = publicKeySpkiHex.replace(/^0x/i, '').trim()
  if (!/^[a-f0-9]+$/i.test(clean) || clean.length % 2 !== 0) {
    throw new Error('Invalid recovery public key encoding.')
  }
  const bytes = new Uint8Array(clean.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)))
  const hash = sha256Sync(bytes)
  return Array.from(hash).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
