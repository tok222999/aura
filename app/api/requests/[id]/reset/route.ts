import { NextResponse } from 'next/server'

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: 'RESET_PROHIBITED',
      message: 'Payment requests are strictly single-use cryptographic routes. Re-activating a consumed or expired invoice violates forward secrecy and replay-protection invariants.',
    },
    { status: 403 }
  )
}
