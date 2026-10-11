export function canonicalizeTransactionHash(chain: string, txHash: string): string {
  return chain.toLowerCase() === 'base' ? txHash.toLowerCase() : txHash
}

export function canonicalizeChainAddress(chain: string, address: string): string {
  return chain.toLowerCase() === 'base' ? address.toLowerCase() : address
}

export function createPaymentAuthorizationMessage(input: {
  requestId: string
  txHash: string
  amountCents: number
  asset: string
  chain: string
}): string {
  return [
    'Aura invoice payment authorization v1',
    `Invoice: ${input.requestId}`,
    `Transaction: ${canonicalizeTransactionHash(input.chain, input.txHash)}`,
    `Amount (cents): ${input.amountCents}`,
    `Asset: ${input.asset}`,
    `Network: ${input.chain}`,
  ].join('\n')
}

export function createPaymentRecoveryAuthorizationMessage(input: {
  requestId: string
  amountCents: number
  asset: string
  chain: string
  payerAddress: string
}): string {
  return [
    'Aura invoice payment recovery v1',
    `Invoice: ${input.requestId}`,
    `Payer: ${canonicalizeChainAddress(input.chain, input.payerAddress)}`,
    `Amount (cents): ${input.amountCents}`,
    `Asset: ${input.asset}`,
    `Network: ${input.chain}`,
    'Purpose: recover a source transfer after client interruption',
  ].join('\n')
}

export function createPaymentPreparationMessage(input: {
  requestId: string
  minimumAmountCents: number
  asset: string
  chain: string
  payerAddress: string
}): string {
  return [
    'Aura invoice payment preparation v1',
    `Invoice: ${input.requestId}`,
    `Payer: ${canonicalizeChainAddress(input.chain, input.payerAddress)}`,
    `Minimum amount (cents): ${input.minimumAmountCents}`,
    `Asset: ${input.asset}`,
    `Network: ${input.chain}`,
    'Purpose: bind the payer before an open-amount transfer',
  ].join('\n')
}
