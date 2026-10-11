/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'

import { AuraLogo } from './aura-logo'
import {
  MetaMaskIcon,
  PhantomIcon,
  CoinbaseWalletIcon,
  SparkleIcon,
  ZapIcon,
  ArrowUpRightIcon,
  ArrowRightIcon,
  ArrowDownIcon,
  CloseIcon,
  WalletIcon,
  ActivityIcon,
  ChevronDownIcon,
} from './aura-icons'
import { useAura } from '@/lib/context/aura-context'
import { VaultSecurityModal } from './vault-security-modal'
import { LiveExecutionLogPanel } from './live-execution-log-panel'

export function AuraHeader() {
  const pathname = usePathname()
  const { wallet, connectWallet, disconnectWallet } = useAura()
  const [showConnectModal, setShowConnectModal] = useState(false)
  const [walletConnectionError, setWalletConnectionError] = useState<string | null>(null)
  const [showSecurityModal, setShowSecurityModal] = useState(false)
  const [showExecutionLog, setShowExecutionLog] = useState(false)
  const [liveDemoStatus, setLiveDemoStatus] = useState<'unverified' | 'checking' | 'ready' | 'pay-only' | 'add-only' | 'blocked'>('unverified')
  const [currentTheme, setCurrentTheme] = useState<'violet' | 'blue' | 'zec'>('violet')
  const [platformOpen, setPlatformOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('aura-theme')
      if (saved === 'blue' || saved === 'zec') {
        setCurrentTheme(saved)
        document.documentElement.setAttribute('data-theme', saved)
      } else {
        localStorage.setItem('aura-theme', 'violet')
        document.documentElement.removeAttribute('data-theme')
        setCurrentTheme('violet')
      }
    }
  }, [])

  useEffect(() => {
    const onDemoReadiness = (event: Event) => {
      const detail = (event as CustomEvent<{ quickReady?: boolean; freshReady?: boolean; checking?: boolean }>).detail
      setLiveDemoStatus(detail?.checking
        ? 'checking'
        : detail?.quickReady && detail?.freshReady
          ? 'ready'
          : detail?.quickReady
            ? 'pay-only'
            : detail?.freshReady
              ? 'add-only'
              : 'blocked')
    }
    window.addEventListener('aura:demo-readiness', onDemoReadiness)
    return () => window.removeEventListener('aura:demo-readiness', onDemoReadiness)
  }, [])

  useEffect(() => {
    const openConnectWallet = () => {
      setWalletConnectionError(null)
      setShowConnectModal(true)
    }
    window.addEventListener('aura:open-connect-wallet', openConnectWallet)
    return () => window.removeEventListener('aura:open-connect-wallet', openConnectWallet)
  }, [])

  const switchTheme = (theme: 'violet' | 'blue' | 'zec') => {
    setCurrentTheme(theme)
    if (typeof window !== 'undefined') {
      localStorage.setItem('aura-theme', theme)
      if (theme === 'violet') {
        document.documentElement.removeAttribute('data-theme')
      } else {
        document.documentElement.setAttribute('data-theme', theme)
      }
    }
  }

  const navLinks = [
    { href: '/balance', label: 'Balance' },
    { href: '/send', label: 'Pay' },
    { href: '/receive', label: 'Receive' },
    { href: '/activity', label: 'Activity' },
  ]

  const isPlatformActive = ['/aura-pay', '/business', '/developers', '/how-privacy-works'].includes(pathname)
  const isDemoSurface = ['/', '/balance', '/send', '/receive', '/activity'].includes(pathname)

  return (
    <>
      {/* Locked Hackathon Truth Banner */}
      <div
        className="truth-banner"
        style={{
          background: '#191820',
          color: '#f0edff',
          fontSize: 11,
          padding: '6px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          flexWrap: 'wrap',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          letterSpacing: '0.02em',
        }}
      >
        <span
          style={{
            background: 'var(--violet)',
            color: '#fff',
            fontSize: 9,
            fontWeight: 800,
            padding: '2px 7px',
            borderRadius: 4,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {liveDemoStatus === 'ready'
            ? 'ADD + PAY READY'
            : liveDemoStatus === 'pay-only'
              ? 'PAY READY · ADD MONEY LIMITED'
              : liveDemoStatus === 'add-only'
                ? 'ADD READY · PAY CHECK REQUIRED'
                : liveDemoStatus === 'checking'
                  ? 'CHECKING LIVE TESTNET'
                  : liveDemoStatus === 'unverified'
                    ? 'LIVE STATUS NOT CHECKED'
                  : 'LIVE TESTNET · CHECK REQUIRED'}
        </span>
          <span className="truth-banner-copy" style={{ color: '#d4ccff', fontWeight: 600 }}>
          Public entry and exit remain visible · view privacy limits
        </span>
        {isDemoSurface && (
          <>
            <Link
              href="/activity?proof=1"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: 'none',
                borderRadius: 4,
                color: '#fff',
                padding: '2px 8px',
                fontSize: 10,
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                textDecoration: 'none',
              }}
            >
              <span>Operator-verified receipt</span>
              <ArrowRightIcon size={10} color="#fff" />
            </Link>
            <button
              type="button"
              onClick={() => setShowExecutionLog(true)}
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: 'none',
                borderRadius: 4,
                color: '#fff',
                padding: '2px 8px',
                fontSize: 10,
                fontWeight: 700,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>Live status</span>
              <ArrowRightIcon size={10} color="#fff" />
            </button>
          </>
        )}
      </div>

      <header>
        <Link href="/" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} title="Aura — ZEC-backed Private Balance">
          <AuraLogo height={38} />
        </Link>

        {/* Clean Swiss Navigation */}
        <nav aria-label="Main navigation">
          {navLinks.map((link) => {
            const isActive = pathname === link.href
            return (
              <Link
                key={link.href}
                href={link.href}
                className={isActive ? 'active' : ''}
              >
                {link.label}
              </Link>
            )
          })}

          {/* Platform Dropdown */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setPlatformOpen(!platformOpen)}
              onBlur={() => setTimeout(() => setPlatformOpen(false), 200)}
              style={{
                background: 'transparent',
                border: 'none',
                color: isPlatformActive ? 'var(--violet)' : '#68636e',
                font: '500 13px var(--font-ui)',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '28px 0',
                position: 'relative',
              }}
            >
              <span>More</span>
              <ChevronDownIcon size={12} color={isPlatformActive ? 'var(--violet)' : '#77727d'} />
              {isPlatformActive && (
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 20,
                    height: 2,
                    background: 'var(--violet)',
                    borderRadius: 1,
                  }}
                />
              )}
            </button>

            {platformOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% - 10px)',
                  left: 0,
                  background: '#ffffff',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  boxShadow: '0 12px 32px rgba(25, 24, 32, 0.12)',
                  minWidth: 230,
                  padding: '8px',
                  zIndex: 200,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                {[
                  { href: '/how-privacy-works', title: 'How It Works', desc: 'Privacy explained in plain language', badge: 'Learn More', badgeColor: 'var(--green)', badgeBg: 'var(--green-light)' },
                ].map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setPlatformOpen(false)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      background: pathname === item.href ? 'var(--lav)' : 'transparent',
                      textDecoration: 'none',
                      display: 'block',
                      transition: 'background 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong style={{ fontSize: 13, color: '#191820', fontWeight: 700 }}>
                        {item.title}
                      </strong>
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 800,
                          padding: '2px 6px',
                          borderRadius: 4,
                          color: item.badgeColor,
                          background: item.badgeBg,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {item.badge}
                      </span>
                    </div>
                    <span style={{ display: 'block', fontSize: 11, color: '#77727d', marginTop: 2 }}>
                      {item.desc}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className="head-actions">
          {/* Demo wallet recovery/settings only appears after the demo is active. */}
          {wallet.isDemoWallet && (
          <button
            type="button"
            className="vault-security-btn"
            onClick={() => setShowSecurityModal(true)}
            style={{
              background: '#fcfbfe',
              border: '1px solid #e7e4eb',
              borderRadius: 10,
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 700,
              color: '#47424f',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.15s ease',
            }}
            title="Demo wallet recovery and local settings (testnet only)"
          >
            <WalletIcon size={14} color="var(--violet)" />
            <span>Demo Wallet</span>
          </button>
          )}

          {/* Try Demo Quick-Start Button */}
          {!wallet.connected && (
            <button
              type="button"
              className="try-demo-btn"
              onClick={async () => {
                setWalletConnectionError(null)
                try {
                  await connectWallet('demo')
                } catch (error) {
                  setWalletConnectionError(error instanceof Error ? error.message : 'The jury demo could not be started.')
                  setShowConnectModal(true)
                }
              }}
              style={{
                background: 'var(--violet)',
                color: '#fff',
                border: 0,
                borderRadius: 10,
                padding: '8px 14px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                transition: 'all 0.15s ease',
              }}
              title="Open the Base Sepolia test-wallet session"
            >
              <ArrowRightIcon size={14} color="#fff" />
              <span>Try Demo</span>
            </button>
          )}

          <button
            type="button"
            className="connect-wallet-btn"
            onClick={() => {
              if (!wallet.connected) {
                setShowConnectModal(true)
              } else {
                disconnectWallet()
              }
            }}
            title={wallet.connected ? 'Disconnect' : 'Connect Wallet'}
          >
            {wallet.connected ? (
              <>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
                <span className="wallet-address">{`${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`}</span>
                {wallet.isDemoWallet && (
                  <span className="wallet-demo-badge" style={{ background: 'var(--warning-light)', color: 'var(--warning)', fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 4 }}>
                    DEMO
                  </span>
                )}
                <span className="wallet-close-icon"><CloseIcon size={12} color="#fff" /></span>
              </>
            ) : (
              <>
                <WalletIcon size={14} color="#fff" />
                <span>Connect Wallet</span>
                <ArrowRightIcon size={13} color="#fff" />
              </>
            )}
          </button>
        </div>
      </header>

      {/* Connect Wallet Modal */}
      {showConnectModal && (
        <div className="modal-backdrop" onClick={() => setShowConnectModal(false)}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SparkleIcon size={14} color="var(--violet)" />
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Connect Wallet
                </span>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowConnectModal(false)}
                title="Close"
              >
                <CloseIcon size={14} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: 24 }}>
              <p style={{ color: '#77727d', fontSize: 13, margin: '0 0 18px', lineHeight: 1.5 }}>
                Connect your existing Web3 wallet to manage deposits into your Private Balance. The connected wallet key stays with your wallet; the testnet demo uses AURA-operated Zcash private state for the private step.
              </p>
              {walletConnectionError && (
                <p role="alert" style={{ color: 'var(--danger)', fontSize: 12, margin: '0 0 14px' }}>
                  {walletConnectionError}
                </p>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  {
                    id: 'metamask' as const,
                    name: 'MetaMask',
                    desc: 'Ethereum & Base networks',
                    icon: MetaMaskIcon,
                    badge: 'Popular',
                    disabled: false,
                  },
                  {
                    id: 'phantom' as const,
                    name: 'Phantom',
                    desc: 'Solana recipient support · deposits coming next',
                    icon: PhantomIcon,
                    badge: 'Coming next',
                    disabled: true,
                  },
                  {
                    id: 'coinbase' as const,
                    name: 'Coinbase Wallet',
                    desc: 'Smart Wallet & multi-chain',
                    icon: CoinbaseWalletIcon,
                    badge: null,
                    disabled: false,
                  },
                  {
                    id: 'demo' as const,
                    name: 'Demo Wallet',
                    desc: 'Live Base Sepolia balance',
                    icon: SparkleIcon,
                    badge: 'Ready on Base Sepolia',
                    disabled: false,
                  },
                ].map((w) => {
                  const Icon = w.icon
                  return (
                    <button
                      key={w.name}
                      type="button"
                      className="wallet-option-btn"
                      disabled={w.disabled}
                      style={w.disabled ? { opacity: 0.58, cursor: 'not-allowed' } : undefined}
                      onClick={async () => {
                        if (w.disabled) return
                        setWalletConnectionError(null)
                        try {
                          await connectWallet(w.id)
                          setShowConnectModal(false)
                        } catch (error) {
                          setWalletConnectionError(error instanceof Error ? error.message : 'Wallet connection failed.')
                        }
                      }}
                    >
                      <div className="wallet-info">
                        <div className="wallet-icon-wrapper">
                          <Icon size={26} />
                        </div>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <strong style={{ display: 'block', fontSize: 14, fontWeight: 700, color: '#191820' }}>
                              {w.name}
                            </strong>
                            {w.badge && (
                              <span style={{
                                fontSize: 9,
                                fontWeight: 700,
                                background: 'var(--lav)',
                                color: 'var(--violet)',
                                padding: '1px 6px',
                                borderRadius: 4,
                                textTransform: 'uppercase',
                                letterSpacing: '0.04em',
                              }}>
                                {w.badge}
                              </span>
                            )}
                          </div>
                          <small style={{ color: '#77727d', fontSize: 11, display: 'block', marginTop: 2 }}>{w.desc}</small>
                        </div>
                      </div>
                      <ArrowUpRightIcon size={16} color="var(--violet)" />
                    </button>
                  )
                })}
              </div>

              <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)', textAlign: 'center' }}>
                <small style={{ color: '#9b95a1', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5, justifyContent: 'center' }}>
                  <WalletIcon size={12} color="var(--violet)" /> Testnet demo · never use real funds
                </small>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Demo wallet recovery/local settings modal */}
      <VaultSecurityModal
        isOpen={showSecurityModal}
        onClose={() => setShowSecurityModal(false)}
      />

      {/* Live Execution Log belongs to the working demo surfaces only. */}
      {isDemoSurface && (
        <LiveExecutionLogPanel
          key={showExecutionLog ? 'execution-log-open' : 'execution-log-closed'}
          initialOpen={showExecutionLog}
          onClose={() => setShowExecutionLog(false)}
        />
      )}

      {/* Mobile Drawer for Platform & Utilities */}
      {mobileMenuOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(25, 24, 32, 0.5)',
            backdropFilter: 'blur(4px)',
            WebkitBackdropFilter: 'blur(4px)',
            zIndex: 1050,
            display: 'flex',
            alignItems: 'flex-end',
          }}
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            style={{
              background: '#fff',
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: '20px 18px 80px',
              width: '100%',
              boxShadow: '0 -8px 30px rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--violet)', letterSpacing: '0.06em' }}>
                Learn & roadmap
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4 }}
              >
                <CloseIcon size={14} color="#77727d" />
              </button>
            </div>

            <Link
              href="/#products"
              onClick={() => setMobileMenuOpen(false)}
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                background: '#fcfbfe',
                border: '1px solid #e7e4eb',
                textDecoration: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <strong style={{ fontSize: 13, color: '#191820', display: 'block' }}>Roadmap</strong>
                <span style={{ fontSize: 11, color: '#77727d' }}>Future surfaces · clearly marked</span>
              </div>
              <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--violet)', background: 'var(--lav)', padding: '3px 6px', borderRadius: 4 }}>COMING NEXT</span>
            </Link>

            <Link
              href="/how-privacy-works"
              onClick={() => setMobileMenuOpen(false)}
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                background: pathname === '/how-privacy-works' ? '#f5f3ff' : '#fcfbfe',
                border: '1px solid #e7e4eb',
                textDecoration: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <strong style={{ fontSize: 13, color: '#191820', display: 'block' }}>How It Works</strong>
                <span style={{ fontSize: 11, color: '#77727d' }}>Architecture, Proofs & FAQ</span>
              </div>
              <ArrowRightIcon size={14} color="var(--violet)" />
            </Link>

            <div style={{ marginTop: 4 }}>
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false)
                  setShowSecurityModal(true)
                }}
                style={{
                  width: '100%',
                  background: '#fcfbfe',
                  border: '1px solid #d9d0ff',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--violet)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  justifyContent: 'center',
                }}
              >
                <WalletIcon size={14} color="var(--violet)" />
                <span>Demo Wallet</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Native Mobile Bottom Navigation Bar */}
      <nav className="mobile-bottom-bar" aria-label="Mobile Bottom Navigation">
        <Link
          href="/balance"
          className={`mobile-tab-item ${pathname === '/balance' ? 'active' : ''}`}
        >
          <div className="mobile-tab-icon">
            <WalletIcon size={18} />
          </div>
          <span className="mobile-tab-label">Balance</span>
          {pathname === '/balance' && <span className="mobile-tab-indicator" />}
        </Link>

        <Link
          href="/send"
          className={`mobile-tab-item ${pathname === '/send' ? 'active' : ''}`}
        >
          <div className="mobile-tab-icon">
            <ArrowRightIcon size={18} />
          </div>
          <span className="mobile-tab-label">Pay</span>
          {pathname === '/send' && <span className="mobile-tab-indicator" />}
        </Link>

        <Link
          href="/receive"
          className={`mobile-tab-item ${pathname === '/receive' ? 'active' : ''}`}
        >
          <div className="mobile-tab-icon">
            <ArrowDownIcon size={18} />
          </div>
          <span className="mobile-tab-label">Receive</span>
          {pathname === '/receive' && <span className="mobile-tab-indicator" />}
        </Link>

        <Link
          href="/activity"
          className={`mobile-tab-item ${pathname === '/activity' ? 'active' : ''}`}
        >
          <div className="mobile-tab-icon">
            <ActivityIcon size={18} />
          </div>
          <span className="mobile-tab-label">Activity</span>
          {pathname === '/activity' && <span className="mobile-tab-indicator" />}
        </Link>

        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className={`mobile-tab-item ${['/aura-pay', '/business', '/developers', '/how-privacy-works'].includes(pathname) || mobileMenuOpen ? 'active' : ''}`}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          <div className="mobile-tab-icon">
            <ChevronDownIcon
              size={16}
              color={['/aura-pay', '/business', '/developers', '/how-privacy-works'].includes(pathname) || mobileMenuOpen ? 'var(--violet)' : '#77727d'}
              className={mobileMenuOpen ? 'mobile-more-icon-open' : ''}
            />
          </div>
          <span className="mobile-tab-label">More</span>
          {(['/aura-pay', '/business', '/developers', '/how-privacy-works'].includes(pathname) || mobileMenuOpen) && <span className="mobile-tab-indicator" />}
        </button>
      </nav>
    </>
  )
}

export default AuraHeader
