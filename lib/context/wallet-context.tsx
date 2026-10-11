/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { zcashEnclaveService } from '@/lib/services/zcash-enclave-service'

export interface WalletState {
  connected: boolean
  address: string
  network: string
  /** `null` means the chain read is unavailable; `0` is a confirmed zero. */
  publicUsdcBalance: number | null
  publicEthBalance?: number | null
  isDemoWallet: boolean
  demoTenantId?: string
  demoCanSend?: boolean
  walletProvider: 'metamask' | 'phantom' | 'coinbase' | 'walletconnect' | 'demo'
  balanceSource: 'onchain' | 'sandbox_usdc' | 'syncing' | 'offline'
}

let jurySessionExpiresAt = 0
let jurySessionRequest: Promise<void> | null = null

/**
 * In a local hackathon run the browser can exchange the server-side jury
 * capability for an HttpOnly cookie. The capability itself is never sent to
 * or stored in the client. Production deployments still require the
 * operator-only capability header at the exchange endpoint.
 */
async function ensureJurySession(): Promise<void> {
  if (jurySessionExpiresAt > Date.now() + 60_000) return
  if (jurySessionRequest) return jurySessionRequest
  jurySessionRequest = (async () => {
    const juryPasscode = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.hash.replace(/^#/, '')).get('jury')
      : null
    const response = await fetch('/api/wallet/demo/jury-session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: juryPasscode ? JSON.stringify({ passcode: juryPasscode }) : undefined,
      cache: 'no-store',
    })
    if (response.status === 404) {
      jurySessionExpiresAt = Number.MAX_SAFE_INTEGER
      return
    }
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload.success) {
      throw new Error(payload.error === 'JURY_CAPABILITY_REQUIRED'
        ? 'The jury demo is locked. Start the operator session before choosing Try Demo.'
        : payload.error || 'The jury demo session could not be created.')
    }
    if (juryPasscode && typeof window !== 'undefined') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    }
    jurySessionExpiresAt = typeof payload.expiresAt === 'number'
      ? payload.expiresAt
      : Date.now() + 45 * 60 * 1000
  })()
  try {
    await jurySessionRequest
  } finally {
    jurySessionRequest = null
  }
}

interface WalletContextType {
  wallet: WalletState
  connectWallet: (provider?: 'metamask' | 'phantom' | 'coinbase' | 'walletconnect' | 'demo') => Promise<void>
  disconnectWallet: () => void
  creditPublicBalance: (amount: number) => void
  debitPublicBalance: (amount: number) => void
  setPublicBalance: (balance: number) => void
  refreshDemoWallet: () => Promise<void>
}

const DEFAULT_WALLET: WalletState = {
  connected: false,
  address: '0x9CAF6275fe5e9F833818D1a76A09d9c067C19033',
  network: 'Base Sepolia',
  publicUsdcBalance: null,
  publicEthBalance: null,
  isDemoWallet: false,
  demoCanSend: false,
  walletProvider: 'metamask',
  balanceSource: 'offline',
}

const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const EVM_NETWORKS: Record<string, string> = {
  '0x2105': 'Base',
  '0x14a34': 'Base Sepolia',
  '0x1': 'Ethereum',
  '0xaa36a7': 'Sepolia',
  '0xa4b1': 'Arbitrum',
  '0x66eee': 'Arbitrum Sepolia',
}

type EvmProvider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

async function fetchBaseSepoliaBalances(eth: EvmProvider, address: string) {
  const cleanAddress = address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const [rawUsdc, rawEth] = await Promise.all([
    eth.request({
      method: 'eth_call',
      params: [{ to: BASE_SEPOLIA_USDC, data: `0x70a08231${cleanAddress}` }, 'latest'],
    }),
    eth.request({ method: 'eth_getBalance', params: [address, 'latest'] }),
  ])
  if (
    typeof rawUsdc !== 'string' || !/^0x[0-9a-f]+$/i.test(rawUsdc) ||
    typeof rawEth !== 'string' || !/^0x[0-9a-f]+$/i.test(rawEth)
  ) throw new Error('Wallet returned an invalid balance response.')

  return {
    publicUsdcBalance: Number((Number(BigInt(rawUsdc)) / 1e6).toFixed(2)),
    publicEthBalance: Number((Number(BigInt(rawEth)) / 1e18).toFixed(6)),
  }
}

const WalletContext = createContext<WalletContextType | undefined>(undefined)

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<WalletState>(DEFAULT_WALLET)
  const autoJuryActivationStarted = useRef(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('aura_wallet_state_v3')
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          if (parsed.isDemoWallet) {
            parsed.address = DEFAULT_WALLET.address
            parsed.network = 'Base Sepolia'
            parsed.connected = false
            parsed.balanceSource = 'syncing'
            parsed.demoCanSend = false
          }
          if (parsed.balanceSource !== 'onchain' && parsed.balanceSource !== 'sandbox_usdc') {
            parsed.publicUsdcBalance = null
            parsed.publicEthBalance = null
          }
          setWallet((prev) => ({ ...prev, ...parsed }))

          if (!parsed.isDemoWallet && parsed.connected && ['metamask', 'coinbase'].includes(parsed.walletProvider)) {
            const eth = (window as unknown as { ethereum?: EvmProvider }).ethereum
            if (eth) {
              const savedAddress = typeof parsed.address === 'string' ? parsed.address : DEFAULT_WALLET.address
              setWallet((prev) => prev.isDemoWallet || prev.address.toLowerCase() !== savedAddress.toLowerCase()
                ? prev
                    : { ...prev, publicUsdcBalance: null, publicEthBalance: null, balanceSource: prev.network === 'Base Sepolia' ? 'syncing' : 'offline' })

              void Promise.all([
                eth.request({ method: 'eth_accounts' }),
                eth.request({ method: 'eth_chainId' }),
              ]).then(async ([accounts, chainIdValue]) => {
                const activeAddress = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : ''
                if (!activeAddress) {
                  setWallet((prev) => prev.isDemoWallet || prev.address.toLowerCase() !== savedAddress.toLowerCase()
                    ? prev
                    : { ...DEFAULT_WALLET, connected: false })
                  return
                }

                const chainId = String(chainIdValue)
                const network = EVM_NETWORKS[chainId] || 'EVM Testnet'
                setWallet((prev) => {
                  if (prev.isDemoWallet || prev.address.toLowerCase() !== savedAddress.toLowerCase()) return prev
                  const updated = {
                    ...prev,
                    connected: true,
                    address: activeAddress,
                    network,
                    publicUsdcBalance: null,
                    publicEthBalance: null,
                    balanceSource: network === 'Base Sepolia' ? 'syncing' as const : 'offline' as const,
                  }
                  localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
                  return updated
                })
                let balances: { publicUsdcBalance: number | null; publicEthBalance: number | null } = { publicUsdcBalance: null, publicEthBalance: null }
                let balanceSource: WalletState['balanceSource'] = 'offline'
                if (network === 'Base Sepolia') {
                  try {
                    balances = await fetchBaseSepoliaBalances(eth, activeAddress)
                    balanceSource = 'onchain'
                  } catch {
                    // Keep zeroed balances marked unavailable when the provider cannot answer.
                  }
                }
                setWallet((prev) => {
                  if (prev.isDemoWallet || prev.address.toLowerCase() !== activeAddress.toLowerCase() || prev.network !== network) return prev
                  const updated = {
                    ...prev,
                    ...balances,
                    balanceSource,
                  }
                  localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
                  return updated
                })
              }).catch(() => {
                setWallet((prev) => {
                  if (prev.isDemoWallet || prev.address.toLowerCase() !== savedAddress.toLowerCase()) return prev
                  const updated = { ...prev, publicUsdcBalance: null, publicEthBalance: null, balanceSource: 'offline' as const }
                  localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
                  return updated
                })
              })
            } else {
              setWallet((prev) => prev.isDemoWallet ? prev : {
                ...prev,
                publicUsdcBalance: null,
                publicEthBalance: null,
                balanceSource: 'offline',
              })
            }
          }
        } catch {
          // Fall back to default
        }
      }
    }

  }, [])

  const saveWallet = useCallback((updated: WalletState) => {
    setWallet(updated)
    if (typeof window !== 'undefined') {
      localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
    }
  }, [])

  const activateJuryTenant = useCallback(async (tenantId: unknown): Promise<string> => {
    if (typeof tenantId !== 'string' || !/^vault_r_[a-zA-Z0-9._-]{8,120}$/.test(tenantId)) {
      throw new Error('The jury demo tenant is not configured.')
    }
    const ecdsa = await zcashEnclaveService.getOrCreateEcdsaKeyPair()
    const response = await fetch('/api/auth/jury/rotate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, authPublicKey: ecdsa.publicKeySpkiHex }),
      cache: 'no-store',
    })
    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.success) {
      throw new Error(result?.error || 'The funded jury tenant could not be activated.')
    }
    zcashEnclaveService.setJuryTenantId(tenantId)
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('aura:jury-tenant-activated'))
    return tenantId
  }, [])

  // Listen to live MetaMask network and account changes
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      (window as unknown as { ethereum?: { on?: (e: string, fn: (...args: unknown[]) => void) => void; removeListener?: (e: string, fn: (...args: unknown[]) => void) => void } }).ethereum
    ) {
      const eth = (window as unknown as { ethereum: EvmProvider & { on?: (e: string, fn: (...args: unknown[]) => void) => void; removeListener?: (e: string, fn: (...args: unknown[]) => void) => void } }).ethereum
      const syncEvmAccount = async (address: string, chainId: string) => {
        const network = EVM_NETWORKS[chainId] || 'EVM Testnet'
        setWallet((prev) => {
          if (prev.isDemoWallet) return prev
          const updated = {
            ...prev,
            connected: true,
            address,
            network,
             publicUsdcBalance: null,
             publicEthBalance: null,
            balanceSource: network === 'Base Sepolia' ? 'syncing' as const : 'offline' as const,
          }
          localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
          return updated
        })
        if (network !== 'Base Sepolia') return

        try {
          const balances = await fetchBaseSepoliaBalances(eth, address)
          setWallet((prev) => {
            if (prev.isDemoWallet || prev.address.toLowerCase() !== address.toLowerCase() || prev.network !== network) return prev
            const updated = { ...prev, ...balances, balanceSource: 'onchain' as const }
            localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
            return updated
          })
        } catch {
          setWallet((prev) => {
            if (prev.isDemoWallet || prev.address.toLowerCase() !== address.toLowerCase() || prev.network !== network) return prev
             const updated = { ...prev, publicUsdcBalance: null, publicEthBalance: null, balanceSource: 'offline' as const }
            localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
            return updated
          })
        }
      }
      const handleAccounts = (...args: unknown[]) => {
        const accounts = args[0] as string[]
        if (wallet.isDemoWallet) return
        if (!accounts || accounts.length === 0) {
          saveWallet({ ...DEFAULT_WALLET, connected: false })
        } else {
          void Promise.all([
            eth.request({ method: 'eth_chainId' }),
            eth.request({ method: 'eth_accounts' }),
          ])
            .then(([chainId, currentAccounts]) => {
              if (!Array.isArray(currentAccounts) || currentAccounts[0]?.toLowerCase() !== accounts[0]?.toLowerCase()) return
              return syncEvmAccount(accounts[0], String(chainId))
            })
            .catch(() => syncEvmAccount(accounts[0], ''))
        }
      }
      const handleChain = (...args: unknown[]) => {
        if (wallet.isDemoWallet) return
        const chainIdHex = args[0] as string
        void eth.request({ method: 'eth_accounts' })
          .then((accounts) => {
            const address = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : ''
            if (address) return syncEvmAccount(address, chainIdHex)
            const network = EVM_NETWORKS[chainIdHex] || 'EVM Testnet'
            setWallet((prev) => {
              if (prev.isDemoWallet) return prev
              const updated = { ...prev, network, publicUsdcBalance: null, publicEthBalance: null, balanceSource: 'offline' as const }
              localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
              return updated
            })
          })
          .catch(() => {
            setWallet((prev) => {
              if (prev.isDemoWallet) return prev
              const updated = { ...prev, network: 'EVM Testnet', publicUsdcBalance: null, publicEthBalance: null, balanceSource: 'offline' as const }
              localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
              return updated
            })
          })
      }

      eth.on?.('accountsChanged', handleAccounts)
      eth.on?.('chainChanged', handleChain)

      return () => {
        eth.removeListener?.('accountsChanged', handleAccounts)
        eth.removeListener?.('chainChanged', handleChain)
      }
    }
  }, [saveWallet, wallet.isDemoWallet])

  const connectWallet = useCallback(async (provider: 'metamask' | 'phantom' | 'coinbase' | 'walletconnect' | 'demo' = 'metamask') => {
    if (provider === 'walletconnect') {
      throw new Error('WalletConnect is not connected in this build. Choose MetaMask, Phantom, Coinbase, or the testnet demo wallet.')
    }
    // 1. Phantom / Solana Provider
    if (provider === 'phantom') {
      if (typeof window !== 'undefined' && (window as unknown as { solana?: { isPhantom?: boolean; connect: () => Promise<{ publicKey: { toString: () => string } }> } }).solana?.isPhantom) {
        try {
          const sol = (window as unknown as { solana: { connect: () => Promise<{ publicKey: { toString: () => string } }> } }).solana
          const resp = await sol.connect()
          const address = resp.publicKey.toString()
          saveWallet({
            connected: true,
            address,
            network: 'Solana',
            publicUsdcBalance: null,
            isDemoWallet: false,
            demoCanSend: false,
            walletProvider: 'phantom',
            balanceSource: 'offline',
          })
          return
        } catch (err) {
          console.warn('Phantom wallet connection cancelled:', err)
          throw err
        }
      }
      throw new Error('Phantom was not detected. Install or unlock Phantom, then try again.')
    }

    // 2. MetaMask / Coinbase / EVM Provider
    if (provider === 'metamask' || provider === 'coinbase') {
      if (
        typeof window !== 'undefined' &&
        (window as unknown as { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
      ) {
        try {
          const eth = (window as unknown as { ethereum: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
          const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
          // Enforce Base Sepolia chain (0x14a34 / 84532)
          let chainIdHex = (await eth.request({ method: 'eth_chainId' })) as string
          if (chainIdHex !== '0x14a34') {
            try {
              await eth.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: '0x14a34' }],
              })
              chainIdHex = (await eth.request({ method: 'eth_chainId' })) as string
            } catch (switchError: unknown) {
              if (typeof switchError === 'object' && switchError !== null && 'code' in switchError && (switchError as { code: number }).code === 4902) {
                try {
                  await eth.request({
                    method: 'wallet_addEthereumChain',
                    params: [
                      {
                        chainId: '0x14a34',
                        chainName: 'Base Sepolia',
                        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                        rpcUrls: ['https://sepolia.base.org'],
                        blockExplorerUrls: ['https://sepolia.basescan.org'],
                      },
                    ],
                  })
                  chainIdHex = (await eth.request({ method: 'eth_chainId' })) as string
                } catch {
                  // User rejected add chain
                }
              }
            }
          }
          const chainMap: Record<string, string> = {
            '0x2105': 'Base',
            '0x14a34': 'Base Sepolia',
            '0x1': 'Ethereum',
            '0xaa36a7': 'Sepolia',
            '0xa4b1': 'Arbitrum',
            '0x66eee': 'Arbitrum Sepolia',
          }
          const network = chainMap[chainIdHex] || 'Base Sepolia'
          const address = accounts[0] || DEFAULT_WALLET.address
          if (!accounts[0]) throw new Error('The wallet did not return an account.')
          if (chainIdHex !== '0x14a34') throw new Error('Switch your wallet to Base Sepolia to continue.')

          let balances: { publicUsdcBalance: number | null; publicEthBalance: number | null } = { publicUsdcBalance: null, publicEthBalance: null }
          let balanceSource: WalletState['balanceSource'] = 'offline'
          try {
            balances = await fetchBaseSepoliaBalances(eth, address)
            balanceSource = 'onchain'
          } catch {
            // A failed RPC read is not proof that the wallet has a zero balance.
          }

          saveWallet({
            connected: true,
            address,
            network,
            ...balances,
            isDemoWallet: false,
            demoCanSend: false,
            walletProvider: provider,
            balanceSource,
          })
          return
        } catch (err) {
          console.warn('EVM wallet connection dismissed:', err)
          throw err
        }
      }
      throw new Error(`${provider === 'coinbase' ? 'Coinbase Wallet' : 'MetaMask'} was not detected. Install or unlock the wallet, then try again.`)
    }

    if (provider !== 'demo') return

    // The demo wallet displays only balances read from the live testnet.
    try {
      await ensureJurySession()
      const res = await fetch('/api/wallet/demo', { credentials: 'same-origin', cache: 'no-store' })
      const data = await res.json()
      if (data.success) {
        const demoTenantId = await activateJuryTenant(data.tenantId)
        saveWallet({
          connected: true,
          address: data.address,
          network: data.network || 'Base Sepolia',
          publicUsdcBalance: data.rpcAvailable && typeof data.usdcBalance === 'number' ? data.usdcBalance : null,
          publicEthBalance: data.rpcAvailable && typeof data.ethBalance === 'number' ? data.ethBalance : null,
          isDemoWallet: true,
          demoTenantId,
          demoCanSend: data.canSend === true,
          walletProvider: 'demo',
          balanceSource: data.rpcAvailable ? 'onchain' : 'offline',
        })
        return
      }
        throw new Error(data.error || 'The jury demo wallet is unavailable.')
    } catch (e) {
      jurySessionExpiresAt = 0
      console.warn('Failed to fetch live demo wallet stats:', e)
      setWallet((prev) => {
        if (!prev.isDemoWallet) return prev
        const reset = { ...DEFAULT_WALLET, connected: false }
        if (typeof window !== 'undefined') localStorage.removeItem('aura_wallet_state_v3')
        return reset
      })
      throw e
    }
  }, [activateJuryTenant, saveWallet])

  const refreshDemoWallet = useCallback(async () => {
    try {
      await ensureJurySession()
      const res = await fetch('/api/wallet/demo', { credentials: 'same-origin', cache: 'no-store' })
      const data = await res.json()
      if (data.success) {
        const demoTenantId = await activateJuryTenant(data.tenantId)
        const onchainUsdc = typeof data.usdcBalance === 'number' ? data.usdcBalance : null
        setWallet((prev) => {
          if (!prev.isDemoWallet) return prev
          const updated: WalletState = {
            ...prev,
            // Restoration is complete only after the signed jury authority
            // was successfully activated above. Leaving connected=false
            // here displayed a spendable balance but blocked Add after reload.
            connected: true,
            address: data.address,
            network: data.network || 'Base Sepolia',
            publicUsdcBalance: data.rpcAvailable ? onchainUsdc : null,
            publicEthBalance: data.rpcAvailable && typeof data.ethBalance === 'number' ? data.ethBalance : null,
            demoCanSend: data.canSend === true,
            demoTenantId,
            balanceSource: data.rpcAvailable ? 'onchain' : 'offline',
            walletProvider: 'demo',
          }
          if (typeof window !== 'undefined') {
            localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
          }
          return updated
        })
      } else {
        setWallet((prev) => {
          if (!prev.isDemoWallet) return prev
          const reset = { ...DEFAULT_WALLET, connected: false }
          if (typeof window !== 'undefined') localStorage.removeItem('aura_wallet_state_v3')
          return reset
        })
      }
    } catch (e) {
      console.warn('Failed to refresh demo wallet:', e)
      setWallet((prev) => {
        if (!prev.isDemoWallet) return prev
        const reset = { ...DEFAULT_WALLET, connected: false }
        if (typeof window !== 'undefined') localStorage.removeItem('aura_wallet_state_v3')
        return reset
      })
    }
  }, [activateJuryTenant])

  // A jury URL is an explicit demo entry point. Activate the existing
  // provisioned tenant automatically so a fresh browser does not stop at
  // "Try Demo Wallet" before the funded balance can be displayed. This only
  // creates the short-lived demo session; it never sends a chain transaction.
  useEffect(() => {
    if (typeof window === 'undefined' || wallet.isDemoWallet || autoJuryActivationStarted.current) return
    if (new URLSearchParams(window.location.search).get('tour') !== '1') return
    autoJuryActivationStarted.current = true
    void connectWallet('demo').catch(() => {
      autoJuryActivationStarted.current = false
    })
  }, [wallet.isDemoWallet, connectWallet])

  // Automatically refresh demo wallet on initial mount if in demo mode
  useEffect(() => {
    if (wallet.isDemoWallet) {
      refreshDemoWallet()
    }
  }, [wallet.isDemoWallet, refreshDemoWallet])

  const disconnectWallet = useCallback(() => {
    zcashEnclaveService.setJuryTenantId(null)
    saveWallet({ ...DEFAULT_WALLET, connected: false })
  }, [saveWallet])

  const creditPublicBalance = useCallback((amount: number) => {
    setWallet((prev) => {
      const updated = {
        ...prev,
        publicUsdcBalance: prev.publicUsdcBalance === null ? null : Number((prev.publicUsdcBalance + amount).toFixed(2)),
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
      }
      return updated
    })
  }, [])

  const debitPublicBalance = useCallback((amount: number) => {
    setWallet((prev) => {
      const updated = {
        ...prev,
        publicUsdcBalance: prev.publicUsdcBalance === null ? null : Math.max(0, Number((prev.publicUsdcBalance - amount).toFixed(2))),
      }
      if (typeof window !== 'undefined') {
        localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
      }
      return updated
    })
  }, [])

  const setPublicBalance = useCallback((balance: number) => {
    setWallet((prev) => {
      const updated = { ...prev, publicUsdcBalance: balance }
      if (typeof window !== 'undefined') {
        localStorage.setItem('aura_wallet_state_v3', JSON.stringify(updated))
      }
      return updated
    })
  }, [])

  return (
    <WalletContext.Provider
      value={{
        wallet,
        connectWallet,
        disconnectWallet,
        creditPublicBalance,
        debitPublicBalance,
        setPublicBalance,
        refreshDemoWallet,
      }}
    >
      {children}
    </WalletContext.Provider>
  )
}

export function useWallet() {
  const context = useContext(WalletContext)
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider')
  }
  return context
}
