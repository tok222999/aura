import { NextResponse } from 'next/server'
import { solanaRelayer } from '@/lib/crypto/solana-relayer'
import { baseRelayer } from '@/lib/crypto/base-relayer'
import { zcashDevtoolService } from '@/lib/services/zcash-devtool-service'

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ success: false, error: 'NOT_FOUND' }, { status: 404 })
  }
  try {
    const solPubkey = solanaRelayer.getPublicKey()
    const solBal = await solanaRelayer.getBalance()
    const baseAddr = baseRelayer.getAddress()
    const baseBal = await baseRelayer.getBalances()
    const zcashBal = await zcashDevtoolService.getBalance().catch(() => ({ totalSpendable: 0 }))
    const zcashAddrs = await zcashDevtoolService.listAddresses().catch(() => ({} as { unified?: string }))

    return NextResponse.json({
      solana: {
        publicKey: solPubkey,
        balanceSol: solBal,
      },
      base: {
        relayerAddress: baseAddr,
        configured: baseRelayer.hasConfiguredKey(),
        ...baseBal,
      },
      zcash: {
        address: zcashAddrs.unified,
        ...zcashBal,
      },
    })
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
}
