import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { broadcastRpcJson, fetchRpcResultAcrossPool, uniqueRpcUrls } from '@/lib/services/rpc-fallback'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE = BigInt(58)

export function isConfirmedSolanaSignatureStatus(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false
  const value = status as { confirmationStatus?: unknown; err?: unknown }
  return !value.err && (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')
}

export function isFinalizedSolanaSignatureStatus(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false
  const value = status as { confirmationStatus?: unknown; err?: unknown }
  return !value.err && value.confirmationStatus === 'finalized'
}

export function parseSolanaBalanceResponse(response: unknown): number {
  if (!response || typeof response !== 'object') {
    throw new Error('Solana RPC returned an invalid balance response.')
  }
  const payload = response as {
    error?: { message?: unknown }
    result?: { value?: unknown }
  }
  if (payload.error) {
    throw new Error(typeof payload.error.message === 'string'
      ? payload.error.message
      : 'Solana RPC rejected the balance request.')
  }
  const lamports = payload.result?.value
  if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error('Solana RPC returned an invalid lamport balance.')
  }
  return lamports / 1e9
}

export function summarizeSolanaVaultTransfers(
  instructions: Array<{
    program?: string
    parsed?: {
      type?: string
      info?: { destination?: string; source?: string; lamports?: string | number | bigint }
    }
  }>,
  vaultAddress: string
): { amountLamports: bigint; sender?: string; mixedSenders: boolean; matchingInstructionCount: number } {
  let amountLamports = 0n
  let sender: string | undefined
  let mixedSenders = false
  let matchingInstructionCount = 0

  for (const instruction of instructions) {
    if (instruction.program !== 'system' || instruction.parsed?.type !== 'transfer') continue
    const info = instruction.parsed.info
    if (!info || info.destination !== vaultAddress) continue
    if (typeof info.source !== 'string' || !info.source) {
      mixedSenders = true
      continue
    }

    const currentAmount = BigInt(info.lamports || 0)
    matchingInstructionCount++
    amountLamports += currentAmount
    if (sender && sender !== info.source) mixedSenders = true
    sender ||= info.source
  }

  return { amountLamports, sender, mixedSenders, matchingInstructionCount }
}

export function base58Decode(str: string): Uint8Array {
  let num = BigInt(0)
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    const index = ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`Invalid base58 character: ${char}`)
    num = num * BASE + BigInt(index)
  }
  // Zero has no magnitude bytes. Treating its string form ('0') as a byte
  // adds one phantom zero after the leading Base58 zero bytes are restored.
  const hex = num === 0n ? '' : num.toString(16)
  const hexPadded = hex.length % 2 !== 0 ? '0' + hex : hex
  const bytes = new Uint8Array(hexPadded.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexPadded.slice(i * 2, i * 2 + 2), 16)
  }
  let leadingZeros = 0
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    leadingZeros++
  }
  const result = new Uint8Array(leadingZeros + bytes.length)
  result.set(bytes, leadingZeros)
  return result
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  let num = BigInt(0)
  for (let i = 0; i < bytes.length; i++) {
    num = (num << BigInt(8)) + BigInt(bytes[i])
  }
  let str = ''
  while (num > BigInt(0)) {
    const rem = num % BASE
    num = num / BASE
    str = ALPHABET[Number(rem)] + str
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    str = '1' + str
  }
  return str || '1'
}

export function deriveSolanaKeyMaterial(secretKey: Uint8Array): { seed: Uint8Array; publicKeyBytes: Uint8Array } | null {
  if (secretKey.length !== 32 && secretKey.length !== 64) return null
  try {
    const seed = secretKey.slice(0, 32)
    const pkcs8Header = Buffer.from('302e020100300506032b657004220420', 'hex')
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([pkcs8Header, Buffer.from(seed)]),
      format: 'der',
      type: 'pkcs8',
    })
    const publicDer = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
    const publicKeyBytes = new Uint8Array(publicDer.subarray(publicDer.length - 32))
    if (secretKey.length === 64 && !Buffer.from(secretKey.slice(32, 64)).equals(Buffer.from(publicKeyBytes))) {
      return null
    }
    return { seed, publicKeyBytes }
  } catch {
    return null
  }
}

export function verifySolanaMessageSignature(message: string, publicKeyBase58: string, signatureBase64: string): boolean {
  try {
    const publicKey = Buffer.from(base58Decode(publicKeyBase58))
    const signature = Buffer.from(signatureBase64, 'base64')
    if (publicKey.length !== 32 || signature.length !== 64) return false
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const key = crypto.createPublicKey({
      key: Buffer.concat([spkiPrefix, publicKey]),
      format: 'der',
      type: 'spki',
    })
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, signature)
  } catch {
    return false
  }
}

export interface SolanaBroadcastIntent {
  signature: string
  recentBlockhash: string
  senderAddress: string
  recipientAddress: string
  lamports: number
}

function encodeCompactU16(val: number): Uint8Array {
  if (val <= 0x7f) {
    return new Uint8Array([val])
  } else if (val <= 0x3fff) {
    return new Uint8Array([(val & 0x7f) | 0x80, val >> 7])
  } else {
    return new Uint8Array([(val & 0x7f) | 0x80, ((val >> 7) & 0x7f) | 0x80, val >> 14])
  }
}

export interface SolanaRelayerInfo {
  publicKey: string
  solBalance: number
  explorerUrl: string
}

export class SolanaRelayerService {
  private rpcUrl: string
  private rpcReadUrls: string[]
  private privateKeyBase58: string
  private demoRecipientPrivateKeyBase58: string

  constructor() {
    this.rpcUrl = process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com'
    this.rpcReadUrls = uniqueRpcUrls(this.rpcUrl, [
      ...(process.env.SOLANA_DEVNET_RPC_FALLBACKS || '').split(','),
      'https://api.devnet.solana.com',
    ])
    const rawKey = process.env.DEMO_WALLET_SOLANA_PRIVATE_KEY || ''
    if (this.isValidPrivateKey(rawKey)) {
      this.privateKeyBase58 = rawKey.trim()
    } else {
      this.privateKeyBase58 = this.loadOrGeneratePersistentKey()
    }
    const configuredDemoRecipient = process.env.DEMO_WALLET_SOLANA_RECIPIENT_PRIVATE_KEY || ''
    this.demoRecipientPrivateKeyBase58 = this.isValidPrivateKey(configuredDemoRecipient)
      ? configuredDemoRecipient.trim()
      : this.loadOrGeneratePersistentKey('solana-demo-recipient.json', 'solana-devnet-demo-recipient')
  }

  private loadOrGeneratePersistentKey(
    fileName = 'solana-relayer.json',
    network = 'solana-devnet',
  ): string {
    const cwd = typeof process !== 'undefined' && process.cwd ? process.cwd() : '.'
    const dataDir = path.join(cwd, '.aura-data')
    const keyFile = path.join(dataDir, fileName)
    if (fs.existsSync(keyFile)) {
      try {
        const content = fs.readFileSync(keyFile, 'utf8')
        const parsed = JSON.parse(content)
        if (typeof parsed.privateKey !== 'string' || !this.isValidPrivateKey(parsed.privateKey)) {
          throw new Error('Saved Solana signing key is invalid')
        }
        const material = deriveSolanaKeyMaterial(base58Decode(parsed.privateKey.trim()))
        if (!material) throw new Error('Saved Solana signing key has mismatched public material')
        const derivedAddress = base58Encode(material.publicKeyBytes)
        if (parsed.publicKey && parsed.publicKey !== derivedAddress) {
          throw new Error('Saved Solana public key does not match its private key')
        }
        return parsed.privateKey.trim()
      } catch (err) {
        console.error('Saved Solana relayer key is unreadable; refusing to replace it:', err)
        return ''
      }
    }

    let tempKeyFile = ''
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true })
      }
      // Generate standard 32-byte Ed25519 seed
      const seed = crypto.randomBytes(32)
      const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex')
      const pkcs8Key = Buffer.concat([PKCS8_HEADER, seed])
      const privKeyObj = crypto.createPrivateKey({ key: pkcs8Key, format: 'der', type: 'pkcs8' })
      const pubKeyObj = crypto.createPublicKey(privKeyObj)
      const spkiDer = pubKeyObj.export({ format: 'der', type: 'spki' })
      const rawPubkeyBytes = spkiDer.subarray(spkiDer.length - 32)
      const fullSecretBytes = new Uint8Array(64)
      fullSecretBytes.set(new Uint8Array(seed), 0)
      fullSecretBytes.set(new Uint8Array(rawPubkeyBytes), 32)
      const keyBase58 = base58Encode(fullSecretBytes)
      const pubBase58 = base58Encode(new Uint8Array(rawPubkeyBytes))

      tempKeyFile = `${keyFile}.tmp.${crypto.randomBytes(8).toString('hex')}`
      fs.writeFileSync(tempKeyFile, JSON.stringify({
        publicKey: pubBase58,
        privateKey: keyBase58,
        createdAt: new Date().toISOString(),
        network,
      }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      fs.renameSync(tempKeyFile, keyFile)

      return keyBase58
    } catch (err) {
      try { if (tempKeyFile && fs.existsSync(tempKeyFile)) fs.unlinkSync(tempKeyFile) } catch {}
      console.warn('Could not persist Solana relayer key:', err)
      return ''
    }
  }

  private isValidPrivateKey(key: string): boolean {
    if (!key || key.startsWith('your_') || key.length < 40) return false
    try {
      const decoded = base58Decode(key.trim())
      return decoded.length === 64 || decoded.length === 32
    } catch {
      return false
    }
  }

  private getSignerMaterial(): { seed: Uint8Array; publicKeyBytes: Uint8Array } | null {
    try {
      const decoded = base58Decode(this.getPrivateKey().trim())
      return deriveSolanaKeyMaterial(decoded)
    } catch {
      return null
    }
  }

  private getConfiguredVaultAddress(): string {
    const configuredAddress = process.env.SOLANA_VAULT_ADDRESS?.trim() || ''
    try {
      return base58Decode(configuredAddress).length === 32 ? configuredAddress : ''
    } catch {
      return ''
    }
  }

  public getPrivateKey(): string {
    const envKey = process.env.DEMO_WALLET_SOLANA_PRIVATE_KEY?.trim()
    if (envKey && this.isValidPrivateKey(envKey)) {
      return envKey
    }
    if (!this.privateKeyBase58) {
      this.privateKeyBase58 = this.loadOrGeneratePersistentKey()
    }
    return this.privateKeyBase58
  }

  public getPublicKey(): string {
    const signer = this.getSignerMaterial()
    return signer ? base58Encode(signer.publicKeyBytes) : this.getConfiguredVaultAddress()
  }

  /**
   * Returns the public key of the recoverable server-operated demo recipient.
   * It is intentionally separate from the relayer address so demo payouts do
   * not send funds back to the account that broadcasts them.
   */
  public getDemoRecipientPublicKey(): string {
    try {
      const material = deriveSolanaKeyMaterial(base58Decode(this.demoRecipientPrivateKeyBase58.trim()))
      const recipient = material ? base58Encode(material.publicKeyBytes) : ''
      // A payout recipient must never silently fall back to the relayer. If
      // configuration accidentally points both keys at the same account,
      // fail closed instead of sending the demo payout back to its sender.
      return recipient && recipient !== this.getPublicKey() ? recipient : ''
    } catch {
      return ''
    }
  }

  public hasConfiguredKey(): boolean {
    return Boolean(this.getSignerMaterial())
  }

  public async getBalance(): Promise<number> {
    return this.getBalanceForAddress(this.getPublicKey())
  }

  public async getBalanceForAddress(pubkey: string): Promise<number> {
    if (!pubkey) throw new Error('Solana wallet address is unavailable.')
    const { result } = await fetchRpcResultAcrossPool<{ value?: unknown }>(this.rpcReadUrls, {
      jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey],
    }, 5000, (value) => typeof value?.value === 'number' && Number.isSafeInteger(value.value) && value.value >= 0)
    return parseSolanaBalanceResponse({ result })
  }

  public async requestAirdrop(solAmount: number = 0.2): Promise<{ success: boolean; signature?: string; error?: string }> {
    const pubkey = this.getPublicKey()
    if (!pubkey) return { success: false, error: 'NO_PUBLIC_KEY' }
    const rpcs = Array.from(new Set([this.rpcUrl, 'https://api.devnet.solana.com']))
    const lamports = Math.round(solAmount * 1e9)
    let lastErr = 'Airdrop rejected by Devnet RPC'
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'requestAirdrop',
            params: [pubkey, lamports],
          }),
        })
        const json = await res.json()
        if (json.result) {
          await new Promise((r) => setTimeout(r, 1500))
          return { success: true, signature: json.result }
        }
        if (json.error?.message) {
          lastErr = `${rpc}: ${json.error.message}`
        }
      } catch (err) {
        lastErr = String(err)
      }
    }
    return { success: false, error: lastErr }
  }

  public async sendSol(
    recipientPubkey: string,
    solAmount: number,
    beforeBroadcast?: (intent: SolanaBroadcastIntent) => void | Promise<void>
  ): Promise<{ success: boolean; signature?: string; error?: string; broadcastUncertain?: boolean }> {
    const signer = this.getSignerMaterial()
    if (!signer) {
      return { success: false, error: 'NO_SOLANA_PRIVATE_KEY' }
    }
    if (!Number.isFinite(solAmount) || solAmount <= 0 || solAmount > 1_000_000) {
      return { success: false, error: 'INVALID_SOL_AMOUNT' }
    }
    try {
      if (base58Decode(recipientPubkey.trim()).length !== 32) {
        return { success: false, error: 'INVALID_RECIPIENT_ADDRESS' }
      }
    } catch {
      return { success: false, error: 'INVALID_RECIPIENT_ADDRESS' }
    }

    let expectedSignature: string | undefined
    let broadcastAttempted = false
    try {
      const { seed, publicKeyBytes: senderPubkeyBytes } = signer
      const recipientPubkeyBytes = base58Decode(recipientPubkey.trim())

      if (recipientPubkeyBytes.length !== 32) {
        return { success: false, error: 'INVALID_RECIPIENT_ADDRESS' }
      }

      // 1. Get latest blockhash
      const { result: blockhashResult } = await fetchRpcResultAcrossPool<{ value?: { blockhash?: string } }>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'finalized' }],
      }, 5000, (value) => typeof value?.value?.blockhash === 'string' && value.value.blockhash.length > 0)
      const recentBlockhashBase58 = blockhashResult?.value?.blockhash
      if (!recentBlockhashBase58) {
        return { success: false, error: 'FAILED_TO_GET_RECENT_BLOCKHASH' }
      }
      const blockhashBytes = base58Decode(recentBlockhashBase58)

      // 2. Build Message
      // System Program Account: 32 zeros
      const systemProgramBytes = new Uint8Array(32)

      // Header: [num_req_sigs = 1, num_ro_signed = 0, num_ro_unsigned = 1]
      const header = new Uint8Array([1, 0, 1])

      // Accounts array: sender (signer, writable), recipient (writable), SystemProgram (readonly)
      const accountsCount = encodeCompactU16(3)
      const accountsData = new Uint8Array(3 * 32)
      accountsData.set(senderPubkeyBytes, 0)
      accountsData.set(recipientPubkeyBytes, 32)
      accountsData.set(systemProgramBytes, 64)

      // Instruction: SystemProgram.transfer (type 2)
      // data: uint32 LE (2) + uint64 LE (lamports)
      const lamports = BigInt(Math.max(1000, Math.round(solAmount * 1e9)))
      const instrData = new Uint8Array(12)
      const view = new DataView(instrData.buffer)
      view.setUint32(0, 2, true) // Transfer instruction index
      view.setBigUint64(4, lamports, true)

      const instructionsCount = encodeCompactU16(1)
      const instrProgramIdIndex = 2 // SystemProgram is at index 2
      const instrAccounts = new Uint8Array([2, 0, 1]) // 2 accounts: from 0, to 1
      const instrDataCount = encodeCompactU16(instrData.length)

      const messageParts = [
        header,
        accountsCount,
        accountsData,
        blockhashBytes,
        instructionsCount,
        new Uint8Array([instrProgramIdIndex]),
        instrAccounts,
        instrDataCount,
        instrData,
      ]

      const totalMsgLen = messageParts.reduce((acc, p) => acc + p.length, 0)
      const message = new Uint8Array(totalMsgLen)
      let offset = 0
      for (const part of messageParts) {
        message.set(part, offset)
        offset += part.length
      }

      // 3. Sign with Ed25519 using native Node.js crypto
      const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex')
      const pkcs8Key = Buffer.concat([PKCS8_HEADER, Buffer.from(seed)])
      const privKeyObj = crypto.createPrivateKey({
        key: pkcs8Key,
        format: 'der',
        type: 'pkcs8',
      })

      const signatureBuffer = crypto.sign(null, Buffer.from(message), privKeyObj)
      const signatureBytes = new Uint8Array(signatureBuffer)
      expectedSignature = base58Encode(signatureBytes)

      // 4. Combine into Wire Transaction: [compact-u16(1), signature (64 bytes), message]
      const sigsCount = encodeCompactU16(1)
      const wireTx = new Uint8Array(sigsCount.length + signatureBytes.length + message.length)
      wireTx.set(sigsCount, 0)
      wireTx.set(signatureBytes, sigsCount.length)
      wireTx.set(message, sigsCount.length + signatureBytes.length)

      const base64Tx = Buffer.from(wireTx).toString('base64')

      // 5. Persist the fully signed identity before broadcasting. The
      // signature is deterministic for this exact message and is therefore
      // the recovery key if the process dies after RPC acceptance.
      await beforeBroadcast?.({
        signature: expectedSignature,
        recentBlockhash: recentBlockhashBase58,
        senderAddress: base58Encode(senderPubkeyBytes),
        recipientAddress: recipientPubkey.trim(),
        lamports: Number(lamports),
      })
      broadcastAttempted = true
      const { json: sendJson } = await broadcastRpcJson<{
        result?: unknown
        error?: { message?: string }
      }>(this.rpcReadUrls, {
        jsonrpc: '2.0',
        id: 2,
        method: 'sendTransaction',
        params: [base64Tx, { encoding: 'base64', preflightCommitment: 'confirmed' }],
      })

      if (sendJson.error) {
        if (/already processed|already confirmed|already finalized|already known/i.test(String(sendJson.error.message || ''))) {
          return {
            success: false,
            signature: expectedSignature,
            broadcastUncertain: true,
            error: String(sendJson.error.message || 'Solana transaction was already processed.'),
          }
        }
        // The signed payload was already handed to at least one RPC. A
        // rejection from a later fallback does not prove that the first RPC
        // rejected it, so preserve the exact signature and keep the durable
        // operation in recovery rather than allowing a fresh payout.
        return {
          success: false,
          signature: expectedSignature,
          broadcastUncertain: true,
          error: String(sendJson.error.message || 'Solana RPC send error'),
        }
      }

      const sig = typeof sendJson.result === 'string' ? sendJson.result : undefined
      if (!sig) {
        return { success: false, signature: expectedSignature, broadcastUncertain: true, error: 'SOLANA_RPC_EMPTY_BROADCAST_RESPONSE' }
      }
      if (sig !== expectedSignature) {
        return { success: false, signature: expectedSignature, broadcastUncertain: true, error: 'SOLANA_RPC_SIGNATURE_MISMATCH' }
      }
      return { success: true, signature: sig }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        signature: broadcastAttempted ? expectedSignature : undefined,
        broadcastUncertain: broadcastAttempted,
        error: msg,
      }
    }
  }

  /**
   * Read blockhash validity for diagnostics only. Expiry does not prove that
   * an earlier broadcast was absent, so recovery must never use this result
   * alone to authorize a second payout.
   */
  public async isBlockhashExpired(blockhash: string): Promise<boolean | null> {
    if (!blockhash) return null
    try {
      const { result } = await fetchRpcResultAcrossPool<{ value?: unknown }>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 6, method: 'isBlockhashValid', params: [blockhash, { commitment: 'finalized' }],
      }, 5000, (value) => typeof value?.value === 'boolean')
      return result?.value === false ? true : result?.value === true ? false : null
    } catch {
      return null
    }
  }

  /**
   * Transfer SOL method alias for sendSol
   */
  public async transferSol(recipientPubkey: string, solAmount: number): Promise<{ success: boolean; signature?: string; error?: string; broadcastUncertain?: boolean }> {
    return this.sendSol(recipientPubkey, solAmount)
  }

  /** Reads signature status through the same failover pool used by broadcast. */
  public async getSignatureStatus(signature: string): Promise<{
    confirmationStatus?: 'processed' | 'confirmed' | 'finalized'
    err?: unknown
    slot?: number
  } | null> {
    const { result } = await fetchRpcResultAcrossPool<{
      value?: Array<{
        confirmationStatus?: 'processed' | 'confirmed' | 'finalized'
        err?: unknown
        slot?: number
      } | null>
    }>(this.rpcReadUrls, {
      jsonrpc: '2.0', id: 3, method: 'getSignatureStatuses',
      params: [[signature], { searchTransactionHistory: true }],
    }, 5000, (value) => Boolean(
      value && Array.isArray(value.value) && value.value.length > 0 && value.value[0] !== null,
    ))
    return result?.value?.[0] || null
  }

  /** Reads parsed transaction details through the same failover pool. */
  public async getParsedTransaction(signature: string): Promise<any | null> {
    const { result } = await fetchRpcResultAcrossPool<any>(this.rpcReadUrls, {
      jsonrpc: '2.0', id: 4, method: 'getTransaction', params: [
        signature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ],
    }, 5000, (value) => Boolean(value && typeof value === 'object'))
    return result
  }

  /**
   * Verifies an on-chain deposit on Solana Devnet.
   * Confirms transaction succeeded, verifies destination matches vault, and amount >= minAmount.
   */
  public async verifyDeposit(
    signature: string,
    expectedVaultPubkey: string,
    expectedAmount: number,
    asset: string = 'SOL'
  ): Promise<{
    verified: boolean
    reverted?: boolean
    sender?: string
    amountTransferred?: number
    error?: string
  }> {
    try {
      const { result: tx } = await fetchRpcResultAcrossPool<{
          meta?: { err?: unknown }
          transaction?: {
            message?: {
              instructions?: Array<{
                program?: string
                parsed?: {
                  type?: string
                  info?: { destination?: string; source?: string; lamports?: string | number | bigint }
                }
              }>
            }
          }
        } | null>(this.rpcReadUrls, {
        jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [
          signature,
          { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
        ],
      }, 5000, (value) => Boolean(value && typeof value === 'object'))
      if (!tx) {
        // Fallback to check signature status if full tx details not yet indexed
        const { result: statResult } = await fetchRpcResultAcrossPool<{ value?: Array<{ err?: unknown }> }>(this.rpcReadUrls, {
          jsonrpc: '2.0', id: 2, method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: true }],
        }, 5000, (value) => Boolean(value && Array.isArray(value.value)))
        const sigStat = statResult?.value?.[0]
        if (sigStat?.err) {
          return { verified: false, reverted: true, error: 'SOLANA_TX_FAILED' }
        }
        return { verified: false, error: 'TRANSACTION_NOT_YET_PARSED' }
      }

      if (tx.meta?.err) {
        return { verified: false, reverted: true, error: 'SOLANA_TX_FAILED' }
      }

      // A single signed deposit may contain several transfers, but all matching
      // instructions must have the same source to prevent cross-tenant crediting.
      const instructions = tx.transaction?.message?.instructions || []
      const cleanVault = expectedVaultPubkey.trim()
      const summary = summarizeSolanaVaultTransfers(instructions, cleanVault)
      const transferredLamports = summary.amountLamports

      const minLamports = BigInt(Math.max(1000, Math.round((asset === 'SOL' ? expectedAmount : expectedAmount / 180) * 1e9)))

      if (
        summary.mixedSenders || summary.matchingInstructionCount === 0 ||
        (transferredLamports < minLamports && expectedAmount > 0)
      ) {
        return {
          verified: false,
          error: 'DEPOSIT_AMOUNT_OR_RECIPIENT_MISMATCH',
          amountTransferred: Number(transferredLamports) / 1e9,
        }
      }

      return {
        verified: true,
        sender: summary.sender || '',
        amountTransferred: Number(transferredLamports) / 1e9,
      }
    } catch (err: unknown) {
      return {
        verified: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

export const solanaRelayer = new SolanaRelayerService()
