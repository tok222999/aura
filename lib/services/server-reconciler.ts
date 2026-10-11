import { reconcilePendingDemoBudget } from './demo-budget-reconciler'
import { reconcileConfirmedShieldedPayouts, reconcilePendingOperations } from './pending-operation-reconciler'
import { ledgerService } from './ledger-service'
import { persistentStore } from './persistent-store'

type ReconcilerRuntime = typeof globalThis & {
  __auraServerReconcilerStarted?: boolean
  __auraServerReconcilerTimer?: ReturnType<typeof setInterval>
}

/**
 * Keep durable destination payouts moving even when no browser is open.
 * API routes remain an on-demand fallback, but recovery is not UI-driven.
 */
export function startServerReconciler(): void {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.AURA_DISABLE_BACKGROUND_RECONCILER === 'true') return

  const runtime = globalThis as ReconcilerRuntime
  if (runtime.__auraServerReconcilerStarted) return
  runtime.__auraServerReconcilerStarted = true

  const tick = async () => {
    try {
      await reconcilePendingDemoBudget()
      await reconcilePendingOperations()
      // This is the only automatic path allowed to create a new destination
      // payout after a confirmed Zcash spend. Read/status routes remain safe
      // observation paths and never become settlement liveness requirements.
      await reconcileConfirmedShieldedPayouts(persistentStore, ledgerService)
    } catch (error) {
      console.warn('Background settlement reconciliation delayed:', error)
    }
  }

  void tick()
  const timer = setInterval(() => { void tick() }, 15_000)
  timer.unref?.()
  runtime.__auraServerReconcilerTimer = timer
}
