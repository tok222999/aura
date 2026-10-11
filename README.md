# AURA — Private Balance for crypto payments

> **Working testnet demo:** AURA puts a Private Balance between your main wallet and the world. Fund it on Base Sepolia, inspect the real Zcash Testnet privacy step, and pay on Solana Devnet. This demo does not prove transaction unlinkability or self-custody.

[![Testnet Status](https://img.shields.io/badge/Demo-Testnet%20Readiness%20via%20Preflight-blue)](#)
[![Privacy Guardrails](https://img.shields.io/badge/Privacy%20Guardrails-Privacy%20Check-orange)](#)
[![Verification](https://img.shields.io/badge/Verification-Automated%20Tests%20%C2%B7%20Live%20Runner-blue)](#)
[![Multi-Chain](https://img.shields.io/badge/Chains-Base%20Sepolia%20%7C%20Solana%20Devnet-purple)](#)
[![Routing](https://img.shields.io/badge/Demo%20Routing-Aura%20Testnet%20Orchestration-teal)](#)

---

## 1. The Problem

On public blockchains like Ethereum, Base, and Solana, **public wallet activity can expose balances, counterparties, and transaction history tied to that address**.

When you pay a friend, merchant, or contractor from your primary Web3 wallet:
* The recipient can inspect the balance and transaction history tied to the wallet used for payment.
* Incoming and outgoing addresses, timing, and amounts remain visible on the relevant public explorer.
* Public payment patterns can reveal or help infer operational balances and activity; they do not, by themselves, prove total reserves, burn rate, or runway.

---

## 2. The Solution: AURA Private Balance

AURA is a **private spending account layered on top of the wallet you already use**. It is not trying to replace that wallet or present itself as a general-purpose bridge. The Private Balance sits between public funding and the external world; Zcash is the real private asset and settlement layer underneath.

### Why now

Stablecoins are becoming a real business payment rail while onchain activity remains public by default. Shielded settlement is mature enough to become a product feature, so AURA turns privacy into a payment decision instead of leaving it as a cryptography hobby.

```
[PUBLIC ENTRY]                 [SHIELDED PRIVACY CORE]            [PUBLIC EXIT]
Base Sepolia USDC  ───────►  AURA TESTNET DEMO  ───────►  Solana Devnet SOL
(Verified On-Chain)          (Ledger + real Zcash test tx)    (Test-only relayer payout)
                             - Local client authorization    - On-chain receipt checks
                             - Privacy delay warnings         - No unlinkability guarantee
```

1. **Deposit:** The demo accepts USDC on Base Sepolia. Deposits are checked against the public testnet receipt before AURA records a balance entry.
2. **Private Balance:** In the hackathon jury path, a verified Base deposit allocates already-confirmed shielded `AuraVault` inventory to the tenant ledger; it does not wait for or invent a new deposit-specific Zcash transaction. Tenant ledgers, authorities, and payment authorization remain isolated, and the normal tenant-account path remains available outside that demo mode. This is not production self-custody and does not mean each displayed user balance is a separate Zcash note.
3. **Pay:** Privacy Check and atomic reservation run first; AURA then broadcasts a real Zcash spend, persists its exact txid, and pays SOL on Solana Devnet. Solana may finalize while Zcash confirmation continues asynchronously; Activity shows both states truthfully. Base Sepolia payout is not enabled for private payments. Future routing can add more networks, but it is not the product promise of this demo.
4. **Limit:** Public entry and payout transactions remain visible. Timing, amounts, shared relayers, and other metadata may still enable correlation; the demo does not prove unlinkability or hide the AURA operator from its own server records.

This is three real testnet chain steps connected by AURA test orchestration and pre-funded demo inventory. It is not an atomic Base-to-Zcash-to-Solana swap. AURA's thesis is provider-independent payment policy: the Private Balance, readiness decision, and payment warnings should remain the product layer even if the settlement provider changes. NEAR Confidential Intents is a possible future confidential execution architecture, not an already-live integration in this demo.

### Production settlement architecture

The demo inventory is only a testnet bootstrap. In production, AURA would request a
stable-value quote from a replaceable solver or intent-liquidity provider. That
provider would source or rebalance pooled ZEC/SOL inventory, quote the conversion
rate and fee, carry the ZEC/FX and inventory risk, and define refund/failure
behavior. AURA would keep the user-facing Private Balance and Privacy Check as
the product layer; the solver would be the replaceable execution and liquidity
layer. This avoids making one permanent relayer identity or AURA's own reserve
the business model.

### Why this is different from a Zcash wallet

Zcash is the private settlement layer, not the product identity. AURA starts with the wallet a user already has and adds a persistent spending balance, a plain-language payment flow, payment-time warnings, and a policy-controlled ready balance. The intended experience is to reach a shielded working balance without requiring Zcash expertise; the current demo proves the Zcash step, while live asset conversion is a production goal. Zodl is a Zcash-first wallet with swaps and CrossPay; AURA explores a different payment-policy UX around a prepared spending balance.

### Why not just use a second wallet?

A second public wallet separates addresses, but a direct `main wallet → spending wallet` funding transfer can publicly connect those addresses again. AURA inserts a real shielded Zcash state between the public entry and the public payout, then runs payment-time warnings and a spending-eligibility check before the exit. The difference is not a new address; it is the persistent shielded state plus the decision made before spending.

### Competitive wedge

Cross-chain privacy payment is not enough novelty on its own. Zodl already offers shielded ZEC CrossPay, and NEAR Intents already abstracts cross-chain asset execution. AURA's difference is the product layer: a persistent Private Balance between the wallet someone already uses and the people they pay, plus payment-time policy enforcement against funding age, timing, amount, and full-balance exposure. In this demo, Zcash is deliberate product infrastructure: the shielded ZEC state is the privacy asset layer behind the Private Balance. A routing provider can change as the product matures; Zcash is not incidental plumbing in AURA's current thesis. See the primary references: [Zodl CrossPay](https://support.zodl.com/article/24-using-crosspay-to-spend-zec) and [NEAR Intents](https://www.near.org/intents).

AURA does not claim to be the first product with a private balance or a privacy check. The narrower claim is: **AURA puts fund age, timing, amount, and ready-balance enforcement inside the payment flow, and can stop a spend when the balance is not ready.**

### Value and threat-model honesty

The demo balance is ZEC-backed and shown in USD at the current testnet reference rate. A $1.00 entry can therefore display a different USD mark after shielding; that difference is market movement, not an AURA fee. The current server-operated demo is designed to reduce direct wallet exposure to the recipient and to warn about simple timing/amount/full-balance correlations. It does not yet protect against correlation by the AURA operator, and it is not self-custody. Those are explicit production requirements, not claims hidden behind the demo.

The server currently sees a correlation graph containing tenant, entry, amount, recipient, and settlement state. Production privacy therefore requires a client-side Privacy Check, a local or self-custodial Zcash wallet, pooled/solver liquidity, non-permanent payout identities, and minimum backend metadata. AURA is a **ZEC-backed private working balance**, not a private stablecoin account; stable-value funding and settlement are an explicit later milestone. On a low-volume deployment, timing and amount correlation can still be visible, so AURA claims reduced direct wallet exposure—not perfect unlinkability.

### Why Zcash is central

AURA productizes Zcash wallet privacy policy for an ordinary cross-chain payment:
the wallet's confirmation and spend-source rules become a plain-language Privacy
Check before Pay. The policy-eligible Zcash balance is read from the wallet with
the selected confirmation threshold; historical ledger timestamps cannot make a
fresh change note spendable. Routing providers are replaceable. Zcash is AURA's
chosen private asset and settlement layer, and the persistent shielded state is
central to the core behavior rather than an incidental integration.

---

## 3. Product Surface

AURA has one working product surface today, with clearly separated expansion paths.

### Consumers — NOW
* **Private Balance (`/balance`):** Live private balance, USD and ZEC equivalents, privacy policy status, and Base Sepolia balance sync.
* **Pay (`/send`):** Private testnet payments to Solana Devnet (SOL), with recent-timing, fund-age, amount-echo, fresh-balance, and near-full-exit warnings.
* **Receive (`/receive`):** Single-use private requests with source-chain verification and Zcash settlement status.
* **Activity (`/activity`):** Transaction ledger, route status, on-chain receipt viewer, and verified proof card.

The recipient does not need an AURA account for the current payout flow. That is a usability advantage, not a unique moat; the defensible product behavior is the persistent shielded balance and the Privacy Check before the public exit.

### Merchants — COMING NEXT
* **Aura Pay Checkout (`/aura-pay`):** Roadmap preview only; merchant checkout is not enabled.

### Businesses — COMING NEXT
* **Private working-balance tools (`/business`):** Roadmap preview only; no business payout is sent.

### Developers — COMING NEXT
* **Privacy Payments API / SDK (`/developers`):** Product specification and illustrative integration shape only.

The architecture explanation (`/how-privacy-works`) and single-use invoice route (`/pay/[id]`) support the current demo experience. `/gio` is an internal checkout preview, not a separate recipient profile or supported identity feature, and is excluded from the jury archive.

## 4. Who AURA Is For

The product is for anyone who pays from a public wallet and does not want the payment to expose that wallet’s full balance and history. Ordinary crypto users, freelancers, traders, founders, and teams are examples. Crypto-native teams are one practical distribution wedge, not the product boundary.

Freelancers, traders, and broader business users are part of the same audience. The submission makes no fabricated traction or testimonial claims.

## 5. Platform Story

### ONE PRIVATE BALANCE. CLEAR EXPANSION PATH.

| Audience | Status | Surface |
| --- | --- | --- |
| Consumers | NOW | Private Balance · Pay · Receive |
| Merchants | COMING NEXT | Aura Pay Checkout |
| Businesses | COMING NEXT | Private payment and working-balance tools |
| Developers | COMING NEXT | Privacy Payments API / SDK |

Cross-chain routing supports the product, but it is not the main innovation. The differentiator is a persistent Private Balance, simple payment UX, main-wallet separation, Privacy Guardrails expressed through the Privacy Check, and one-time Receive Requests.

**Core insight:** privacy is not only cryptography; ordinary payment behavior can recreate public linkage through timing, amount, and repeated spending patterns. AURA's product response is a persistent shielded balance plus a payment-time policy that decides what is ready to spend before publication.

## 6. Business Model

AURA plans to charge one transparent service fee included in the payment quote. Exact production pricing remains to be validated. Provider and network costs are pass-through or embedded in that quote; AURA does not claim a second settlement fee. No current revenue or conversion is claimed.

Later expansion can add merchant processing, a business subscription for working-balance controls, and developer/API usage. Those are expansion paths, not four equal products on day one.

## 6A. Go-to-market hypothesis

Start with direct outreach to crypto-native teams and freelancers, then use crypto payroll communities, wallet/payment integrations, and ordinary wallet users as distribution. A private payment link is a later loop, after recipient onboarding becomes one click rather than a setup burden.

## 6B. Market sizing discipline

No invented TAM is included. The first research pass should count reachable crypto-native teams, estimate their annual supplier-payment volume, and calculate **SAM = reachable teams × annual relevant payment volume**. Only verified ecosystem or partner data should populate those inputs.

## 6C. Market and founder-market fit

See [MARKET_AND_FIT.md](MARKET_AND_FIT.md) for the bounded bottom-up wedge model and the execution evidence that can be stated without inventing interviews or traction. Founder-specific experience is intentionally not invented in the repository.

## 6D. Composability

See [COMPOSABILITY.md](COMPOSABILITY.md) for the reusable Privacy Check, proof, and settlement-adapter boundaries.

---

## 7. Cryptographic & Security Invariants

Aura adheres to strict security rules:

1. **Confirmation-First Settlement (Zero-Fake-Success):**
   * Transactions are never marked `completed` upon broadcast. Base Sepolia receipts must pass a canonical block re-check and reach the chain's `safe` or `finalized` head; confirmation depth alone is not treated as finality. Solana payouts require `finalized` with no error.
2. **Authentic Zcash Testnet Integration:**
   * Utilizes the compiled Rust `zcash-devtool.exe` binary connected to `testnet.zec.rocks:443`.
   * Real ZIP-316 Unified Addresses (`utest1...`) and the shielded pools supported by the current Zcash Testnet wallet/tool stack.
   * Real testnet shielded broadcasts via `zcashDevtoolService.sendShielded()` when spendable ZEC is available. Pay converts the selected privacy buffer into a minimum-confirmation policy, so the Rust wallet's note selector cannot spend a fresh note just because the account total is large enough.
3. **Fail-Closed Invoice Verification:**
   * `/api/requests/[id]/consume` strictly verifies Base Sepolia ERC-20 transfer logs: contract address matches Base Sepolia USDC, recipient matches payment vault, and amount matches invoice.
   * Transactions with 0 transfer logs or reverted status are rejected with `INVALID_PAYMENT_LOGS`.
   * Solana transactions are parsed with `getTransaction` to confirm token mint, destination, and amount.
   * Any RPC failure immediately returns `502 RPC_VERIFICATION_FAILED` and halts execution (no fail-open bypass).
4. **Client-Side Intent Signatures & Nonce Replay Defense:**
   * Spend authorizations use a client-side ECDSA signature over the requested action and parameters.
   * Nonce replay claims are stored by tenant and operation; a reused spend nonce is rejected with `401 NONCE_REPLAYED`.
5. **Phrase-Based Recovery & Key Rotation:**
   * The BIP-39 phrase deterministically derives a recovery-only authority; the phrase is never uploaded to the server.
   * `restoreFromMnemonic()` creates a fresh browser ECDSA key and rotates the same tenant's spend authority after recovery proof.
   * The old IndexedDB key, browser profile, origin, and port are not required for recovery. Balances remain on the original tenant and are never recreated from the phrase.
6. **Multi-Tenant Ledger Isolation:**
   * Ledger state is partitioned by client enclave fingerprints. Tenant A cannot view or mutate Tenant B's balances.
7. **Durable Server Authority State:**
   * Spend and recovery authorities persist in `.aura-data`; set `AURA_DATA_DIR` to a stable durable directory when running multiple ports, workers, or deployments.
   * Authority files are reread for each authorization decision so a restart or another server process cannot keep a stale signing key in memory.
8. **Crash-Recoverable External Operations:**
   * Zcash shielding writes a tenant-bound pending operation with its exact memo, amount, recipient, and transaction draft before broadcast. Receive settlement uses the same durable intent and resumes invoice consumption plus ledger persistence after a restart.
   * Destination payouts persist the signed Solana signature or predicted Base transaction hash before broadcast. Reconciliation checks that exact identity first and never retries while the original transaction could still be accepted.
   * Base Receive requests persist their creation block. If a payer's tab closes after sending, the payer can sign a recovery request from the same wallet; Aura scans only that invoice window for an exact sender/amount transfer, rejects ambiguity, then applies the same finality and timestamp checks before shielding.
   * Receive management is recoverable from the tenant's signed authority after a browser storage wipe: active requests can be listed and updated/revoked without returning a plaintext owner token.
9. **Smart-account authorization boundary:**
   * Base EOA proofs use EIP-191 `personal_sign`; deployed Safe/multisig senders can use ERC-1271 contract validation for deposits and Receive payments. Counterfactual ERC-6492 accounts remain a documented production extension and are never silently treated as EOAs.

### Production boundary

This repository is a hackathon testnet prototype, not a production custody system. Production quote issuance/consumption can use the opt-in Node 24 SQLite transactional quote/outbox adapter by setting `AURA_PRODUCTION_DB_PATH`; the demo never selects it. A complete production deployment must still replace the JSON/filesystem ledger and remaining idempotency state with a transactional database, enforce retention and data-minimization policies for recipient/amount/identity metadata, use audited cryptographic libraries, and protect recovery/unlock with OS-backed secure storage or WebAuthn. A production privacy engine would also need a client-local or self-custodial Zcash component instead of the server-operated demo wallet.

### Privacy product hygiene

The app does not include third-party analytics or payment tracking. Fonts use local system fallbacks rather than a remote font provider. Security headers include a same-origin CSP, clickjacking protection, restrictive permissions, and strict referrer policy. The public submission archive excludes `.env.local`, `.aura-data`, `zcash-wallet-data`, compiled binaries, and operator-only live-flow scripts.

---

## 8. Automated Verification & Telemetry

Aura includes automated test suites and real-time health checks accessible directly via HTTP:

### Security Test Suite: `POST /api/audit/test-runner`
Executes the current automated cryptographic, settlement, persistence, accounting, authorization, and chain-verification checks in development mode. The live runner reports the exact current total; passing these checks does not prove a live testnet transfer succeeded.

The hosted UI reports the runner's current check count; the endpoint is intentionally
development-only and is not presented as a production action for jury reviewers.

Run `pnpm test` to execute the suite. It reuses a running development server or starts and stops one automatically.

### Live Network Preflight: `GET /api/preflight`
Returns live block heights, RPC latency, and connectivity status for:
* Base Sepolia RPC (`https://sepolia.base.org`)
* Zcash Testnet LightwalletD (`testnet.zec.rocks:443`)
* Solana Devnet RPC (`https://api.devnet.solana.com`)

Use `/api/preflight?demo=quick&amountUsd=0.50` to check the short jury path:
the shared, already-funded jury Zcash source, Zcash spend readiness, and the
Solana exit. The tenant ledger and authority remain isolated, while the live
testnet inventory is pooled for this hackathon-only route.
The Interactive Demo Tour exposes this as **Quick Jury Demo**. Use
`/api/preflight?amountUsd=1` for the optional fresh Base entry path. Capacity
now includes the active tenant's spendable share of that pooled jury source; it
is not inferred from the ledger alone. `readyForQuickDemo` and
`readyForRequestedRun` are reported separately, so a short proof run is not
confused with a fresh deposit. The tenant pool still contains separately
provisioned authorities and ledgers; one tenant is never rotated across
concurrent jury browsers.

---

## 9. Running Locally

### Prerequisites
* Node.js v20.9.0 or newer (required by the installed Next.js 16 version)
* pnpm 12 (the repository declares its package manager in `package.json`)
* Rust toolchain (only required when rebuilding the Zcash helper binary)

### Quickstart
```bash
# 1. Open the supplied repository checkout
cd Aura

# 2. Install dependencies
pnpm install

# 3. Configure environment variables (optional for live testnet wallets)
cp .env.example .env.local

# 4. Run the reviewer-safe repository gate
pnpm repo:check

# 5. Start Next.js development server
pnpm dev -- -p 4173

# 6. Open application
# Navigate to http://localhost:4173
```

### Reviewer Quickstart vs. Live Testnet Operator Setup

The reviewer path runs the application and its local integrity checks without
committing secrets or wallet state. The live testnet path additionally needs the
Zcash helper binary, a synced testnet wallet, funded Base/Solana relayers, and the
server-side variables shown below:

```bash
# From zcash-devtool/; produces target/release/zcash-devtool(.exe)
cargo build --release

# Then point the app at the binary and wallet data in .env.local:
# ZCASH_DEVTOOL_PATH=./zcash-devtool/target/release/zcash-devtool.exe
# ZCASH_WALLET_DIR=./zcash-wallet-data
```

Never add `.env.local`, `.aura-data`, or `zcash-wallet-data` to a submission archive.

### Production data retention boundary

The hackathon demo keeps its durable ledger and proof records so reviewers can
inspect the complete testnet flow. A production deployment must set
`AURA_DATA_RETENTION_DAYS` to a finite positive number. On server startup, old
terminal transaction records are redacted to remove recipient addresses,
destination addresses, explorer links, local proof metadata, and leg
descriptions; expired payment requests are deleted. Accounting amounts and
chain hashes needed for settlement reconciliation remain available.

This is a retention/minimization layer, not a claim of production self-custody.
Production still requires a transactional database/outbox and audited custody
or signing infrastructure before handling real funds.

### Production roadmap (explicitly outside the testnet demo)

The next product milestones are deliberately separate from the live hackathon
flow: request-specific deposit references so a payment is bound before funds
move; a client-side Privacy Check with minimum-metadata operation; a local or
self-custodial Zcash wallet; audited EVM signing libraries and smart-account
support (including ERC-6492 for counterfactual accounts); a stable-value
funding/settlement path; pooled liquidity or routing-provider selection rather
than one permanent payout identity; and selective audit disclosure with team
roles and approvals. None of these roadmap items is implied to be live by the
current Base Sepolia → Zcash Testnet → Solana Devnet demo.

`/api/preflight` exposes this boundary as `checks.routingArchitecture.productionBoundary`:
the hackathon demo can be ready while production readiness remains explicitly
`false` until those components are replaced.

The product execution mode is controlled by `AURA_RUNTIME_MODE`, not
`NODE_ENV`. Set it to `hackathon-testnet` for the hosted jury demo; this mode
keeps the public demo behind durable budget and rate limits. Set it to
`production` only when the transactional database and audited custody
boundary are ready. In that explicit mode, deposit, spend, settlement,
sponsored-demo, quote, and payment-request write endpoints fail closed with
`503 PRODUCTION_BOUNDARY_NOT_READY` instead of using the demo filesystem ledger
or server-operated testnet custody.

For rate-limit fairness, the browser receives an HttpOnly `aura_rl_id` bucket
cookie from Proxy. It is only a throttling bucket, never an identity or wallet
credential. Requests without that cookie still fall under the global emergency
limiter; deployments behind a trusted proxy may additionally enable
`AURA_TRUST_PROXY=true` for forwarded-IP buckets.

### Environment Configuration (`.env.local`)
```env
PORT=4173
AURA_DATA_DIR=./.aura-data
BASE_SEPOLIA_RPC=https://sepolia.base.org
SOLANA_DEVNET_RPC=https://api.devnet.solana.com
# Optional comma-separated RPC fallbacks used for reads, broadcasts, and confirmation checks.
# BASE_SEPOLIA_RPC_FALLBACKS=https://base-sepolia-rpc.publicnode.com
# SOLANA_DEVNET_RPC_FALLBACKS=https://api.devnet.solana.com
BASE_SEPOLIA_USDC_CONTRACT=0x036CbD53842c5426634e7929541eC2318f3dCF7e
VAULT_DEPOSIT_ADDRESS=0x84bE03816773229bBcE6e422D7702f23fD6Ec10e

# Zcash shielding requires a compiled binary, synced wallet, and spendable test ZEC.
# If unavailable, the deposit/receive flow fails closed and does not claim shielding succeeded.
ZCASH_DEVTOOL_PATH=./zcash-devtool/target/release/zcash-devtool.exe # or /usr/local/bin/zcash-devtool
ZCASH_WALLET_DIR=./zcash-wallet-data
ZCASH_SERVER=zecrocks # connects to testnet.zec.rocks:443

# Required for Try Demo and server-operated testnet payouts. Never commit these keys.
# DEMO_WALLET_BASE_PRIVATE_KEY=
# DEMO_WALLET_SOLANA_PRIVATE_KEY=
# Optional separate, durable demo recipient key. If omitted, Aura persists a
# separate recipient under AURA_DATA_DIR; it is never the relayer address.
# DEMO_WALLET_SOLANA_RECIPIENT_PRIVATE_KEY=
# Optional when AURA_RUNTIME_MODE=production. The public hackathon-testnet
# mode uses the durable demo budget/rate limits instead. Forwarded IP headers
# are trusted only when explicitly enabled.
# AURA_DEMO_JURY_CAPABILITY=
# AURA_TRUST_PROXY=false
# Comma-separated pool of separately provisioned, funded jury tenants.
# AURA_JURY_TENANT_IDS=vault_r_replace_1,vault_r_replace_2,vault_r_replace_3
```

In local `hackathon-testnet` mode, the `Explore AURA` button opens the product
preview. The live jury flow starts only after an authenticated jury session.
The `Try Demo` button obtains a short-lived
HttpOnly jury session without requiring a browser secret only when
`AURA_DEMO_LOCAL_BOOTSTRAP=true` is explicitly enabled. Hosted deployments
must configure `AURA_DEMO_JURY_CAPABILITY`; the session is created through
`POST /api/wallet/demo/jury-session` with the capability header. Durable
server-side budget and rate limits still protect the testnet wallet. The capability
is never placed in browser storage or frontend code. The operator-only
final-flow runner is kept in the working project for an intentional testnet
proof run and is not included in the jury-safe submission archive; the archive
relies on the browser flow and the server-issued session instead. If the
production capability is missing, sponsored demo issuance is disabled and the
server fails closed; no test funds are sent.
Each signed jury session leases one tenant from `AURA_JURY_TENANT_IDS` for the
session lifetime. The lease is stored in `AURA_DATA_DIR`, so concurrent browsers
cannot rotate the same tenant's spend key or share its demo history. If every
tenant is leased, a new session fails closed instead of silently reusing another
tenant.
The operator sequence is deliberately simple:

1. Start the server with `pnpm dev` (or build with `pnpm build && pnpm start`).
2. In the private operator checkout, run `pnpm operator:check`.
3. Open `/balance?tour=1` through the jury invite/session and start `Try Demo`.

For the actual hosted release gate, set `AURA_OPERATOR_BASE_URL` to the deployed
jury origin and `AURA_JURY_DEMO_URL` to its same-origin
`/balance?tour=1` invite, then run `pnpm launch:check`. This is separate from
the local archive check: it verifies the deployed page and runs the read-only
Quick preflight against every configured tenant. Finally open that invite in a
clean browser and run **Quick Jury Demo** twice; no submission is complete until
both runs finish with real receipts.

`pnpm operator:check` validates every configured jury tenant: durable recovery
and spend authority, live Zcash account/balance, Quick Demo readiness, and a
real Privacy Check warning pattern. It is read-only and does not create a
browser session or tenant lease. Reviewers should use `pnpm repo:check`, which
does not require private runtime material.

`pnpm test` starts its own temporary audit server and data directory. It never
executes the audit suite against the live jury server or its durable tenant
pool.

### Hosted jury deployment boundary

The live jury demo must run as one long-lived Node process/container/VM with a
durable mounted `AURA_DATA_DIR` and `ZCASH_WALLET_DIR`. Do not deploy the demo
worker on a scale-to-zero/serverless filesystem: the ledger, Zcash wallet lock,
pending-operation reconciler, and 15-second background worker all depend on
process liveness and durable disk. If the deployment needs horizontal scaling,
replace the filesystem ledger and timer with an external transactional database
and a durable job worker before enabling production mode.

The hosted invite decision is explicit: the public landing page does not expose
a permanent `#jury=SECRET`. Give judges a private, expiring invite/session or
use the platform's private access control. The browser receives only an
HttpOnly session cookie; the demo signing token is never returned in JSON or
stored in localStorage.

For a genuinely new end-to-end proof, run the operator script with
`AURA_ALLOW_LIVE_FINAL_FLOW=1`; it starts a fresh flow by default and never
reuses `.aura-data/final-flow-state.json`. Set
`AURA_RESUME_FINAL_FLOW=1` only when intentionally resuming an interrupted
run with the same controlled recipient and flow schema. The proof runner also
requires `AURA_FINAL_FLOW_RECOVERY_PHRASE` (a valid 12-word BIP-39 phrase) so
its recovery rotation is derived from the same authority used by the browser;
the phrase is read only from the operator environment and is never sent to the
server.

`pnpm proof:check-artifact` checks the structure and hash/status formats in the sanitized `public/verified-proof.json` artifact
without sending anything or requiring the operator's private `.aura-data`
directory. It validates the original timestamps, public transaction hashes,
confirmation states, and the positive Private Balance checkpoint. The private
operator workspace may still use `scripts/verify-final-proof.mjs` separately
for the deeper read-only RPC and local-wallet audit; that internal verifier is
not part of the clean submission archive. In the full operator checkout, run
`node scripts/verify-final-proof.mjs` for that live check; the public artifact
command never claims live chain verification.

### Latest verified testnet run

The sanitized [`public/verified-proof.json`](public/verified-proof.json) is the
single source of truth for the identifiers below. `pnpm proof:check-artifact`
also fails if this table drifts from that artifact.

The server-side read-only relayer proof check reported `PASS` for a fresh $1.00
deposit and $0.02 payout after the current settlement and recovery changes.
These are public transaction identifiers. Base receipt/finality and Solana
transfer/finality were checked through the configured relayer RPCs; the Zcash
mined heights and exact operation memos were checked against the synced
operator wallet. The artifact records the operator observation time separately
from the application event timestamp.

| Step | Public proof |
| --- | --- |
| Base Sepolia USDC deposit | [0xb666370fbb6be2a05307c3ab3d3f2aa68bca873b6d8c3b3a40a073347348c8d7](https://sepolia.basescan.org/tx/0xb666370fbb6be2a05307c3ab3d3f2aa68bca873b6d8c3b3a40a073347348c8d7) · finalized |
| Zcash Testnet shielding | `605e02aed9a7ad6519fb03779ac72f8e448e0376f67faa6b9eaa6a3be389c4b4` |
| Zcash shielding mined block | `4410610` (operator wallet record) |
| Deposit checkpoint | $0.00 → ≈$0.85 ZEC-backed value before Pay |
| Conversion breakdown | $1.00 → 0.000684 ZEC · entry ≈$1,461.99/ZEC · verification mark ≈$1,242.69/ZEC · recorded network fee $0.00 |
| Marked value at verification | ≈ $0.85 ZEC-backed value; the $0.15 difference is a marked-value/reserve difference, not an Aura fee |
| Zcash Testnet spend | `1e798e459f7665e21c4bdd29a1b68953581b2b8cce92d7ae4841184e5389d385` |
| Zcash spend mined block | `4410626` (operator wallet record) |
| Solana Devnet payout | [4UUUUxSmrXma3aMhLYav17Jq9KacerwVo74M8t9aS241sieGCapRUWemLeoakwtJ3REAmxkn9V3vCo8FzwRMceAB](https://solscan.io/tx/4UUUUxSmrXma3aMhLYav17Jq9KacerwVo74M8t9aS241sieGCapRUWemLeoakwtJ3REAmxkn9V3vCo8FzwRMceAB?cluster=devnet) · finalized |

The verified payout recipient was `HTSBQs5YNHnJbp4QbjbTdYuvawr776Zuvfpp6GzMcyKN`.

The `$0.92` value is a USD mark-to-market estimate of the confirmed shielded ZEC
at the verification timestamp, after testnet amount precision and the shielded
network reserve are accounted for. It is not an Aura fee or an 8% production
charge: this demo route records `feeUsd: 0` and the test amount is intentionally
small and rate-sensitive.

### Settlement and liquidity model

```text
User balance → server quote / solver-liquidity layer → target-chain payout
                    │
                    ├─ demo: pre-funded Base, Zcash, and Solana test inventory
                    └─ production: quoted solver / intent liquidity, fee, spread,
                                  price-risk, refund, and failure policy
```

The testnet demo proves routing and confirmation mechanics; it does not claim
that pre-funded inventory is a production settlement model. Production must
define a routing provider or pooled-liquidity strategy rather than relying on
one permanent payout identity, who supplies ZEC/SOL liquidity, who carries
ZEC price risk, how fees or spread are quoted, and how an unsuccessful
conversion is refunded. NEAR
Confidential Intents is the intended future routing/execution direction, not an
already-live production integration. NEAR would handle confidential execution;
AURA plus Zcash handle persistent shielded holding state and the payment-time
policy between transactions.

---

## 10. Hackathon Jury Verification Guide

To verify Aura during the hackathon evaluation:

1. **Start, check, open:** Start the server, run `pnpm operator:check`, then open [http://localhost:4173/balance?tour=1](http://localhost:4173/balance?tour=1) through the operator-provided jury invite/session. The public URL is read-only. After the session is active, the Interactive Demo Tour runs the Quick Jury Demo and its authenticated preflight for the assigned tenant.
2. **Run Cryptographic Test Suite:** In development mode, POST to `/api/audit/test-runner` to run the automated checks. They test accounting and cryptographic helpers; they do not prove a live chain transaction succeeded.
3. **Test Private Deposit:** First ensure preflight is ready and the demo relayer has test USDC plus Base Sepolia ETH for the public-chain transaction fee. Zcash has no separate gas token: its network fee is paid from the existing ZEC source balance. Then navigate to `/balance`, connect a Base Sepolia wallet or choose `Try Demo`, and submit a deposit. The demo wallet transfer limit is $20 USDC per transaction.
4. **Inspect the wait policy:** Navigate to `/send` and compare the available balance under each wait setting. A delay may reduce simple timing clues; it does not prove transactions cannot be linked.
5. **Test Single-Use Invoices:** Navigate to `/receive`, create an invoice, copy the link, and view the atomic CAS single-use fulfillment behavior.
6. **Verify the execution record:** Open `/activity`, choose the operator-verified testnet receipt, and inspect the real Base Sepolia hash, Zcash Testnet transaction IDs, timestamps, and Solana Devnet signature. The UI labels saved evidence as `LAST VERIFIED RUN` when live RPC state is unavailable. This is chain hashes plus an operator-verified run and balance checkpoint, not a cryptographic Zcash payment-disclosure receipt.

For the short judge presentation, follow [JURY_DEMO.md](JURY_DEMO.md).

For submission preparation, use [VIDEO_SUBMISSION_PLAN.md](VIDEO_SUBMISSION_PLAN.md),
[INTERVIEW_QA.md](INTERVIEW_QA.md), [HACKATHON_BUILD_LOG.md](HACKATHON_BUILD_LOG.md),
and [WEEKLY_UPDATE_SCRIPT.md](WEEKLY_UPDATE_SCRIPT.md). These files are
preparation material; the repository does not claim that a presentation or
demo video has been recorded until the actual video files are produced.

---

## 11. License

MIT License. See [LICENSE](LICENSE). Designed and built for the Hackathon.
