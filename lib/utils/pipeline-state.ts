import type { AuraTransaction } from '@/lib/types/aura'
import { hasCompletedDestinationDelivery } from './transaction-finality'

export type PipelineStageStatus = 'idle' | 'processing' | 'confirmed' | 'finalized' | 'failed'

export interface PipelineStageState {
  status: PipelineStageStatus
  hash?: string
}

export interface PipelineState {
  entry: PipelineStageState
  shielding: PipelineStageState
  privateBalance: PipelineStageState & { usd: number }
  spend: PipelineStageState
  destination: PipelineStageState
}

function hashFor(kind: 'base' | 'zcash' | 'solana', value: string | undefined): boolean {
  if (!value) return false
  if (kind === 'base') return /^0x[a-f0-9]{64}$/i.test(value)
  if (kind === 'zcash') return /^[a-f0-9]{64}$/i.test(value)
  return /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)
}

/** One canonical interpretation of chain progress for every proof UI. */
export function buildPipelineState(input: {
  deposit?: AuraTransaction | null
  spend?: AuraTransaction | null
  privateBalanceUsd?: number
  privateBalanceSynced?: boolean
}): PipelineState {
  const deposit = input.deposit
  const spend = input.spend
  const entryHash = deposit?.legs?.deposit?.txHash
  const shieldHash = deposit?.legs?.shielded?.txHash
  const spendHash = spend?.legs?.shielded?.txHash
  const destinationHash = spend?.legs?.delivery?.txHash
  const destinationFinalized = hasCompletedDestinationDelivery(spend) && hashFor(
    spend?.toChain === 'solana' ? 'solana' : 'base',
    destinationHash,
  )
  const entryStatus: PipelineStageStatus = deposit?.legs?.deposit?.status === 'failed'
    ? 'failed' : deposit?.legs?.deposit?.status === 'confirmed' && hashFor('base', entryHash) ? 'confirmed' : deposit ? 'processing' : 'idle'
  const shieldingStatus: PipelineStageStatus = deposit?.legs?.shielded?.status === 'failed'
    ? 'failed' : deposit?.legs?.shielded?.status === 'confirmed' && hashFor('zcash', shieldHash) ? 'confirmed' : deposit ? 'processing' : 'idle'
  // A finalized destination means the user-facing payout completed. Older
  // records may still carry a failed/private-leg label after that payout, and
  // inventory-backed payments may intentionally have no fresh Zcash txid.
  // Neither case should be shown as a terminal user-payment failure.
  const spendSourceRecovering = destinationFinalized
  const spendStatus: PipelineStageStatus = spendSourceRecovering
    ? 'processing'
    : spend?.legs?.shielded?.status === 'failed' || spend?.status === 'failed'
      ? 'failed'
      : spend?.legs?.shielded?.status === 'confirmed' && hashFor('zcash', spendHash) ? 'confirmed' : spend ? 'processing' : 'idle'
  const destinationStatus: PipelineStageStatus = destinationFinalized
    ? 'finalized'
    : spend?.legs?.delivery?.status === 'failed' || spend?.status === 'failed'
      ? 'failed'
      : spend ? 'processing' : 'idle'

  return {
    entry: { status: entryStatus, hash: entryStatus === 'confirmed' ? entryHash : undefined },
    shielding: { status: shieldingStatus, hash: shieldingStatus === 'confirmed' ? shieldHash : undefined },
    privateBalance: {
      status: input.privateBalanceSynced === true ? 'confirmed' : shieldingStatus === 'confirmed' ? 'processing' : 'idle',
      usd: Number(input.privateBalanceUsd || 0),
    },
    spend: { status: spendStatus, hash: spendStatus === 'confirmed' || spendStatus === 'processing' ? spendHash : undefined },
    destination: { status: destinationStatus, hash: destinationStatus === 'finalized' ? destinationHash : undefined },
  }
}
