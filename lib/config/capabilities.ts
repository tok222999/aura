import type { AssetSymbol, ChainId } from '@/lib/types/aura'

export type CapabilityStatus = 'LIVE' | 'SOON' | 'PLANNED'

export type CapabilityOption = {
  id: string
  label: string
  icon: string
  description: string
  status: CapabilityStatus
}

/**
 * One source of truth for the routes shown in the product.
 * LIVE is intentionally limited to the verified hackathon path:
 * Base Sepolia USDC → Zcash Testnet → Solana Devnet SOL.
 */
export const AURA_CAPABILITIES = {
  entry: {
    networks: [
      { id: 'base', label: 'Base Sepolia', icon: 'base', description: 'Supported public entry · USDC', status: 'LIVE' },
      { id: 'solana', label: 'Solana Devnet', icon: 'solana', description: 'Coming next · SOL entry', status: 'SOON' },
      { id: 'ethereum', label: 'Ethereum', icon: 'ethereum', description: 'Planned public entry', status: 'PLANNED' },
      { id: 'arbitrum', label: 'Arbitrum', icon: 'arbitrum', description: 'Planned public entry', status: 'PLANNED' },
      { id: 'ton', label: 'TON', icon: 'ton', description: 'Planned public entry', status: 'PLANNED' },
      { id: 'bitcoin', label: 'Bitcoin', icon: 'btc', description: 'Planned public entry', status: 'PLANNED' },
    ] satisfies CapabilityOption[],
    assets: [{ id: 'USDC', label: 'USDC', chain: 'base', status: 'LIVE' }] satisfies Array<{ id: AssetSymbol; label: string; chain: ChainId; status: CapabilityStatus }>,
  },
  private: {
    network: { id: 'zcash', label: 'Zcash Testnet', icon: 'zcash', description: 'Private middle · ZEC', status: 'LIVE' } satisfies CapabilityOption,
    assets: [{ id: 'ZEC', label: 'ZEC', chain: 'zcash', status: 'LIVE' }] satisfies Array<{ id: AssetSymbol; label: string; chain: ChainId; status: CapabilityStatus }>,
  },
  destination: {
    networks: [
      { id: 'solana', label: 'Solana Devnet', icon: 'solana', description: 'Supported public exit · SOL', status: 'LIVE' },
      { id: 'base', label: 'Base Sepolia', icon: 'base', description: 'Coming next · USDC exit', status: 'SOON' },
      { id: 'ethereum', label: 'Ethereum', icon: 'ethereum', description: 'Planned public exit', status: 'PLANNED' },
      { id: 'arbitrum', label: 'Arbitrum', icon: 'arbitrum', description: 'Planned public exit', status: 'PLANNED' },
      { id: 'ton', label: 'TON', icon: 'ton', description: 'Planned public exit', status: 'PLANNED' },
      { id: 'bitcoin', label: 'Bitcoin', icon: 'btc', description: 'Planned public exit', status: 'PLANNED' },
    ] satisfies CapabilityOption[],
    assets: [{ id: 'SOL', label: 'SOL', chain: 'solana', status: 'LIVE' }] satisfies Array<{ id: AssetSymbol; label: string; chain: ChainId; status: CapabilityStatus }>,
  },
} as const

export const DEMO_ENTRY_NETWORKS = AURA_CAPABILITIES.entry.networks
export const DEMO_DESTINATION_NETWORKS = AURA_CAPABILITIES.destination.networks

export const AURA_ROUTE_MATRIX = [
  { route: 'Base Sepolia → Zcash Testnet → Solana Devnet', badge: 'ENABLED · TESTNET', isLive: true },
  { route: 'Ethereum → Zcash → Solana', badge: 'COMING NEXT', isLive: false },
  { route: 'Base → Zcash → Ethereum', badge: 'COMING NEXT', isLive: false },
  { route: 'Arbitrum → Zcash → Solana', badge: 'COMING NEXT', isLive: false },
] as const

export const PUBLIC_ASSET_CAPABILITIES = [
  { symbol: 'USDC', label: 'USDC', network: 'Base Sepolia', chain: 'base', status: 'LIVE', badge: 'ENABLED · TESTNET' },
  { symbol: 'SOL', label: 'SOL', network: 'Solana Devnet', chain: 'solana', status: 'SOON', badge: 'COMING NEXT' },
  { symbol: 'ETH', label: 'ETH', network: 'Ethereum', chain: 'ethereum', status: 'PLANNED', badge: 'COMING NEXT' },
  { symbol: 'USDT', label: 'USDT', network: 'Ethereum', chain: 'ethereum', status: 'PLANNED', badge: 'COMING NEXT' },
] as const

export const PUBLIC_ASSET_ROUTE_OPTIONS = PUBLIC_ASSET_CAPABILITIES.filter(
  (asset) => asset.symbol === 'USDC' || asset.symbol === 'SOL',
)

export const PUBLIC_DESTINATION_ASSET_OPTIONS = [
  { symbol: 'USDC', label: 'USDC', network: 'Base Sepolia', chain: 'base', status: 'SOON', badge: 'COMING NEXT' },
  { symbol: 'SOL', label: 'SOL', network: 'Solana Devnet', chain: 'solana', status: 'LIVE', badge: 'ENABLED · TESTNET' },
] as const

export function isLiveCapability(status: CapabilityStatus): boolean {
  return status === 'LIVE'
}
