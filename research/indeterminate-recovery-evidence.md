# Durable INDETERMINATE Recovery Evidence (P0, Issue #43)

Status: implementation record for the `fix/p0-durable-indeterminate-evidence`
change. Mock / durable-store evidence only — no live provider was touched.
Related: G-21(2), PR #41, spec §6.15 / §6.16 (both FROZEN; nothing in the
spec files is changed by this work).

**Correction round (PR #50 independent review, findings R1–R4 + two
documentation-accuracy items)** is incorporated throughout: §3 states
the corrected blocking matrix (R1), §4 the branded establishment
trust boundary (R2), the provider-finality rule (R3), and the landing
reconciliation barrier + stale-quote rule (R4); §5 the schema v3
migration and the v2 compatibility rule; §9 the correction-round
failing-first and final counts.

## 1. The original vulnerability (exact)

`DurableQuoteStore.resolveAttempt(attemptId, note: string)` (schema v1):

- accepted a **free-text string** as its only evidence input;
- performed **no state check** (any attempt, in any state, could be
  "resolved") and **no evidence validation** of any kind;
- in one transaction set `operator_review_state = 'RESOLVED'` and appended
  the note to `attempt_history` — a table the store exposes **no reader**
  for. `StoredAttempt` carried no structured resolution-evidence field
  (pinned as a limitation by test56.4).

`findBlockingAttempt` blocked on `DISPATCHING`, or on `INDETERMINATE`
with `operator_review_state != 'RESOLVED'` — so **the flag alone lifted
the block**. `beginDispatch`'s same-key branch correctly returned the
standing INDETERMINATE attempt once resolved (never re-armed), but a
**new idempotency key then dispatched freely** (test56.5 semantics).

Net effect: an operator assertion — with no persisted, structured,
operation-bound evidence of what happened at the provider — was converted
into dispatch eligibility for a different key against the same
subscription. If the original mutation had in fact landed, the new
dispatch could execute a duplicate change. The recovery process turned
an operator assertion into proof of non-execution, which §6.15 forbids:
reconciliation must establish what landed, and state matching alone is
never landing proof.

## 2. Failing-first evidence

`reference/tests/test58-indeterminate-recovery-evidence.test.ts` was
written against the new contract first and run against the **unmodified
main** implementation (Node 22, local):

- **16 tests, 0 pass, 16 fail.**
- Failure modes were the vulnerability itself, not environment errors:
  the free-text call succeeded instead of refusing ("Missing expected
  exception: a string note is not resolution evidence"); empty /
  operator-assertion / snapshot sources were accepted; foreign binding
  fields and foreign request hashes were accepted; replayed evidence was
  accepted; stale observations were accepted; no resolution record
  existed after a "resolution" ("a structured resolution record
  exists"); no v2 migration occurred.

After the implementation: **test58 16/16 pass**, test56 9/9 pass,
full suite **819/819** (baseline main: 803/803; +16 net new tests, no
pre-existing test count changed).

Correction round: test58 was rewritten around the establishment flow
and test56.4/56.5 migrated, then run against the round-1 head
(`d0f35c8`) before any production change: **29 tests, 10 pass, 19
fail** (record: `P0-43-R234-FAILING-FIRST.txt` in the delivery
package). The failures are the findings themselves — e.g. 58.15
fails with "the removed raw-evidence acceptance refuses" *missing*
because the round-1 head accepts the flat raw evidence object; the
R1 assertions invert round-1's own 58.12 scenario B, which asserted
same-quote/new-key dispatch as permitted. After the correction:
**test58 20/20, test56 9/9, full suite 823/823** on both Node
versions (§9).

## 3. Proposed recovery state machine

An INDETERMINATE attempt's dispatch effect, by resolution state:

| Resolution state | Same key (standing attempt) | New key, SAME quote | New key, OTHER quote, same subscription |
| --- | --- | --- | --- |
| No evidence (incl. legacy flag-only `RESOLVED`, and v2-era terminal records without provider finality — §5) | Blocked (blind-retry prohibition) | Blocked | Blocked |
| UNRESOLVED record only | Blocked | Blocked | Blocked |
| CONFIRMED_NON_EXECUTION (established, with finality) | Returns standing attempt, never re-armed | **Blocked** (R1: §6.15 new-quote rule) | **Permitted** (a genuinely new quote; all other gates still apply) |
| CONFIRMED_LANDING, reconciliation NOT recorded | Returns standing attempt, never re-armed | Blocked | **Blocked** (R4: unreconciled landing blocks the whole subscription) |
| CONFIRMED_LANDING, reconciliation recorded | Returns standing attempt, never re-armed | Blocked (would duplicate the landed operation) | **Permitted only for a fresh, non-stale quote** (issued after the landing resolution AND computed against the landed state version; stale quotes refuse) |

DISPATCHING attempts always block, in every row. No resolution ever
re-arms the INDETERMINATE attempt itself, and no path retries it
automatically.

**R1 correction.** Round 1 permitted a new key on the resolved
attempt's OWN quote after CONFIRMED_NON_EXECUTION. The review found
this conflicts with frozen §6.15: re-authorization after
INDETERMINATE proceeds as a **new quote**, never as a re-issue of
the indeterminate attempt. The same-quote/same-key re-arm exception
in `beginDispatch` applies only to attempts that were ORIGINALLY
terminal CONFIRMED_NON_EXECUTION (an attempt-state path, untouched
by this change) — it does not extend to a retroactively resolved
INDETERMINATE attempt. Both terminal classes therefore keep the old
quote blocked for any key.

Classifications:

- **CONFIRMED_NON_EXECUTION** — the specific attempted operation is
  established not to have executed, by an established provider
  record with provider finality (§4). Any subsequently permitted
  dispatch is a new quote and must still satisfy all existing
  authorization, idempotency, freshness, and exclusion gates.
- **CONFIRMED_LANDING** — an established provider record establishes
  the operation landed, with its provider operation id. This does
  not authorize blind re-dispatch (decision
  `RECONCILE_LANDED_STATE_NO_REDISPATCH`), and it does not by itself
  unblock anything: the landed state and its financial consequences
  must be reconciled through the separate recorded barrier (§4)
  before other quotes may proceed, and then only fresh quotes
  validated against the landed state.
- **UNRESOLVED** — evidence is absent, ambiguous, stale, premature
  (finality unavailable), or insufficiently bound to the attempted
  operation. Recorded via `recordUnresolvedResolution` for audit;
  the blocking condition remains.

A provider-state snapshot that merely **matches** the intended final
state is never proof that the specific attempt executed (or did not):
`PROVIDER_STATE_SNAPSHOT` / `STATE_SNAPSHOT_MATCH` refuses for both
terminal classifications.

## 4. Structured evidence model

### 4.1 The trust boundary: branded establishment (R2)

Round 1's `resolveAttempt` accepted a raw caller-asserted evidence
object — enum strings, an arbitrary reference, a caller-supplied
digest. Structurally valid is not the same as established. The
correction round adopts the codebase's existing branded-verifier
pattern (quote-store's `establishVerification`, PR #8 R3 / PR-17):

- `establishResolutionEvidence(attempt, record, classification, now)`
  is a separately testable, module-level establishment procedure. It
  takes an actual **provider-record object**
  (`ResolutionProviderRecord`: the operation log / idempotency
  registry / audit export record for this attempt) and validates it
  field by field (below). On success it mints an
  `EstablishedResolutionEvidence` token, registered in a
  module-private `WeakSet` brand and a `WeakMap` stamping the
  token's attempt binding and a digest of its contents as minted.
- `resolveAttempt(attemptId, { evidence, operatorId,
  reconciliationDecision, justification })` accepts **only** a
  branded token: unbranded (however faithful its fields), bound to a
  different attempt, or altered after minting (content-digest
  mismatch) all refuse. The round-1 raw acceptance is removed
  entirely; UNRESOLVED outcomes move to their own method,
  `recordUnresolvedResolution(attemptId, { operatorId,
  justification })`, which appends an audit record and lifts
  nothing.

**Stated limit** (mirroring PR #8 review correction R3 on the
receipt path): the brand proves the record passed through the
establishment computation **with its checks** — binding to the
attempt, operation-bound kind, provider finality — at minting time.
It does **not** prove the record truly came from a provider: binding
records to real provider reads is the adapters' duty, and **no live
adapter produces these records in this PR**, so no production
unblock path is claimed. Until evidence is established at this
boundary, recovery fails closed.

Establishment validates:

- **Binding** — provider, site, subscription, quote, idempotency
  key, and request hash all equal the attempt's. A record about a
  different operation establishes nothing about this one.
- **Source / kind pairing** — source ∈ {`PROVIDER_OPERATION_LOG`,
  `PROVIDER_IDEMPOTENCY_REGISTRY`, `PROVIDER_AUDIT_EXPORT`}; kind is
  the classification's operation-bound kind (non-execution ∈
  {`OPERATION_LOG_NO_RECORD_FOR_KEY`,
  `IDEMPOTENCY_REGISTRY_NO_RECORD_FOR_KEY`}; landing ∈
  {`OPERATION_LOG_RECORD_FOR_KEY`,
  `PROVIDER_OPERATION_RECEIPT_FOR_KEY`}). A state snapshot refuses:
  matching state is not operation attribution.
- **Outcome coherence** — non-execution requires
  `operationFound === false` and no provider operation id; landing
  requires `operationFound === true`, the non-empty operation id,
  and an observed state that is the landed subscription state
  carrying a non-empty string `version` (extracted as
  `landedStateVersion`; the stale-quote rule keys on it).
- **Digest** — computed at establishment from the record's
  `observedState` (`sha256(canonicalStringify(observedState))`);
  callers never supply one.
- **Finality (R3, below).**

### 4.2 Provider finality (R3)

"No record for key" may be premature: a provider's log or registry
can lag the dispatch. Absence becomes CONFIRMED_NON_EXECUTION only
when the provider record is final past the settlement:

- `observedAt` is **strictly after** the attempt settled
  INDETERMINATE (`attempt.updatedAt`);
- the log/registry is declared final (`logFinal === true`);
- its completeness watermark `completeThrough` **covers the
  settlement** (`completeThrough >= attempt.updatedAt`);
- an idempotency-registry record declares `registryCoverage ===
  "FULL"` (PARTIAL / UNKNOWN refuse);
- the observation is not future-dated.

If finality is unavailable, the outcome stays UNRESOLVED. Negative
pins: pre-settlement (or at-settlement) observation, not-yet-final
log, incomplete watermark, partial/unknown coverage (test58.16).

### 4.3 The landing reconciliation barrier and stale-quote rule (R4)

A CONFIRMED_LANDING resolution is a classification, not an unblock.
Unblocking requires a separate recorded barrier:

- `reconcileLandedAttempt(attemptId, { operatorId,
  landedStateDigest, financialOutcomeDigest, justification })`
  appends one row to the append-only `landing_reconciliations`
  table (schema v3). `landedStateDigest` must **equal the
  resolution's established observed-state digest** — the
  reconciliation must be of the established landed state.
  `financialOutcomeDigest` must be a well-formed sha256: it is the
  digest of the deployment's own financial reconciliation record,
  **recorded here, not recomputed** (the store cannot recompute a
  deployment's books — stated limit). One reconciliation per
  attempt; a second refuses.
- Without the row, the landed attempt blocks the **whole
  subscription**. With it, other quotes unblock subject to the
  stale-quote rule, enforced inside the `beginDispatch` transaction
  from the stored quote row: a candidate quote refuses as **stale**
  if it was issued at or before the landing resolution
  (`created_at <= resolvedAt`) or was computed against a different
  subscription version than the landed state
  (`subscription_version_at_quote !== landedStateVersion`). Only a
  fresh quote validated against the landed state may dispatch. The
  landed attempt's own quote remains blocked regardless (R1).

### 4.4 Persisted records

Append-only table `attempt_resolutions` (schema v2; v3 columns
below). No code path updates or deletes from it. The binding fields
are **copied from the attempt row via the established token**, never
accepted as free caller fields.

| Field | Source / rule |
| --- | --- |
| `resolution_id` | Store-minted primary key |
| `attempt_id`, `quote_id`, `subscription_id`, `provider`, `site`, `request_hash`, `idempotency_key` | Copied from the attempt row (via the token the establishment procedure bound to it) |
| `classification` | `CONFIRMED_NON_EXECUTION` \| `CONFIRMED_LANDING` \| `UNRESOLVED` |
| `operator_id` | Caller; non-empty (asserted identity — see Limitations) |
| `resolved_at` | Store clock (`nowFn`) at resolution |
| `evidence_source` | Terminal only: `PROVIDER_OPERATION_LOG` \| `PROVIDER_IDEMPOTENCY_REGISTRY` \| `PROVIDER_AUDIT_EXPORT` |
| `evidence_kind` | Terminal only, operation-bound per classification (see §4.1) |
| `evidence_reference` | Non-empty for terminal; one (source, reference) pair establishes exactly one attempt's terminal resolution (replay refuses; partial unique index backstop) |
| `observed_at` | Terminal only: the established observation; post-settlement by establishment; ≤ 24h old at resolution (`RESOLUTION_EVIDENCE_MAX_AGE_MS`) |
| `observed_provider_state_digest` | Terminal only: computed at establishment from the record's observed state |
| `provider_operation_id` | Landing only: required non-empty; must be absent for non-execution |
| `reconciliation_decision` | Non-execution: `PERMIT_NEW_DISPATCH`; landing: `RECONCILE_LANDED_STATE_NO_REDISPATCH` |
| `justification` | Caller; non-empty |
| `log_final`, `complete_through`, `registry_coverage`, `landed_state_version` | **v3**: the finality and landed-version facts attested at establishment, persisted with the record (payload also records `establishmentProcedure: "establishResolutionEvidence"`) |
| `evidence_payload_json` / `evidence_hash` | Canonical payload of every binding + evidence field; `evidence_hash = sha256(canonicalStringify(payload))`, UNIQUE |

**Checksum language (documentation-accuracy item a).** The stored
hashes are **internal-consistency checksums**, not anti-tamper
authentication: on open, `loadAndRecover` re-computes each row's
checksum from its payload and checks the payload's binding against
the row columns and the referenced attempt's identity fields, and
any mismatch refuses the whole open (fail closed, the same
discipline as receipt corruption). This detects mismatched or
transplanted edits. It is an *unkeyed* digest: a writer who can
rewrite both the payload and the digest consistently can recompute
it, and is outside this mechanism's threat model — the same
disclosed posture as the quote/receipt record checksums.

Atomicity: validation that can refuse runs inside one
`BEGIN IMMEDIATE` transaction together with the insert, the
`operator_review_state` flip (terminal classifications only), and
the history entry. `faults.beforePersist("resolveAttempt")` /
`faults.insidePersistTx("resolveAttempt")` follow the existing
persistQuote poison discipline: non-evidence errors poison the
store; `ResolutionEvidenceError` / `DispatchBlockedError` do not. A
refusal persists zero resolution rows and leaves the attempt
blocked. The same discipline applies to
`recordUnresolvedResolution` and `reconcileLandedAttempt` (own fault
keys), and landing-reconciliation rows are checksum-verified and
resolution-bound on open exactly like resolution rows.

## 5. Migration and compatibility findings

- `DURABLE_SCHEMA_VERSION` 1 → 2 (round 1) → **3** (correction
  round).
- Fresh database: all v1 tables plus `attempt_resolutions` (v3
  shape) and `landing_reconciliations` with their indexes, version
  marker `'3'`, one transaction.
- v1 database: **one transaction** creates both tables at their v3
  shape and sets the marker to `'3'`. No existing row is created,
  altered, or deleted (test58.14b builds a hand-made v1 database and
  verifies the pre-existing INDETERMINATE attempt survives intact
  and blocking, and that the resolutions table starts empty).
- v2 database: **one transaction** adds the four v3 columns to
  `attempt_resolutions` (`log_final`, `complete_through`,
  `registry_coverage`, `landed_state_version`), creates
  `landing_reconciliations`, and sets the marker to `'3'`. No
  existing row is altered.
- **v2 compatibility rule**: a v2-era terminal resolution row
  migrates with `log_final` NULL — provider finality was never
  attested for it under the v3 rules — so it is **preserved as a
  record but NON-LIFTING**: `terminalResolutionFor` only returns
  rows with finality on record, and the attempt keeps blocking
  (test58.14c builds a hand-made v2 database with a terminal row
  and verifies exactly this). Finality cannot be retroactively
  asserted for the old row; lifting such an attempt requires a NEW
  resolution established under the v3 rules from a fresh, final
  provider record (the non-lifting row does not trigger
  `ALREADY_RESOLVED`, which reads through the same
  finality-filtered lookup; re-presenting the v2 record's own
  (source, reference) refuses as replay).
- Any other version (0, 4+, non-numeric, missing) refuses the open,
  as before.
- **Legacy flag-only records**: a v1 attempt with
  `operator_review_state = 'RESOLVED'` and no resolution row is
  preserved verbatim but **remains blocking** under the
  evidence-derived rules (test58.14a). It is never silently upgraded
  into a resolved record; an operator must supply structured evidence
  through the new path to lift its block.
- API compatibility: `resolveAttempt` was re-signed twice, each time
  deliberately breaking the unsafe call shape: `(attemptId, note:
  string)` → round 1 `(attemptId, evidence:
  ResolutionEvidenceInput)` → correction round `(attemptId, {
  evidence: EstablishedResolutionEvidence, operatorId,
  reconciliationDecision, justification })`. A runtime non-object
  argument, or any raw (unbranded) evidence, refuses with
  `ResolutionEvidenceError` (`RESOLUTION_EVIDENCE_REFUSED`).
  `StoredAttempt` is unchanged. New in the correction round:
  `establishResolutionEvidence`, `recordUnresolvedResolution`,
  `reconcileLandedAttempt`, `landingReconciliationFor`, and the
  types `ResolutionProviderRecord`, `EstablishedResolutionEvidence`,
  `ResolveAttemptInput`, `ResolutionEvidenceSource`,
  `StoredLandingReconciliation`; `StoredResolution` gains
  `logFinal`, `completeThrough`, `registryCoverage`,
  `landedStateVersion`, `establishmentProcedure`. The round-1 export
  `ResolutionEvidenceInput` is removed (nothing in the repo consumed
  it outside the store and its tests).
- `recoveryReport()` INDETERMINATE items carry
  `resolution: { classification, evidenceHash }`, and — correction
  round, documentation-accuracy item (b) —
  `operatorInterventionRequired` / `nextPermittedAction` are now
  **derived from the attempt's actual terminal record**: a
  CONFIRMED_NON_EXECUTION resolution reports no intervention
  required and names the new-quote rule; an unreconciled
  CONFIRMED_LANDING reports intervention required and names the
  reconciliation barrier; a reconciled landing reports no
  intervention and the fresh-quote-only unblock; an unresolved
  attempt keeps the manual-reconciliation text verbatim
  (test27.25's `/Reconcile manually/` expectation preserved, and
  "No automatic re-dispatch is permitted." appears in every
  INDETERMINATE action). The historical INDETERMINATE outcome
  itself is never rewritten by a resolution.
- Untouched, by design: G-17 authorization-preservation refusal paths,
  live adapters, `scq-engine.ts`, `types.ts`, `quote-store.ts`, the
  CONFIRMED_NON_EXECUTION **attempt-state** same-key re-arm in
  `beginDispatch`, and both spec files (freeze guard footprint empty).

## 6. Remaining limitations

- **Operator identity is asserted, not authenticated.** The store
  records `operatorId` for audit; authenticating the operator is the
  embedding service's responsibility.
- **Evidence authenticity rests on the provider read, which is out
  of scope here.** The establishment brand proves a record passed
  the establishment computation with its binding, coherence, and
  finality checks — not that the record truly came from a provider
  (§4.1, stated limit). Binding records to real provider reads is
  the adapters' duty; **no live adapter produces these records in
  this PR**, so no production unblock path is claimed. A false
  record, once resolved from, is permanently attributable in the
  append-only record — never silently editable.
- **The persisted hashes are checksums, not authentication**
  (§4.4): they detect mismatched edits between payload and digest;
  a writer able to rewrite both consistently is outside the threat
  model.
- **The financial half of the landing barrier is recorded, not
  recomputed.** `financialOutcomeDigest` attests that a deployment
  financial reconciliation record exists and is bound into the
  barrier row; the store cannot recompute a deployment's books.
- **Snapshot evidence is deliberately insufficient.** A matching
  provider state can arise from another actor's identical change
  (§6.15); only operation-bound records (operation log / idempotency
  registry / audit export, keyed to this attempt) can terminate an
  INDETERMINATE block.
- The 24h freshness window is a policy constant of this
  implementation, not a spec value.
- UNRESOLVED records (via `recordUnresolvedResolution`) are
  audit-only: operator id + justification, no evidence fields; they
  establish nothing.

## 7. PROPOSED normative change — NOT enacted (governance decision required)

The spec files are frozen and are **not** changed by this work. The
following §6.16 amendment is proposed for separate review; enacting it
requires explicit protocol freeze approval (`protocol-change-approved`)
through the normal maintainer process:

> **Proposed §6.16 addition (for maintainer review only):** An
> INDETERMINATE attempt's dispatch block MUST NOT lift on an operator
> assertion alone. Lifting the block requires a durable, append-only
> resolution record bound to the attempt (quote, subscription,
> provider, site, request hash, and idempotency key), classifying the
> outcome as CONFIRMED_NON_EXECUTION or CONFIRMED_LANDING on the basis
> of independently obtained, operation-bound provider evidence
> (provider operation log, idempotency registry, or audit export,
> referenced and freshly observed), with the operator identity,
> observation digest, and reconciliation decision recorded. An
> absence establishes CONFIRMED_NON_EXECUTION only with provider
> finality: the observation postdates the settlement, the provider
> record is declared final, and its completeness covers the
> settlement. A record classifying the outcome UNRESOLVED, a
> free-text note, or an observed provider state that merely matches
> the intended outcome MUST NOT lift the block. A terminal resolution
> of either class MUST NOT authorize re-dispatch against its own
> quote — re-authorization proceeds as a NEW quote (§6.15); a
> CONFIRMED_LANDING record additionally MUST NOT unblock the
> subscription until the landed state and its financial consequences
> are reconciled in a separate recorded barrier, after which only
> quotes issued after the landing and computed against the landed
> state version may dispatch.

Until that amendment is approved, this implementation is stricter
than the current §6.16 text where they differ (the implemented
same-subscription keying divergence tracked in G-21 is unchanged).

## 8. Security / regression audit summary

- **Transaction atomicity**: insert + flag flip + history in one
  immediate transaction; crash-in-transaction test (58.8) leaves no
  row and a still-blocked attempt after reopen.
- **SQLite persistence / migration**: v1→v3 and v2→v3
  single-transaction migrations (58.14b, 58.14c); unsupported
  versions still refuse; v2-era terminal rows preserved but
  non-lifting (§5).
- **Crash consistency**: fault-injection at both persist boundaries;
  non-evidence failures poison the instance rather than serving
  volatile state.
- **Trust boundary (R2)**: resolveAttempt accepts only branded
  established tokens; fabricated raw evidence, post-minting token
  alteration, and cross-attempt tokens refuse (58.15); records bound
  to a foreign identity refuse at establishment (58.3, 58.4);
  cross-subscription isolation control (58.3).
- **Provider finality (R3)**: pre-settlement observation, non-final
  log, incomplete watermark, and PARTIAL/UNKNOWN registry coverage
  all refuse at establishment (58.16).
- **New-quote rule (R1)**: after either terminal class, the old
  quote is blocked for any key; the positive case is a genuinely
  new quote (58.12, 56.5). The originally-terminal
  CONFIRMED_NON_EXECUTION attempt-state re-arm path is untouched.
- **Landing barrier (R4)**: a landing alone unblocks nothing; the
  reconciliation refuses a wrong landed-state digest; pre-landing
  and wrong-version quotes refuse as stale after the barrier; a
  second reconciliation refuses (58.13).
- **Concurrency / exclusion**: terminal-resolution existence is
  checked inside the immediate transaction (58.9: a second terminal
  resolution refuses with exactly one row persisted); DISPATCHING
  still always blocks.
- **Evidence immutability**: no update/delete code paths for
  `attempt_resolutions` or `landing_reconciliations`; a payload
  whose checksum no longer matches refuses the whole open (58.5b);
  replayed (source, reference) refuses (58.5a).
- **Receipt replay semantics**: unchanged — same-key terminal
  resolutions return the standing attempt (58.7, 58.12); the
  attempt-state CONFIRMED_NON_EXECUTION re-arm path is untouched.
- **Report derivation**: recoveryReport status follows the actual
  terminal record (58.17), the historical INDETERMINATE outcome is
  preserved, and the unresolved text is unchanged (test27.25).
- **Operator identity / auditability**: operator id, justification,
  timestamps, and the evidence checksum are recorded for every
  record, including UNRESOLVED ones; the attempt history notes the
  classification, evidence reference, and checksum prefix.
- **Fail-closed behaviour**: every refusal path persists nothing and
  leaves the block in place; legacy flag-only records remain blocked.

## 9. Test results (local)

Round 1 (head `d0f35c8`):

- Node v22.14.0 and Node v20.19.5: full suite **819/819 pass**
  (baseline main 803/803); test56 9/9; test58 16/16 (failing-first
  on baseline: 0/16).

Correction round (this head):

- Failing-first against `d0f35c8`: test58 + test56 = 29 tests,
  **19 fail / 10 pass** (the 10 passes are pins whose behaviour was
  already correct; see §2).
- Node v22.14.0 (locally installed toolchain; system node is v24):
  build clean; full suite **823/823 pass**.
- Node v20.19.5 (locally installed toolchain + matching rebuilt
  better-sqlite3 binding): full suite **823/823 pass**.
- test56: 9/9; test58: 20/20. No pre-existing test file other than
  test56/test58 was modified.
- Provider neutrality check (workflow script run locally): OK.
- Protocol freeze guard footprint:
  `git diff --name-only main...HEAD -- spec/scq-v0.6.1-spec.md
  spec/scq-v0.6.2-spec.md reference/src/core/types.ts
  reference/src/core/scq-engine.ts` → **empty**.
- CI (GitHub Actions, Node 20 + 22) is the authoritative record for
  the PR head; see the PR for exact run results.
