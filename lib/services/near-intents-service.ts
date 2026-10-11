/**
 * Testnet route metadata and proof commitments.
 * This module does not execute NEAR Intents swaps or generate provider quotes.
 */

import {
  AssetSymbol,
  ChainId,
  TransactionLeg,
  ZeroKnowledgeProofData,
} from '../types/aura'
import { sha256Sync } from '../crypto/bip39'

export function getDefaultChainForAsset(asset: AssetSymbol): ChainId {
  if (asset === 'SOL') return 'solana'
  if (asset === 'ZEC') return 'zcash'
  return 'base'
}

/**
 * Historical class name retained because the rest of the app imports it.
 * The hackathon implementation is a test-only route; production NEAR Intents
 * execution and live quotes are not implemented here.
 */
export class NearIntentsAdapter {
  /**
   * Builds transaction legs from submitted receipt identifiers.
   * A hash/txid/signature proves only that a receipt identifier exists; it
   * does not prove chain inclusion. Callers must set `confirmed` only after
   * verifying the relevant chain's receipt/status.
   */
  public generateRoutingLegs(
    type: 'deposit' | 'send' | 'withdraw' | 'receive',
    fromChain: ChainId,
    toChain: ChainId,
    txId: string,
    recipientAddress?: string,
    onChainTxHash?: string,
    zcashTxHash?: string
  ): {
    deposit?: TransactionLeg
    shielded?: TransactionLeg
    delivery?: TransactionLeg
  } {
    const timestamp = Date.now()
    const solverVault = '0x84bE03816773229bBcE6e422D7702f23fD6Ec10e'
    const solanaUsdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

    const finalZcashHash = zcashTxHash || undefined
    const zcashExplorer = zcashTxHash && /^[0-9a-fA-F]{64}$/.test(zcashTxHash)
      ? `https://testnet.cipherscan.app/tx/${zcashTxHash}`
      : undefined

    if (type === 'deposit' || type === 'receive') {
      const explorer = fromChain === 'base'
        ? (onChainTxHash ? `https://sepolia.basescan.org/tx/${onChainTxHash}` : `https://sepolia.basescan.org/address/${solverVault}`)
        : fromChain === 'solana'
        ? (onChainTxHash ? `https://solscan.io/tx/${onChainTxHash}?cluster=devnet` : (recipientAddress ? `https://solscan.io/account/${recipientAddress}?cluster=devnet` : `https://solscan.io/token/${solanaUsdcMint}?cluster=devnet`))
        : `https://sepolia.etherscan.io/address/${solverVault}`

      return {
        deposit: {
          chain: fromChain,
          description: `Deposit transfer on ${fromChain.toUpperCase()}`,
          txHash: onChainTxHash,
          explorerUrl: explorer,
          status: onChainTxHash ? 'broadcasting' : 'pending',
          timestamp: timestamp - 4000,
        },
        shielded: {
          chain: 'zcash',
          description: zcashTxHash
            ? `Shielded transaction submitted to Zcash Testnet (Tx #${zcashTxHash.slice(0, 16)}...); awaiting confirmation.`
            : 'Shielded note registered in client enclave vault (pending Zcash broadcast)',
          txHash: finalZcashHash,
          explorerUrl: zcashExplorer,
          status: zcashTxHash ? 'broadcasting' : 'enclave_committed',
          timestamp,
        },
      }
    }

    // Send or Withdraw
    const destExplorer = toChain === 'solana'
      ? (onChainTxHash ? `https://solscan.io/tx/${onChainTxHash}?cluster=devnet` : (recipientAddress ? `https://solscan.io/account/${recipientAddress}?cluster=devnet` : `https://solscan.io/token/${solanaUsdcMint}?cluster=devnet`))
      : toChain === 'base'
      ? (onChainTxHash ? `https://sepolia.basescan.org/tx/${onChainTxHash}` : `https://sepolia.basescan.org/address/${solverVault}`)
      : `https://sepolia.etherscan.io/address/${solverVault}`

    return {
      shielded: {
        chain: 'zcash',
        description: zcashTxHash
          ? `Shielded note spent on Zcash Testnet (Tx #${zcashTxHash.slice(0, 16)}...)`
          : 'Client spending authorization verified locally in WebCrypto enclave',
        txHash: finalZcashHash,
        explorerUrl: zcashExplorer,
        status: zcashTxHash ? 'broadcasting' : 'enclave_authorized',
        timestamp: timestamp - 2000,
      },
      delivery: {
        chain: toChain,
        description: `Testnet payout on ${toChain.toUpperCase()} to recipient`,
        txHash: onChainTxHash,
        explorerUrl: destExplorer,
        status: onChainTxHash ? 'broadcasting' : 'pending',
        timestamp,
      },
    }
  }

  /**
   * Generates genuine cryptographic audit metadata for transaction tracking.
   * SHA-256 intent commitment.
   */
  public generateAuditCommitment(commitmentInput?: string): ZeroKnowledgeProofData {
    const randBytes = new Uint8Array(8)
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(randBytes)
    }
    const randHex = Array.from(randBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const input = commitmentInput || `aura_commitment_${Date.now()}_${randHex}`
    const enc = new TextEncoder()
    const hash = sha256Sync(enc.encode(input))
    const clientCommitmentHash = `0x${Array.from(hash)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`

    return {
      privacyRoutingType: 'intent_shielded_vault',
      clientCommitmentHash,
      intermediateHopExecuted: false,
      // These fields indicate route decoupling intent, not guaranteed cryptographic unlinkability
      senderUnlinked: false,
      recipientUnlinked: false,
      auditStatus: 'pending',
      zkProofType: 'SHA-256 Intent Commitment (not a zero-knowledge proof)',
      verifiedLocally: false,
      orchardActionCount: 0,
    }
  }
}

// Export both standard and backward-compatible alias
export const NearIntentsService = NearIntentsAdapter
export const MockNearIntentsAdapter = NearIntentsAdapter
export const nearIntentsService = new NearIntentsAdapter()
