import os
import re

audit_results = []

# 1. authoritative-balance.ts
with open("lib/services/authoritative-balance.ts", "r", encoding="utf-8") as f:
    ab_content = f.read()

has_enclave_spendable = "enclaveCredit" in ab_content
audit_results.append({
    "file": "lib/services/authoritative-balance.ts",
    "check": "No enclaveCredit in spendable balance",
    "passed": not has_enclave_spendable,
    "detail": "enclaveCredit was NOT found in authoritative-balance.ts" if not has_enclave_spendable else "FAIL: enclaveCredit still present"
})

# 2. app/api/deposit/route.ts
with open("app/api/deposit/route.ts", "r", encoding="utf-8") as f:
    dep_content = f.read()

# Check: does it do txStatus = 'completed' when !zcashTxid?
bad_pattern = re.search(r"if\s*\(\s*isConfirmedOnChain\s*\)\s*\{\s*if\s*\(\s*zcashTxid\s*\)\s*\{\s*txStatus\s*=\s*zcashConfirmed\s*\?\s*'completed'\s*:\s*'routing_shielded'\s*\}\s*else\s*\{\s*txStatus\s*=\s*'completed'", dep_content)
has_premature_completed = bool(bad_pattern)
has_enclave_committed_dep = "legs.shielded.status = isConfirmedOnChain ? 'enclave_committed'" in dep_content

audit_results.append({
    "file": "app/api/deposit/route.ts",
    "check": "No premature completed on Base-only confirmation",
    "passed": not has_premature_completed and not has_enclave_committed_dep,
    "detail": "txStatus strictly requires zcashConfirmed === true" if (not has_premature_completed and not has_enclave_committed_dep) else "FAIL: Premature completed found"
})

# 3. lib/services/pending-operation-reconciler.ts
with open("lib/services/pending-operation-reconciler.ts", "r", encoding="utf-8") as f:
    rec_content = f.read()

bad_reconciler = "sourceDepositConfirmed" in rec_content and "completed" in rec_content
audit_results.append({
    "file": "lib/services/pending-operation-reconciler.ts",
    "check": "No Base-only completed in reconciler",
    "passed": "sourceDepositConfirmed" not in rec_content,
    "detail": "sourceDepositConfirmed removed; strictly requires Zcash confirmation" if "sourceDepositConfirmed" not in rec_content else "FAIL: sourceDepositConfirmed still present"
})

# 4. app/balance/page.tsx
with open("app/balance/page.tsx", "r", encoding="utf-8") as f:
    bal_content = f.read()

has_enclave_committed_bal = "enclave_committed" in bal_content
audit_results.append({
    "file": "app/balance/page.tsx",
    "check": "No enclave_committed in isShieldedConfirmed",
    "passed": not has_enclave_committed_bal,
    "detail": "enclave_committed removed from balance page" if not has_enclave_committed_bal else "FAIL: enclave_committed still present"
})

print("=== CODEBASE AUDIT RESULTS ===")
all_passed = True
for r in audit_results:
    status = "PASS [OK]" if r["passed"] else "FAIL [X]"
    print(f"[{status}] {r['file']}: {r['check']} -> {r['detail']}")
    if not r["passed"]:
        all_passed = False

print(f"\nALL CRITICAL ROLLBACK CHECKS PASSED: {all_passed}")
