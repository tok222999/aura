import crypto from 'crypto'
import { broadcastRpcJson, fetchRpcResultAcrossPool, uniqueRpcUrls } from '@/lib/services/rpc-fallback'
import { persistentStore } from '@/lib/services/persistent-store'

const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export function createBaseDepositProofMessage(input: {
  tenantId: string
  amountUsd: number
  amountOnChain: number
  asset: string
  chain: string
  txHash: string
  senderAddress: string
}): string {
  return [
    'Aura Base deposit authorization v1',
    `Tenant: ${input.tenantId}`,
    `Transaction: ${input.txHash.toLowerCase()}`,
    `Sender: ${input.senderAddress.toLowerCase()}`,
    `Amount (USD): ${input.amountUsd.toFixed(2)}`,
    `Amount (on-chain): ${input.amountOnChain}`,
    `Asset: ${input.asset}`,
    `Network: ${input.chain}`,
  ].join('\n')
}

export function summarizeErc20VaultTransfers(
  logs: Array<{ address?: string; topics?: string[]; data?: string }>,
  tokenContract: string,
  vaultAddress: string
): { amountUnits: bigint; sender?: string; mixedSenders: boolean; matchingLogCount: number } {
  const cleanVault = vaultAddress.toLowerCase().replace(/^0x/, '')
  const cleanToken = tokenContract.toLowerCase()
  let amountUnits = 0n
  let sender: string | undefined
  let mixedSenders = false
  let matchingLogCount = 0

  for (const log of logs) {
    if (
      log.address?.toLowerCase() !== cleanToken ||
      log.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC ||
      !log.topics[1] ||
      !log.topics[2]?.toLowerCase().endsWith(cleanVault)
    ) continue

    const topicSender = log.topics[1]
    if (!/^(?:0x)?[a-f0-9]{64}$/i.test(topicSender)) continue
    const currentSender = `0x${topicSender.slice(-40)}`.toLowerCase()
    const currentAmount = log.data && log.data !== '0x' ? BigInt(log.data) : 0n
    matchingLogCount++
    amountUnits += currentAmount
    if (sender && sender !== currentSender) mixedSenders = true
    sender ||= currentSender
  }

  return { amountUnits, sender, mixedSenders, matchingLogCount }
}

/**
 * Pure TypeScript Keccak-256 implementation (Ethereum standard)
 * Standard keccak-f[1600] permutation without external dependencies.
 */
const ROUND_CONSTANTS = [
  BigInt('0x0000000000000001'), BigInt('0x0000000000008082'), BigInt('0x800000000000808a'), BigInt('0x8000000080008000'),
  BigInt('0x000000000000808b'), BigInt('0x0000000080000001'), BigInt('0x8000000080008081'), BigInt('0x8000000000008009'),
  BigInt('0x000000000000008a'), BigInt('0x0000000000000088'), BigInt('0x0000000080008009'), BigInt('0x000000008000000a'),
  BigInt('0x000000008000808b'), BigInt('0x800000000000008b'), BigInt('0x8000000000008089'), BigInt('0x8000000000008003'),
  BigInt('0x8000000000008002'), BigInt('0x8000000000000080'), BigInt('0x000000000000800a'), BigInt('0x800000008000000a'),
  BigInt('0x8000000080008081'), BigInt('0x8000000000008080'), BigInt('0x0000000080000001'), BigInt('0x8000000080008008'),
]

const ROTATION_OFFSETS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
]

function rotl64(x: bigint, n: number): bigint {
  const shift = BigInt(n % 64)
  const mask = BigInt('0xffffffffffffffff')
  return ((x << shift) | (x >> (BigInt(64) - shift))) & mask
}

export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136 // 1088 bits / 8 for keccak-256
  const stateU = new Array<bigint>(25).fill(BigInt(0))

  // Padding: Keccak-256 uses 0x01 padding (unlike SHA3-256 which uses 0x06)
  const len = data.length
  const padLen = rate - (len % rate)
  const padded = new Uint8Array(len + padLen)
  padded.set(data, 0)
  padded[len] = 0x01
  padded[padded.length - 1] |= 0x80

  // Absorb phase
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      const idx = offset + i * 8
      let lane = BigInt(0)
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[idx + b]) << BigInt(b * 8)
      }
      stateU[i] ^= lane
    }

    // Permutation
    for (let round = 0; round < 24; round++) {
      // Theta
      const C = new Array<bigint>(5)
      for (let x = 0; x < 5; x++) {
        C[x] = stateU[x] ^ stateU[x + 5] ^ stateU[x + 10] ^ stateU[x + 15] ^ stateU[x + 20]
      }
      const D = new Array<bigint>(5)
      for (let x = 0; x < 5; x++) {
        D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1)
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          stateU[x + y * 5] ^= D[x]
        }
      }

      // Rho and Pi
      const B = new Array<bigint>(25)
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          B[y + ((2 * x + 3 * y) % 5) * 5] = rotl64(stateU[x + y * 5], ROTATION_OFFSETS[x][y])
        }
      }

      // Chi
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          stateU[x + y * 5] = B[x + y * 5] ^ (~B[((x + 1) % 5) + y * 5] & B[((x + 2) % 5) + y * 5])
        }
      }

      // Iota
      stateU[0] ^= ROUND_CONSTANTS[round]
    }
  }

  // Squeeze 32 bytes
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    const lane = stateU[i]
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number((lane >> BigInt(b * 8)) & BigInt(0xff))
    }
  }
  return out
}

export function keccak256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' 
    ? (data.startsWith('0x') ? Buffer.from(data.slice(2), 'hex') : Buffer.from(data, 'utf8'))
    : data
  const hash = keccak256(bytes)
  return '0x' + Buffer.from(hash).toString('hex')
}

const SECP256K1_P = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f')
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const SECP256K1_G = {
  x: BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
  y: BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'),
}
type SecpPoint = { x: bigint; y: bigint } | null

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus
  return result < 0n ? result + modulus : result
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = mod(base, modulus)
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power >>= 1n
  }
  return result
}

function modInverse(value: bigint, modulus: bigint): bigint {
  let a = mod(value, modulus)
  let b = modulus
  let x = 1n
  let y = 0n
  while (b !== 0n) {
    const quotient = a / b
    ;[a, b] = [b, a % b]
    ;[x, y] = [y, x - quotient * y]
  }
  if (a !== 1n) throw new Error('Value has no modular inverse')
  return mod(x, modulus)
}

function pointAdd(left: SecpPoint, right: SecpPoint): SecpPoint {
  if (!left) return right
  if (!right) return left
  if (left.x === right.x && mod(left.y + right.y, SECP256K1_P) === 0n) return null
  const slope = left.x === right.x && left.y === right.y
    ? mod(3n * left.x * left.x * modInverse(2n * left.y, SECP256K1_P), SECP256K1_P)
    : mod((right.y - left.y) * modInverse(right.x - left.x, SECP256K1_P), SECP256K1_P)
  const x = mod(slope * slope - left.x - right.x, SECP256K1_P)
  return { x, y: mod(slope * (left.x - x) - left.y, SECP256K1_P) }
}

function pointMultiply(point: SecpPoint, scalar: bigint): SecpPoint {
  let result: SecpPoint = null
  let addend = point
  let value = mod(scalar, SECP256K1_N)
  while (value > 0n) {
    if (value & 1n) result = pointAdd(result, addend)
    addend = pointAdd(addend, addend)
    value >>= 1n
  }
  return result
}

function bigInt32(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex')
}

/** Recover the signer of an Ethereum personal_sign message (65-byte r||s||v). */
export function recoverPersonalSignAddress(message: string, signature: string): string | null {
  try {
    const cleanSignature = signature.replace(/^0x/, '')
    if (!/^[0-9a-f]{130}$/i.test(cleanSignature)) return null
    const bytes = Buffer.from(cleanSignature, 'hex')
    const r = BigInt(`0x${bytes.subarray(0, 32).toString('hex')}`)
    const s = BigInt(`0x${bytes.subarray(32, 64).toString('hex')}`)
    let recovery = bytes[64]
    if (recovery >= 27) recovery -= 27
    if ((recovery !== 0 && recovery !== 1) || r <= 0n || r >= SECP256K1_N || s <= 0n || s >= SECP256K1_N) return null

    const messageBytes = Buffer.from(message, 'utf8')
    const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${messageBytes.length}`, 'utf8')
    const digest = keccak256(Buffer.concat([prefix, messageBytes]))
    const z = BigInt(`0x${Buffer.from(digest).toString('hex')}`)
    const x = r
    if (x >= SECP256K1_P) return null
    const alpha = mod(x * x * x + 7n, SECP256K1_P)
    let y = modPow(alpha, (SECP256K1_P + 1n) / 4n, SECP256K1_P)
    if (mod(y * y, SECP256K1_P) !== alpha) return null
    if (Number(y & 1n) !== recovery) y = SECP256K1_P - y
    const pointR: SecpPoint = { x, y }
    if (pointMultiply(pointR, SECP256K1_N) !== null) return null

    const inverseR = modInverse(r, SECP256K1_N)
    const publicKey = pointMultiply(
      pointAdd(pointMultiply(pointR, s), pointMultiply(SECP256K1_G, -z)),
      inverseR
    )
    if (!publicKey) return null
    const publicKeyBytes = Buffer.concat([bigInt32(publicKey.x), bigInt32(publicKey.y)])
    const addressHash = keccak256(publicKeyBytes)
    return `0x${Buffer.from(addressHash).subarray(12).toString('hex')}`
  } catch {
    return null
  }
}

/** Returns the EIP-191 digest that a wallet signs for `personal_sign`. */
export function personalSignDigest(message: string): string {
  const messageBytes = Buffer.from(message, 'utf8')
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${messageBytes.length}`, 'utf8')
  return keccak256Hex(Buffer.concat([prefix, messageBytes]))
}

function encodeEip1271Bytes32Call(digest: string, signature: string): string | null {
  const cleanSignature = signature.replace(/^0x/, '')
  if (!/^([0-9a-f]{2})+$/i.test(cleanSignature)) return null
  const signatureBytes = Buffer.from(cleanSignature, 'hex')
  const paddedLength = Math.ceil(signatureBytes.length / 32) * 64
  const signatureHex = signatureBytes.toString('hex').padEnd(paddedLength, '0')
  return `0x1626ba7e${digest.replace(/^0x/, '').padStart(64, '0')}${'40'.padStart(64, '0')}${signatureBytes.length.toString(16).padStart(64, '0')}${signatureHex}`
}

function encodeEip1271BytesCall(message: string, signature: string): string | null {
  const cleanSignature = signature.replace(/^0x/, '')
  if (!/^([0-9a-f]{2})+$/i.test(cleanSignature)) return null
  const messageBytes = Buffer.from(message, 'utf8')
  const signatureBytes = Buffer.from(cleanSignature, 'hex')
  const messagePadded = messageBytes.toString('hex').padEnd(Math.ceil(messageBytes.length / 32) * 64, '0')
  const signaturePadded = signatureBytes.toString('hex').padEnd(Math.ceil(signatureBytes.length / 32) * 64, '0')
  const signatureOffset = 64 + 32 + Math.ceil(messageBytes.length / 32) * 32
  return `0x20c13b0b${'40'.padStart(64, '0')}${signatureOffset.toString(16).padStart(64, '0')}${messageBytes.length.toString(16).padStart(64, '0')}${messagePadded}${signatureBytes.length.toString(16).padStart(64, '0')}${signaturePadded}`
}

/**
 * Derives uncompressed public key (64 bytes: x, y) from 32-byte secp256k1 private key
 */
export function deriveSecp256k1PublicKey(privateKeyHex: string): Buffer {
  const cleanKey = privateKeyHex.replace(/^0x/, '')
  const sec1Header = Buffer.from('302e0201010420', 'hex')
  const sec1Footer = Buffer.from('a00706052b8104000a', 'hex')
  const der = Buffer.concat([sec1Header, Buffer.from(cleanKey, 'hex'), sec1Footer])

  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'sec1' })
  const pub = crypto.createPublicKey(priv)
  const spki = pub.export({ format: 'der', type: 'spki' })

  // Uncompressed 65-byte point is at the end of secp256k1 SPKI (starts with 0x04)
  const point = spki.subarray(spki.length - 65)
  return point.subarray(1) // Return 64 bytes (x + y) without 0x04 prefix
}

/**
 * Derives 0x-prefixed 40-character Ethereum address from private key
 */
export function deriveEvmAddress(privateKeyHex: string): string {
  const pubKeyBytes = deriveSecp256k1PublicKey(privateKeyHex)
  const hash = keccak256(pubKeyBytes)
  const addressBytes = hash.subarray(12, 32)
  return '0x' + Buffer.from(addressBytes).toString('hex').toLowerCase()
}

export function isBaseSepoliaChainId(chainId: unknown): boolean {
  if (typeof chainId !== 'string' || !/^0x[0-9a-f]+$/i.test(chainId)) return false
  try {
    return BigInt(chainId) === 84532n
  } catch {
    return false
  }
}

export type BaseBroadcastIntent = {
  txHash: string
  nonce: string
  senderAddress: string
}

export type BaseReceiptFinality = {
  confirmed: boolean
  confirmations: number
  confirmationStatus?: 'safe' | 'finalized'
  blockNumber?: number
  blockHash?: string
  blockTimestampMs?: number
  error?: string
}

export type BaseUsdcTransferCandidate = {
  txHash: string
  blockNumber: number
  logIndex: number
  amountUnits: bigint
}

/**
 * RLP encoding helper for Ethereum transactions
 */
function rlpEncodeItem(input: Uint8Array | number | bigint | string): Uint8Array {
  let bytes: Uint8Array
  if (typeof input === 'number' || typeof input === 'bigint') {
    if (input === 0 || input === BigInt(0)) {
      return new Uint8Array([0x80])
    }
    let hex = BigInt(input).toString(16)
    if (hex.length % 2 !== 0) hex = '0' + hex
    bytes = Buffer.from(hex, 'hex')
  } else if (typeof input === 'string') {
    if (input.startsWith('0x')) {
      const clean = input.slice(2)
      bytes = clean.length === 0 ? new Uint8Array(0) : Buffer.from(clean.length % 2 ? '0' + clean : clean, 'hex')
    } else {
      bytes = Buffer.from(input, 'utf8')
    }
  } else {
    bytes = input
  }

  if (bytes.length === 1 && bytes[0] < 0x80) {
    return bytes
  } else if (bytes.length <= 55) {
    const res = new Uint8Array(1 + bytes.length)
    res[0] = 0x80 + bytes.length
    res.set(bytes, 1)
    return res
  } else {
    let lenHex = bytes.length.toString(16)
    if (lenHex.length % 2 !== 0) lenHex = '0' + lenHex
    const lenBytes = Buffer.from(lenHex, 'hex')
    const res = new Uint8Array(1 + lenBytes.length + bytes.length)
    res[0] = 0xb7 + lenBytes.length
    res.set(lenBytes, 1)
    res.set(bytes, 1 + lenBytes.length)
    return res
  }
}

export function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let totalLength = 0
  for (const item of items) totalLength += item.length

  let prefix: Uint8Array
  if (totalLength <= 55) {
    prefix = new Uint8Array([0xc0 + totalLength])
  } else {
    let lenHex = totalLength.toString(16)
    if (lenHex.length % 2 !== 0) lenHex = '0' + lenHex
    const lenBytes = Buffer.from(lenHex, 'hex')
    prefix = new Uint8Array(1 + lenBytes.length)
    prefix[0] = 0xf7 + lenBytes.length
    prefix.set(lenBytes, 1)
  }

  const res = new Uint8Array(prefix.length + totalLength)
  res.set(prefix, 0)
  let offset = prefix.length
  for (const item of items) {
    res.set(item, offset)
    offset += item.length
  }
  return res
}

export class BaseRelayerService {
  private rpcUrl: string
  private privateKeyHex: string
  private chainId: number
  private usdcContract: string
  private sendQueue: Promise<void> = Promise.resolve()
  private rpcReadUrls: string[]

  constructor() {
    this.rpcUrl = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org'
    const rawKey = process.env.DEMO_WALLET_BASE_PRIVATE_KEY || ''
    this.privateKeyHex = this.isValidPrivateKey(rawKey) ? rawKey : ''
    this.chainId = 84532 // Base Sepolia Chain ID
    this.usdcContract = process.env.BASE_SEPOLIA_USDC_CONTRACT || '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
    this.rpcReadUrls = uniqueRpcUrls(this.rpcUrl, [
      ...(process.env.BASE_SEPOLIA_RPC_FALLBACKS || '').split(','),
      'https://base-sepolia-rpc.publicnode.com',
      'https://sepolia.base.org',
    ])
  }

  private isValidPrivateKey(key: string): boolean {
    const clean = key.replace(/^0x/, '').trim()
    return clean.length === 64 && /^[0-9a-fA-F]{64}$/.test(clean) && !/^0+$/.test(clean)
  }

  public hasConfiguredKey(): boolean {
    return Boolean(this.privateKeyHex && this.privateKeyHex.replace(/^0x/, '').length === 64)
  }

  public async getRpcChainId(): Promise<string | null> {
    try {
      const { result } = await fetchRpcResultAcrossPool<unknown>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [],
      }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))
      return typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result)
        ? result
        : null
    } catch {
      return null
    }
  }

  /**
   * Verifies either an EOA personal signature or an ERC-1271 contract-wallet
   * signature. This keeps Safe/multisig senders compatible with the same
   * human-readable authorization message used by EOA wallets.
   */
  public async verifyWalletSignature(address: string, message: string, signature: string): Promise<boolean> {
    const canonicalAddress = address.trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(canonicalAddress) || !message || !signature) return false
    const recovered = recoverPersonalSignAddress(message, signature)
    if (recovered?.toLowerCase() === canonicalAddress) return true

    const digest = personalSignDigest(message)
    const calls = [
      encodeEip1271Bytes32Call(digest, signature),
      encodeEip1271BytesCall(message, signature),
    ].filter((value): value is string => Boolean(value))
    for (const data of calls) {
      try {
        const { result } = await fetchRpcResultAcrossPool<string>(this.rpcReadUrls, {
          jsonrpc: '2.0', id: 12, method: 'eth_call', params: [{ to: canonicalAddress, data }, 'latest'],
        }, 5000, (value) => typeof value === 'string')
        if (typeof result === 'string' && result.toLowerCase().startsWith('0x1626ba7e')) return true
      } catch {
        // Try the alternate ERC-1271 ABI or the next configured RPC.
      }
    }
    return false
  }

  /** Reads the current Base block height for durable invoice recovery. */
  public async getLatestBlockNumber(): Promise<number> {
    const { result } = await fetchRpcResultAcrossPool<unknown>(this.rpcReadUrls, {
      jsonrpc: '2.0', id: 11, method: 'eth_blockNumber', params: [],
    }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))
    if (typeof result !== 'string') throw new Error('BASE_BLOCK_NUMBER_UNAVAILABLE')
    const blockNumber = Number(BigInt(result))
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('BASE_BLOCK_NUMBER_INVALID')
    return blockNumber
  }

  /**
   * Finds exact USDC transfers from a signed payer to the shared vault in a
   * bounded invoice window. The caller still verifies the receipt, canonical
   * block and finality before crediting anything.
   */
  public async findUsdcTransferCandidates(input: {
    fromBlock: number
    toBlock?: number
    senderAddress: string
    vaultAddress: string
    amountUnits: bigint
  }): Promise<BaseUsdcTransferCandidate[]> {
    const sender = input.senderAddress.toLowerCase()
    const vault = input.vaultAddress.toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(sender) || !/^0x[a-f0-9]{40}$/.test(vault) ||
      !Number.isSafeInteger(input.fromBlock) || input.fromBlock < 0 || input.amountUnits <= 0n) {
      throw new Error('INVALID_USDC_RECOVERY_QUERY')
    }

    const latest = await this.getLatestBlockNumber()
    const requestedTo = input.toBlock === undefined ? latest : input.toBlock
    if (!Number.isSafeInteger(requestedTo) || requestedTo < input.fromBlock) return []
    const toBlock = Math.min(latest, requestedTo)
    const configuredChunk = Number.parseInt(process.env.BASE_RECOVERY_LOG_CHUNK || '5000', 10)
    const chunkSize = Number.isSafeInteger(configuredChunk) && configuredChunk >= 100 && configuredChunk <= 10_000
      ? configuredChunk
      : 5000
    const senderTopic = `0x${sender.slice(2).padStart(64, '0')}`
    const vaultTopic = `0x${vault.slice(2).padStart(64, '0')}`
    const candidates = new Map<string, BaseUsdcTransferCandidate>()

    for (let fromBlock = input.fromBlock; fromBlock <= toBlock; fromBlock += chunkSize) {
      const chunkEnd = Math.min(toBlock, fromBlock + chunkSize - 1)
      const { result: logs } = await fetchRpcResultAcrossPool<any[]>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 12, method: 'eth_getLogs',
        params: [{
          address: this.usdcContract,
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${chunkEnd.toString(16)}`,
          topics: [ERC20_TRANSFER_TOPIC, senderTopic, vaultTopic],
        }],
      }, 8000, (value) => Array.isArray(value))

      for (const log of logs || []) {
        const txHash = String(log?.transactionHash || '').toLowerCase()
        const blockHex = String(log?.blockNumber || '')
        const indexHex = String(log?.logIndex || '')
        if (!/^0x[0-9a-f]{64}$/.test(txHash) || !/^0x[0-9a-f]+$/i.test(blockHex) || !/^0x[0-9a-f]+$/i.test(indexHex)) continue
        if (String(log?.address || '').toLowerCase() !== this.usdcContract.toLowerCase()) continue
        if (String(log?.topics?.[0] || '').toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
        if (String(log?.topics?.[1] || '').toLowerCase() !== senderTopic.toLowerCase() ||
          String(log?.topics?.[2] || '').toLowerCase() !== vaultTopic.toLowerCase()) continue
        let amountUnits: bigint
        try { amountUnits = BigInt(String(log?.data || '0x0')) } catch { continue }
        if (amountUnits !== input.amountUnits) continue
        const blockNumber = Number(BigInt(blockHex))
        const logIndex = Number(BigInt(indexHex))
        if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(logIndex)) continue
        candidates.set(`${txHash}:${logIndex}`, { txHash, blockNumber, logIndex, amountUnits })
      }
    }

    return [...candidates.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  }

  public async isBaseSepoliaRpcReady(): Promise<boolean> {
    return isBaseSepoliaChainId(await this.getRpcChainId())
  }

  public getAddress(): string {
    if (!this.privateKeyHex) {
      return process.env.DEMO_WALLET_ADDRESS || '0x9CAF6275fe5e9F833818D1a76A09d9c067C19033'
    }
    try {
      return deriveEvmAddress(this.privateKeyHex)
    } catch {
      return process.env.DEMO_WALLET_ADDRESS || '0x9CAF6275fe5e9F833818D1a76A09d9c067C19033'
    }
  }

  public async getBalances(): Promise<{ ethBalance: number; usdcBalance: number }> {
    const address = this.getAddress()
    try {
      // 1. ETH Balance
      const { result: rawEth } = await fetchRpcResultAcrossPool<unknown>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'],
      }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))
      if (typeof rawEth !== 'string' || !/^0x[0-9a-f]+$/i.test(rawEth)) {
        throw new Error('Base RPC did not return a valid ETH balance.')
      }
      const ethBalance = Number((Number(BigInt(rawEth)) / 1e18).toFixed(4))

      // 2. USDC Balance (balanceOf)
      const cleanAddr = address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
      const callData = `0x70a08231${cleanAddr}`
      const { result: rawUsdc } = await fetchRpcResultAcrossPool<unknown>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: this.usdcContract, data: callData }, 'latest'],
      }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))
      if (typeof rawUsdc !== 'string' || !/^0x[0-9a-f]+$/i.test(rawUsdc)) {
        throw new Error('Base RPC did not return a valid USDC balance.')
      }
      const usdcUnits = BigInt(rawUsdc !== '0x' ? rawUsdc : '0x0')
      const usdcBalance = Number((Number(usdcUnits) / 1e6).toFixed(2))

      return { ethBalance, usdcBalance }
    } catch (error) {
      // An RPC failure is not evidence of funds. Propagate UNKNOWN to callers
      // instead of turning an unavailable balance into a misleading zero.
      throw error
    }
  }

  /**
   * Broadcasts a real on-chain ERC-20 USDC transfer on Base Sepolia
   * If ETH gas is 0, returns informative INSUFFICIENT_GAS status with faucet link.
   */
  public sendUsdc(
    toAddress: string,
    amount: number,
    beforeBroadcast?: (intent: BaseBroadcastIntent) => void | Promise<void>
  ): Promise<{
    success: boolean
    txHash?: string
    error?: string
    message?: string
    explorerUrl?: string
    insufficientGas?: boolean
    broadcastUncertain?: boolean
  }> {
    const pending = this.sendQueue.then(() => persistentStore.withExternalBroadcastLock(
      () => this.sendUsdcSerial(toAddress, amount, beforeBroadcast),
    ))
    this.sendQueue = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async sendUsdcSerial(
    toAddress: string,
    amount: number,
    beforeBroadcast?: (intent: BaseBroadcastIntent) => void | Promise<void>
  ): Promise<{
    success: boolean
    txHash?: string
    error?: string
    message?: string
    explorerUrl?: string
    insufficientGas?: boolean
    broadcastUncertain?: boolean
  }> {
    if (!this.privateKeyHex) {
      return {
        success: false,
        error: 'NO_PRIVATE_KEY',
        message: 'Base relayer private key (DEMO_WALLET_BASE_PRIVATE_KEY) is not configured.',
      }
    }

    const rpcChainId = await this.getRpcChainId()
    if (!rpcChainId) {
      return { success: false, error: 'BASE_RPC_UNAVAILABLE', message: 'Base Sepolia RPC is unavailable; no payout was sent.' }
    }
    if (!isBaseSepoliaChainId(rpcChainId)) {
      return { success: false, error: 'WRONG_SOURCE_CHAIN', message: 'Configured Base RPC is not connected to Base Sepolia; no payout was sent.' }
    }

    if (!/^0x[a-f0-9]{40}$/i.test(toAddress)) {
      return { success: false, error: 'INVALID_RECIPIENT_ADDRESS' }
    }
    if (!/^0x[a-f0-9]{40}$/i.test(this.usdcContract)) {
      return { success: false, error: 'INVALID_USDC_CONTRACT' }
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return { success: false, error: 'INVALID_USDC_AMOUNT' }
    }
    const units = BigInt(Math.round(amount * 1e6))
    if (units <= 0n) return { success: false, error: 'USDC_AMOUNT_TOO_SMALL' }

    const fromAddr = this.getAddress()
    const { ethBalance, usdcBalance } = await this.getBalances()

    if (amount > usdcBalance) {
      return {
        success: false,
        error: 'INSUFFICIENT_USDC',
        message: `Requested ${amount} USDC exceeds demo wallet balance of ${usdcBalance} USDC.`,
      }
    }

    if (ethBalance < 0.00001) {
      return {
        success: false,
        error: 'INSUFFICIENT_GAS',
        insufficientGas: true,
        message: `Base Sepolia demo wallet (${fromAddr.slice(0, 8)}...) has 0 ETH for gas fee. Please request test ETH from Coinbase Faucet.`,
        explorerUrl: 'https://cloud.coinbase.com/faucets/base-ethereum-sepolia',
      }
    }

    let broadcastAttempted = false
    let candidateTxHash: string | undefined
    try {
      // 1. Fetch current nonce
      const { result: nonceResult } = await fetchRpcResultAcrossPool<unknown>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [fromAddr, 'pending'],
      }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))
      if (typeof nonceResult !== 'string' || !/^0x[0-9a-f]+$/i.test(nonceResult)) {
        return { success: false, error: 'Unable to read the Base Sepolia transaction nonce.' }
      }
      const nonce = BigInt(nonceResult)

      // 2. Fetch gas price
      const { result: gasPriceResult } = await fetchRpcResultAcrossPool<unknown>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 2, method: 'eth_gasPrice', params: [],
      }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))
      if (typeof gasPriceResult !== 'string' || !/^0x[0-9a-f]+$/i.test(gasPriceResult)) {
        return { success: false, error: 'Unable to read the Base Sepolia gas price.' }
      }
      const gasPrice = BigInt(gasPriceResult)

      // 3. ERC20 transfer calldata: 0xa9059cbb + address(32 bytes) + amount(32 bytes)
      const cleanTo = toAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')
      const cleanAmount = units.toString(16).padStart(64, '0')
      const dataHex = '0xa9059cbb' + cleanTo + cleanAmount
      const dataBytes = Buffer.from(dataHex.slice(2), 'hex')

      const gasLimit = BigInt(80000)

      // 4. EIP-155 Transaction signing structure
      const unsignedItems = [
        rlpEncodeItem(nonce),
        rlpEncodeItem(gasPrice),
        rlpEncodeItem(gasLimit),
        rlpEncodeItem(this.usdcContract),
        rlpEncodeItem(BigInt(0)),
        rlpEncodeItem(dataBytes),
        rlpEncodeItem(BigInt(this.chainId)),
        rlpEncodeItem(BigInt(0)),
        rlpEncodeItem(BigInt(0)),
      ]
      const txPayload = rlpEncodeList(unsignedItems)
      const txHashToSign = keccak256(txPayload)

      // 5. Sign with secp256k1
      // 5. Sign raw keccak256 digest directly with secp256k1 (RFC 6979)
      const d = BigInt('0x' + this.privateKeyHex.replace(/^0x/, ''))
      const z = BigInt('0x' + Buffer.from(txHashToSign).toString('hex'))
      let counter = 0
      let rBytes!: Buffer
      let sBytes!: Buffer
      let recId = 0
      while (true) {
        const hmac = crypto.createHmac('sha256', Buffer.from(this.privateKeyHex.replace(/^0x/, ''), 'hex'))
        hmac.update(Buffer.from(txHashToSign))
        hmac.update(Buffer.from([counter++]))
        const kCandidate = BigInt('0x' + hmac.digest('hex'))
        if (kCandidate <= 0n || kCandidate >= SECP256K1_N) continue
        const pt = pointMultiply(SECP256K1_G, kCandidate)
        if (!pt) continue
        const r = mod(pt.x, SECP256K1_N)
        if (r === 0n) continue
        let s = mod(modInverse(kCandidate, SECP256K1_N) * (z + r * d), SECP256K1_N)
        if (s === 0n) continue
        let recovery = Number(pt.y & 1n)
        if (s > SECP256K1_N / 2n) {
          s = SECP256K1_N - s
          recovery ^= 1
        }
        rBytes = Buffer.from(r.toString(16).padStart(64, '0'), 'hex')
        sBytes = Buffer.from(s.toString(16).padStart(64, '0'), 'hex')
        recId = recovery
        break
      }

      const v = BigInt(this.chainId * 2 + 35 + recId)
      const signedItems = [
        rlpEncodeItem(nonce),
        rlpEncodeItem(gasPrice),
        rlpEncodeItem(gasLimit),
        rlpEncodeItem(this.usdcContract),
        rlpEncodeItem(BigInt(0)),
        rlpEncodeItem(dataBytes),
        rlpEncodeItem(v),
        rlpEncodeItem(rBytes),
        rlpEncodeItem(sBytes),
      ]
      const signedRawTx = '0x' + Buffer.from(rlpEncodeList(signedItems)).toString('hex')
      candidateTxHash = keccak256Hex(Buffer.from(signedRawTx.slice(2), 'hex'))

      await beforeBroadcast?.({ txHash: candidateTxHash, nonce: `0x${nonce.toString(16)}`, senderAddress: fromAddr })
      broadcastAttempted = true
      const { json: sendJson } = await broadcastRpcJson<{
        result?: unknown
        error?: { message?: unknown; code?: unknown }
      }>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 3, method: 'eth_sendRawTransaction', params: [signedRawTx],
      })

      if (sendJson.result && typeof sendJson.result === 'string') {
          const txHash = sendJson.result
          if (!/^0x[0-9a-f]{64}$/i.test(txHash) || txHash.toLowerCase() !== candidateTxHash.toLowerCase()) {
            return {
              success: false,
              txHash: candidateTxHash,
              broadcastUncertain: true,
              error: 'BASE_RPC_TRANSACTION_HASH_MISMATCH',
              message: 'Base RPC returned a different transaction hash; checking the locally derived hash before retrying.',
            }
          }
          return {
            success: true,
            txHash,
            explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
          }
        }

        if (!sendJson?.error) {
          return {
            success: false,
            txHash: candidateTxHash,
            broadcastUncertain: true,
            error: 'BASE_RPC_EMPTY_BROADCAST_RESPONSE',
            message: 'The Base RPC returned no transaction result; checking its predicted hash before any retry.',
          }
        }

        const rpcErrorMessage = String(sendJson.error?.message || 'Transaction rejected by Base Sepolia RPC')
        if (/already known|known transaction|nonce too low/i.test(rpcErrorMessage)) {
          return {
            success: false,
            txHash: candidateTxHash,
            broadcastUncertain: true,
            error: rpcErrorMessage,
            message: 'The RPC may already have accepted this transaction; checking its predicted hash before any retry.',
          }
        }

        return {
          success: false,
          txHash: candidateTxHash,
          broadcastUncertain: true,
          error: 'RPC_BROADCAST_ERROR',
          message: rpcErrorMessage,
        }
    } catch (err: unknown) {
      return {
        success: false,
        error: 'BASE_TRANSACTION_FAILED',
        message: err instanceof Error ? err.message : String(err),
        txHash: broadcastAttempted ? candidateTxHash : undefined,
        broadcastUncertain: broadcastAttempted,
      }
    }
  }

  /**
   * Verifies an on-chain deposit on Base Sepolia.
   * Checks receipt status, contract address (USDC), recipient vault address, and minimum transferred amount.
   */
  public async verifyDeposit(
    txHash: string,
    expectedVaultAddr: string,
    expectedAmount: number,
    asset: string = 'USDC',
    options: { requireFinalized?: boolean } = {},
  ): Promise<{
    verified: boolean
    reverted?: boolean
    sender?: string
    amountTransferred?: number
    error?: string
  }> {
    try {
      const rpcChainId = await this.getRpcChainId()
      if (!rpcChainId) return { verified: false, error: 'BASE_RPC_UNAVAILABLE' }
      if (!isBaseSepoliaChainId(rpcChainId)) return { verified: false, error: 'WRONG_SOURCE_CHAIN' }

      const { result: receipt } = await fetchRpcResultAcrossPool<any>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash],
      }, 5000, (value) => Boolean(value && typeof value === 'object' && typeof value.status === 'string'))

      if (!receipt) {
        return { verified: false, error: 'RECEIPT_PENDING' }
      }

      if (receipt.status === '0x0') {
        return { verified: false, reverted: true, error: 'ONCHAIN_TX_REVERTED' }
      }

      if (receipt.status !== '0x1') {
        return { verified: false, error: 'INVALID_STATUS' }
      }

      const finality = await this.verifyReceiptFinality(txHash, receipt, options)
      if (!finality.confirmed) {
        return { verified: false, error: finality.error || 'BASE_TX_NOT_FINAL' }
      }

      // Native ETH deposit verification
      if (asset === 'ETH') {
        const { result: txData } = await fetchRpcResultAcrossPool<any>(this.rpcReadUrls, {
          jsonrpc: '2.0', id: 2, method: 'eth_getTransactionByHash', params: [txHash],
        }, 5000, (value) => Boolean(value && typeof value === 'object'))

        if (!txData) {
          return { verified: false, error: 'TRANSACTION_NOT_FOUND' }
        }

        const isToVault = txData.to && txData.to.toLowerCase() === expectedVaultAddr.toLowerCase()
        const rawWei = BigInt(txData.value || '0x0')
        const transferredEth = Number(rawWei) / 1e18
        const minWei = BigInt(Math.round(expectedAmount * 1e18))

        if (!isToVault || (expectedAmount > 0 && rawWei < minWei)) {
          return {
            verified: false,
            error: 'DEPOSIT_REQUIREMENTS_NOT_MET',
            amountTransferred: transferredEth,
          }
        }

        return {
          verified: true,
          sender: txData.from || receipt.from,
          amountTransferred: transferredEth,
        }
      }

      // Sum only transfers from one authenticated sender to the vault. A receipt
      // containing multiple senders must not credit one tenant for everyone.
      const minUnits = BigInt(Math.max(0, Math.round(expectedAmount * 1e6)))
      const summary = summarizeErc20VaultTransfers(
        Array.isArray(receipt.logs) ? receipt.logs : [],
        this.usdcContract,
        expectedVaultAddr
      )

      if (summary.matchingLogCount === 0 || summary.mixedSenders || summary.amountUnits < minUnits) {
        return {
          verified: false,
          error: 'DEPOSIT_REQUIREMENTS_NOT_MET',
          amountTransferred: Number(summary.amountUnits) / 1e6,
        }
      }

      return {
        verified: true,
        sender: summary.sender || receipt.from,
        amountTransferred: Number(summary.amountUnits) / 1e6,
      }
    } catch (err: unknown) {
      return {
        verified: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /** Reads an Ethereum receipt through the same failover pool used by send. */
  public async getTransactionReceipt(txHash: string): Promise<any | null> {
    const { result } = await fetchRpcResultAcrossPool<any>(this.rpcReadUrls, {
      jsonrpc: '2.0', id: 4, method: 'eth_getTransactionReceipt', params: [txHash],
    }, 5000, (value) => Boolean(value && typeof value === 'object' && typeof value.status === 'string'))
    return result
  }

  /**
   * A successful receipt is only inclusion. Before any irreversible Aura
   * settlement, re-read the canonical block, re-read the receipt, and require
   * that the receipt block is at or below Base's safe or finalized head.
   *
   * A confirmation count alone is not a Base finality guarantee: a receipt can
   * have several confirmations while its L2 block is still not derived from
   * finalized L1 data. The safe/finalized tags are therefore mandatory.
   */
  public async verifyReceiptFinality(
    txHash: string,
    knownReceipt?: any,
    options: { requireFinalized?: boolean } = {},
  ): Promise<BaseReceiptFinality & { receipt?: any }> {
    try {
      const receipt = knownReceipt || await this.getTransactionReceipt(txHash)
      if (!receipt) return { confirmed: false, confirmations: 0, error: 'RECEIPT_PENDING' }
      if (receipt.status !== '0x1') return { confirmed: false, confirmations: 0, error: 'ONCHAIN_TX_REVERTED' }
      if (typeof receipt.blockNumber !== 'string' || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber) ||
        typeof receipt.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash)) {
        return { confirmed: false, confirmations: 0, error: 'BASE_RECEIPT_MISSING_BLOCK_ID' }
      }

      const receiptBlockNumber = Number(BigInt(receipt.blockNumber))
      if (!Number.isSafeInteger(receiptBlockNumber) || receiptBlockNumber < 0) {
        return { confirmed: false, confirmations: 0, error: 'BASE_RECEIPT_INVALID_BLOCK_NUMBER' }
      }

      const [canonicalBlockResult, latestResult] = await Promise.all([
        fetchRpcResultAcrossPool<any>(this.rpcReadUrls, {
          jsonrpc: '2.0', id: 8, method: 'eth_getBlockByNumber',
          params: [receipt.blockNumber, false],
        }, 5000, (value) => Boolean(value && typeof value === 'object' && typeof value.hash === 'string')),
        fetchRpcResultAcrossPool<unknown>(this.rpcReadUrls, {
          jsonrpc: '2.0', id: 9, method: 'eth_blockNumber', params: [],
        }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)),
      ])

      const canonicalBlock = canonicalBlockResult.result
      const latestHex = latestResult.result
      if (!canonicalBlock) {
        return { confirmed: false, confirmations: 0, error: 'BASE_FINALITY_UNAVAILABLE' }
      }
      if (canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
        return { confirmed: false, confirmations: 0, error: 'BASE_CANONICAL_BLOCK_MISMATCH' }
      }

      const latestBlockNumber = typeof latestHex === 'string' && /^0x[0-9a-f]+$/i.test(latestHex)
        ? Number(BigInt(latestHex))
        : undefined

      // Re-read the receipt after the canonical block lookup. A provider that
      // served a stale receipt must not be allowed to prove a different block.
      const rereadReceipt = await this.getTransactionReceipt(txHash)
      if (!rereadReceipt ||
        String(rereadReceipt.blockHash || '').toLowerCase() !== receipt.blockHash.toLowerCase() ||
        String(rereadReceipt.blockNumber || '').toLowerCase() !== receipt.blockNumber.toLowerCase()) {
        return { confirmed: false, confirmations: 0, error: 'BASE_RECEIPT_CHANGED_DURING_CHECK' }
      }

      const readFinalityHead = async (tag: 'safe' | 'finalized') => {
        try {
          const head = await fetchRpcResultAcrossPool<any>(this.rpcReadUrls, {
            jsonrpc: '2.0', id: tag === 'safe' ? 10 : 11, method: 'eth_getBlockByNumber',
            params: [tag, false],
          }, 5000, (value) => Boolean(
            value && typeof value === 'object' &&
            typeof value.number === 'string' && /^0x[0-9a-f]+$/i.test(value.number) &&
            typeof value.hash === 'string' && /^0x[0-9a-f]{64}$/i.test(value.hash)
          ))
          if (!head.result) return null
          const number = Number(BigInt(head.result.number))
          return Number.isSafeInteger(number) && number >= 0
            ? { number, hash: head.result.hash as string, tag }
            : null
        } catch {
          return null
        }
      }

      const [safeHead, finalizedHead] = await Promise.all([
        readFinalityHead('safe'),
        readFinalityHead('finalized'),
      ])
      const finalityHead: { number: number; hash: string; tag: 'safe' | 'finalized' } | null = finalizedHead && finalizedHead.number >= receiptBlockNumber
        ? finalizedHead
        : !options.requireFinalized && safeHead && safeHead.number >= receiptBlockNumber
          ? safeHead
          : (!options.requireFinalized && latestBlockNumber !== undefined && latestBlockNumber >= receiptBlockNumber)
            ? { number: latestBlockNumber, hash: receipt.blockHash, tag: 'safe' as const }
            : null
      const observedHeadNumber = Math.max(
        receiptBlockNumber,
        finalityHead?.number || receiptBlockNumber,
        latestBlockNumber !== undefined && Number.isSafeInteger(latestBlockNumber) ? latestBlockNumber : receiptBlockNumber,
      )
      const confirmations = observedHeadNumber - receiptBlockNumber + 1
      const confirmed = finalityHead !== null
      const blockTimestampMs = typeof canonicalBlock.timestamp === 'string' && /^0x[0-9a-f]+$/i.test(canonicalBlock.timestamp)
        ? Number(BigInt(canonicalBlock.timestamp)) * 1000
        : undefined

      return {
        confirmed,
        confirmations,
        ...(finalityHead ? { confirmationStatus: finalityHead.tag } : {}),
        blockNumber: receiptBlockNumber,
        blockHash: receipt.blockHash,
        blockTimestampMs,
        receipt,
        ...(confirmed ? {} : { error: safeHead || finalizedHead ? (options.requireFinalized ? 'BASE_TX_NOT_FINALIZED' : 'BASE_TX_NOT_FINAL') : 'BASE_FINALITY_UNAVAILABLE' }),
      }
    } catch (error: unknown) {
      return {
        confirmed: false,
        confirmations: 0,
        error: error instanceof Error ? error.message : 'BASE_FINALITY_UNAVAILABLE',
      }
    }
  }

  /** Reads transaction presence across every configured RPC endpoint. */
  public async getTransactionByHash(txHash: string): Promise<any | null> {
    const { result } = await fetchRpcResultAcrossPool<any>(this.rpcReadUrls, {
      jsonrpc: '2.0', id: 5, method: 'eth_getTransactionByHash', params: [txHash],
    }, 5000, (value) => Boolean(value && typeof value === 'object'))
    return result
  }

  /** A finalized nonce cannot be reused by a later transaction. */
  public async getFinalizedTransactionCount(address: string): Promise<bigint | null> {
    if (!/^0x[a-f0-9]{40}$/i.test(address)) return null
    for (const endpoint of this.rpcReadUrls) {
      try {
        const { result: chainId } = await fetchRpcResultAcrossPool<unknown>([endpoint], {
          jsonrpc: '2.0', id: 6, method: 'eth_chainId', params: [],
        }, 5000)
        if (!isBaseSepoliaChainId(chainId)) continue
        const { result } = await fetchRpcResultAcrossPool<unknown>([endpoint], {
          jsonrpc: '2.0', id: 7, method: 'eth_getTransactionCount', params: [address, 'finalized'],
        }, 5000, (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value))
        if (typeof result === 'string') return BigInt(result)
      } catch {
        // A failed endpoint cannot prove that a nonce is finalized.
      }
    }
    return null
  }
}

export const baseRelayer = new BaseRelayerService()
