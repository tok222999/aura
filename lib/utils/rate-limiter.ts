import { NextRequest } from 'next/server'
import { getTrustedClientId } from '@/lib/services/demo-session-service'

/** No trusted per-client identity exists; use the endpoint's global abuse bucket. */
export function isSharedUnauthenticatedIdentifier(identifier: string): boolean {
  return identifier === 'direct-client' || identifier === 'proxy-unknown'
}

interface RateLimitRecord {
  tokens: number
  lastRefill: number
}

/**
 * InMemoryRateLimiter
 * Token bucket rate limiter preventing DOS and resource exhaustion on API endpoints.
 */
export class InMemoryRateLimiter {
  private clients: Map<string, RateLimitRecord> = new Map()
  private readonly maxTokens: number
  private readonly refillRatePerSecond: number
  private readonly windowMs: number
  private readonly maxTrackedClients = 10_000

  constructor(maxRequests: number = 30, windowSeconds: number = 60) {
    this.maxTokens = maxRequests
    this.refillRatePerSecond = maxRequests / windowSeconds
    this.windowMs = windowSeconds * 1000
  }

  public check(identifier: string): { allowed: boolean; remaining: number; retryAfter?: number } {
    const now = Date.now()
    if (!this.clients.has(identifier) && this.clients.size >= this.maxTrackedClients) {
      for (const [client, record] of this.clients) {
        if (now - record.lastRefill >= this.windowMs) this.clients.delete(client)
      }
      if (this.clients.size >= this.maxTrackedClients) {
        return { allowed: false, remaining: 0, retryAfter: Math.ceil(this.windowMs / 1000) }
      }
    }
    const record = this.clients.get(identifier) || {
      tokens: this.maxTokens,
      lastRefill: now,
    }

    // Refill tokens based on elapsed time
    const elapsedSeconds = (now - record.lastRefill) / 1000
    record.tokens = Math.min(this.maxTokens, record.tokens + elapsedSeconds * this.refillRatePerSecond)
    record.lastRefill = now

    if (record.tokens >= 1) {
      record.tokens -= 1
      this.clients.set(identifier, record)
      return {
        allowed: true,
        remaining: Math.floor(record.tokens),
      }
    }

    // Rate limited
    const needed = 1 - record.tokens
    const retryAfter = Math.ceil(needed / this.refillRatePerSecond)
    this.clients.set(identifier, record)

    return {
      allowed: false,
      remaining: 0,
      retryAfter,
    }
  }

  public getIdentifier(req: NextRequest, authenticatedIdentity?: string): string {
    return authenticatedIdentity?.trim()
      ? getTrustedClientId(req.headers, { sessionToken: authenticatedIdentity })
      : getTrustedClientId(req.headers)
  }
}

// Global API rate limiters
export const requestCreationLimiter = new InMemoryRateLimiter(30, 60) // 30 req / min
export const paymentLimiter = new InMemoryRateLimiter(20, 60)         // 20 req / min
export const quoteLimiter = new InMemoryRateLimiter(60, 60)           // 60 req / min
export const globalRequestCreationLimiter = new InMemoryRateLimiter(180, 60)
export const globalPaymentLimiter = new InMemoryRateLimiter(180, 60)
export const globalQuoteLimiter = new InMemoryRateLimiter(180, 60)
