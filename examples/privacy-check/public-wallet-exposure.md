# Public wallet exposure example

This is a small, reproducible proof of the problem AURA addresses. It is an observation exercise, not a claim about a specific person's finances.

1. Choose a public testnet wallet with a visible token balance.
2. Open its explorer page and record the balance, recent counterparties, and the last payment amount.
3. Follow one vendor/payment recipient address from the same transfer.
4. Record which parts of the payer's financial history are visible without any private access.
5. Compare the direct transfer with AURA's intended route:

```text
Main wallet → recipient
Main wallet → AURA Private Balance → recipient
```

The second route does not promise perfect unlinkability. It adds a real shielded state and a payment-time Privacy Check so a direct public funding link, a matching amount, or a suspiciously close timing pattern can be called out before the payout.

For the hackathon demo, use Base Sepolia and Solana Devnet only. Do not use real funds or publish private wallet identifiers.
