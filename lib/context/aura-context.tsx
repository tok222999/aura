/**
 * TESTNET PROTOTYPE
 * Real testnet transactions. Real Zcash privacy.
 * A future production route may use NEAR Intents or another supported provider; this hackathon demo uses a test-only route.
 */

'use client'

import React, { createContext, useContext, useCallback } from 'react'
import {
  AssetSymbol,
  AuraTransaction,
  ChainId,
  MarketRate,
  PrivacyBufferMode,
  PrivacyPolicy,
  PrivateBalanceState,
} from '../types/aura'
import { WalletProvider, useWallet, WalletState } from './wallet-context'
import { RatesProvider, useRates } from './rates-context'
import { VaultProvider, useVault, DepositProgress, SendProgress, PendingDepositTransfer } from './vault-context'

export type AuraWalletState = WalletState

export interface AuraContextValue {
  wallet: AuraWalletState
  connectWallet: (provider?: 'metamask' | 'phantom' | 'coinbase' | 'walletconnect' | 'demo') => Promise<void>
  disconnectWallet: () => void
  privateBalance: PrivateBalanceState
  pendingDepositTransfer: PendingDepositTransfer | null
  clearPendingDepositTransfer?: () => void
  setPrivacyPolicy: (policy: PrivacyPolicy) => void
  rates: Record<string, MarketRate>
  isLive?: boolean
  isOracleLive?: boolean
  oracleStatus?: 'live' | 'stale_benchmark' | 'unavailable'
  transactions: AuraTransaction[]
  loadingTransactions: boolean
  refreshTransactions: (filter?: string) => Promise<AuraTransaction[]>
  resyncBalance: (policyOverride?: PrivacyBufferMode) => Promise<AuraTransaction[]>
  executeDeposit: (
    asset: AssetSymbol,
    amount: number,
    chain?: ChainId,
    type?: 'deposit' | 'receive',
    recipientAddress?: string,
    onProgress?: (progress: DepositProgress) => void
  ) => Promise<AuraTransaction | null>
  executeSend: (
    recipient: string,
    asset: AssetSymbol,
    amount: number,
    chain?: ChainId,
    bufferMode?: PrivacyBufferMode,
    onProgress?: (progress: SendProgress) => void
  ) => Promise<AuraTransaction | null>
  executeWithdraw: (
    asset: AssetSymbol,
    amount: number,
    chain?: ChainId,
    recipient?: string,
    onProgress?: (progress: SendProgress) => void
  ) => Promise<AuraTransaction | null>
  creditPublicBalance: (amount: number) => void
  debitPublicBalance: (amount: number) => void
  setPublicBalance: (balance: number) => void
  refreshDemoWallet?: () => Promise<void>
  resetDemoData: () => Promise<void>
}

const AuraContext = createContext<AuraContextValue | null>(null)

function AuraInnerConsumer({ children }: { children: React.ReactNode }) {
  const { wallet, connectWallet, disconnectWallet, creditPublicBalance, debitPublicBalance, setPublicBalance, refreshDemoWallet } = useWallet()
  const { rates, isOracleLive, oracleStatus } = useRates()
  const {
    privateBalance,
    transactions,
    loadingTransactions,
    pendingDepositTransfer,
    clearPendingDepositTransfer,
    setPrivacyPolicy,
    refreshTransactions,
    executeDeposit,
    executeSend,
    executeWithdraw,
    resetDemoData,
  } = useVault()

  const resyncBalance = useCallback(async (policyOverride?: PrivacyBufferMode): Promise<AuraTransaction[]> => {
    return refreshTransactions('all', policyOverride, { requireAuthoritativeBalance: true })
  }, [refreshTransactions])

  const value: AuraContextValue = {
    wallet,
    connectWallet,
    disconnectWallet,
    creditPublicBalance,
    debitPublicBalance,
    setPublicBalance,
    refreshDemoWallet,
    privateBalance,
    pendingDepositTransfer,
    clearPendingDepositTransfer,
    setPrivacyPolicy,
    rates,
    isLive: isOracleLive,
    isOracleLive,
    oracleStatus,
    transactions,
    loadingTransactions,
    refreshTransactions,
    resyncBalance,
    executeDeposit,
    executeSend,
    executeWithdraw,
    resetDemoData,
  }

  return <AuraContext.Provider value={value}>{children}</AuraContext.Provider>
}

/**
 * Composite Provider: Composes WalletProvider, RatesProvider, and VaultProvider
 * into a single unified hierarchy, cleanly modularizing domains while preserving full compatibility.
 */
export function AuraProvider({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <RatesProvider>
        <VaultProvider>
          <AuraInnerConsumer>{children}</AuraInnerConsumer>
        </VaultProvider>
      </RatesProvider>
    </WalletProvider>
  )
}

export function useAura() {
  const context = useContext(AuraContext)
  if (!context) {
    throw new Error('useAura must be used within an AuraProvider')
  }
  return context
}

export { useWallet, useRates, useVault }
