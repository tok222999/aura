/**
 * Deterministic recovery authority for the BIP-39 vault phrase.
 *
 * The browser-specific ECDSA key remains the normal short-lived signing
 * authority. This second key is derived deterministically from the recovery
 * phrase and is used only to authenticate a recovery-time key rotation.
 */

import { deriveBip39SeedAsync, sha256Sync } from './bip39'

const P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff')
const A = P - 3n
const B = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b')
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')
const GX = BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')
const GY = BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5')

interface Point {
  x: bigint
  y: bigint
}

const GENERATOR: Point = { x: GX, y: GY }

function mod(value: bigint, modulus = P): bigint {
  const result = value % modulus
  return result >= 0n ? result : result + modulus
}

function modPow(base: bigint, exponent: bigint, modulus = P): bigint {
  let result = 1n
  let current = mod(base, modulus)
  let remaining = exponent
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * current) % modulus
    current = (current * current) % modulus
    remaining >>= 1n
  }
  return result
}

function modInverse(value: bigint, modulus = P): bigint {
  if (mod(value, modulus) === 0n) throw new Error('Cannot invert zero.')
  return modPow(value, modulus - 2n, modulus)
}

function addPoints(left: Point | null, right: Point | null): Point | null {
  if (!left) return right
  if (!right) return left
  if (left.x === right.x && mod(left.y + right.y) === 0n) return null

  const slope = left.x === right.x
    ? mod((3n * left.x * left.x + A) * modInverse(2n * left.y))
    : mod((right.y - left.y) * modInverse(right.x - left.x))
  const x = mod(slope * slope - left.x - right.x)
  const y = mod(slope * (left.x - x) - left.y)
  return { x, y }
}

function multiplyPoint(point: Point, scalar: bigint): Point {
  let result: Point | null = null
  let current: Point | null = point
  let remaining = scalar
  while (remaining > 0n) {
    if (remaining & 1n) result = addPoints(result, current)
    current = addPoints(current, current)
    remaining >>= 1n
  }
  if (!result) throw new Error('Invalid recovery signing scalar.')
  return result
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function bigintToBytes(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0')
  return new Uint8Array(hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function buildP256Spki(publicPoint: Point): string {
  const prefix = Uint8Array.from([
    0x30, 0x59,
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    0x03, 0x42, 0x00, 0x04,
  ])
  return bytesToHex(concatBytes(prefix, bigintToBytes(publicPoint.x), bigintToBytes(publicPoint.y)))
}

export interface RecoveryAuthority {
  publicKeySpkiHex: string
  sign: (payload: string) => Promise<string>
}

/** Derive a stable P-256 recovery authority without transmitting the phrase. */
export async function deriveRecoveryAuthority(words: string[]): Promise<RecoveryAuthority> {
  const seed = await deriveBip39SeedAsync(words)
  const scalarBytes = sha256Sync(concatBytes(seed, new TextEncoder().encode('aura-recovery-authority-v1')))
  let scalar = BigInt(`0x${bytesToHex(scalarBytes)}`) % N
  if (scalar === 0n) scalar = 1n

  const publicPoint = multiplyPoint(GENERATOR, scalar)
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: base64Url(bigintToBytes(publicPoint.x)),
      y: base64Url(bigintToBytes(publicPoint.y)),
      d: base64Url(bigintToBytes(scalar)),
      ext: false,
      key_ops: ['sign'],
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )

  return {
    publicKeySpkiHex: buildP256Spki(publicPoint),
    sign: async (payload: string) => {
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        privateKey,
        new TextEncoder().encode(payload),
      )
      return `sig_0x${bytesToHex(new Uint8Array(signature))}`
    },
  }
}
