import { NextResponse } from 'next/server'
import { BIP39_WORDLIST } from '@/lib/crypto/bip39'

export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ success: false, error: 'NOT_FOUND' }, { status: 404 })
  }
  try {
    const res = await fetch('https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt')
    if (!res.ok) {
      return NextResponse.json({ success: false, error: 'Failed to fetch official BIP-39 wordlist' }, { status: 502 })
    }

    const text = await res.text()
    const words = text.trim().split('\n').map((w: string) => w.trim()).filter(Boolean)

    if (words.length !== 2048) {
      return NextResponse.json({ success: false, error: `Invalid count: ${words.length}` }, { status: 500 })
    }

    const isMatch = words.length === BIP39_WORDLIST.length && words[0] === BIP39_WORDLIST[0] && words[2047] === BIP39_WORDLIST[2047]

    return NextResponse.json({
      success: true,
      verified: isMatch,
      count: words.length,
      localCount: BIP39_WORDLIST.length,
      firstWord: words[0],
      lastWord: words[2047],
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
