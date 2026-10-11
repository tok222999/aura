export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startServerReconciler } = await import('./lib/services/server-reconciler')
    startServerReconciler()
  }
}
