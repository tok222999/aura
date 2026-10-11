# Public Testnet NU7 parameter backport

The hosted lightwalletd reports consensus branch `77190ad9`. The old helper
created NU6.3 transactions (`37a5165b`) after Testnet height 4,465,026.

This vendors the published `zcash_protocol` 0.10.6 crate, changes only the
Testnet NU7 activation height and both mappings of its consensus branch ID,
and enables the existing NU7 support throughout the wallet dependencies.
Orchard revision V3 and transaction construction remain upstream code.
Mainnet activation and existing wallet DB/key material are unchanged.

The three parameter values are taken from the published official
`zcash_protocol` 0.11.0-pre.0 `src/consensus.rs`:
https://docs.rs/crate/zcash_protocol/0.11.0-pre.0/source/src/consensus.rs

Do not deploy without parameter tests, a build, a wallet-copy compatibility
check, and a real Testnet broadcast. Broadcast acceptance alone is not mining.
