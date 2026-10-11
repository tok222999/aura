# AURA Privacy Check integration example

`PrivacyRiskSnapshot` is the small policy result a wallet or checkout can show before it signs a payment. The local implementation lives at [`lib/privacy-check/index.ts`](../../lib/privacy-check/index.ts).

```ts
import { calculatePrivacyRiskSnapshot } from '../../../lib/privacy-check'

const review = calculatePrivacyRiskSnapshot({
  transactions: [],
  totalBalanceUsd: 100,
  amountUsd: 100,
  policy: 'private',
})

if (review.riskCodes.length > 0) {
  // Show the human-readable warning before the user signs.
  console.log(review.summary)
}

// Bind review.hash into the quote/signature. Recompute and compare it at
// settlement time so a changed balance or policy cannot bypass the review.
```

The example is intentionally dependency-free and does not claim perfect unlinkability. A production integration must provide its own authenticated transport, durable replay protection, and finality checks.

## Exact input/output shape

The public result shape is documented in [`privacy-risk-snapshot.schema.json`](./privacy-risk-snapshot.schema.json). The input includes the proposed `amountUsd`, a `policy`, and the caller's confirmed transaction history; the output includes `riskCodes`, `readyToSpendUsd`, `policy`, `summary`, and a deterministic `hash` that must be rechecked before settlement.
