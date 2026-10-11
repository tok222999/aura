/**
 * AuraClientVaultBridge (formerly RustWalletBridge)
 *
 * Implements the React <-> Client Vault Boundary:
 * - React is UI only; React NEVER transmits the BIP-39 seed or spending keys to the server.
 * - Sensitive cryptographic operations, key generation, and signing happen locally inside
 *   the client-side Web Crypto Enclave (WebCrypto API + BIP-39).
 * - Honest architecture: In the web browser, keys live inside local client memory/storage.
 *   There is no native Rust/SQLite binary in browser runtime; operations are secured via
 *   Web Crypto primitives and client-side intent signing.
 */

import { AssetSymbol, ChainId, PrivacyBufferMode, PrivateBalanceState, AuraTransaction, SwapQuote } from '../types/aura'
import { zcashEnclaveService } from './zcash-enclave-service'
import { canonicalizePaymentRequestIntent } from '../crypto/request-authorization'

async function getTenantBalanceSafe(fingerprint: string) {
  if (typeof window !== 'undefined') {
    try {
      const authorization = await zcashEnclaveService.signVaultActionLocally('read_activity')
      const res = await fetch('/api/activity?filter=all', {
        headers: {
          'x-aura-enclave-fingerprint': fingerprint,
          'x-aura-auth-timestamp': String(authorization.clientTimestamp),
          'x-aura-auth-nonce': authorization.nonce,
          'x-aura-auth-public-key': authorization.authPublicKey,
          'x-aura-auth-signature': authorization.signature,
        },
      })
      if (res.ok) {
        const data = await res.json()
        const balance = data.balance
        if (data.success && balance) {
          const balanceAvailable = balance.balanceAvailable !== false &&
            balance.zcashStateSynced !== false &&
            typeof balance.totalUsd === 'number' &&
            Number.isFinite(balance.totalUsd)
          return {
            balanceAvailable,
            totalUsd: balanceAvailable ? balance.totalUsd : 0,
            zecEquivalent: balanceAvailable && typeof balance.zecEquivalent === 'number' ? balance.zecEquivalent : null,
            availableToSendUsd: balanceAvailable ? (balance.availableToSendUsd ?? balance.readyToSpendUsd ?? 0) : 0,
            readyToSpendUsd: balanceAvailable ? (balance.readyToSpendUsd ?? 0) : 0,
            shieldedWaitRemainingUsd: balance.shieldedWaitRemainingUsd ?? 0,
            shieldedWaitHoursRemaining: balance.shieldedWaitHoursRemaining ?? 0,
            privacyPolicy: balance.privacyPolicy ?? 'private',
            unconfirmedUsd: balance.unconfirmedUsd ?? 0,
          }
        }
      }
      throw new Error('Could not load the balance.')
    } catch (error) {
      throw new Error(`Could not load the balance: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Server-side dynamic require so Webpack does not pull node modules into client bundle
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ledgerService } = eval('require')('./ledger-service')
    const balance = ledgerService.getTenantBalance(fingerprint)
    return { ...balance, balanceAvailable: true, availableToSendUsd: balance.readyToSpendUsd }
  } catch (error) {
    throw new Error(`Could not load the balance: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface VaultEngineStatus {
  backend: string
  isNativeTauri: boolean
  vaultStorageSecure: boolean
  keysLoaded: boolean
  isSelfCustodial: boolean
  lastBlockHeight: number
  sqliteDbConnected?: boolean // Kept for legacy component compatibility, always false in web runtime
  storageTier?: string
}

class AuraClientVaultBridge {
  private cachedBlockHeight: number = 3493894

  public async getBridgeStatus(): Promise<VaultEngineStatus> {
    return {
      backend: 'Web Browser Prototype Enclave (WebCrypto ECDSA & BIP-39)',
      isNativeTauri: false,
      // Detecting Tauri globals does not prove that Stronghold storage is wired up.
      vaultStorageSecure: false,
      keysLoaded: true,
      // The current server-ledger / relayer path is not self-custodial.
      isSelfCustodial: false,
      lastBlockHeight: this.cachedBlockHeight,
      sqliteDbConnected: false, // Honestly report false: browser does not run native SQLite
      storageTier: 'browser_local_storage_prototype',
    }
  }

  // Section 30 Command 1: create_wallet
  public async create_wallet(): Promise<{ recoveryPhrase: string[]; fingerprint: string }> {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const phrase = await zcashEnclaveService.getRecoveryPhrase()
    return {
      recoveryPhrase: phrase,
      fingerprint: enclave.fingerprint,
    }
  }

  // Section 30 Command 2: restore_wallet
  public async restore_wallet(recoveryPhrase: string[]): Promise<{ success: boolean; fingerprint: string }> {
    return await zcashEnclaveService.restoreFromMnemonic(recoveryPhrase)
  }

  // Section 30 Command 3: sync_wallet
  public async sync_wallet(): Promise<{ syncedHeight: number; timestamp: number }> {
    try {
      if (typeof fetch !== 'undefined') {
        const res = await fetch('https://api.blockchair.com/zcash/stats', { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          const data = await res.json()
          if (data.data?.blocks) {
            this.cachedBlockHeight = data.data.blocks
          }
        }
      }
    } catch {
      // Keep cached height if offline
    }
    return {
      syncedHeight: this.cachedBlockHeight,
      timestamp: Date.now(),
    }
  }

  // Section 30 Command 4: get_private_balance
  public async get_private_balance(): Promise<PrivateBalanceState> {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const tenantBalance = await getTenantBalanceSafe(enclave.fingerprint)
    return {
      totalUsd: tenantBalance.totalUsd,
      zecEquivalent: tenantBalance.zecEquivalent,
      availableToSendUsd: tenantBalance.availableToSendUsd,
      readyToSpendUsd: tenantBalance.readyToSpendUsd,
      shieldedWaitRemainingUsd: tenantBalance.shieldedWaitRemainingUsd,
      shieldedWaitHoursRemaining: tenantBalance.shieldedWaitHoursRemaining,
      privacyPolicy: tenantBalance.privacyPolicy,
      unconfirmedUsd: tenantBalance.unconfirmedUsd,
      vaultSynced: tenantBalance.balanceAvailable,
      orchardPoolSynced: false,
      syncStatus: tenantBalance.balanceAvailable ? 'synced' : 'error',
      lastSyncedAt: Date.now(),
      enclaveKeyFingerprint: enclave.fingerprint,
    }
  }

  // Section 30 Command 5: get_ready_balance
  public async get_ready_balance(): Promise<{
    readyToSpendUsd: number
    shieldedWaitRemainingUsd: number
    hoursRemaining: number
    policy: string
  }> {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const tenantBalance = await getTenantBalanceSafe(enclave.fingerprint)
    return {
      readyToSpendUsd: tenantBalance.readyToSpendUsd,
      shieldedWaitRemainingUsd: tenantBalance.shieldedWaitRemainingUsd,
      hoursRemaining: tenantBalance.shieldedWaitHoursRemaining,
      policy: 'Private (1 day recommended wait)',
    }
  }

  // Section 30 Command 6: get_privacy_status
  public async get_privacy_status(): Promise<{
    policy: string
    shieldedConfirmed: boolean
    shieldedAgeHours: number
    correlationRisk: 'low' | 'moderate' | 'high'
    note: string
  }> {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const tenantBalance = await getTenantBalanceSafe(enclave.fingerprint)
    return {
      policy: 'Private (1 day recommended wait)',
      shieldedConfirmed: false,
      shieldedAgeHours: 0,
      correlationRisk: 'moderate',
      note: 'Aura balance is a server-side demo ledger backed by AURA-operated Zcash Testnet inventory with tenant-scoped authorization; public timing and amount data may still be correlated.',
    }
  }

  // Section 30 Command 7: create_payment_request
  public async create_payment_request(options: {
    asset?: AssetSymbol
    chain?: ChainId
    amount?: number
    expiryHours?: number
    bufferMode?: PrivacyBufferMode
  }): Promise<{
    requestId: string
    paymentUrl: string
    shieldedReceiver: string
    expiresAt: number
    isSingleUse: boolean
  }> {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const bufferMode = options.bufferMode || 'private'
    const authorization = await zcashEnclaveService.signVaultActionLocally(
      'create_request',
      canonicalizePaymentRequestIntent({
        amount: options.amount,
        asset: options.asset || 'USDC',
        chain: options.chain || 'base',
        expiryHours: options.expiryHours || 24,
        bufferMode,
      }),
    )
    // Create via server API so it is persistently stored and replay-protected
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aura-enclave-fingerprint': enclave.fingerprint,
      },
      body: JSON.stringify({
        amount: options.amount,
        asset: options.asset || 'USDC',
        chain: options.chain || 'base',
        expiryHours: options.expiryHours || 24,
        bufferMode,
        isSingleUse: true,
        ...authorization,
        enclaveFingerprint: enclave.fingerprint,
      }),
    })
    const json = await res.json()
    if (!res.ok || !json.success || !json.request?.shieldedReceiver) {
      throw new Error(json.message || json.error || 'Payment request creation failed.')
    }

    return {
      requestId: json.request.id,
      paymentUrl: `https://aura.money/pay/${json.request.id}`,
      shieldedReceiver: `${json.request.shieldedReceiver.slice(0, 18)}...${json.request.shieldedReceiver.slice(-8)}`,
      expiresAt: json.request.expiresAt,
      isSingleUse: true,
    }
  }

  // Section 30 Command 8: get_activity
  public async get_activity(filter: string = 'all'): Promise<AuraTransaction[]> {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const authorization = await zcashEnclaveService.signVaultActionLocally('read_activity')
    const res = await fetch(`/api/activity?filter=${encodeURIComponent(filter)}`, {
      headers: {
        'x-aura-enclave-fingerprint': enclave.fingerprint,
        'x-aura-auth-timestamp': String(authorization.clientTimestamp),
        'x-aura-auth-nonce': authorization.nonce,
        'x-aura-auth-public-key': authorization.authPublicKey,
        'x-aura-auth-signature': authorization.signature,
      }
    })
    const json = await res.json()
    if (!res.ok || !json.success || !Array.isArray(json.data)) {
      throw new Error(json.message || json.error || 'Could not load activity.')
    }
    return json.data
  }

  // Section 30 Command 9: get_swap_quote
  public async get_swap_quote(
    fromAsset: AssetSymbol,
    toAsset: AssetSymbol,
    amount: number,
    fromChain: ChainId = 'base',
    toChain: ChainId = 'solana',
    bufferMode: PrivacyBufferMode = 'private'
  ): Promise<SwapQuote | null> {
    const res = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromAsset, toAsset, amount, fromChain, toChain, bufferMode }),
    })
    const json = await res.json()
    return json.success ? json.data : null
  }

  // Section 30 Command 10: review_privacy
  public async review_privacy(
    amount: number,
    recentDeposits: number[] = [],
    totalBalance: number = 0,
    waitRemainingHours: number = 0
  ): Promise<{
    hasWarning: boolean
    warnings: string[]
    recentDepositSimilarity: boolean
    fullBalanceExit: boolean
    waitRemainingNotice: string | null
    suggestedActions: ('pay_anyway' | 'keep_private' | 'use_older_balance')[]
  }> {
    const warnings: string[] = []
    let recentDepositSimilarity = false
    let fullBalanceExit = false
    let waitRemainingNotice: string | null = null
    const suggestedActions: ('pay_anyway' | 'keep_private' | 'use_older_balance')[] = []

    // 1. Check if amount matches a recent deposit within 5%
    for (const dep of recentDeposits) {
      if (Math.abs(amount - dep) / dep < 0.05) {
        recentDepositSimilarity = true
        warnings.push(`This payment closely matches a recent deposit of $${dep.toFixed(2)}. Matching amounts make transactions easier to correlate.`)
        break
      }
    }

    // 2. Check full balance exit
    if (amount >= totalBalance * 0.92) {
      fullBalanceExit = true
      warnings.push('Exiting nearly all of your shielded balance at once makes transaction amounts easier to correlate across public chains.')
    }

    // 3. Check wait policy
    if (waitRemainingHours > 0) {
      waitRemainingNotice = `A portion of this payment relies on funds that entered your vault recently (${waitRemainingHours}h wait remaining under Private policy).`
      warnings.push(waitRemainingNotice)
    }

    if (warnings.length > 0) {
      suggestedActions.push('pay_anyway')
      suggestedActions.push('keep_private')
      suggestedActions.push('use_older_balance')
    }

    return {
      hasWarning: warnings.length > 0,
      warnings,
      recentDepositSimilarity,
      fullBalanceExit,
      waitRemainingNotice,
      suggestedActions,
    }
  }

  // Section 30 Command 11: add_money
  public async add_money(
    asset: AssetSymbol,
    amount: number,
    chain: ChainId = 'base',
    payment: { amountOnChain: number; txHash: string; senderAddress: string }
  ): Promise<AuraTransaction | null> {
    const enclave = await zcashEnclaveService.getOrCreateEnclaveKey()
    const clientSignature = await zcashEnclaveService.signDepositLocally(
      amount,
      payment.amountOnChain,
      asset,
      chain,
      payment.txHash,
      payment.senderAddress,
    )
    const res = await fetch('/api/deposit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aura-enclave-fingerprint': enclave.fingerprint,
      },
      body: JSON.stringify({ asset, amount, chain, onChainTxHash: payment.txHash, clientSignature }),
    })
    const json = await res.json()
    if (!res.ok || !json.success) throw new Error(json.message || json.error || 'Could not add funds.')
    return json.transaction
  }

  // Section 30 Command 12: send_private
  public async send_private(
    recipient: string,
    asset: AssetSymbol,
    amount: number,
    chain: ChainId = 'solana',
    bufferMode: PrivacyBufferMode = 'private'
  ): Promise<AuraTransaction | null> {
    const quoteAuthorization = await zcashEnclaveService.signVaultActionLocally('quote_request')
    const tenantId = quoteAuthorization.enclaveFingerprint
    const quoteResponse = await fetch('/api/spend/quote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aura-enclave-fingerprint': tenantId,
        'x-aura-auth-timestamp': String(quoteAuthorization.clientTimestamp),
        'x-aura-auth-nonce': quoteAuthorization.nonce,
        'x-aura-auth-public-key': quoteAuthorization.authPublicKey,
        'x-aura-auth-signature': quoteAuthorization.signature,
      },
      body: JSON.stringify({
        type: 'send',
        amount,
        asset,
        chain,
        bufferMode,
        enclaveFingerprint: tenantId,
      }),
    })
    const quotePayload = await quoteResponse.json().catch(() => ({}))
    if (!quoteResponse.ok || !quotePayload.success || !quotePayload.quote) {
      throw new Error(quotePayload.message || quotePayload.error || 'A fresh settlement quote is unavailable; no payment was sent.')
    }
    const quote = quotePayload.quote
    // 1. Client-Side Cryptographic Intent Signature
    const clientSignature = await zcashEnclaveService.signShieldedSpendLocally(quote.amountZec, recipient, {
      amountUsd: amount,
      asset,
      chain,
      transactionType: 'send',
      bufferMode,
      quoteId: quote.quoteId,
      quoteZecUsd: quote.quoteZecUsd,
      quoteSolUsd: quote.quoteSolUsd,
      quoteExpiresAt: quote.expiresAt,
      privacyRiskHash: quote.privacyRiskHash,
    })

    // 2. Dispatch authorized spend intent to settlement solver
    const res = await fetch('/api/spend', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aura-enclave-fingerprint': clientSignature.enclaveFingerprint,
      },
      body: JSON.stringify({
        type: 'send',
        recipient,
        asset,
        amount,
        chain,
        bufferMode,
        clientSignature,
        enclaveFingerprint: clientSignature.enclaveFingerprint,
        settlementQuote: quote,
      }),
    })
    const json = await res.json()
    return json.success ? json.transaction : null
  }

  // Section 30 Command 13: withdraw
  public async withdraw(
    asset: AssetSymbol,
    amount: number,
    chain: ChainId = 'base',
    recipientAddress?: string
  ): Promise<AuraTransaction | null> {
    if (!recipientAddress) {
      throw new Error('A recipient address is required; funds are never sent to an automatic address.')
    }
    return this.send_private(
      recipientAddress,
      asset,
      amount,
      chain,
      'fast'
    )
  }
}

export type RustBridgeStatus = VaultEngineStatus
export const rustWalletBridge = new AuraClientVaultBridge()
