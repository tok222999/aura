/**
 * Return a transaction-specific explorer URL for a verified receipt.
 * Legacy durable records may contain an address page or a retired host; a
 * real receipt identifier must always take precedence in the UI.
 */
export function canonicalExplorerUrl(chain: string | undefined, hash: string | undefined, fallback?: string) {
  if (!hash) return fallback
  if (chain === 'base' && /^0x[a-f0-9]{64}$/i.test(hash)) {
    return `https://sepolia.basescan.org/tx/${hash}`
  }
  if (chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(hash)) {
    return `https://solscan.io/tx/${hash}?cluster=devnet`
  }
  if (chain === 'zcash' && /^[a-f0-9]{64}$/i.test(hash)) {
    return `https://testnet.cipherscan.app/tx/${hash}`
  }
  return fallback
}
