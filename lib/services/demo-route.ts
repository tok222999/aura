import type { AssetSymbol, ChainId } from '@/lib/types/aura'

/**
 * The hackathon demo has one deliberately narrow public-entry route.
 * Keep this rule shared by invoice creation, viewing, editing and settlement
 * so an old/legacy request cannot silently reopen a roadmap route.
 */
export const WORKING_DEMO_ROUTE_MESSAGE =
  'The working demo accepts Base Sepolia USDC entry only. Other networks are coming next.'

export function isWorkingDemoEntryRoute(chain: ChainId | string | undefined, asset: AssetSymbol | string | undefined): boolean {
  return String(chain || '').toLowerCase() === 'base' && String(asset || '').toUpperCase() === 'USDC'
}
