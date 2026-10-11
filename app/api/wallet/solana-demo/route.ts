import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { solanaRelayer } from '@/lib/crypto/solana-relayer'
import { InMemoryRateLimiter } from '@/lib/utils/rate-limiter'
import { getTrustedClientId, hasJuryAccess } from '@/lib/services/demo-session-service'

const airdropLimiter = new InMemoryRateLimiter(1, 60)

export async function GET(req: NextRequest) {
  try {
    const privileged = hasJuryAccess(req.headers, req.cookies.get('aura_jury_session')?.value || '')
    const recipientPublicKey = solanaRelayer.getDemoRecipientPublicKey()
    if (!recipientPublicKey) {
      return NextResponse.json({ success: false, error: 'SOLANA_WALLET_UNAVAILABLE' }, { status: 503 })
    }
    // The controlled recipient is durable state; a temporary RPC read failure
    // must not make that recipient disappear or turn an unavailable balance
    // into a misleading zero.
    const [balance, recipientBalance] = await Promise.all([
      solanaRelayer.getBalance().catch(() => null),
      solanaRelayer.getBalanceForAddress(recipientPublicKey).catch(() => null),
    ])

    return NextResponse.json({
      success: true,
      ...(privileged ? { recipientPublicKey } : {}),
      recipientType: 'server-persisted-controlled-demo',
      recipientReady: Boolean(recipientPublicKey),
      recipientBalance: privileged ? recipientBalance : null,
      balanceAvailable: privileged && balance !== null,
      recipientBalanceAvailable: privileged && recipientBalance !== null,
      network: 'Solana Devnet',
      solBalance: privileged ? balance : null,
      ...(privileged ? {
        explorerUrl: `https://explorer.solana.com/address/${recipientPublicKey}?cluster=devnet`,
        recipientExplorerUrl: `https://explorer.solana.com/address/${recipientPublicKey}?cluster=devnet`,
      } : {}),
      scope: privileged ? 'jury' : 'public',
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ success: false, error: 'NOT_FOUND' }, { status: 404 })
  }
  const identifier = getTrustedClientId(req.headers)
  const rate = airdropLimiter.check(identifier)
  if (!rate.allowed) {
    return NextResponse.json({ success: false, error: 'RATE_LIMITED' }, {
      status: 429,
      headers: { 'Retry-After': String(rate.retryAfter || 60) },
    })
  }
  const result = await solanaRelayer.requestAirdrop(1)
  // The airdrop may already have been accepted even if the follow-up balance
  // read fails. Preserve and return the signature instead of masking the
  // successful request with a 500 response.
  const balance = await solanaRelayer.getBalance().catch(() => null)
  return NextResponse.json({ ...result, newBalance: balance })
}
