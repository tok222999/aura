import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const artifactPath = path.resolve(root, process.env.AURA_VERIFIED_PROOF_PATH || 'public/verified-proof.json')
const BASE_HASH = /^0x[a-f0-9]{64}$/i
const ZCASH_HASH = /^[a-f0-9]{64}$/i
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0
}

function verify(item, hashPattern, network, status) {
  return item && hashPattern.test(String(item.hash || '')) &&
    item.network === network && item.status === status && timestamp(item.timestamp) &&
    timestamp(item.observedAt) && item.observedAt >= item.timestamp &&
    (item.blockHeight === undefined || (Number.isSafeInteger(item.blockHeight) && item.blockHeight > 0)) &&
    (item.confirmations === undefined || (Number.isSafeInteger(item.confirmations) && item.confirmations > 0))
}

function verifyBaseFinality(item) {
  const confirmationStatus = String(item?.confirmationStatus || '')
  const confirmations = Number(item?.confirmations)
  const blockHeight = Number(item?.blockHeight)
  return /^0x[a-f0-9]{64}$/i.test(String(item?.blockHash || '')) &&
    Number.isSafeInteger(blockHeight) && blockHeight > 0 &&
    Number.isSafeInteger(confirmations) && confirmations >= 3 &&
    ['safe', 'finalized', 'depth'].includes(confirmationStatus)
}

let artifact
try {
  artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
} catch (error) {
  console.error(`Public proof could not be read: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

let readme = ''
try {
  readme = fs.readFileSync(path.resolve(root, 'README.md'), 'utf8')
} catch {
  // The sanitized artifact can still be checked in isolation.
}

const proofValues = [
  artifact?.proof?.base?.hash,
  artifact?.proof?.shielding?.hash,
  artifact?.proof?.spend?.hash,
  artifact?.proof?.solana?.hash,
].filter(Boolean)
const documentationMatchesArtifact = !readme || proofValues.every((value) => readme.includes(String(value)))

const passed = artifact?.schemaVersion === 'aura-verified-proof-v1' &&
  typeof artifact.source === 'string' &&
  timestamp(artifact.verifiedAt) &&
  timestamp(artifact.observedAt) && artifact.observedAt >= artifact.verifiedAt &&
  Number.isFinite(artifact.privateBalanceUsd) && artifact.privateBalanceUsd > 0 &&
  verify(artifact.proof?.base, BASE_HASH, 'Base Sepolia', 'confirmed') &&
  verifyBaseFinality(artifact.proof?.base) &&
  verify(artifact.proof?.shielding, ZCASH_HASH, 'Zcash Testnet', 'confirmed') &&
  verify(artifact.proof?.spend, ZCASH_HASH, 'Zcash Testnet', 'confirmed') &&
  verify(artifact.proof?.solana, SOLANA_SIGNATURE, 'Solana Devnet', 'finalized') &&
  documentationMatchesArtifact

console.log('AURA PUBLIC PROOF ARTIFACT CHECK')
console.log(`Artifact: ${path.relative(root, artifactPath)}`)
console.log(`Ledger checkpoint: ${passed ? `$${Number(artifact.balanceCheckpoint?.beforeUsd || 0).toFixed(2)} → $${Number(artifact.balanceCheckpoint?.afterUsd || 0).toFixed(2)}` : 'invalid'}`)
console.log(`ZEC-backed value at verification: ${passed ? `≈$${Number(artifact.privateBalanceUsd).toFixed(2)}` : 'invalid'}`)
console.log(`Base: ${passed ? artifact.proof.base.hash : 'invalid'}`)
console.log(`Zcash shielding: ${passed ? artifact.proof.shielding.hash : 'invalid'}`)
console.log(`Zcash shielding block: ${passed ? artifact.proof.shielding.blockHeight || 'not supplied' : 'invalid'}`)
console.log(`Zcash spend: ${passed ? artifact.proof.spend.hash : 'invalid'}`)
console.log(`Zcash spend block: ${passed ? artifact.proof.spend.blockHeight || 'not supplied' : 'invalid'}`)
console.log(`Solana: ${passed ? artifact.proof.solana.hash : 'invalid'}`)
console.log(`README matches artifact: ${documentationMatchesArtifact ? 'yes' : 'no'}`)
console.log(`STATUS: ${passed ? 'ARTIFACT CHECK PASSED — not a live chain verification' : 'ARTIFACT CHECK FAILED'}`)
if (!passed) process.exitCode = 1
