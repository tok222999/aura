export interface RpcJsonError {
  message?: unknown
  code?: unknown
}

export function uniqueRpcUrls(primary: string, fallbacks: string[] = []): string[] {
  return Array.from(new Set([primary, ...fallbacks].map((url) => url.trim()).filter(Boolean)))
}

/**
 * Read-only JSON-RPC helper. It fails over before a usable result is returned.
 * Signed broadcasts use the companion helper below, which retries the exact
 * same payload so an ambiguous response cannot create a different transaction.
 */
export async function fetchRpcJson<T>(
  urls: string[],
  payload: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ json: T; endpoint: string }> {
  let lastError: unknown = new Error('RPC unavailable.')
  for (const endpoint of uniqueRpcUrls(urls[0] || '', urls.slice(1))) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload),
        cache: 'no-store',
      })
      const json = await response.json() as T & { error?: RpcJsonError }
      if (!response.ok || json?.error) {
        const message = json?.error?.message || `RPC returned HTTP ${response.status}.`
        throw new Error(String(message))
      }
      return { json, endpoint }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Reads a nullable JSON-RPC result from the whole pool. A null result is
 * valid for lookups such as eth_getTransactionReceipt while a transaction is
 * still pending, so it must not stop us from checking the next RPC.
 */
export async function fetchRpcResultAcrossPool<T>(
  urls: string[],
  payload: Record<string, unknown>,
  timeoutMs = 5000,
  isUsable?: (result: T) => boolean,
): Promise<{ result: T | null; endpoint: string }> {
  let lastError: unknown = new Error('RPC unavailable.')
  let lastEndpoint = ''
  let hadHealthyResponse = false

  for (const endpoint of uniqueRpcUrls(urls[0] || '', urls.slice(1))) {
    lastEndpoint = endpoint
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload),
        cache: 'no-store',
      })
      const json = await response.json() as { result?: T | null; error?: RpcJsonError }
      if (!response.ok || json?.error) {
        const message = json?.error?.message || `RPC returned HTTP ${response.status}.`
        throw new Error(String(message))
      }
      hadHealthyResponse = true
      if (json.result !== null && json.result !== undefined) {
        if (isUsable && !isUsable(json.result)) continue
        return { result: json.result, endpoint }
      }
    } catch (error) {
      lastError = error
    }
  }

  if (hadHealthyResponse) return { result: null, endpoint: lastEndpoint }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Sends the same already-signed payload through the configured RPC pool.
 *
 * This is safe for transaction broadcasts because every retry carries the
 * identical signed transaction (same nonce/signature). A node may accept it
 * while the HTTP response is lost; another RPC will then either return the
 * transaction result or an idempotent "already known" error that the caller
 * can reconcile by the locally-derived transaction identifier.
 */
export async function broadcastRpcJson<T>(
  urls: string[],
  payload: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<{ json: T; endpoint: string }> {
  let lastJson: T | undefined
  let lastEndpoint = ''
  let lastError: unknown = new Error('RPC broadcast unavailable.')

  for (const endpoint of uniqueRpcUrls(urls[0] || '', urls.slice(1))) {
    lastEndpoint = endpoint
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify(payload),
        cache: 'no-store',
      })
      const json = await response.json() as T & { error?: RpcJsonError }
      lastJson = json
      if (!response.ok) {
        throw new Error(`RPC returned HTTP ${response.status}.`)
      }
      // Try the next endpoint for JSON-RPC errors. The signed payload is
      // identical, so this cannot create a second logical transaction.
      if (json?.error) {
        lastError = new Error(String(json.error.message || 'RPC rejected the broadcast.'))
        continue
      }
      return { json, endpoint }
    } catch (error) {
      lastError = error
    }
  }

  if (lastJson !== undefined) return { json: lastJson, endpoint: lastEndpoint }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
