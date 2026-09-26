# Threat model

This document covers what can go wrong in the proof of concept, what the PoC does about it today, and what a production system would still need. Each mitigation points to the code that implements it and the test or demo scenario that exercises it.

## System and trust boundaries

```
 ┌──────────────┐  signed reading   ┌──────────────┐   submitReading()   ┌───────────────────────────┐
 │ Smart meter  │ ────────────────▶ │    Oracle    │ ──────────────────▶ │ EnergyToken               │
 │ (own key)    │   HTTP (untrusted)│ (ORACLE_ROLE)│  tx (authenticated) │  re-verifies everything   │
 └──────────────┘                   └──────────────┘                     │  mints / burns credits    │
        ▲ trust boundary 1                 ▲ trust boundary 2            └─────────────┬─────────────┘
        │ physical device                  │ single operator                            │ ERC-20
 ┌──────────────┐                                                        ┌─────────────▼─────────────┐
 │ Household    │ ─────────────── list / buy / cancel (own wallet) ─────▶│ EnergyMarketplace         │
 │ wallet       │                                                        │  escrow, max-price guard  │
 └──────────────┘                                                        └───────────────────────────┘
 ┌──────────────┐  registerMeter / pause                     ┌──────────────┐
 │ Admin        │ ──────────────────────────────────────────▶│ Both contracts│   trust boundary 3: role holders
 │ (REGISTRAR,  │                                            └──────────────┘
 │  PAUSER)     │
 └──────────────┘
```

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Smart meter | Measuring its own export/import, keeping its key secret | Anything about other meters |
| Oracle | Liveness: relaying readings promptly and in order | Correctness: the contract re-checks every reading |
| Registrar (utility / DSO) | Binding meter keys to owners and rated capacities | — (compromise is critical, see below) |
| Pauser | Stopping the system in an emergency | — |
| Households | Their own trading decisions | Everything else |
| Dashboard viewers | Nothing: read-only view (the chain RPC beside it is not read-only, see T10) | — |

The key design decision is **defence in depth at trust boundary 2**: `EnergyToken.submitReading` repeats the oracle's security checks on-chain (signature, registration, alignment, replay, double counting, capacity). The oracle is trusted to be *live*, not to be *honest*.

## Threats

### T1. Spoofed meter (fabricated readings)

**Attack.** Someone without a meter's key submits readings in its name (or invents a meter) to mint credits for energy that was never exported.

**PoC mitigations**
- Every reading is an EIP-712 typed-data signature by the meter's own key (`src/shared/reading.ts`, `src/meter-simulator/meter.ts`). The domain binds it to one chain id and one `EnergyToken` address, so signatures cannot be replayed on another deployment or chain.
- The oracle recovers the signer and rejects anything not signed by the claimed meter (`BAD_SIGNATURE`) or not registered (`UNKNOWN_METER`) — `src/oracle/validation.ts`. It accepts only the signature encoding the contract accepts (65 bytes, v = 27/28, low s; `isCanonicalSignature` in `src/shared/reading.ts`), so a re-encoded copy of a genuine signature cannot get a reading accepted off-chain, refused on-chain and the genuine one then turned away as a duplicate. If the chain does refuse an accepted reading for any reason, the oracle forgets it, so a correct copy can still settle.
- The contract independently recovers the signer (`ECDSA.tryRecoverCalldata`, low-s enforced) and reverts with `InvalidMeterSignature` / `UnknownMeter`.
- Meters are onboarded only by `REGISTRAR_ROLE`; the oracle does not hold it.

**Evidence.** Tests: *"rejects a reading signed by a key other than the meter's"*, *"rejects a signature made for a different contract"*, *"rejects readings from unregistered meters"*, oracle *"rejects spoofed meters"*. Demo scenario at 09:00 ("Spoofed meter").

**Residual risk / deferred.** A meter whose key is *extracted* (physical tampering) can sign anything up to its rated capacity (see T5). Production: keys generated and held in a secure element / TPM, device attestation at provisioning, key rotation and revocation lists, tamper detection.

### T2. Compromised oracle

**Attack.** The oracle's signing key leaks, or its operator turns malicious. It could try to mint for itself or others, replay old readings, register meters, or censor.

**PoC mitigations**
- The oracle cannot fabricate readings: the contract requires a valid signature from a registered meter for every mint. A stolen oracle key can only submit readings that meters actually signed.
- It cannot replay or double-submit: per-meter `lastNonce` and `lastIntervalStart` are enforced on-chain.
- It cannot exceed physical limits: `maxExportWh` / `maxImportWh` are enforced on-chain.
- It cannot onboard meters it controls: that requires `REGISTRAR_ROLE`, held separately.
- The admin can revoke `ORACLE_ROLE` and grant it to a fresh key (`AccessControl`), and can pause the token while doing so.
- The consumption burn is also driven by meter-signed readings, so a compromised oracle cannot burn arbitrary balances either (a compromised *registrar* can, see T6). It can, however, choose *when* a reading settles, and the burn uses the owner's balance at that moment (see residual risk).

**Evidence.** Tests: *"only the oracle can submit readings"*, *"stops a revoked oracle from minting"*, *"only lets the registrar register meters (not the oracle)"*. Demo scenario at 11:00 ("Compromised oracle") attempts all of these against the live contract and shows each revert.

**Residual risk / deferred.**
- **Censorship and delay.** A single oracle can drop or hold readings (liveness). Readings are also only accepted in order, so dropping one reading does not block later ones (nonce gaps are allowed) but its energy is never credited.
- **Selective submission.** It could favour some meters over others.
- **Burn timing.** The consumption burn uses the owner's balance when the reading settles. By holding an import reading back (up to the 6-hour window the oracle accepts, and on-chain without limit), an oracle makes it burn credits the household bought after the consumption.
- Production: several independent oracle operators with a k-of-n threshold (or a decentralised oracle network), meters able to submit directly as a fallback, public monitoring that compares meter-published hashes with settled readings, and a dispute window.

### T3. Front-running

**Attack.** Transactions are visible in the mempool before they are mined. A seller (or anyone) sees a pending `buy` and (a) raises the listing price so the buy fills at a worse price, or (b) buys the listing first.

**PoC mitigations**
- `buy(listingId, amountWh, maxPricePerKwh)` reverts with `PriceAboveLimit` if the listing's price is above what the buyer signed for. A re-price can make a buy fail, never overcharge it.
- Listings are escrowed, so the seller cannot sell the same credits twice or pull them out from under a buyer without a visible `cancelListing`.
- `buy` reverts with `InsufficientListing` rather than partially filling a different amount than requested.

**Evidence.** Tests in *"front-running protection"*. Demo scenario at 12:00 ("Front-running") disables auto-mining, puts a buyer's transaction and a higher-tip seller re-price in the same mempool, mines them in one block (re-price first), and shows the buy revert with the buyer paying nothing.

**Residual risk / deferred.** Buyers can still be *raced* (someone else takes the cheap listing first — the loser's transaction just reverts), and failed transactions still cost gas. Sellers can observe demand. Production: per-interval sealed-bid or batch auctions (uniform clearing price), commit–reveal, or a private mempool / sequencer with fair ordering on an L2.

### T4. Double counting

**Attack.** The same exported energy is credited more than once: the same reading replayed, the same interval re-signed with a new nonce (buggy or malicious meter firmware), an old interval submitted out of order, or the oracle retrying a transaction that already succeeded.

**PoC mitigations**
- Intervals are aligned to 15 minutes (`IntervalNotAligned`) and must have ended (`IntervalNotFinished`), so a meter cannot pre-claim the future.
- Each meter's `intervalStart` must be strictly greater than the last settled one (`IntervalAlreadySettled`) and its nonce strictly greater than the last (`StaleNonce`). Each (meter, interval) is therefore credited at most once, and replays are impossible even with a fresh signature.
- A meter address can be registered only once (`MeterAlreadyRegistered`), so its replay history can never be reset.
- The oracle rejects exact duplicates (`DUPLICATE`), already-settled intervals (`INTERVAL_ALREADY_SETTLED`) and reused nonces (`REPLAYED_NONCE`) before paying gas. Its cursor takes the maximum of its own state and the chain's, so it stays correct across restarts. If a submission was mined but its confirmation was lost, the oracle finds the receipt before retrying, so the reading is recorded as settled rather than resubmitted and reported as rejected.
- Credits sold on the marketplace are escrowed, and burned credits are gone, so a kWh cannot be both sold and self-consumed.
- The settlement report re-checks the whole history, independently of the contract's own checks: *every credit traces to a signed reading* (it decodes each `submitReading` call, recovers the meter's EIP-712 signature, and checks the registered owner and the amount minted), *no interval credited twice*, *supply = minted − burned*.

**Evidence.** Tests in *"replay protection and double counting"*, oracle *"rejects exact replays, double counting and reused nonces"*, *"reconciles a submission that was mined although its confirmation was lost"* and *"picks up the chain's cursor after a restart"*, and settlement *"re-verifies each reading's meter signature from calldata"*. Demo scenario at 09:30 ("Replay and double counting"). Report integrity checks.

**Residual risk / deferred.** Double counting *across systems* is out of scope: the same export could also be claimed under utility net metering or as a renewable energy certificate. Production: integrate with the utility's billing and with a certificate registry (e.g. I-REC, GO, M-RETS) so a kWh is retired in exactly one place.

### T5. Tampered or faulty meter (implausible values)

**Attack.** A meter with extracted keys or faulty firmware signs readings with inflated export.

**PoC mitigations.** Export is capped at the registered PV nameplate for 15 minutes and import at the service connection limit, both off-chain (`EXPORT_ABOVE_CAPACITY`, `IMPORT_ABOVE_CAPACITY`) and on-chain (`ExportAboveCapacity`, `ImportAboveCapacity`). The registrar can suspend a meter (`setMeterActive`). Demo scenario at 10:00 ("Implausible production").

**Residual risk / deferred.** Inflation *below* the cap is not detected. Production: compare against irradiance data and neighbouring systems, flag export at night for systems without storage, reconcile with the utility's revenue-grade meter data (VEE: validation, estimation, editing), and anomaly detection.

### T6. Compromised admin / registrar

**Attack.** `REGISTRAR_ROLE` alone is enough to do serious damage; the honest oracle relays any reading signed by a registered, active meter within that meter's registered caps, and the registrar sets both freely.
- **Minting.** It registers a meter whose key it holds, with itself as owner and a rated export of up to `uint32` max (about 4.29 GWh per interval), then has that meter sign export readings.
- **Burning anyone's credits.** It registers a meter it controls with a victim wallet as owner and a large import limit, then has it sign an import reading: up to that many credits are burned from the victim. If the "victim" is the `EnergyMarketplace` address, the escrow itself is burned, and every `buy` and `cancelListing` on the open listings then reverts.
- The admin key can additionally grant itself any role, including `ORACLE_ROLE`.

**PoC mitigations.** Roles are separated (the oracle is not a registrar) and every role and registry change is an on-chain event. That is all; the admin and registrar are one deployer key.

**Deferred.** Multisig admin behind a timelock (`AccessControlDefaultAdminRules`), registrations requiring utility attestation, protocol-wide caps on rated capacities, refusing contract addresses (such as the marketplace) as meter owners, monitoring of role and registry events.

### T7. Emergency / incident response

**PoC.** `PAUSER_ROLE` can pause `EnergyToken` (blocks mint, burn and all transfers, therefore trading, and also freezes escrowed credits until unpause) and `EnergyMarketplace` (blocks listing, re-pricing and buying but still lets sellers cancel and recover escrowed credits). While paused, the oracle keeps accepted readings in an order-preserving queue and settles them after unpause, so no data is lost. Demo scenario at 13:00 ("Emergency pause": a listing attempt reverts, all 10 readings queue, all 10 settle after unpause); tests *"queues readings while the token is paused"*, *"blocks minting, burning and transfers while paused"* and *"keeps escrow in place while the energy token is paused"*.

**Deferred.** The queue is in memory; a production oracle needs durable storage, and resubmission that stays idempotent across restarts (within one process, a lost confirmation is already reconciled from the transaction receipt).

### T8. Smart-contract bugs, reentrancy and denial of service

**PoC.**
- OpenZeppelin v5 base contracts; Solidity 0.8 checked arithmetic.
- `ReentrancyGuard` and checks-effects-interactions on every marketplace function that moves tokens; `SafeERC20` for transfers.
- No loops anywhere in the contracts: every function does constant work, so no call can run out of gas as state grows. Open listings are enumerated off-chain from events.
- Cost rounding is up (`Math.mulDiv(..., Ceil)`), so dust purchases are never free.
- 85 unit tests covering minting rules, trades, access control, pause, replay, the oracle, the settlement report's integrity checks and the dashboard proxy.

**Deferred.** Independent audit, fuzzing / invariant tests (e.g. supply = minted − burned under random operations), formal verification of the reading checks.

### T9. Privacy

**Risk.** Every 15-minute import/export reading is public on-chain. Load profiles reveal occupancy, routines and appliance use; wallet addresses link to meters.

**PoC.** Not mitigated — accepted for a transparent demo.

**Deferred.** Put only commitments (hashes or Merkle roots) on-chain with the readings held off-chain by the utility; aggregate before publishing; zero-knowledge proofs of "exported X kWh in period P"; a permissioned chain or L2 with restricted data visibility; pseudonymous, rotating meter identifiers.

### T10. Dashboard and service endpoints

**PoC.** All services bind to `127.0.0.1`. The dashboard's JSON-RPC proxy forwards only read-only methods (`eth_call`, `eth_getLogs`, …) and refuses anything that could change state. The browser inserts all dynamic text with `textContent`, never `innerHTML`, and renders out-of-range values from the oracle feed as a dash rather than failing. The oracle caps request bodies at 16 KB and the proxy at 64 KB (both answer 413) and treat every field as untrusted input. Tests in *"Dashboard RPC proxy"* and the oracle's *"HTTP server"*.

**Not a boundary.** The read-only proxy protects only the dashboard's own endpoint. The Hardhat node itself (`127.0.0.1:8545`) is unauthenticated, accepts cross-origin requests and holds unlocked accounts, including the admin. While the demo runs, any local process, or a web page the browser lets reach localhost, can send it transactions: grant roles, register meters, pause, or rewrite state with `hardhat_*` / `evm_*` methods. Acceptable for a local demo with nothing of value; not something to expose.

**Deferred.** Authentication, TLS, rate limiting, and meter-side mutual TLS for a networked deployment; a node that does not hold keys, with the chain RPC reachable only through an authenticated gateway.

## Summary

| Threat | Mitigated in PoC | How | Deferred to production |
|---|---|---|---|
| Spoofed meter | Yes | EIP-712 meter signatures, registry, verified off- and on-chain | Secure elements, attestation, key revocation |
| Compromised oracle | Minting: yes. Liveness: no | Contract re-verifies every reading; role separation; revocable role | k-of-n oracles, direct meter fallback, monitoring |
| Front-running | Price manipulation: yes. Racing: no | `maxPricePerKwh`, escrowed listings | Batch auctions, commit–reveal, fair sequencing |
| Double counting | Within the system: yes | Strict per-meter interval + nonce ordering, one-time registration, report checks | Registry integration against net metering / RECs |
| Tampered meter | Above rated capacity only | Capacity caps, meter suspension | Irradiance / neighbour cross-checks, utility VEE |
| Compromised admin / registrar | No | Role separation only | Multisig + timelock, capacity caps, attested registrations |
| Contract bugs / DoS | Partly | OZ, reentrancy guard, no loops, tests | Audit, fuzzing, formal verification |
| Privacy | No | — | Off-chain data with on-chain commitments, ZK proofs, permissioned chain |
