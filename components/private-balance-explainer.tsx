'use client'

type PrivateBalanceExplainerProps = {
  compact?: boolean
}

export function PrivateBalanceExplainer({ compact = false }: PrivateBalanceExplainerProps) {
  return (
    <section className={`private-balance-explainer${compact ? ' private-balance-explainer-compact' : ''}`}>
      <div className="private-balance-explainer-copy">
        <span className="section-label">THE PRODUCT IN ONE LINE</span>
        <h2>A private spending balance for crypto.</h2>
        <p>
          Move the crypto you want to spend into Private Balance. Then pay without using your main wallet as the direct source.
        </p>
        <p className="private-balance-explainer-note">
          <strong>Your wallet stays your wallet.</strong> AURA does not replace it — it gives you a separate balance for private spending.
        </p>
      </div>

      <div className="private-balance-route" aria-label="How AURA changes the payment route">
        <div className="private-balance-route-card private-balance-route-card-muted">
          <span>WITHOUT AURA</span>
          <strong>Your Wallet <b>→</b> Recipient</strong>
          <small>Your main wallet is the direct payment source.</small>
        </div>
        <div className="private-balance-route-divider" aria-hidden="true">or</div>
        <div className="private-balance-route-card private-balance-route-card-active">
          <span>WITH AURA</span>
          <strong>Your Wallet <b>→</b> Private Balance <b>→</b> Recipient</strong>
          <small>Pay from the balance you prepared for private spending.</small>
        </div>
      </div>
    </section>
  )
}
