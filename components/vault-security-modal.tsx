'use client'

import React, { useState, useEffect } from 'react'
import { zcashEnclaveService } from '@/lib/services/zcash-enclave-service'
import { rustWalletBridge, RustBridgeStatus } from '@/lib/services/rust-wallet-bridge'
import { CloseIcon, SparkleIcon, CheckIcon, CopyIcon } from './aura-icons'

interface VaultSecurityModalProps {
  isOpen: boolean
  onClose: () => void
}

export function VaultSecurityModal({ isOpen, onClose }: VaultSecurityModalProps) {
  const [activeTab, setActiveTab] = useState<'backup' | 'restore' | 'engine' | 'lock'>('backup')
  const [words, setWords] = useState<string[]>([])
  const [isCopied, setIsCopied] = useState(false)
  const [isConfirmed, setIsConfirmed] = useState(false)
  const [phraseLoadError, setPhraseLoadError] = useState<string | null>(null)
  const [activeFingerprint, setActiveFingerprint] = useState('')

  // Restore State
  const [inputPhrase, setInputPhrase] = useState('')
  const [restoreStatus, setRestoreStatus] = useState<'idle' | 'restoring' | 'done' | 'error'>('idle')
  const [restoreError, setRestoreError] = useState<string | null>(null)

  // Bridge Status State
  const [bridgeStatus, setBridgeStatus] = useState<RustBridgeStatus | null>(null)

  // App Lock (PIN) State
  const [pinEnabled, setPinEnabled] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinSuccessMsg, setPinSuccessMsg] = useState<string | null>(null)
  const [isPinUnlocked, setIsPinUnlocked] = useState(false)
  const [pinUnlockAttempt, setPinUnlockAttempt] = useState('')
  const [pinUnlockError, setPinUnlockError] = useState(false)

  useEffect(() => {
    if (isOpen) {
      let cancelled = false
      setWords([])
      setPhraseLoadError(null)
      setActiveFingerprint('')
      void zcashEnclaveService.getOrCreateEnclaveKey().then((enclave) => {
        if (!cancelled) setActiveFingerprint(enclave.fingerprint)
      }).catch(() => {
        if (!cancelled) setActiveFingerprint('unavailable')
      })
      setIsConfirmed(zcashEnclaveService.isBackupConfirmed())
      rustWalletBridge.getBridgeStatus().then(setBridgeStatus)
      const hasPin = zcashEnclaveService.isPinSet()
      setPinEnabled(hasPin)
      if (!hasPin) {
        setIsPinUnlocked(true)
        void zcashEnclaveService.exportRecoveryPhrase().then((result) => {
          if (cancelled) return
          if (result.success && result.words) {
            setWords(result.words)
            setPhraseLoadError(null)
          } else {
            setPhraseLoadError(result.error || 'Could not load the recovery phrase.')
          }
        }).catch((error) => {
          if (!cancelled) setPhraseLoadError(error instanceof Error ? error.message : 'Could not load the recovery phrase.')
        })
      } else {
        setIsPinUnlocked(false)
      }
      setPinInput('')
      setPinUnlockAttempt('')
      return () => { cancelled = true }
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleCopy = () => {
    navigator.clipboard.writeText(words.join(' '))
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const handleConfirmBackup = () => {
    zcashEnclaveService.confirmBackup()
    setIsConfirmed(true)
  }

  const handleUnlockPin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (await zcashEnclaveService.verifyPinAsync(pinUnlockAttempt)) {
      setIsPinUnlocked(true)
      setPinUnlockError(false)
      try {
        const result = await zcashEnclaveService.exportRecoveryPhrase(pinUnlockAttempt)
        if (!result.success || !result.words) throw new Error(result.error || 'Could not load the recovery phrase.')
        setWords(result.words)
        setPhraseLoadError(null)
      } catch (error) {
        setWords([])
        setPhraseLoadError(error instanceof Error ? error.message : 'Could not load the recovery phrase.')
      }
    } else {
      setPinUnlockError(true)
    }
  }

  const loadPhraseAfterUnlock = async () => {
    try {
      const result = await zcashEnclaveService.exportRecoveryPhrase()
      if (!result.success || !result.words) throw new Error(result.error || 'Could not load the recovery phrase.')
      setWords(result.words)
      setPhraseLoadError(null)
    } catch (error) {
      setWords([])
      setPhraseLoadError(error instanceof Error ? error.message : 'Could not load the recovery phrase.')
    }
  }

  const handleSavePin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{6,8}$/.test(pinInput)) {
      setPinSuccessMsg('New PIN must be 6–8 digits.')
      return
    }
    const success = await zcashEnclaveService.setPinAsync(pinInput)
    if (success) {
      setPinEnabled(true)
      setIsPinUnlocked(true)
      setPinInput('')
      setPinSuccessMsg('Local App Lock enabled. The PIN uses PBKDF2, a per-install salt, and attempt limits.')
      setTimeout(() => setPinSuccessMsg(null), 3500)
    }
  }

  const handleDisablePin = async () => {
    if (!/^\d{4,8}$/.test(pinInput)) {
      setPinSuccessMsg('Enter your current PIN. The old 4-digit PIN is accepted; new PINs must be 6–8 digits.')
      return
    }
    const removed = await zcashEnclaveService.removePinAsync(pinInput)
    if (removed) {
      setPinEnabled(false)
      setIsPinUnlocked(true)
      setPinInput('')
      setPinSuccessMsg('Local PIN lock removed.')
      setTimeout(() => setPinSuccessMsg(null), 3000)
    } else {
      setPinSuccessMsg('Incorrect PIN. Cannot remove lock.')
    }
  }

  const handleRestoreSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const phraseWords = inputPhrase.trim().toLowerCase().split(/\s+/)
    if (phraseWords.length !== 12) {
      setRestoreStatus('error')
      setRestoreError('Phrase must contain exactly 12 BIP-39 words.')
      return
    }
    setRestoreStatus('restoring')
    setRestoreError(null)
    await new Promise((r) => setTimeout(r, 600))
    let result
    try {
      result = await zcashEnclaveService.restoreFromMnemonic(phraseWords)
    } catch (error) {
      setRestoreStatus('error')
      setRestoreError(error instanceof Error ? error.message : 'Could not save the recovery phrase.')
      return
    }
    if (result.success) {
      setRestoreStatus('done')
      setTimeout(() => {
        onClose()
        window.location.reload()
      }, 1200)
    } else {
      setRestoreStatus('error')
      setRestoreError(result.error || 'Invalid recovery phrase checksum.')
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-window"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, width: '92%' }}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SparkleIcon size={14} color="var(--violet, #6b55df)" />
            <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.04em' }}>
              DEMO WALLET RECOVERY &amp; LOCAL SETTINGS (TESTNET ONLY)
            </span>
          </div>
          <button type="button" className="modal-close" onClick={onClose} title="Close">
            <CloseIcon size={14} />
          </button>
        </div>

        {/* Tab Switcher */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid #e7e4eb',
            background: '#faf9fc',
            padding: '4px 8px 0',
          }}
        >
          {[
            { id: 'backup', label: '1. Backup Phrase' },
            { id: 'restore', label: '2. Restore Vault' },
            { id: 'engine', label: '3. Enclave & Vault Info' },
            { id: 'lock', label: '4. App Lock (PIN)' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              style={{
                border: 0,
                borderBottom: activeTab === tab.id ? '2px solid var(--violet, #6b55df)' : '2px solid transparent',
                background: 'transparent',
                color: activeTab === tab.id ? 'var(--violet, #6b55df)' : '#77727d',
                padding: '10px 14px',
                fontSize: 12,
                fontWeight: activeTab === tab.id ? 700 : 500,
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="modal-body" style={{ padding: 24 }}>
          {/* TAB 1: BACKUP PHRASE */}
          {activeTab === 'backup' && (
            <div>
              {pinEnabled && !isPinUnlocked ? (
                <div style={{ textAlign: 'center', padding: '24px 12px' }}>
                  <div style={{ marginBottom: 12 }}>
                    <SparkleIcon size={32} color="var(--violet, #6b55df)" />
                  </div>
                  <h3 style={{ fontSize: 16, fontWeight: 800, marginBottom: 6, color: '#191820' }}>
                    Vault Locked
                  </h3>
                  <p style={{ fontSize: 13, color: '#68636f', marginBottom: 16 }}>
                    Enter your PIN to reveal your master recovery phrase.
                  </p>
                  <form onSubmit={handleUnlockPin} style={{ maxWidth: 220, margin: '0 auto' }}>
                    <input
                      type="password"
                      maxLength={8}
                      value={pinUnlockAttempt}
                      onChange={(e) => setPinUnlockAttempt(e.target.value.replace(/\D/g, ''))}
                      placeholder="••••"
                      style={{
                        width: '100%',
                        padding: '10px 14px',
                        fontSize: 20,
                        fontWeight: 800,
                        letterSpacing: '0.4em',
                        borderRadius: 10,
                        border: pinUnlockError ? '2px solid var(--danger)' : '1px solid #d9d0ff',
                        textAlign: 'center',
                        marginBottom: 12,
                      }}
                    />
                    {pinUnlockError && (
                      <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10, fontWeight: 600 }}>
                        Incorrect PIN. Please try again.
                      </div>
                    )}
                    <button
                      type="submit"
                      style={{
                        width: '100%',
                        padding: '10px',
                        borderRadius: 8,
                        border: 0,
                        background: 'var(--violet, #6b55df)',
                        color: '#fff',
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Unlock Phrase
                    </button>
                  </form>
                </div>
              ) : (
                <>
                  <div
                    style={{
                      background: '#fcfbfe',
                      border: '1px solid #e7e4eb',
                      borderRadius: 12,
                      padding: '14px 16px',
                      marginBottom: 18,
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: '#56515d',
                    }}
                  >
                    <strong style={{ color: '#191820', display: 'block', marginBottom: 4 }}>
                      Master Client Passphrase (BIP-39 Standard)
                    </strong>
                    This phrase restores the same testnet demo tenant. It is a recovery mechanism for the demo session, not a personal wallet-security guarantee or self-custody feature. Never use real funds.
                  </div>

                  {/* 12 Words Grid */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: 8,
                      background: '#f6f5f9',
                      border: '1px solid #e7e4eb',
                      borderRadius: 12,
                      padding: 14,
                      marginBottom: 16,
                    }}
                  >
                    {phraseLoadError && <div style={{ color: '#b42318', fontSize: 12, marginBottom: 10 }}>{phraseLoadError}</div>}
                    {words.map((w, i) => (
                      <div
                        key={i}
                        style={{
                          background: '#fff',
                          border: '1px solid #e2dee8',
                          borderRadius: 8,
                          padding: '6px 10px',
                          fontSize: 12,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <span style={{ color: '#77727d', fontSize: 10, fontWeight: 700, width: 16 }}>
                          {i + 1}.
                        </span>
                        <strong style={{ color: '#191820', fontFamily: 'var(--font-ui)' }}>{w}</strong>
                      </div>
                    ))}
                  </div>

                  {/* Action Buttons */}
                  <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
                    <button
                      type="button"
                      onClick={handleCopy}
                      disabled={words.length !== 12}
                      style={{
                        flex: 1,
                        padding: '10px',
                        borderRadius: 8,
                        border: '1px solid #e7e4eb',
                        background: '#fff',
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#191820',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        cursor: 'pointer',
                      }}
                    >
                      <CopyIcon size={13} />
                      {isCopied ? 'Copied to Clipboard!' : 'Copy Phrase'}
                    </button>

                    <button
                      type="button"
                      onClick={handleConfirmBackup}
                      style={{
                        flex: 1.2,
                        padding: '10px',
                        borderRadius: 8,
                        border: 0,
                        background: isConfirmed ? 'var(--green-light)' : 'var(--violet, #6b55df)',
                        color: isConfirmed ? 'var(--green-dark)' : '#fff',
                        fontSize: 12,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        cursor: isConfirmed ? 'default' : 'pointer',
                      }}
                    >
                      <CheckIcon size={13} />
                      {isConfirmed ? 'Backup Confirmed' : 'I Saved My Phrase'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB 2: RESTORE VAULT */}
          {activeTab === 'restore' && (
            <form onSubmit={handleRestoreSubmit}>
              <div
                style={{
                  background: '#fcfbfe',
                  border: '1px solid #e7e4eb',
                  borderRadius: 12,
                  padding: '14px 16px',
                  marginBottom: 18,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: '#56515d',
                }}
              >
                <strong style={{ color: '#191820', display: 'block', marginBottom: 4 }}>
                  Restore Demo Account Access
                </strong>
                Enter your 12-word phrase to restore access to the same testnet demo tenant. The old browser profile is not required. This restores demo account access and rotates its demo signing authority; it does not recover a personal wallet, recreate funds, or provide self-custody. The phrase is never uploaded. Never use real funds.
              </div>

              <textarea
                value={inputPhrase}
                onChange={(e) => setInputPhrase(e.target.value)}
                placeholder="abandon ability able about above absent absorb abstract absurd abuse access accident"
                rows={3}
                style={{
                  width: '100%',
                  padding: 12,
                  borderRadius: 10,
                  border: restoreStatus === 'error' ? '1px solid var(--danger)' : '1px solid #d9d0ff',
                  fontSize: 13,
                  fontFamily: 'var(--font-ui)',
                  lineHeight: 1.6,
                  resize: 'none',
                  marginBottom: 12,
                  boxSizing: 'border-box',
                }}
              />

              {restoreError && (
                <div style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 12, fontWeight: 600 }}>
                  {restoreError}
                </div>
              )}

              <button
                type="submit"
                disabled={restoreStatus === 'restoring' || restoreStatus === 'done'}
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: 8,
                  border: 0,
                  background: restoreStatus === 'done' ? 'var(--green)' : 'var(--violet, #6b55df)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                {restoreStatus === 'restoring' ? (
                  <span>Verifying and Restoring Vault...</span>
                ) : restoreStatus === 'done' ? (
                  <>
                    <CheckIcon size={14} color="#fff" />
                    <span>Demo Account Access Restored</span>
                  </>
                ) : (
                  <span>Restore Demo Access from Phrase</span>
                )}
              </button>
            </form>
          )}

          {/* TAB 3: ENCLAVE & VAULT INFO */}
          {activeTab === 'engine' && (
            <div>
              <div
                style={{
                  background: '#f4f1ff',
                  border: '1px solid #d9d0ff',
                  borderRadius: 10,
                  padding: '10px 12px',
                  marginBottom: 14,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: '#3f356f',
                }}
              >
                <strong style={{ display: 'block', marginBottom: 3 }}>Active tenant</strong>
                <span style={{ fontFamily: 'var(--font-ui)' }}>{activeFingerprint || 'loading…'}</span>
              </div>
              <div
                style={{
                  background: '#191820',
                  color: '#e7e4eb',
                  borderRadius: 12,
                  padding: 16,
                  fontFamily: 'var(--font-ui)',
                  fontSize: 11,
                  lineHeight: 1.6,
                }}
              >
                <div style={{ color: 'var(--violet, #a596f7)', fontWeight: 800, marginBottom: 8 }}>
                  // AURA CLIENT VAULT &amp; KEYSTORE ARCHITECTURE
                </div>
                <div>Runtime Mode: Client Web Crypto Keystore + AURA Testnet Relayer</div>
                <div>Custody Model: Client-Side Authorization (Testnet Prototype)</div>
                <div>Mnemonic Standard: BIP-39 (128-bit Cryptographically Secure Entropy)</div>
                <div>Intent Signing: Browser ECDSA key + deterministic BIP-39 recovery authority</div>
                <div>Recovery: Phrase-authenticated spend-key rotation (old browser not required)</div>
                <div>Local PIN: browser-only screen lock; not wallet security</div>
                <div>Privacy Layer:</div>
                <div style={{ paddingLeft: 12, color: '#aaa' }}>
                  • Connected-wallet authorization stays local; Zcash settlement is server-operated in this demo<br />
                  • Public entry and payout remain visible; amounts and timing may enable correlation<br />
                  • Browser signs spend intents locally; this does not make the testnet settlement self-custodial
                </div>
                <div style={{ marginTop: 8, color: 'var(--green)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <CheckIcon size={12} color="var(--green)" />
                  <span>Transparent Architecture: Web Crypto API client-side key isolation with a modular testnet settlement pipeline.</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: APP LOCK (PIN) */}
          {activeTab === 'lock' && (
            <div>
              <div
                style={{
                  background: '#fcfbfe',
                  border: '1px solid #e7e4eb',
                  borderRadius: 12,
                  padding: '14px 16px',
                  marginBottom: 18,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: '#56515d',
                }}
              >
                <strong style={{ color: '#191820', display: 'block', marginBottom: 4 }}>
                  Local Browser Lock (Not Wallet Security)
                </strong>
                Lock this session with a 6–8 digit PIN. New PINs use browser PBKDF2, a per-install salt, and failed-attempt lockout; plaintext is never saved. This is a local convenience lock, not wallet security. Legacy 4-digit PINs remain usable only so they can be replaced.
              </div>

              {pinSuccessMsg && (
                <div
                  style={{
                    background: !pinSuccessMsg.includes('must') && !pinSuccessMsg.includes('Incorrect') && !pinSuccessMsg.includes('Enter') ? 'var(--green-light)' : 'var(--danger-light)',
                    color: !pinSuccessMsg.includes('must') && !pinSuccessMsg.includes('Incorrect') && !pinSuccessMsg.includes('Enter') ? 'var(--green-dark)' : 'var(--danger)',
                    padding: '10px 14px',
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 700,
                    marginBottom: 16,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <CheckIcon size={13} color="var(--green-dark)" />
                  <span>{pinSuccessMsg}</span>
                </div>
              )}

              <form onSubmit={handleSavePin}>
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#191820' }}>
                    {pinEnabled ? 'Enter New 6–8 Digit Local PIN:' : 'Enter 6–8 Digit Local PIN:'}
                  </label>
                  <input
                    type="password"
                    maxLength={8}
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ''))}
                    placeholder="••••••"
                    style={{
                      width: 140,
                      padding: '12px 16px',
                      fontSize: 22,
                      fontWeight: 800,
                      letterSpacing: '0.4em',
                      borderRadius: 10,
                      border: '1px solid #d9d0ff',
                      textAlign: 'center',
                    }}
                  />
                </div>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    type="submit"
                    style={{
                      flex: 1,
                      padding: '12px',
                      borderRadius: 8,
                      border: 0,
                      background: 'var(--violet, #6b55df)',
                      color: '#fff',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    {pinEnabled ? 'Update PIN' : 'Enable Local App Lock'}
                  </button>

                  {pinEnabled && (
                    <button
                      type="button"
                      onClick={handleDisablePin}
                      style={{
                        padding: '12px 18px',
                        borderRadius: 8,
                        border: '1px solid #e7e4eb',
                        background: '#fff',
                        color: 'var(--danger)',
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Disable PIN
                    </button>
                  )}
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
