'use client'

import { useEffect, useState } from 'react'
import type { AuraTransaction } from '@/lib/types/aura'
import { ExternalLinkIcon } from '@/components/aura-icons'

type ProofItem = { hash?: string; network: string; status: string; timestamp?: number; confirmationStatus?: string; confirmations?: number }
export type VerifiedProof = {
  base?: ProofItem
  shielding?: ProofItem
  spend?: ProofItem
  solana?: ProofItem
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
}

type VerifiedReceiptCardProps = {
  deposit?: AuraTransaction | null
  spend?: AuraTransaction | null
  privateBalanceUsd?: number
  privateBalanceBeforeUsd?: number
  checkpointAfterUsd?: number
  depositCreditedUsd?: number
  savedProof?: VerifiedProof | null
  savedAt?: number
  unavailable?: boolean
}

function validHash(hash: string | undefined, kind: 'base' | 'zcash' | 'solana') {
  if (!hash) return false
  if (kind === 'base') return /^0x[a-f0-9]{64}$/i.test(hash)
  if (kind === 'zcash') return /^[a-f0-9]{64}$/i.test(hash)
  return /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(hash)
}

function explorerUrl(item: ProofItem, kind: 'base' | 'zcash' | 'solana') {
  if (!item.hash) return ''
  if (kind === 'base') return `https://sepolia.basescan.org/tx/${item.hash}`
  if (kind === 'zcash') return `https://testnet.cipherscan.app/tx/${item.hash}`
  return `https://solscan.io/tx/${item.hash}?cluster=devnet`
}

function fromTransactions(deposit?: AuraTransaction | null, spend?: AuraTransaction | null): VerifiedProof {
  const sharedPoolBacking = deposit?.settlementMode === 'jury_inventory' && deposit.backingSource === 'confirmed_zcash_inventory'
  const destinationFinalized = Boolean(
    spend?.toChain === 'solana' &&
    spend.status === 'completed' &&
    spend.legs?.delivery?.status === 'confirmed' &&
    spend.legs.delivery.confirmationStatus === 'finalized' &&
    validHash(spend.legs.delivery.txHash, 'solana'),
  )
  const spendStatus = destinationFinalized && validHash(spend?.legs?.shielded?.txHash, 'zcash')
    ? 'broadcasting'
    : spend?.status === 'failed'
      ? 'failed'
      : spend?.legs?.shielded?.status
  return {
    base: deposit?.legs?.deposit ? { hash: deposit.legs.deposit.txHash, network: 'Base Sepolia', status: deposit.status === 'failed' ? 'failed' : deposit.legs.deposit.status, timestamp: deposit.legs.deposit.timestamp } : undefined,
    shielding: deposit?.legs?.shielded ? { hash: deposit.legs.shielded.txHash, network: sharedPoolBacking ? 'Zcash Testnet pool' : 'Zcash Testnet', status: deposit.status === 'failed' ? 'failed' : deposit.legs.shielded.status, confirmationStatus: deposit.legs.shielded.confirmationStatus, timestamp: deposit.legs.shielded.timestamp } : undefined,
    spend: spend?.legs?.shielded ? { hash: spend.legs.shielded.txHash, network: 'Zcash Testnet', status: spendStatus || 'pending', confirmationStatus: spend.legs.shielded.confirmationStatus, timestamp: spend.legs.shielded.timestamp } : undefined,
    solana: spend?.legs?.delivery ? { hash: spend.legs.delivery.txHash, network: 'Solana Devnet', status: spend.status === 'failed' ? 'failed' : (spend.legs.delivery.confirmationStatus || spend.legs.delivery.status), confirmationStatus: spend.legs.delivery.confirmationStatus, timestamp: spend.legs.delivery.timestamp } : undefined,
  }
}

export function VerifiedReceiptCard({ deposit, spend, privateBalanceUsd, privateBalanceBeforeUsd, checkpointAfterUsd, depositCreditedUsd, savedProof, savedAt, unavailable }: VerifiedReceiptCardProps) {
  const hasAccountTx = Boolean(deposit || spend)
  const proof = hasAccountTx ? fromTransactions(deposit, spend) : (savedProof || fromTransactions(deposit, spend))
  const live = hasAccountTx
  const hasSharedPoolBacking = deposit?.settlementMode === 'jury_inventory' && deposit.backingSource === 'confirmed_zcash_inventory'
  const hasDepositOk = validHash(proof.base?.hash, 'base') && (proof.base?.status === 'confirmed' || proof.base?.status === 'finalized')
  const hasShieldOk = (validHash(proof.shielding?.hash, 'zcash') || hasSharedPoolBacking) && proof.shielding?.status === 'confirmed'
  const hasBalanceOk = Number(privateBalanceUsd || 0) > 0
  const hasSpendOk = validHash(proof.spend?.hash, 'zcash') && proof.spend?.status === 'confirmed'
  const hasSolanaOk = validHash(proof.solana?.hash, 'solana') && proof.solana?.status === 'finalized'
  const hasSpendBroadcasted = validHash(proof.spend?.hash, 'zcash') && ['broadcasting', 'broadcasted', 'confirmed', 'completed'].includes(proof.spend?.status || '')
  const hasSpendReceipt = hasSpendOk || (hasSpendBroadcasted && hasSolanaOk)
  const spendFailed = proof.spend?.status === 'failed'
  // A private-leg failure/recovery flag must never erase a finalized
  // destination receipt. The Solana row reflects only Solana's own leg.
  const solanaFailed = proof.solana?.status === 'failed'

  const fullPipelineComplete = hasDepositOk && hasShieldOk && hasBalanceOk && hasSpendReceipt && hasSolanaOk
  const depositPhaseComplete = hasDepositOk && hasShieldOk && hasBalanceOk
  const isComplete = fullPipelineComplete || (hasAccountTx && depositPhaseComplete) || (!hasAccountTx && Boolean(savedProof))

  const baseLabel = proof.base?.confirmationStatus === 'finalized' ? 'Base Entry · Finalized' : 'Base Entry · Included'
  const rows = [
    { label: baseLabel, item: proof.base, kind: 'base' as const, ok: hasDepositOk },
    { label: hasSharedPoolBacking ? 'Private backing · Confirmed Zcash pool' : 'Private Zcash step · Confirmed', item: proof.shielding, kind: 'zcash' as const, ok: hasShieldOk },
    { label: 'Private Balance · Shielded', item: undefined, kind: 'zcash' as const, ok: hasBalanceOk },
    { label: hasSpendOk ? 'Private Zcash payment · Confirmed' : spendFailed ? 'Private Zcash payment · Failed' : hasSpendBroadcasted && hasSolanaOk ? 'Private Zcash payment · Broadcasted · confirmation async' : proof.spend?.hash ? 'Private Zcash payment · Processing' : 'Private Zcash payment · Ready on send', item: proof.spend, kind: 'zcash' as const, ok: hasSpendReceipt },
    { label: hasSolanaOk ? 'Solana payout · Finalized' : solanaFailed ? 'Solana payout · Not sent' : proof.solana?.hash ? 'Solana payout · Processing' : 'Solana payout · Ready on payment', item: proof.solana, kind: 'solana' as const, ok: hasSolanaOk },
  ]
  const [showProof, setShowProof] = useState(false)

  const badgeText = fullPipelineComplete && live
    ? 'FOR JUDGES · CURRENT TESTNET EXECUTION RECEIPT'
    : (hasAccountTx && depositPhaseComplete)
      ? 'FOR JUDGES · YOUR ACCOUNT TESTNET DEPOSIT RECEIPT'
      : (!hasAccountTx && savedProof)
        ? 'FOR JUDGES · REFERENCE BENCHMARK RUN · OPERATOR-VERIFIED'
        : 'FOR JUDGES · LIVE DEMO CONNECTING'

  const titleText = fullPipelineComplete && live
    ? 'Current testnet deposit + private balance + verified payout'
    : (hasAccountTx && depositPhaseComplete)
      ? (hasSharedPoolBacking
        ? 'Testnet deposit confirmed on Base Sepolia & backed by the confirmed Zcash pool'
        : 'Testnet deposit confirmed on Base Sepolia & shielded in private balance')
      : (!hasAccountTx && savedProof)
        ? 'Full 3-chain testnet benchmark · Pre-verified for evaluation'
        : unavailable
          ? 'No live account receipts yet'
          : 'Waiting for real chain receipts'

  return (
    <section style={{ border: `1px solid ${isComplete ? '#d7e9df' : '#eadff4'}`, borderRadius: 16, background: '#fff', padding: 18, marginBottom: 20, boxShadow: '0 8px 24px rgba(31, 24, 56, .05)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ color: isComplete ? '#16805c' : 'var(--violet)', fontSize: 11, fontWeight: 800, letterSpacing: '.08em' }}>
            {badgeText}
          </div>
          <strong style={{ display: 'block', fontSize: 17, marginTop: 5, color: '#191820' }}>
            {titleText}
          </strong>
          {!hasAccountTx && savedProof && savedAt ? (
            <span style={{ color: '#77727d', fontSize: 11 }}>
              Reference benchmark run · {new Date(savedAt).toLocaleString()} · Your account transactions will appear here as soon as you deposit or send
            </span>
          ) : hasAccountTx ? (
            <span style={{ color: '#16805c', fontSize: 11, fontWeight: 600 }}>
              {hasSharedPoolBacking
                ? 'Live account transactions · Base verified and backed by confirmed Zcash inventory'
                : 'Live account transactions · verified on Base Sepolia and Zcash Testnet'}
            </span>
          ) : null}
        </div>
        <button type="button" onClick={() => setShowProof((value) => !value)} style={{ border: '1px solid #d9d0ff', background: 'var(--lav)', color: 'var(--violet)', borderRadius: 9, padding: '7px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>
          {showProof ? 'Hide Proof' : 'View Proof'}
        </button>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 24 }}>
            <span style={{ color: row.ok ? '#16805c' : '#aaa2b2', fontWeight: 900 }}>{row.ok ? '✓' : '○'}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#25212d', flex: 1 }}>{row.label}</span>
            {row.item?.hash && showProof ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
              <span style={{ color: '#77727d', fontSize: 10 }}>{row.item.network} · {row.item.confirmationStatus || row.item.status}{row.item.confirmations ? ` · ${row.item.confirmations} confirmations` : ''} · {row.item.timestamp ? new Date(row.item.timestamp).toLocaleString() : 'time unavailable'}</span>
              <a href={explorerUrl(row.item, row.kind)} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: 'var(--violet)', fontFamily: 'var(--font-ui)', fontSize: 10, textDecoration: 'none' }}>{row.item.hash.slice(0, 12)}… <ExternalLinkIcon size={11} color="currentColor" /></a>
            </span> : null}
          </div>
        ))}
      </div>
      {showProof ? <div style={{ color: '#77727d', fontSize: 11, lineHeight: 1.5, marginTop: 10 }}>Base proof uses inclusion and finality metadata when available. {hasSharedPoolBacking ? 'This deposit is backed by the confirmed shielded Zcash pool; it has no per-deposit Zcash txid.' : 'Zcash rows show the recorded broadcast and confirmation state.'} Solana is accepted only at finalized status. A Zcash txid proves the private transaction was broadcast; it does not reveal its private recipient or amount.</div> : null}
      {showProof && isComplete ? <div style={{ color: '#77727d', fontSize: 11, lineHeight: 1.5, margin: '12px 0 0', borderTop: '1px solid #eeeaf2', paddingTop: 10 }}>
        <div>Deposit credited: <strong style={{ color: '#16805c' }}>+${Number(depositCreditedUsd || 0).toFixed(2)}</strong></div>
        <div>Deposit checkpoint: <strong style={{ color: '#16805c' }}>${Number(savedProof?.balanceMark?.depositCheckpointUsd ?? checkpointAfterUsd ?? 0).toFixed(2)}</strong></div>
        <div>Marked value at verification: <strong style={{ color: '#25212d' }}>≈${Number(savedProof?.balanceMark?.verificationMarkUsd ?? privateBalanceUsd ?? 0).toFixed(2)}</strong></div>
        <div>Conversion record: ${Number(savedProof?.balanceMark?.sourceAmountUsd ?? depositCreditedUsd ?? 0).toFixed(2)} → {savedProof?.balanceMark?.backingZec ? `${savedProof.balanceMark.backingZec.toFixed(6)} ZEC` : 'ZEC quantity not recorded'}</div>
        <div>Rates: entry {savedProof?.balanceMark?.entryRateUsdPerZec ? `$${savedProof.balanceMark.entryRateUsdPerZec.toFixed(2)}/ZEC` : 'not recorded'} · verification {savedProof?.balanceMark?.verificationRateUsdPerZec ? `$${savedProof.balanceMark.verificationRateUsdPerZec.toFixed(2)}/ZEC` : 'not recorded'}</div>
        <div>Recorded network fee: <strong>${Number(savedProof?.balanceMark?.networkFeeUsd ?? 0).toFixed(2)}</strong> · mark difference: <strong>${Number(savedProof?.balanceMark?.markDifferenceUsd ?? 0).toFixed(2)}</strong></div>
        <div style={{ marginTop: 4 }}>Ledger checkpoint: ${Number(privateBalanceBeforeUsd || 0).toFixed(2)} before → ${Number(checkpointAfterUsd ?? privateBalanceBeforeUsd ?? 0).toFixed(2)} after. {savedProof?.balanceMark?.reason || 'The current ZEC mark is shown separately and is not an Aura fee.'}</div>
        <div style={{ marginTop: 4 }}>The receipt shows real network identifiers; visual animation is not proof. This demo does not claim a cryptographic Zcash payment-disclosure proof; a production disclosure would be scoped to the transaction and shared only with its intended verifier.</div>
      </div> : null}
    </section>
  )
}
