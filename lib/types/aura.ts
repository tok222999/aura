/**
 * Aura Domain Types & Interfaces
 * Defined in accordance with the Aura PRD and Architecture Specification.
 *
 * Production Model:
 * - Single source of truth for Privacy Modes. `custom` is retained as a wire
 *   value for compatibility, but the UI presents it honestly as Extended (7d).
 * - Clean cryptographic intent commitments
 * - Strict financial accounting
 */

export type AssetSymbol = 'USDC' | 'USDT' | 'ETH' | 'SOL' | 'ZEC'

export type ChainId = 'base' | 'ethereum' | 'solana' | 'zcash' | 'arbitrum' | 'bitcoin'

export interface AssetInfo {
  symbol: AssetSymbol
  name: string
  chain: ChainId
  chainName: string
  decimals: number
  icon: string
  isStable: boolean
}

// Unified privacy buffers: Fast (Immediate), 1-day buffer, 3-day buffer, 7-day buffer.
export type PrivacyBufferMode = 'fast' | 'private' | 'strong' | 'custom'
export type PrivacyPolicy = PrivacyBufferMode

export interface PrivacyRiskSnapshot {
  schemaVersion: 'aura-privacy-risk-v1'
  hash: string
  evaluatedAt: number
  amountUsd: number
  policy: PrivacyBufferMode
  riskCodes: Array<'RECENT_TIMING' | 'POLICY_AGE' | 'AMOUNT_ECHO' | 'FRESH_BALANCE' | 'FULL_BALANCE' | 'FUNDING_HISTORY_VISIBLE'>
  totalBalanceUsd: number
  policyReadyUsd: number
  latestFundingAgeMs: number | null
  matchingFundingAmountUsd: number | null
  recommendedAction: 'pay' | 'wait' | 'use_mature_balance'
}

export interface BufferModeConfig {
  id: PrivacyBufferMode
  label: string
  badge?: string
  duration: string
  durationSec: number
  description: string
  timingBufferHours: number
  splittingStrategy: string
  recommended?: boolean
}

export interface SwapQuoteRequest {
  fromAsset: AssetSymbol
  fromChain?: ChainId
  toAsset: AssetSymbol
  toChain?: ChainId
  amount: number
  bufferMode?: PrivacyBufferMode
}

export interface SwapQuote {
  id: string
  fromAsset: AssetSymbol
  fromChain: ChainId
  fromAmount: number
  toAsset: AssetSymbol
  toChain: ChainId
  toAmount: number
  intermediateZec: number
  exchangeRate: number
  nearIntentsFeeUsd: number
  auraProtocolFeeUsd: number
  estimatedSlippagePercent: number
  bufferMode: PrivacyBufferMode
  estimatedDuration: string
  expiresAt: number
}

export type TransactionType = 'deposit' | 'send' | 'receive' | 'withdraw'

export type TransactionStatus =
  | 'initiated'
  | 'processing'
  | 'locking_collateral'
  | 'routing_shielded'
  | 'settling_destination'
  | 'completed'
  | 'failed'
  // Legacy aliases for backward compatibility
  | 'locking_base'
  | 'shielding_orchard'
  | 'shielded'
  | 'routing_near'
  | 'delivering_dest'

export interface TransactionLeg {
  chain: ChainId
  description: string
  txHash?: string
  explorerUrl?: string
  status: 'pending' | 'in_progress' | 'confirmed' | 'failed' | 'broadcasting' | 'enclave_committed' | 'enclave_authorized'
  /** The chain's authoritative confirmation level; Solana completion requires finalized. */
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized'
  timestamp?: number
  destinationAddress?: string
}

export interface ZeroKnowledgeProofData {
  privacyRoutingType: 'intent_shielded_vault' | 'direct_atomic_route'
  clientCommitmentHash: string
  intermediateHopExecuted: boolean
  senderUnlinked: boolean
  recipientUnlinked: boolean
  auditStatus: 'verified' | 'pending'
  nullifierHash?: string
  valueCommitment?: string
  anchorCommitment?: string
  zkProofType?: string
  verifiedLocally?: boolean
  orchardActionCount?: number
}

export interface AuraTransaction {
  id: string
  type: TransactionType
  status: TransactionStatus
  fromAsset: AssetSymbol
  fromAmount: number
  fromChain: ChainId
  toAsset: AssetSymbol
  toAmount: number
  toChain: ChainId
  recipientAddress?: string
  toAddress?: string
  bufferMode: PrivacyBufferMode
  createdAt: number
  completedAt?: number
  /** Captured when a shielded deposit becomes confirmed; never inferred later. */
  balanceCheckpoint?: {
    beforeUsd: number
    afterUsd: number
    deltaUsd: number
    capturedAt: number
  }
  /**
   * The exact ZEC quantity reserved for an outbound spend. USD is only a
   * display value; availability must subtract this quantity before applying
   * the current ZEC/USD rate.
   */
  reservedZec?: number
  /** The exact ZEC quantity credited by a confirmed shielded deposit. */
  backingZec?: number
  /** The private leg's settlement source. Jury inventory has no per-payment txid. */
  settlementMode?: 'live_zcash' | 'jury_inventory'
  backingSource?: 'confirmed_zcash_inventory'
  /** Set only when a delivered payout's private settlement needs operator recovery. */
  privateSettlementRecovery?: {
    status: 'required'
    reason: 'expired' | 'unknown'
    txHash: string
    detectedAt: number
    message: string
  }
  legs: {
    deposit?: TransactionLeg
    shielded?: TransactionLeg
    delivery?: TransactionLeg
  }
  zkData?: ZeroKnowledgeProofData
  feeUsd: number
}

export interface PrivacyReviewResult {
  hasWarning: boolean
  warnings: string[]
  recentDepositSimilarity: boolean
  fullBalanceExit: boolean
  waitRemainingNotice: string | null
  suggestedActions: ('pay_anyway' | 'keep_private' | 'use_older_balance')[]
}

export interface PaymentRequest {
  id: string
  url: string
  asset: AssetSymbol
  chain: ChainId
  amount?: number
  expiresAt: number
  singleUse: boolean
  shieldedReceiver: string
  zcashAccountId?: string
}

export interface PrivateBalanceState {
  totalUsd: number
  zecEquivalent: number | null
  shieldedZecBalance?: number | null
  onChainZecBackedUsd?: number | null
  /** null means the authoritative Zcash read is unavailable; 0 means confirmed zero. */
  fastAvailableToSendUsd?: number | null
  /** Exact ZEC quantity still inside the selected privacy maturity window. */
  immatureBufferedZec?: number
  zcashAccountAddress?: string
  zcashStateSynced?: boolean
  availableToSendUsd: number
  readyToSpendUsd: number
  shieldedWaitRemainingUsd: number
  shieldedWaitHoursRemaining: number
  privacyPolicy: PrivacyPolicy
  unconfirmedUsd: number
  vaultSynced: boolean
  orchardPoolSynced?: boolean // Backwards compatibility
  lastSyncedAt: number
  enclaveKeyFingerprint: string
  syncStatus?: 'synced' | 'syncing' | 'error'
}

export interface MarketRate {
  symbol: AssetSymbol
  usdPrice: number
  change24h: number
  lastUpdated: number
  status?: 'live' | 'unavailable' | 'stale'
}
