# Third-party notices

## `zcash-devtool`

AURA vendors and adapts the source of the official Zcash developer wallet tool:

- Upstream: https://github.com/zcash/zcash-devtool
- Snapshot commit: `5a26ee854e634a4e88d1d79dab13f8fbb1eac6b8`
- License: MIT OR Apache-2.0
- License texts: `zcash-devtool/LICENSE-MIT` and `zcash-devtool/LICENSE-APACHE`
- Vendored paths: `zcash-devtool/src`, `Cargo.toml`, and `Cargo.lock`.

The AURA repository uses this tool as a testnet wallet/CLI boundary. AURA's
TypeScript service starts the compiled binary, supplies the testnet wallet
directory, serializes access, and interprets its output. The AURA application
code is not represented as upstream Zcash work.

The vendored snapshot includes the upstream source and license notices in the
jury archive. Dependency licenses remain governed by their respective Cargo
package metadata and lockfile.

## Hackathon disclosure

This archive makes no claim about AURA work predating the hackathon. If any
pre-hackathon code, design, research, or infrastructure exists, the submission
owner must disclose it through the official submission form using the accurate
dates and scope. The archive does not invent dates, founder history, traction,
or ownership claims.

The final disclosure should state, in plain language:

- the hackathon start date and the first date AURA work began, if applicable;
- which code, design, research, or infrastructure existed before that date, if applicable;
- what was built during the hackathon; and
- any third-party code or assistance used in the submitted archive.
