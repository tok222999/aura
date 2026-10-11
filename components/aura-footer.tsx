import Link from 'next/link'
import { AuraLogo } from './aura-logo'

export function AuraFooter() {
  return (
    <footer>
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
          <AuraLogo height={30} />
        </Link>
        <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
          <Link href="/balance" style={{ color: '#77727d', textDecoration: 'none' }}>Balance</Link>
          <Link href="/send" style={{ color: '#77727d', textDecoration: 'none' }}>Pay</Link>
          <Link href="/receive" style={{ color: '#77727d', textDecoration: 'none' }}>Receive</Link>
          <Link href="/activity" style={{ color: '#77727d', textDecoration: 'none' }}>Activity</Link>
          <Link href="/#products" style={{ color: '#77727d', textDecoration: 'none' }}>Roadmap</Link>
          <Link href="/how-privacy-works" style={{ color: '#6b55df', textDecoration: 'none', fontWeight: 600 }}>How Privacy Works ↗</Link>
        </div>
      </div>
      <span style={{ fontSize: 12, color: '#77727d' }}>Your main wallet should not be your public financial identity.</span>
      <span style={{ fontSize: 11, color: '#a09ba6' }}>© 2026 AURA · Private Balance. Powered by Zcash Technology.</span>
    </footer>
  )
}

export default AuraFooter
