/** Small, secret-safe diagnostics shared by the browser and API routes. */
export function createRequestId(prefix = 'req'): string {
  const entropy = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 18)
  return `${prefix}-${Date.now().toString(36)}-${entropy}`
}

export function logStructuredEvent(
  scope: string,
  event: string,
  details: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const record = {
    source: 'aura',
    scope,
    event,
    at: new Date().toISOString(),
    ...details,
  }
  // Do not include raw auth headers, signatures, mnemonics, or wallet keys here.
  console.info(`[AURA][${scope}] ${JSON.stringify(record)}`)
}

export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/sig_0x[0-9a-f]+/gi, '[redacted-signature]')
    .replace(/0x[0-9a-f]{40,64}/gi, '[redacted-hex]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted-hash]')
    .replace(/(?:mnemonic|seed phrase|private key)\s*[:=]?\s*[^,;.]+/gi, '[redacted-secret]')
    .slice(0, 180)
}
