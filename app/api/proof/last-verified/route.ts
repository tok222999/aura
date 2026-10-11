import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const BASE_HASH = /^0x[a-f0-9]{64}$/i
const ZCASH_HASH = /^[a-f0-9]{64}$/i
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/

type ProofItem = {
  hash: string
  network: string
  status: 'confirmed' | 'finalized'
  timestamp: number
  observedAt?: number
  blockHeight?: number
  blockTime?: number
  confirmations?: number
  confirmationStatus?: 'safe' | 'finalized'
  blockHash?: string
  confirmationSource?: string
}

type PublicProofArtifact = {
  schemaVersion: 'aura-verified-proof-v1'
  source: string
  verifiedAt: number
  observedAt: number
  privateBalanceUsd: number
  balanceCheckpoint?: { beforeUsd?: number; afterUsd: number; deltaUsd?: number }
  balanceMark?: {
    depositCheckpointUsd?: number
    verificationMarkUsd?: number
    sourceAmountUsd?: number
    backingZec?: number
    entryRateUsdPerZec?: number
    verificationRateUsdPerZec?: number
    networkFeeUsd?: number
    markDifferenceUsd?: number
    reason?: string
  }
  recipient?: string
  proof: {
    base: ProofItem
    shielding: ProofItem
    spend: ProofItem
    solana: ProofItem
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function hasBaseFinalityProof(item: ProofItem): boolean {
  return /^0x[a-f0-9]{64}$/i.test(String(item.blockHash || '')) &&
    Number.isSafeInteger(item.blockHeight) && Number(item.blockHeight) > 0 &&
    Number.isSafeInteger(item.confirmations) && Number(item.confirmations) >= 1 &&
    ['safe', 'finalized'].includes(String(item.confirmationStatus || ''))
}

function isPublicProof(value: unknown): value is PublicProofArtifact {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PublicProofArtifact>
  const proof = candidate.proof
  if (
    candidate.schemaVersion !== 'aura-verified-proof-v1' ||
    typeof candidate.source !== 'string' ||
    !isTimestamp(candidate.verifiedAt) ||
    !isTimestamp(candidate.observedAt) ||
    candidate.observedAt < candidate.verifiedAt ||
    typeof candidate.privateBalanceUsd !== 'number' ||
    !Number.isFinite(candidate.privateBalanceUsd) ||
    candidate.privateBalanceUsd <= 0 ||
    !proof ||
    !BASE_HASH.test(String(proof.base?.hash || '')) ||
    proof.base.network !== 'Base Sepolia' ||
    proof.base.status !== 'confirmed' ||
    !hasBaseFinalityProof(proof.base) ||
    !isTimestamp(proof.base.timestamp) ||
    !isTimestamp(proof.base.observedAt) ||
    proof.base.observedAt < proof.base.timestamp ||
    !ZCASH_HASH.test(String(proof.shielding?.hash || '')) ||
    proof.shielding.network !== 'Zcash Testnet' ||
    proof.shielding.status !== 'confirmed' ||
    !isTimestamp(proof.shielding.timestamp) ||
    !isTimestamp(proof.shielding.observedAt) ||
    proof.shielding.observedAt < proof.shielding.timestamp ||
    !Number.isSafeInteger(proof.shielding.blockHeight) ||
    Number(proof.shielding.blockHeight) <= 0 ||
    !ZCASH_HASH.test(String(proof.spend?.hash || '')) ||
    proof.spend.network !== 'Zcash Testnet' ||
    proof.spend.status !== 'confirmed' ||
    !isTimestamp(proof.spend.timestamp) ||
    !isTimestamp(proof.spend.observedAt) ||
    proof.spend.observedAt < proof.spend.timestamp ||
    !Number.isSafeInteger(proof.spend.blockHeight) ||
    Number(proof.spend.blockHeight) <= 0 ||
    !SOLANA_SIGNATURE.test(String(proof.solana?.hash || '')) ||
    proof.solana.network !== 'Solana Devnet' ||
    proof.solana.status !== 'finalized' ||
    !isTimestamp(proof.solana.timestamp) ||
    !isTimestamp(proof.solana.observedAt) ||
    proof.solana.observedAt < proof.solana.timestamp
  ) return false

  if (candidate.balanceCheckpoint) {
    if (
      typeof candidate.balanceCheckpoint.afterUsd !== 'number' ||
      !Number.isFinite(candidate.balanceCheckpoint.afterUsd) ||
      candidate.balanceCheckpoint.afterUsd <= 0 ||
      (candidate.balanceCheckpoint.beforeUsd !== undefined &&
        (typeof candidate.balanceCheckpoint.beforeUsd !== 'number' || !Number.isFinite(candidate.balanceCheckpoint.beforeUsd)))
    ) return false
  }
  return true
}

async function readJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

async function loadProofArtifact(): Promise<PublicProofArtifact | null> {
  // The public route reads only the reviewed, sanitized artifact. It never
  // scans private runtime state or invents a verification timestamp.
  const publicArtifact = path.join(process.cwd(), 'public', 'verified-proof.json')
  const publicValue = await readJson(publicArtifact)
  return isPublicProof(publicValue) ? publicValue : null
}

export async function GET() {
  const artifact = await loadProofArtifact()
  if (!artifact) {
    return NextResponse.json({ success: true, available: false }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json({
    success: true,
    available: true,
    source: artifact.source,
    verifiedAt: artifact.verifiedAt,
    observedAt: artifact.observedAt,
    privateBalanceUsd: artifact.privateBalanceUsd,
    balanceCheckpoint: artifact.balanceCheckpoint,
    balanceMark: artifact.balanceMark,
    recipient: artifact.recipient || '',
    proof: artifact.proof,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
