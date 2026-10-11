/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

import {
  generateBip39Mnemonic,
  validateBip39Mnemonic,
  deriveClientVaultKeys,
  deriveBip39SeedAsync,
  deriveRecoveryTenantIdFromSpki,
  deriveLegacyRecoveryTenantIdFromSpki,
  sha256Sync,
  hmacSha256Sync,
} from '../crypto/bip39'
import { deriveRecoveryAuthority, RecoveryAuthority } from '../crypto/recovery-key'
import { canonicalizeChainAddress, canonicalizeTransactionHash } from '../crypto/payment-authorization'

export interface ClientSpendSignature {
  signed: boolean
  intentCommitment: string
  clientTimestamp: number
  enclaveFingerprint: string
  nonce: string
  authPublicKey?: string
  amountZec?: number
  amountUsd?: number
  asset?: string
  chain?: string
  transactionType?: string
  bufferMode?: string
  quoteId?: string
  quoteZecUsd?: number
  quoteSolUsd?: number
  quoteExpiresAt?: number
  privacyRiskHash?: string
}

export interface ClientDepositSignature {
  enclaveFingerprint: string
  clientTimestamp: number
  nonce: string
  authPublicKey: string
  signature: string
  amountUsd: number
  amountOnChain: number
  asset: string
  chain: string
  txHash: string
  senderAddress: string
  baseWalletMessage?: string
  baseWalletSignature?: string
}

/**
 * ZcashEnclaveService
 *
 * Implements browser-side prototype identity and authorization helpers.
 * Cryptographic rules:
 * - The BIP-39 phrase derives an account fingerprint; it is not a chain spending key.
 * - Browser authorization uses a separate non-extractable ECDSA P-256 key in IndexedDB.
 * - The phrase also derives a recovery-only P-256 authority used to rotate a lost browser key.
 * - Recovery rotates the server's tenant spend authority; it never recreates or moves ledger funds.
 * - The server ledger/relayer means this demo is not self-custodial.
 * - Testnet network mode: Zcash Testnet (ZIP-316 'utest1' diversified receivers).
 * - No fake Halo2 proofs or Math.random mocks.
 */
class ZcashEnclaveService {
  private readonly STORAGE_KEY = 'aura_enclave_key_v2'
  private readonly MNEMONIC_KEY = 'aura_recovery_phrase_v2'
  private readonly PIN_KEY = 'aura_app_pin_v2'
  private readonly LEGACY_PIN_KEY = 'aura_app_pin_v1'
  private readonly PIN_SALT_KEY = 'aura_app_pin_salt_v2'
  private readonly PIN_KDF_KEY = 'aura_app_pin_kdf_v3'
  private readonly PIN_ATTEMPTS_KEY = 'aura_app_pin_attempts_v1'
  private readonly PIN_LOCKOUT_KEY = 'aura_app_pin_lockout_v1'
  private readonly EC_SPKI_KEY = 'aura_enclave_ec_spki_v2'
  private readonly EC_PKCS8_KEY = 'aura_enclave_ec_pkcs8_v2'
  private readonly EC_ACTIVE_KEY_ID = 'aura_enclave_ec_active_key_id_v1'
  private readonly JURY_TENANT_KEY = 'aura_jury_tenant_v1'
  private readonly RECOVERY_PENDING_KEY = 'aura_recovery_rotation_pending_v1'
  private readonly KEY_DATABASE = 'aura-secure-keys-v1'
  private recoveryStorageKeyPromise: Promise<CryptoKey> | null = null
  private signingKeyPairPromise: Promise<{
    publicKeySpkiHex: string
    sign: (data: Uint8Array) => Promise<Uint8Array>
  }> | null = null
  private recoveryRegistrationPromise: Promise<void> | null = null
  private pinUnlocked = false

  private async openKeyDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('Secure browser key storage is unavailable.')
    }

    return new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        callback()
      }
      const timeout = window.setTimeout(() => {
        finish(() => reject(new Error('Secure browser key storage timed out. Close other AURA tabs and retry.')))
      }, 5000)
      const request = indexedDB.open(this.KEY_DATABASE, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('keys')) request.result.createObjectStore('keys')
      }
      request.onblocked = () => {
        finish(() => reject(new Error('Secure browser key storage is blocked by another AURA tab. Close the other tab and retry.')))
      }
      request.onsuccess = () => finish(() => resolve(request.result))
      request.onerror = () => finish(() => reject(request.error || new Error('Could not open secure key storage.')))
    })
  }

  public setJuryTenantId(tenantId: string | null): void {
    if (typeof window === 'undefined') return
    if (tenantId && !/^vault_r_[a-zA-Z0-9._-]{8,120}$/.test(tenantId)) {
      throw new Error('Invalid jury tenant identity.')
    }
    // Jury sessions are browser-tab scoped. Keeping this binding in shared
    // localStorage let two tabs overwrite each other's tenant fingerprint and
    // produced false JURY_TENANT_MISMATCH errors after session rotation.
    if (tenantId) {
      sessionStorage.setItem(this.JURY_TENANT_KEY, tenantId)
      localStorage.removeItem(this.JURY_TENANT_KEY)
    } else {
      sessionStorage.removeItem(this.JURY_TENANT_KEY)
      localStorage.removeItem(this.JURY_TENANT_KEY)
    }
  }

  private getJuryTenantId(): string | null {
    if (typeof window === 'undefined') return null
    const value = sessionStorage.getItem(this.JURY_TENANT_KEY)?.trim() || ''
    return /^vault_r_[a-zA-Z0-9._-]{8,120}$/.test(value) ? value : null
  }

  private isJuryTenantMode(): boolean {
    return this.getJuryTenantId() !== null
  }

  private clearPinAttempts(): void {
    if (typeof window === 'undefined') return
    localStorage.removeItem(this.PIN_ATTEMPTS_KEY)
    localStorage.removeItem(this.PIN_LOCKOUT_KEY)
  }

  private registerPinFailure(): void {
    if (typeof window === 'undefined') return
    const attempts = Number(localStorage.getItem(this.PIN_ATTEMPTS_KEY) || '0') + 1
    if (attempts >= 5) {
      localStorage.setItem(this.PIN_LOCKOUT_KEY, String(Date.now() + 60_000))
      localStorage.removeItem(this.PIN_ATTEMPTS_KEY)
    } else {
      localStorage.setItem(this.PIN_ATTEMPTS_KEY, String(attempts))
    }
  }

  private assertRecoveryPhraseUnlocked(): void {
    if (this.isPinSet() && !this.pinUnlocked) {
      throw new Error('Vault is locked. Unlock the local PIN before accessing the recovery phrase.')
    }
  }

  private async getSigningKeyFromIndexedDb(keyId = 'spend-signing-key'): Promise<CryptoKey | null> {
    const db = await this.openKeyDatabase()
    return new Promise<CryptoKey | null>((resolve, reject) => {
      const request = db.transaction('keys', 'readonly').objectStore('keys').get(keyId)
      request.onsuccess = () => {
        const key = request.result as CryptoKey | undefined
        db.close()
        resolve(key || null)
      }
      request.onerror = () => {
        db.close()
        reject(request.error || new Error('Could not read secure key storage.'))
      }
    })
  }

  private async saveSigningKeyToIndexedDb(key: CryptoKey, keyId = 'spend-signing-key'): Promise<void> {
    const db = await this.openKeyDatabase()
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite')
      transaction.objectStore('keys').put(key, keyId)
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => {
        db.close()
        reject(transaction.error || new Error('Could not store the private signing key.'))
      }
      transaction.onabort = () => {
        db.close()
        reject(transaction.error || new Error('Secure key storage was interrupted.'))
      }
    })
  }

  public async getOrCreateEnclaveKey(): Promise<{
    fingerprint: string
    unifiedAddress?: string
    testnetAddress?: string
    isNew: boolean
  }> {
    if (typeof window === 'undefined') {
      throw new Error('The client vault cannot be opened outside the browser.')
    }

    try {
      const juryTenantId = this.getJuryTenantId()
      if (juryTenantId) return { fingerprint: juryTenantId, isNew: false }
      await this.completePendingRecovery()
      const stored = localStorage.getItem(this.STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (typeof parsed?.fingerprint !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(parsed.fingerprint)) {
          throw new Error('Saved vault identity is damaged. Restore the original recovery phrase before continuing.')
        }
        // Clean legacy hardcoded utest addresses if previously stored
        if (parsed.unifiedAddress?.includes('utest1s4yw') || parsed.testnetAddress?.includes('utest1s4yw')) {
          delete parsed.unifiedAddress
          delete parsed.testnetAddress
          localStorage.setItem(this.STORAGE_KEY, JSON.stringify(parsed))
        }
        return {
          ...parsed,
          isNew: false,
        }
      }

      // Generate a genuine BIP-39 mnemonic. This is only reached while the
      // vault is being created; an existing PIN must never cause a replacement
      // phrase to be generated behind the user's back.
      this.assertRecoveryPhraseUnlocked()
      const mnemonic = await this.readRecoveryPhrase()
      const recoveryAuthority = await deriveRecoveryAuthority(mnemonic)
      const derived = {
        fingerprint: deriveRecoveryTenantIdFromSpki(recoveryAuthority.publicKeySpkiHex),
      }

      const enclaveData = {
        fingerprint: derived.fingerprint,
      }
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(enclaveData))
      return { ...enclaveData, isNew: true }
    } catch {
      throw new Error('Local vault storage is unavailable. Refusing to use a shared fallback account.')
    }
  }

  /**
   * Retrieves or generates a genuine non-extractable ECDSA P-256 keypair in the browser WebCrypto enclave.
   */
  public getOrCreateEcdsaKeyPair(): Promise<{
    publicKeySpkiHex: string
    sign: (data: Uint8Array) => Promise<Uint8Array>
  }> {
    // React Strict Mode can run the initial activity sync twice. Share one key
    // initialization across all callers so two first-run requests cannot race
    // and persist a private key that disagrees with the public key in storage.
    if (!this.signingKeyPairPromise) {
      this.signingKeyPairPromise = this.initializeEcdsaKeyPair().catch((error: unknown) => {
        this.signingKeyPairPromise = null
        throw error
      })
    }
    return this.signingKeyPairPromise
  }

  private async initializeEcdsaKeyPair(): Promise<{
    publicKeySpkiHex: string
    sign: (data: Uint8Array) => Promise<Uint8Array>
  }> {
    if (typeof window === 'undefined' || !window.crypto?.subtle || typeof indexedDB === 'undefined') {
      throw new Error('Secure browser key storage is unavailable; signing is disabled.')
    }

    const storedSpki = localStorage.getItem(this.EC_SPKI_KEY)
    const activeKeyId = localStorage.getItem(this.EC_ACTIVE_KEY_ID) || 'spend-signing-key'
    let privateKey = await this.getSigningKeyFromIndexedDb(activeKeyId)

    // Migrate legacy extractable keys out of localStorage into non-extractable IndexedDB storage.
    if (!privateKey) {
      const legacyPkcs8 = localStorage.getItem(this.EC_PKCS8_KEY)
      if (storedSpki && legacyPkcs8) {
        const bytes = new Uint8Array(legacyPkcs8.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) || [])
        try {
          privateKey = await window.crypto.subtle.importKey(
            'pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
          )
          await this.saveSigningKeyToIndexedDb(privateKey, activeKeyId)
          // The extractable legacy copy has served its migration purpose. Do
          // not leave the private PKCS#8 bytes readable in localStorage after
          // the non-extractable IndexedDB copy is durably saved.
          localStorage.removeItem(this.EC_PKCS8_KEY)
          bytes.fill(0)
        } catch {
          bytes.fill(0)
          throw new Error('The saved signing key could not be secured. Restore the account before signing.')
        }
      } else if (storedSpki || legacyPkcs8) {
        throw new Error('The existing signing key is incomplete. Restore the account before signing.')
      } else {
        const generated = await window.crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
        ) as CryptoKeyPair
        const spki = await window.crypto.subtle.exportKey('spki', generated.publicKey)
        const pkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', generated.privateKey))
        try {
          privateKey = await window.crypto.subtle.importKey(
            'pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
          )
          await this.saveSigningKeyToIndexedDb(privateKey, activeKeyId)
          const publicHex = Array.from(new Uint8Array(spki)).map((b) => b.toString(16).padStart(2, '0')).join('')
          localStorage.setItem(this.EC_SPKI_KEY, publicHex)
        } finally {
          pkcs8.fill(0)
        }
      }
    }

    if (!privateKey || privateKey.type !== 'private' || privateKey.algorithm.name !== 'ECDSA' || !storedSpki && !localStorage.getItem(this.EC_SPKI_KEY)) {
      throw new Error('Secure signing key validation failed.')
    }
    // Also clean sessions migrated by an older build: once the non-extractable
    // IndexedDB key is present, no legacy private-key bytes belong in storage.
    localStorage.removeItem(this.EC_PKCS8_KEY)
    const publicKeySpkiHex = localStorage.getItem(this.EC_SPKI_KEY)!
    return {
      publicKeySpkiHex,
      sign: async (data: Uint8Array) => {
        const sig = await window.crypto.subtle.sign(
          { name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey!, data as any
        )
        return new Uint8Array(sig)
      },
    }
  }

  private async createNonce(): Promise<string> {
    const nonceBytes = new Uint8Array(16)
    if (!window.crypto?.getRandomValues) throw new Error('Secure random generation is unavailable.')
    window.crypto.getRandomValues(nonceBytes)
    return Array.from(nonceBytes).map(byte => byte.toString(16).padStart(2, '0')).join('')
  }

  private async ensureRecoveryAuthority(authority: {
    publicKeySpkiHex: string
    sign: (data: Uint8Array) => Promise<Uint8Array>
  }): Promise<void> {
    if (typeof window === 'undefined') return
    if (this.isJuryTenantMode()) return
    const enclave = await this.getOrCreateEnclaveKey()
    const markerKey = `aura_recovery_authority_registered_v1:${enclave.fingerprint}`
    if (localStorage.getItem(markerKey) === authority.publicKeySpkiHex) return
    if (this.recoveryRegistrationPromise) return this.recoveryRegistrationPromise

    this.recoveryRegistrationPromise = (async () => {
      const recoveryWords = await this.getRecoveryPhrase()
      const recoveryAuthority = await deriveRecoveryAuthority(recoveryWords)
      const clientTimestamp = Date.now()
      const nonce = await this.createNonce()
      const payload = `${enclave.fingerprint}:register_recovery:${clientTimestamp}:${nonce}:${recoveryAuthority.publicKeySpkiHex}`
      const signature = await authority.sign(new TextEncoder().encode(payload))
      const recoverySignature = await recoveryAuthority.sign(payload)
      const response = await fetch('/api/auth/recovery/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aura-enclave-fingerprint': enclave.fingerprint },
        body: JSON.stringify({
          authPublicKey: authority.publicKeySpkiHex,
          signature: `sig_0x${Array.from(signature).map(byte => byte.toString(16).padStart(2, '0')).join('')}`,
          recoveryPublicKey: recoveryAuthority.publicKeySpkiHex,
          recoverySignature,
          clientTimestamp,
          nonce,
        }),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result?.success) {
        throw new Error(result?.message || result?.error || 'Recovery authority registration failed.')
      }
      localStorage.setItem(markerKey, recoveryAuthority.publicKeySpkiHex)
    })().finally(() => {
      this.recoveryRegistrationPromise = null
    })
    return this.recoveryRegistrationPromise
  }

  private async rotateRecoveredSpendKey(
    words: string[],
    enclaveFingerprint: string,
    newAuthority: { publicKeySpkiHex: string },
  ): Promise<void> {
    const recoveryAuthority: RecoveryAuthority = await deriveRecoveryAuthority(words)
    const clientTimestamp = Date.now()
    const nonce = await this.createNonce()
    const payload = `${enclaveFingerprint}:rotate_spend_key:${clientTimestamp}:${nonce}:${newAuthority.publicKeySpkiHex}`
    const recoverySignature = await recoveryAuthority.sign(payload)
    const response = await fetch('/api/auth/recovery/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aura-enclave-fingerprint': enclaveFingerprint },
      body: JSON.stringify({
        recoveryPublicKey: recoveryAuthority.publicKeySpkiHex,
        recoverySignature,
        newAuthPublicKey: newAuthority.publicKeySpkiHex,
        clientTimestamp,
        nonce,
      }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.success) {
      const failure = new Error(result?.message || result?.error || 'The recovery authority could not rotate the spend key.') as Error & { code?: string }
      failure.code = typeof result?.error === 'string' ? result.error : undefined
      throw failure
    }
    localStorage.setItem(`aura_recovery_authority_registered_v1:${enclaveFingerprint}`, recoveryAuthority.publicKeySpkiHex)
  }

  private async createFreshSigningKeyPair(): Promise<{
    keyId: string
    publicKeySpkiHex: string
    sign: (data: Uint8Array) => Promise<Uint8Array>
  }> {
    const generated = await window.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
    ) as CryptoKeyPair
    const spki = await window.crypto.subtle.exportKey('spki', generated.publicKey)
    const pkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', generated.privateKey))
    const privateKey = await window.crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    )
    const publicKeySpkiHex = Array.from(new Uint8Array(spki)).map((b) => b.toString(16).padStart(2, '0')).join('')
    const keyId = `spend-signing-key-${Date.now()}-${Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('')}`
    try {
      await this.saveSigningKeyToIndexedDb(privateKey, keyId)
    } finally {
      pkcs8.fill(0)
    }
    return {
      keyId,
      publicKeySpkiHex,
      sign: async (data: Uint8Array) => new Uint8Array(await window.crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } }, privateKey, data as any
      )),
    }
  }

  private async commitRecoveredSpendKey(
    fingerprint: string,
    keyId: string,
    publicKeySpkiHex: string,
    encryptedPhrase: string,
  ): Promise<void> {
    const previousKeyId = localStorage.getItem(this.EC_ACTIVE_KEY_ID) || 'spend-signing-key'
    const previousPublicKey = localStorage.getItem(this.EC_SPKI_KEY)
    if (previousPublicKey && previousPublicKey !== publicKeySpkiHex) {
      // Preserve the old browser key for diagnostics/recovery; never delete it.
      localStorage.setItem(`${this.EC_SPKI_KEY}:${previousKeyId}`, previousPublicKey)
    }
    localStorage.setItem(`${this.EC_SPKI_KEY}:${keyId}`, publicKeySpkiHex)
    localStorage.setItem(this.EC_ACTIVE_KEY_ID, keyId)
    localStorage.setItem(this.EC_SPKI_KEY, publicKeySpkiHex)
    localStorage.setItem(this.MNEMONIC_KEY, encryptedPhrase)
    localStorage.setItem('aura_backup_confirmed_v2', 'true')
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify({ fingerprint }))
    localStorage.removeItem(this.RECOVERY_PENDING_KEY)
  }

  /**
   * Finish a recovery rotation interrupted after the server accepted the new
   * authority but before the browser committed it. Repeating the same
   * rotation is safe and prevents a crash from leaving the tenant authorized
   * only by an unreachable browser key.
   */
  private async completePendingRecovery(): Promise<void> {
    if (typeof window === 'undefined') return
    const raw = localStorage.getItem(this.RECOVERY_PENDING_KEY)
    if (!raw) return
    this.assertRecoveryPhraseUnlocked()
    const pending = JSON.parse(raw) as {
      fingerprint?: unknown
      keyId?: unknown
      publicKeySpkiHex?: unknown
      encryptedPhrase?: unknown
    }
    if (
      typeof pending.fingerprint !== 'string' ||
      typeof pending.keyId !== 'string' ||
      typeof pending.publicKeySpkiHex !== 'string' ||
      typeof pending.encryptedPhrase !== 'string'
    ) {
      throw new Error('Saved recovery rotation is damaged. Restore the original recovery phrase before continuing.')
    }
    const words = await this.decryptWords(pending.encryptedPhrase)
    if (!words || !validateBip39Mnemonic(words)) {
      throw new Error('Saved recovery rotation cannot be decrypted. Restore the original recovery phrase before continuing.')
    }
    let selectedFingerprint = pending.fingerprint
    const recoveryAuthority = await deriveRecoveryAuthority(words)
    const candidateFingerprints = [
      pending.fingerprint,
      deriveRecoveryTenantIdFromSpki(recoveryAuthority.publicKeySpkiHex),
      deriveLegacyRecoveryTenantIdFromSpki(recoveryAuthority.publicKeySpkiHex),
    ].filter((candidate, index, all) => all.indexOf(candidate) === index)
    let lastRecoveryError: unknown = null
    for (const candidate of candidateFingerprints) {
      try {
        await this.rotateRecoveredSpendKey(words, candidate, { publicKeySpkiHex: pending.publicKeySpkiHex })
        selectedFingerprint = candidate
        lastRecoveryError = null
        break
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code || '')
          : ''
        if (!['RECOVERY_NOT_REGISTERED', 'RECOVERY_AUTHORITY_MISMATCH', 'RECOVERY_TENANT_MISMATCH'].includes(code)) throw error
        lastRecoveryError = error
      }
    }
    if (lastRecoveryError) throw lastRecoveryError
    await this.commitRecoveredSpendKey(
      selectedFingerprint,
      pending.keyId,
      pending.publicKeySpkiHex,
      pending.encryptedPhrase,
    )
  }

  /**
   * Signs a spend intent client-side using authentic ECDSA P-256 asymmetric cryptography.
   * The private key resides strictly on the client device and NEVER touches the network or server.
   */
  public async signShieldedSpendLocally(
    amountZec: number,
    recipientAddress: string,
    intent: {
      amountUsd?: number
      asset?: string
      chain?: string
      transactionType?: string
      bufferMode?: string
      quoteId?: string
      quoteZecUsd?: number
      quoteSolUsd?: number
      quoteExpiresAt?: number
      privacyRiskHash?: string
    } = {}
  ): Promise<ClientSpendSignature> {
    if (this.isPinSet() && !this.pinUnlocked) {
      throw new Error('Vault is locked. Unlock the local PIN before signing a spend.')
    }
    const enclave = await this.getOrCreateEnclaveKey()
    const clientTimestamp = Date.now()

    // 16 bytes cryptographic random nonce
    const nonceBytes = new Uint8Array(16)
    const cryptoApi = typeof window !== 'undefined' ? window.crypto : globalThis.crypto
    if (!cryptoApi?.getRandomValues) {
      throw new Error('Secure random generation is unavailable; refusing to create a spend authorization.')
    }
    cryptoApi.getRandomValues(nonceBytes)
    const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('')

    // Sign all economically relevant fields so intermediaries cannot alter the transfer.
    const amountUsd = Number(intent.amountUsd ?? amountZec * 42.5)
    const asset = intent.asset || 'USDC'
    const chain = intent.chain || 'solana'
    const transactionType = intent.transactionType || 'send'
    const bufferMode = intent.bufferMode || 'private'
    const quoteId = intent.quoteId || ''
    const quoteZecUsd = Number(intent.quoteZecUsd)
    const quoteSolUsd = intent.quoteSolUsd === undefined ? '' : Number(intent.quoteSolUsd).toFixed(8)
    const quoteExpiresAt = Number(intent.quoteExpiresAt)
    const privacyRiskHash = intent.privacyRiskHash || ''
    const payload = `${enclave.fingerprint}:${amountZec.toFixed(6)}:${recipientAddress.trim()}:${clientTimestamp}:${nonce}:${amountUsd.toFixed(2)}:${asset}:${chain}:${transactionType}:${bufferMode}:${quoteId}:${Number.isFinite(quoteZecUsd) ? quoteZecUsd.toFixed(8) : ''}:${quoteSolUsd}:${Number.isFinite(quoteExpiresAt) ? quoteExpiresAt : ''}:${privacyRiskHash}`
    const enc = new TextEncoder()
    const payloadBytes = enc.encode(payload)

    try {
      const ecdsa = await this.getOrCreateEcdsaKeyPair()
      await this.ensureRecoveryAuthority(ecdsa)
      const sigBytes = await ecdsa.sign(payloadBytes)
      const intentCommitment = `sig_0x${Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('')}`

      return {
        signed: true,
        intentCommitment,
        clientTimestamp,
        enclaveFingerprint: enclave.fingerprint,
        nonce,
        authPublicKey: ecdsa.publicKeySpkiHex,
        amountZec,
        amountUsd,
        asset,
        chain,
        transactionType,
        bufferMode,
        quoteId,
        quoteZecUsd,
        quoteSolUsd: intent.quoteSolUsd,
        quoteExpiresAt,
        privacyRiskHash,
      }
    } catch (err) {
      console.error('Secure spend signing failed; refusing to create an unsigned authorization.', err)
      throw new Error('Could not securely sign the spend. No transaction was sent.')
    }
  }

  public async signVaultActionLocally(action: string, detail = ''): Promise<{
    enclaveFingerprint: string
    clientTimestamp: number
    nonce: string
    authPublicKey: string
    signature: string
  }> {
    if (this.isPinSet() && !this.pinUnlocked) {
      throw new Error('Vault is locked. Unlock the local PIN before signing a vault action.')
    }
    if (!/^[a-z_]{3,40}$/.test(action)) throw new Error('Invalid vault action')
    const enclave = await this.getOrCreateEnclaveKey()
    const ecdsa = await this.getOrCreateEcdsaKeyPair()
    await this.ensureRecoveryAuthority(ecdsa)
    const clientTimestamp = Date.now()
    const nonceBytes = new Uint8Array(16)
    crypto.getRandomValues(nonceBytes)
    const nonce = Array.from(nonceBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const payload = `${enclave.fingerprint}:${action}:${clientTimestamp}:${nonce}${detail ? `:${detail}` : ''}`
    const signatureBytes = await ecdsa.sign(new TextEncoder().encode(payload))
    return {
      enclaveFingerprint: enclave.fingerprint,
      clientTimestamp,
      nonce,
      authPublicKey: ecdsa.publicKeySpkiHex,
      signature: `sig_0x${Array.from(signatureBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
    }
  }

  public async signDepositLocally(
    amountUsd: number,
    amountOnChain: number,
    asset: string,
    chain: string,
    txHash: string,
    senderAddress: string,
    baseWalletProof?: { message: string; signature: string }
  ): Promise<ClientDepositSignature> {
    if (this.isPinSet() && !this.pinUnlocked) {
      throw new Error('Vault is locked. Unlock the local PIN before signing a deposit authorization.')
    }
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(amountOnChain) || amountOnChain <= 0 || !txHash || !senderAddress) {
      throw new Error('Deposit authorization details are invalid.')
    }
    const enclave = await this.getOrCreateEnclaveKey()
    const ecdsa = await this.getOrCreateEcdsaKeyPair()
    await this.ensureRecoveryAuthority(ecdsa)
    const clientTimestamp = Date.now()
    const nonceBytes = new Uint8Array(16)
    const cryptoApi = typeof window !== 'undefined' ? window.crypto : globalThis.crypto
    if (!cryptoApi?.getRandomValues) throw new Error('Secure random generation is unavailable.')
    cryptoApi.getRandomValues(nonceBytes)
    const nonce = Array.from(nonceBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    const canonicalTxHash = canonicalizeTransactionHash(chain, txHash)
    const canonicalSender = canonicalizeChainAddress(chain, senderAddress)
    const payload = `${enclave.fingerprint}:deposit:${amountUsd.toFixed(2)}:${amountOnChain}:${asset}:${chain}:${canonicalTxHash}:${canonicalSender}:${clientTimestamp}:${nonce}`
    const signatureBytes = await ecdsa.sign(new TextEncoder().encode(payload))
    return {
      enclaveFingerprint: enclave.fingerprint,
      clientTimestamp,
      nonce,
      authPublicKey: ecdsa.publicKeySpkiHex,
      signature: `sig_0x${Array.from(signatureBytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      amountUsd,
      amountOnChain,
      asset,
      chain,
      txHash: canonicalTxHash,
      senderAddress: canonicalSender,
      baseWalletMessage: baseWalletProof?.message,
      baseWalletSignature: baseWalletProof?.signature,
    }
  }

  private deriveStorageKey(salt: string): Uint8Array {
    const enc = new TextEncoder()
    // 2048 rounds PBKDF2-like cascade for device storage key derivation
    let k = enc.encode(`aura_vault_storage_key_${salt}`)
    for (let i = 0; i < 2048; i++) {
      k = sha256Sync(k)
    }
    return k
  }

  private async getRecoveryStorageKey(): Promise<CryptoKey> {
    if (!this.recoveryStorageKeyPromise) {
      this.recoveryStorageKeyPromise = (async () => {
        if (!window.crypto?.subtle || typeof indexedDB === 'undefined') {
          throw new Error('This browser does not support protected recovery-phrase storage.')
        }
        const generated = await window.crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        )
        const db = await this.openKeyDatabase()
        try {
          return await new Promise<CryptoKey>((resolve, reject) => {
            const transaction = db.transaction('keys', 'readwrite')
            const store = transaction.objectStore('keys')
            const request = store.get('recovery-phrase-aes-gcm-v1')
            let selected: CryptoKey | undefined
            request.onsuccess = () => {
              selected = request.result as CryptoKey | undefined
              if (!selected) {
                selected = generated
                store.put(generated, 'recovery-phrase-aes-gcm-v1')
              }
            }
            transaction.oncomplete = () => selected
              ? resolve(selected)
              : reject(new Error('Protected recovery key could not be initialized.'))
            transaction.onerror = () => reject(transaction.error || new Error('Protected recovery key could not be stored.'))
            transaction.onabort = () => reject(transaction.error || new Error('Protected recovery key storage was interrupted.'))
          })
        } finally {
          db.close()
        }
      })().catch((error: unknown) => {
        this.recoveryStorageKeyPromise = null
        throw error
      })
    }
    return this.recoveryStorageKeyPromise
  }

  private async encryptWords(words: string[]): Promise<string> {
    const key = await this.getRecoveryStorageKey()
    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const additionalData = new TextEncoder().encode('aura-recovery-phrase:v4')
    const cipher = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData }, key, new TextEncoder().encode(JSON.stringify(words))
    )
    const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return JSON.stringify({ v: 4, iv: toHex(iv), cipher: toHex(new Uint8Array(cipher)) })
  }

  private decryptLegacyWords(parsed: any): string[] | null {
    try {
      if (Array.isArray(parsed) && validateBip39Mnemonic(parsed)) return parsed
      if (parsed?.v === 3 && typeof parsed.cipher === 'string' && /^[a-f0-9]{32}$/i.test(parsed.iv) && /^[a-f0-9]{32}$/i.test(parsed.salt) && /^[a-f0-9]{64}$/i.test(parsed.tag)) {
        const key = this.deriveStorageKey(parsed.salt)
        const expected = hmacSha256Sync(key, new TextEncoder().encode(`${parsed.iv}:${parsed.cipher}`))
        const expectedHex = Array.from(expected, byte => byte.toString(16).padStart(2, '0')).join('')
        if (expectedHex !== parsed.tag || !/^(?:[a-f0-9]{2})*$/i.test(parsed.cipher)) return null
        const iv = new Uint8Array(parsed.iv.match(/.{2}/g).map((byte: string) => parseInt(byte, 16)))
        const cipher = new Uint8Array(parsed.cipher.match(/.{2}/g)?.map((byte: string) => parseInt(byte, 16)) || [])
        const plain = new Uint8Array(cipher.length)
        let blockIndex = 0
        let block = hmacSha256Sync(key, new Uint8Array([...iv, blockIndex]))
        let offset = 0
        for (let i = 0; i < cipher.length; i++) {
          if (offset === 32) { block = hmacSha256Sync(key, new Uint8Array([...iv, ++blockIndex])); offset = 0 }
          plain[i] = cipher[i] ^ block[offset++]
        }
        const words = JSON.parse(new TextDecoder().decode(plain))
        return Array.isArray(words) && validateBip39Mnemonic(words) ? words : null
      }
      if (parsed?.v === 2 && typeof parsed.cipher === 'string' && /^[a-f0-9]{32}$/i.test(parsed.salt) && /^(?:[a-f0-9]{2})*$/i.test(parsed.cipher)) {
        const key = sha256Sync(new TextEncoder().encode(`aura_vault_storage_key_${parsed.salt}`))
        const cipher = new Uint8Array(parsed.cipher.match(/.{2}/g)?.map((byte: string) => parseInt(byte, 16)) || [])
        const plain = new Uint8Array(cipher.length)
        let blockIndex = 0
        let offset = 0
        let block = sha256Sync(new Uint8Array([...key, blockIndex]))
        for (let i = 0; i < cipher.length; i++) {
          if (offset === 32) { block = sha256Sync(new Uint8Array([...key, ++blockIndex])); offset = 0 }
          plain[i] = cipher[i] ^ block[offset++]
        }
        const words = JSON.parse(new TextDecoder().decode(plain))
        return Array.isArray(words) && validateBip39Mnemonic(words) ? words : null
      }
    } catch {
      return null
    }
    return null
  }

  private async decryptWords(raw: string): Promise<string[] | null> {
    try {
      const parsed = JSON.parse(raw)
      let words: unknown
      if (parsed?.v === 4 && typeof parsed.iv === 'string' && /^[a-f0-9]{24}$/i.test(parsed.iv) && typeof parsed.cipher === 'string' && /^(?:[a-f0-9]{2})+$/i.test(parsed.cipher)) {
        const fromHex = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))
        const plain = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromHex(parsed.iv), additionalData: new TextEncoder().encode('aura-recovery-phrase:v4') },
          await this.getRecoveryStorageKey(), fromHex(parsed.cipher)
        )
        words = JSON.parse(new TextDecoder().decode(plain))
      } else {
        words = this.decryptLegacyWords(parsed)
      }
      if (Array.isArray(words) && validateBip39Mnemonic(words)) {
        if (parsed?.v !== 4) localStorage.setItem(this.MNEMONIC_KEY, await this.encryptWords(words))
        return words
      }
    } catch {
      return null
    }
    return null
  }

  /**
   * Encrypts local Receive management state with a key derived from the
   * recovery phrase. The owner token never sits as plaintext in storage, and
   * the state can be restored after a normal refresh without changing the
   * request's server-side ownership.
   */
  public async encryptLocalManagementState(value: string): Promise<string> {
    if (typeof window === 'undefined' || !window.crypto?.subtle) throw new Error('Protected local state is unavailable.')
    const words = await this.getRecoveryPhrase()
    const seed = await deriveBip39SeedAsync(words, 'aura-management-state-v1')
    const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', seed))
    seed.fill(0)
    const key = await window.crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt'])
    digest.fill(0)
    const iv = window.crypto.getRandomValues(new Uint8Array(12))
    const cipher = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('aura-management-state:v1') },
      key,
      new TextEncoder().encode(value),
    )
    const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return JSON.stringify({ v: 1, iv: toHex(iv), cipher: toHex(new Uint8Array(cipher)) })
  }

  public async decryptLocalManagementState(raw: string): Promise<string | null> {
    if (typeof window === 'undefined' || !window.crypto?.subtle) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.v !== 1 || typeof parsed.iv !== 'string' || !/^[a-f0-9]{24}$/i.test(parsed.iv) ||
        typeof parsed.cipher !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(parsed.cipher)) return null
      const words = await this.getRecoveryPhrase()
      const seed = await deriveBip39SeedAsync(words, 'aura-management-state-v1')
      const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', seed))
      seed.fill(0)
      const key = await window.crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt'])
      digest.fill(0)
      const fromHex = (hex: string) => new Uint8Array(hex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))
      const plain = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromHex(parsed.iv), additionalData: new TextEncoder().encode('aura-management-state:v1') },
        key,
        fromHex(parsed.cipher),
      )
      return new TextDecoder().decode(plain)
    } catch {
      return null
    }
  }

  /**
   * Retrieves or generates a genuine BIP-39 mnemonic phrase.
   * Words are strictly encrypted with a device-bound key in localStorage.
   */
  private async readRecoveryPhrase(): Promise<string[]> {
    if (typeof window === 'undefined') {
      throw new Error('The recovery phrase can only be accessed in the user’s browser.')
    }

    try {
      const stored = localStorage.getItem(this.MNEMONIC_KEY)
      if (stored) {
        const decrypted = await this.decryptWords(stored)
        if (decrypted && decrypted.length === 12 && validateBip39Mnemonic(decrypted)) {
          return decrypted
        }
        throw new Error('The saved recovery phrase is damaged or cannot be decrypted. Restore the original phrase; a replacement was not created.')
      }

      // Generate fresh, cryptographically secure 12-word BIP-39 phrase and encrypt before storing
      const freshMnemonic = generateBip39Mnemonic()
      localStorage.setItem(this.MNEMONIC_KEY, await this.encryptWords(freshMnemonic))
      return freshMnemonic
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Vault storage is unavailable; no replacement recovery phrase was created.')
    }
  }

  /**
   * Reads the phrase only after the local App Lock has been unlocked.
   * Internal vault creation uses readRecoveryPhrase() so it can bootstrap a
   * brand-new account; all later phrase access passes through this gate.
   */
  public async getRecoveryPhrase(): Promise<string[]> {
    this.assertRecoveryPhraseUnlocked()
    return this.readRecoveryPhrase()
  }

  public isBackupConfirmed(): boolean {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('aura_backup_confirmed_v2') === 'true'
  }

  public confirmBackup(): void {
    if (typeof window !== 'undefined') {
      localStorage.setItem('aura_backup_confirmed_v2', 'true')
    }
  }

  /**
   * Restores vault from user-supplied mnemonic with strict BIP-39 validation.
   */
  public async restoreFromMnemonic(words: string[]): Promise<{ success: boolean; fingerprint: string; error?: string }> {
    if (!words || words.length !== 12) {
      return { success: false, fingerprint: '', error: 'Recovery phrase must be exactly 12 words.' }
    }

    const isValid = validateBip39Mnemonic(words)
    if (!isValid) {
      return { success: false, fingerprint: '', error: 'Invalid BIP-39 recovery phrase or checksum failure.' }
    }

    const legacyDerived = deriveClientVaultKeys(words)
    const recoveryAuthority = await deriveRecoveryAuthority(words)
    const recoveryDerived = {
      fingerprint: deriveRecoveryTenantIdFromSpki(recoveryAuthority.publicKeySpkiHex),
    }
    let recoveredFingerprint = legacyDerived.fingerprint
    if (typeof window !== 'undefined') {
      try {
        // Keep recovery transactional: a failed rotation must not replace the
        // browser identity before the server has accepted the new authority.
        const freshAuthority = await this.createFreshSigningKeyPair()
        const encryptedPhrase = await this.encryptWords(words)
        let selectedFingerprint = legacyDerived.fingerprint
        const recoveryLegacyFingerprint = deriveLegacyRecoveryTenantIdFromSpki(recoveryAuthority.publicKeySpkiHex)
        const candidateFingerprints = [
          legacyDerived.fingerprint,
          recoveryDerived.fingerprint,
          recoveryLegacyFingerprint,
        ].filter((candidate, index, all) => all.indexOf(candidate) === index)
        let rotationCompleted = false
        let lastRotationError: unknown = null
        localStorage.setItem(this.RECOVERY_PENDING_KEY, JSON.stringify({
          fingerprint: selectedFingerprint,
          keyId: freshAuthority.keyId,
          publicKeySpkiHex: freshAuthority.publicKeySpkiHex,
          encryptedPhrase,
        }))
        for (const candidate of candidateFingerprints) {
          try {
            await this.rotateRecoveredSpendKey(words, candidate, freshAuthority)
            selectedFingerprint = candidate
            recoveredFingerprint = selectedFingerprint
            rotationCompleted = true
            localStorage.setItem(this.RECOVERY_PENDING_KEY, JSON.stringify({
              fingerprint: selectedFingerprint,
              keyId: freshAuthority.keyId,
              publicKeySpkiHex: freshAuthority.publicKeySpkiHex,
              encryptedPhrase,
            }))
            break
          } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error
              ? String((error as { code?: unknown }).code || '')
              : ''
            if (!['RECOVERY_NOT_REGISTERED', 'RECOVERY_AUTHORITY_MISMATCH', 'RECOVERY_TENANT_MISMATCH'].includes(code)) throw error
            lastRotationError = error
          }
        }
        if (!rotationCompleted && lastRotationError) throw lastRotationError
        await this.commitRecoveredSpendKey(
          selectedFingerprint,
          freshAuthority.keyId,
          freshAuthority.publicKeySpkiHex,
          encryptedPhrase,
        )
        this.signingKeyPairPromise = Promise.resolve(freshAuthority)
      } catch (error) {
        return {
          success: false,
          fingerprint: legacyDerived.fingerprint,
          error: error instanceof Error
            ? error.message
            : 'Recovery phrase was valid, but the tenant spend authority could not be rotated.',
        }
      }
    }

    return { success: true, fingerprint: recoveredFingerprint }
  }

  // --- LOCAL PIN SECURITY (SECTION 16 & 36) ---

  public isPinSet(): boolean {
    if (typeof window === 'undefined') return false
    return !!(localStorage.getItem(this.PIN_KDF_KEY) || localStorage.getItem(this.PIN_KEY) || localStorage.getItem(this.LEGACY_PIN_KEY))
  }

  private async derivePinHash(pin: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
    if (typeof window === 'undefined' || !window.crypto?.subtle) throw new Error('Protected PIN storage is unavailable.')
    const key = await window.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(pin),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    )
    const bits = await window.crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      key,
      256,
    )
    return new Uint8Array(bits)
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }

  /** Async PBKDF2 path for new PINs; the synchronous method remains only for legacy callers. */
  public async setPinAsync(pin: string): Promise<boolean> {
    if (typeof window === 'undefined' || !/^[0-9]{6,8}$/.test(pin)) return false
    const iterations = 210_000
    const salt = window.crypto.getRandomValues(new Uint8Array(16))
    const hash = await this.derivePinHash(pin, salt, iterations)
    localStorage.setItem(this.PIN_KDF_KEY, JSON.stringify({ v: 3, iterations, salt: this.bytesToHex(salt), hash: this.bytesToHex(hash) }))
    localStorage.removeItem(this.PIN_KEY)
    localStorage.removeItem(this.LEGACY_PIN_KEY)
    localStorage.removeItem(this.PIN_SALT_KEY)
    this.clearPinAttempts()
    this.pinUnlocked = true
    return true
  }

  public async verifyPinAsync(pin: string): Promise<boolean> {
    if (typeof window === 'undefined') return false
    const lockoutUntil = Number(localStorage.getItem(this.PIN_LOCKOUT_KEY) || '0')
    if (lockoutUntil > Date.now()) return false
    if (lockoutUntil) localStorage.removeItem(this.PIN_LOCKOUT_KEY)
    const raw = localStorage.getItem(this.PIN_KDF_KEY)
    if (!raw) return this.verifyPin(pin)
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; iterations?: unknown; salt?: unknown; hash?: unknown }
      const iterations = Number(parsed.iterations)
      if (parsed.v !== 3 || !Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 1_000_000 ||
        typeof parsed.salt !== 'string' || !/^[a-f0-9]{32}$/i.test(parsed.salt) ||
        typeof parsed.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.hash)) throw new Error('Invalid PIN record')
      const salt = new Uint8Array(parsed.salt.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))
      const actual = await this.derivePinHash(pin, salt, iterations)
      const expected = new Uint8Array(parsed.hash.match(/.{2}/g)!.map(byte => parseInt(byte, 16)))
      let difference = actual.length ^ expected.length
      for (let i = 0; i < Math.max(actual.length, expected.length); i++) difference |= (actual[i] || 0) ^ (expected[i] || 0)
      const valid = difference === 0
      if (valid) {
        this.clearPinAttempts()
        this.pinUnlocked = true
      } else {
        this.registerPinFailure()
      }
      return valid
    } catch {
      this.registerPinFailure()
      return false
    }
  }

  public async removePinAsync(currentPin: string): Promise<boolean> {
    if (!(await this.verifyPinAsync(currentPin))) return false
    localStorage.removeItem(this.PIN_KDF_KEY)
    localStorage.removeItem(this.PIN_KEY)
    localStorage.removeItem(this.LEGACY_PIN_KEY)
    localStorage.removeItem(this.PIN_SALT_KEY)
    this.clearPinAttempts()
    this.pinUnlocked = true
    return true
  }

  public setPin(pin: string): boolean {
    if (typeof window === 'undefined' || !/^\d{6,8}$/.test(pin)) return false
    // New PINs use a per-install salt and six digits minimum. Failed attempts
    // are rate-limited so the old four-digit SHA-256 scheme is not repeated.
    const enc = new TextEncoder()
    const saltBytes = new Uint8Array(16)
    crypto.getRandomValues(saltBytes)
    const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    const hash = sha256Sync(enc.encode(`pin_v2:${salt}:${pin}`))
    const hex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(this.PIN_KEY, hex)
    localStorage.setItem(this.PIN_SALT_KEY, salt)
    localStorage.removeItem(this.LEGACY_PIN_KEY)
    this.clearPinAttempts()
    this.pinUnlocked = true
    return true
  }

  public verifyPin(pin: string): boolean {
    if (typeof window === 'undefined') return false
    const lockoutUntil = Number(localStorage.getItem(this.PIN_LOCKOUT_KEY) || '0')
    if (lockoutUntil > Date.now()) return false
    if (lockoutUntil) localStorage.removeItem(this.PIN_LOCKOUT_KEY)
    const stored = localStorage.getItem(this.PIN_KEY)
    const legacyStored = localStorage.getItem(this.LEGACY_PIN_KEY)
    if (!stored && !legacyStored) return true // No PIN set
    const enc = new TextEncoder()
    const salt = localStorage.getItem(this.PIN_SALT_KEY)
    const hash = salt
      ? sha256Sync(enc.encode(`pin_v2:${salt}:${pin}`))
      : sha256Sync(enc.encode(`pin_salt_${pin}`))
    const hex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('')
    const valid = stored === hex || (!!legacyStored && legacyStored === hex)
    if (valid) {
      this.clearPinAttempts()
      this.pinUnlocked = true
    } else {
      this.registerPinFailure()
    }
    return valid
  }

  public removePin(currentPin: string): boolean {
    if (this.verifyPin(currentPin)) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(this.PIN_KEY)
        localStorage.removeItem(this.LEGACY_PIN_KEY)
        localStorage.removeItem(this.PIN_SALT_KEY)
      }
      this.clearPinAttempts()
      this.pinUnlocked = true
      return true
    }
    return false
  }

  /**
   * Securely exports the 12-word recovery phrase.
   * If a PIN is configured, export is strictly rejected until this service has
   * verified the PIN in the current browser session (or verifies the supplied PIN now).
   */
  public async exportRecoveryPhrase(pin?: string): Promise<{ success: boolean; words?: string[]; error?: string }> {
    if (this.isPinSet() && !this.pinUnlocked) {
      if (!pin || !(await this.verifyPinAsync(pin))) {
        return { success: false, error: 'Incorrect PIN. Vault phrase is protected.' }
      }
    }
    return { success: true, words: await this.getRecoveryPhrase() }
  }
}

export const zcashEnclaveService = new ZcashEnclaveService()
export const BrowserEnclaveAdapter = zcashEnclaveService
