import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Temp-dir cleanup (same discipline as test56).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

import {
  DispatchBlockedError,
  DurableRecoveryError,
  DurableQuoteStore,
  type DurableStoreOptions,
} from "../src/store/durable-store.js";
import * as durableModule from "../src/store/durable-store.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 58 — SCQ P0 (issue #43): durable INDETERMINATE recovery evidence.
//
// FAILING-FIRST provenance, round 1: this file was written against the
// structured-evidence contract and run against the UNMODIFIED main
// implementation first. On that baseline, resolveAttempt(attemptId,
// note) accepted a free-text string and lifted the dispatch block on
// the operator's assertion alone, and the resolution readers /
// evidence error / schema v2 did not exist — the cases failed there.
//
// FAILING-FIRST provenance, round 2 (PR #50 review, findings R1–R4):
// the file was updated against head d0f35c8, whose resolveAttempt
// accepted RAW caller-asserted evidence objects. The round-2 cases
// fail there for the review's reasons: same-quote re-dispatch after
// CONFIRMED_NON_EXECUTION was permitted (R1); a fabricated raw
// evidence object could lift the block (R2); absence evidence needed
// no provider finality (R3); CONFIRMED_LANDING unblocked the whole
// subscription on a label with no reconciliation barrier or
// stale-quote check (R4).
//
// The store's round-2 API is reached through `any` casts in this file
// so the SAME test file compiles and runs against both the round-1
// head (failing-first) and the corrected implementation: on the old
// head the casts let the old call shapes execute and fail the
// assertions; on the fixed code they exercise the real contract.
//
// Every provider record below is SIMULATED. No live provider is
// touched, and no test equates a recorded evidence record with the
// provider behaviour it describes: the store's job is to require
// evidence that passed the establishment procedure, bind it, preserve
// it, and gate on it. The brand proves passage through the
// establishment computation — NOT that a record truly came from a
// provider (the stated limit, mirrored from PR #8 R3).

const require = createRequire(import.meta.url);
function rawDb(path: string): any {
  const Database = require("better-sqlite3") as any;
  return new Database(path);
}
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
/** Canonical stringify identical to the store's (sorted keys, undefined dropped) — for hand-built legacy payloads. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function tmpDb(name = "scq.db"): string {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-p043-")));
  return join(dir, name);
}
function openStore(path: string, opts: DurableStoreOptions = {}): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0, ...opts });
}
const INTENT = (quoteId: string, subscriptionId: string, key: string, site = "site-a") => ({
  quoteId,
  subscriptionId,
  provider: "chargebee",
  site,
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
  idempotencyKey: key,
  preDispatchFingerprint: "fp-1",
});

// ---------------------------------------------------------------------------
// Rig: a store on a MANUAL clock, so attempt creation, settlement
// (attempt.updatedAt), provider observation, establishment, and
// resolution have deterministic, strictly ordered timestamps — R3's
// finality rules are about exactly those orderings.
// ---------------------------------------------------------------------------
const T0 = Date.parse("2026-10-31T12:00:00.000Z");
type Rig = {
  store: DurableQuoteStore;
  tick: (ms: number) => void;
  now: () => Date;
  nowIso: () => string;
};
function openRig(path: string = tmpDb(), opts: DurableStoreOptions = {}): Rig {
  let nowMs = T0;
  const store = openStore(path, { now: () => new Date(nowMs), ...opts });
  return {
    store,
    tick: (ms: number) => {
      nowMs += ms;
    },
    now: () => new Date(nowMs),
    nowIso: () => new Date(nowMs).toISOString(),
  };
}

/** Dispatch at the rig's current time, then settle INDETERMINATE one minute later. Returns the attempt id. */
function settleIndeterminate(rig: Rig, quoteId = "q1", subscriptionId = "sub_1", key = "key-1"): string {
  const att = rig.store.beginDispatch(INTENT(quoteId, subscriptionId, key));
  rig.tick(60_000);
  rig.store.recordAttemptOutcome(att.attemptId, "INDETERMINATE");
  return att.attemptId;
}

// Round-2 API accessors (absent or differently shaped on the round-1
// head — the helpers degrade there and the assertions fail).
const establishResolutionEvidence: any = (durableModule as any).establishResolutionEvidence;
function resolve(store: DurableQuoteStore, attemptId: string, input: unknown): any {
  return (store as any).resolveAttempt(attemptId, input);
}
function resolutions(store: DurableQuoteStore, attemptId: string): any[] {
  return typeof (store as any).resolutionsForAttempt === "function" ? (store as any).resolutionsForAttempt(attemptId) : [];
}
function getResolution(store: DurableQuoteStore, attemptId: string): any {
  return typeof (store as any).getResolution === "function" ? (store as any).getResolution(attemptId) : undefined;
}
function recordUnresolved(store: DurableQuoteStore, attemptId: string, input: unknown): any {
  return (store as any).recordUnresolvedResolution(attemptId, input);
}
function reconcileLanded(store: DurableQuoteStore, attemptId: string, input: unknown): any {
  return (store as any).reconcileLandedAttempt(attemptId, input);
}
function landingReconciliation(store: DurableQuoteStore, attemptId: string): any {
  return typeof (store as any).landingReconciliationFor === "function" ? (store as any).landingReconciliationFor(attemptId) : undefined;
}
function isEvidenceRefusal(e: unknown): boolean {
  return (e as { code?: string })?.code === "RESOLUTION_EVIDENCE_REFUSED";
}

let refSeq = 0;
/**
 * A simulated provider record for an attempt, bound to the attempt in
 * every identity field, observed at the rig's current time (AFTER
 * settlement), from a FINAL log whose completeness watermark covers
 * the settlement. Overrides attack one field at a time.
 */
function providerRecord(rig: Rig, attemptId: string, classification: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const attempt = rig.store.getAttempt(attemptId)!;
  const base: Record<string, unknown> =
    classification === "CONFIRMED_LANDING"
      ? {
          source: "PROVIDER_OPERATION_LOG",
          kind: "OPERATION_LOG_RECORD_FOR_KEY",
          reference: `oplog-ref-${++refSeq}`,
          operationFound: true,
          providerOperationId: "op_58_landing",
          observedState: {
            id: attempt.subscriptionId,
            version: "v2",
            status: "active",
            items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
          },
        }
      : {
          source: "PROVIDER_OPERATION_LOG",
          kind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
          reference: `oplog-ref-${++refSeq}`,
          operationFound: false,
          observedState: { lookupResult: "NO_RECORD_FOR_KEY", idempotencyKey: attempt.idempotencyKey },
        };
  return {
    ...base,
    provider: attempt.provider,
    site: attempt.site ?? undefined,
    subscriptionId: attempt.subscriptionId,
    quoteId: attempt.quoteId,
    idempotencyKey: attempt.idempotencyKey,
    requestHash: attempt.requestHash,
    observedAt: rig.nowIso(),
    logFinal: true,
    completeThrough: rig.nowIso(),
    ...overrides,
  };
}
function establish(rig: Rig, attemptId: string, classification: string, overrides: Record<string, unknown> = {}): any {
  const attempt = rig.store.getAttempt(attemptId)!;
  return establishResolutionEvidence(attempt, providerRecord(rig, attemptId, classification, overrides), classification, rig.now());
}
function resolveInput(classification: string, token: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence: token,
    operatorId: "operator-1",
    reconciliationDecision: classification === "CONFIRMED_LANDING" ? "RECONCILE_LANDED_STATE_NO_REDISPATCH" : "PERMIT_NEW_DISPATCH",
    justification:
      classification === "CONFIRMED_LANDING"
        ? "Provider operation log records this attempt's idempotency key as executed; landed state to be reconciled, no re-dispatch."
        : "Provider operation log, final through the settlement, records no operation for this attempt's idempotency key.",
    ...overrides,
  };
}
/** Establish + resolve in one step (the legitimate path). Returns the resolveAttempt result. */
function resolveValid(rig: Rig, attemptId: string, classification: string, recordOverrides: Record<string, unknown> = {}, inputOverrides: Record<string, unknown> = {}): any {
  const token = establish(rig, attemptId, classification, recordOverrides);
  return resolve(rig.store, attemptId, resolveInput(classification, token, inputOverrides));
}

// ---------------------------------------------------------------------------
// 58.1 Free-text-only operator resolution
// ---------------------------------------------------------------------------

test("Test 58.1: a free-text-only operator resolution is refused and unblocks nothing", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);

  assert.throws(
    () => resolve(rig.store, attemptId, "reconciled, trust me"),
    (e: unknown) => isEvidenceRefusal(e),
    "a string note is not resolution evidence",
  );
  assert.equal(resolutions(rig.store, attemptId).length, 0, "the refusal persists zero resolution rows");
  assert.equal(rig.store.getAttempt(attemptId)?.operatorReviewState, "REQUIRED");
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError, "a different key remains blocked");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.2 Missing / non-evidence source (refused at establishment, R2/R3)
// ---------------------------------------------------------------------------

test("Test 58.2: establishment refuses a missing or operator-assertion evidence source", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);

  for (const source of ["", "OPERATOR_ASSERTION", "FREE_TEXT", "PROVIDER_STATE_SNAPSHOT"]) {
    assert.throws(
      () => establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", { source }),
      (e: unknown) => isEvidenceRefusal(e),
      `source ${JSON.stringify(source)} must refuse at establishment`,
    );
  }
  assert.equal(resolutions(rig.store, attemptId).length, 0);
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.3 Foreign binding in the provider record; cross-subscription
// isolation
// ---------------------------------------------------------------------------

test("Test 58.3: a provider record bound to a foreign identity refuses at establishment; resolving one subscription never unblocks another", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_2"));
  const att1 = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  const att2 = settleIndeterminate(rig, "q2", "sub_2", "key-2");
  rig.tick(60_000);

  for (const foreign of [
    { quoteId: "q2" },
    { subscriptionId: "sub_2" },
    { provider: "stripe" },
    { site: "site-b" },
  ]) {
    assert.throws(
      () => establish(rig, att1, "CONFIRMED_NON_EXECUTION", foreign),
      (e: unknown) => isEvidenceRefusal(e),
      `foreign binding field ${JSON.stringify(foreign)} must refuse at establishment`,
    );
  }
  assert.equal(resolutions(rig.store, att1).length, 0);

  // Legitimate resolution of sub_1's attempt…
  resolveValid(rig, att1, "CONFIRMED_NON_EXECUTION");
  assert.equal(rig.store.getAttempt(att1)?.operatorReviewState, "RESOLVED");
  // …does NOT touch sub_2's separate INDETERMINATE attempt.
  assert.equal(rig.store.findBlockingAttempt("q2", "sub_2")?.attemptId, att2);
  assert.throws(() => rig.store.beginDispatch(INTENT("q2", "sub_2", "key-2b")), DispatchBlockedError);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.4 Foreign request hash / idempotency key in the provider record
// ---------------------------------------------------------------------------

test("Test 58.4: a provider record carrying a foreign request hash or idempotency key refuses at establishment", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);

  for (const foreign of [
    { requestHash: "0".repeat(64) },
    { requestHash: sha256("a different request") },
    { idempotencyKey: "key-OTHER" },
  ]) {
    assert.throws(
      () => establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", foreign),
      (e: unknown) => isEvidenceRefusal(e),
      `foreign field ${JSON.stringify(foreign)} must refuse at establishment`,
    );
  }
  assert.equal(resolutions(rig.store, attemptId).length, 0);
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.5 Replayed / tampered evidence
// ---------------------------------------------------------------------------

test("Test 58.5a: the same (evidenceSource, evidenceReference) cannot be replayed for a second attempt", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_2"));
  const att1 = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  const att2 = settleIndeterminate(rig, "q2", "sub_2", "key-2");
  rig.tick(60_000);

  resolveValid(rig, att1, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-shared" });
  const replayToken = establish(rig, att2, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-shared" });
  assert.throws(
    () => resolve(rig.store, att2, resolveInput("CONFIRMED_NON_EXECUTION", replayToken)),
    (e: unknown) => isEvidenceRefusal(e),
    "one provider-evidence reference establishes one attempt's resolution, not two",
  );
  assert.equal(resolutions(rig.store, att2).length, 0);
  assert.throws(() => rig.store.beginDispatch(INTENT("q2", "sub_2", "key-2b")), DispatchBlockedError);
  rig.store.close();
});

test("Test 58.5b: a tampered persisted resolution payload refuses the whole store open (fail closed)", () => {
  const path = tmpDb();
  const rig = openRig(path);
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);
  resolveValid(rig, attemptId, "CONFIRMED_NON_EXECUTION");
  assert.equal(resolutions(rig.store, attemptId).length, 1);
  rig.store.close();

  const db = rawDb(path);
  db.prepare(`UPDATE attempt_resolutions SET evidence_payload_json = '{"tampered":true}'`).run();
  db.close();

  assert.throws(
    () => openStore(path),
    (e: unknown) => e instanceof DurableRecoveryError,
    "a resolution whose payload no longer matches its evidence checksum adopts nothing",
  );
});

// ---------------------------------------------------------------------------
// 58.6 Stale provider observations (freshness at resolution time)
// ---------------------------------------------------------------------------

test("Test 58.6: an observation that is stale at resolution time refuses at resolveAttempt", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);
  const token = establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-stale" });

  // 48h pass between observation and resolution: stale (>24h).
  rig.tick(48 * 3600 * 1000);
  assert.throws(
    () => resolve(rig.store, attemptId, resolveInput("CONFIRMED_NON_EXECUTION", token)),
    (e: unknown) => isEvidenceRefusal(e),
    "an observation 48h old at resolution is stale",
  );
  assert.equal(resolutions(rig.store, attemptId).length, 0);
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1b")), DispatchBlockedError);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.7 Restart durability (R1 applied: the resolved quote stays blocked)
// ---------------------------------------------------------------------------

test("Test 58.7: a valid resolution survives restart byte-identically and governs dispatch after reopen", () => {
  const path = tmpDb();
  const rig = openRig(path);
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);
  resolveValid(rig, attemptId, "CONFIRMED_NON_EXECUTION");
  const before = getResolution(rig.store, attemptId);
  assert.ok(before, "a resolution record exists before restart");
  rig.store.close();

  const b = openStore(path);
  const after = getResolution(b, attemptId);
  assert.deepEqual(after, before, "the persisted resolution record is identical after restart, evidence checksum included");
  assert.match(after.evidenceHash, /^[0-9a-f]{64}$/);

  const standing = b.beginDispatch(INTENT("q1", "sub_1", "key-1"));
  assert.equal(standing.attemptId, attemptId, "same key returns the standing INDETERMINATE attempt");
  assert.equal(standing.state, "INDETERMINATE", "the standing attempt is never re-armed");
  assert.throws(
    () => b.beginDispatch(INTENT("q1", "sub_1", "key-2")),
    DispatchBlockedError,
    "R1: a NEW key on the resolved attempt's OWN quote remains blocked after restart (§6.15 new-quote rule)",
  );
  const fresh = b.beginDispatch(INTENT("q2", "sub_1", "key-2"));
  assert.equal(fresh.state, "DISPATCHING", "a genuinely NEW quote on the same subscription may dispatch after restart");
  b.close();
});

// ---------------------------------------------------------------------------
// 58.8 Crash during resolution persistence
// ---------------------------------------------------------------------------

test("Test 58.8: a crash inside the resolution transaction persists no resolution and leaves the attempt blocked", () => {
  const path = tmpDb();
  const rig = openRig(path, {
    faults: {
      insidePersistTx: (op: string) => {
        if (op === "resolveAttempt") throw new Error("simulated crash inside the resolution transaction");
      },
    },
  });
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);
  assert.throws(() => resolveValid(rig, attemptId, "CONFIRMED_NON_EXECUTION"));
  rig.store.close();

  const reopened = openStore(path);
  assert.equal(resolutions(reopened, attemptId).length, 0, "the rolled-back transaction left no resolution row");
  assert.equal(reopened.getAttempt(attemptId)?.state, "INDETERMINATE");
  assert.equal(reopened.getAttempt(attemptId)?.operatorReviewState, "REQUIRED");
  assert.throws(() => reopened.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  reopened.close();
});

// ---------------------------------------------------------------------------
// 58.9 Concurrent resolution attempts
// (Sequential calls on one synchronous store are the deterministic
// form: the second call runs inside the same immediate-transaction
// discipline a concurrent writer would face.)
// ---------------------------------------------------------------------------

test("Test 58.9: a second terminal resolution for the same attempt refuses; exactly one resolution row exists", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);

  resolveValid(rig, attemptId, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-first" });
  // The resolution bumped the attempt's updatedAt to the resolution
  // instant; a second establishment must observe after it (R3) so
  // the refusal under test is resolveAttempt's own ALREADY_RESOLVED.
  rig.tick(60_000);
  const second = establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-second" });
  assert.throws(
    () => resolve(rig.store, attemptId, resolveInput("CONFIRMED_NON_EXECUTION", second)),
    (e: unknown) => isEvidenceRefusal(e) && /ALREADY_RESOLVED/.test((e as Error).message),
    "an attempt with a terminal resolution cannot be resolved again",
  );
  assert.equal(resolutions(rig.store, attemptId).length, 1, "exactly one resolution row was persisted");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.10 UNRESOLVED record (separate audit-only method) lifts no block
// ---------------------------------------------------------------------------

test("Test 58.10: an UNRESOLVED record is audit trail only — it lifts no block for any key", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);

  const attempt = recordUnresolved(rig.store, attemptId, {
    operatorId: "operator-1",
    justification: "Provider records are ambiguous; the final operation log has not yet been obtained.",
  });
  assert.equal(attempt.operatorReviewState, "REQUIRED", "UNRESOLVED does not set the resolved flag");
  assert.equal(resolutions(rig.store, attemptId).length, 1, "the UNRESOLVED record is appended for audit");
  assert.equal(getResolution(rig.store, attemptId)?.classification, "UNRESOLVED");

  const report = rig.store.recoveryReport();
  const item = report.indeterminateOutcomes.find((i) => i.attemptId === attemptId) as any;
  assert.equal(item?.resolution?.classification, "UNRESOLVED");
  assert.equal(item?.operatorInterventionRequired, true, "an unresolved attempt still requires operator intervention");
  assert.match(String(item?.nextPermittedAction), /Reconcile manually/);
  assert.match(String(item?.nextPermittedAction), /No automatic re-dispatch is permitted\./);

  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError, "new key still blocked");
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1")), DispatchBlockedError, "same key still blocked");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.11 Matching final state without operation attribution
// ---------------------------------------------------------------------------

test("Test 58.11: a provider-state snapshot that merely matches the intended state is refused at establishment for either terminal classification", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  rig.tick(60_000);

  for (const classification of ["CONFIRMED_NON_EXECUTION", "CONFIRMED_LANDING"] as const) {
    assert.throws(
      () =>
        establish(rig, attemptId, classification, {
          source: "PROVIDER_STATE_SNAPSHOT",
          kind: "STATE_SNAPSHOT_MATCH",
          reference: `snapshot-${classification}`,
          // The observed state EXACTLY matches the intended final
          // state — matching state is precisely what must not suffice.
          observedState: { id: "sub_1", version: "v2", status: "active", items: [{ id: "item_1", quantity: 2 }] },
        }),
      (e: unknown) => isEvidenceRefusal(e),
      `a state snapshot must refuse at establishment for ${classification}`,
    );
  }
  assert.equal(resolutions(rig.store, attemptId).length, 0);
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.12 Confirmed non-execution (positive) — R1: the OLD quote stays
// blocked for any key; a genuinely new quote is the positive case.
// ---------------------------------------------------------------------------

test("Test 58.12: valid CONFIRMED_NON_EXECUTION evidence resolves with a bound record; the old quote stays blocked (R1) and a new quote dispatches", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  const attempt = rig.store.getAttempt(attemptId)!;
  rig.tick(60_000);

  const resolved = resolveValid(rig, attemptId, "CONFIRMED_NON_EXECUTION");
  assert.equal(resolved.operatorReviewState, "RESOLVED");

  const record = getResolution(rig.store, attemptId);
  assert.ok(record, "a structured resolution record exists");
  assert.equal(record.attemptId, attemptId);
  assert.equal(record.quoteId, "q1");
  assert.equal(record.subscriptionId, "sub_1");
  assert.equal(record.provider, "chargebee");
  assert.equal(record.site, "site-a");
  assert.equal(record.requestHash, attempt.requestHash, "the record is bound to the attempt's request hash");
  assert.equal(record.idempotencyKey, "key-1");
  assert.equal(record.classification, "CONFIRMED_NON_EXECUTION");
  assert.equal(record.operatorId, "operator-1");
  assert.equal(record.evidenceSource, "PROVIDER_OPERATION_LOG");
  assert.match(record.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(record.logFinal, true, "the provider-finality attestation is persisted with the record");
  assert.ok(record.completeThrough, "the completeness watermark is persisted with the record");
  assert.equal(record.establishmentProcedure, "establishResolutionEvidence", "the record states the establishment procedure that minted its evidence");
  assert.ok(record.resolvedAt && record.observedAt, "resolution and observation timestamps are recorded");

  const report = rig.store.recoveryReport();
  const item = report.indeterminateOutcomes.find((i) => i.attemptId === attemptId) as any;
  assert.equal(item?.resolution?.classification, "CONFIRMED_NON_EXECUTION");
  assert.equal(item?.resolution?.evidenceHash, record.evidenceHash);

  // R1 / frozen §6.15: re-authorization after INDETERMINATE proceeds
  // as a NEW QUOTE — never as a re-issue of the indeterminate attempt.
  const standing = rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1"));
  assert.equal(standing.attemptId, attemptId, "same key returns the standing attempt");
  assert.equal(standing.state, "INDETERMINATE", "the resolved attempt is never re-armed");
  assert.throws(
    () => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")),
    DispatchBlockedError,
    "R1: a NEW key on the SAME (indeterminate) quote is refused — the old quote remains blocked for any key",
  );
  const other = rig.store.beginDispatch(INTENT("q2", "sub_1", "key-2"));
  assert.equal(other.state, "DISPATCHING", "a genuinely new quote on the same subscription is the permitted positive case");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.13 Confirmed landing — R4: no subscription unblock on the label;
// a recorded reconciliation barrier + stale-quote protection first.
// ---------------------------------------------------------------------------

test("Test 58.13: CONFIRMED_LANDING alone unblocks nothing; the reconciliation barrier and stale-quote rule govern any later dispatch", () => {
  const rig = openRig();
  // q1 and q2 are both issued BEFORE the landing is resolved, on
  // pre-landing terms (created 2026-10-29, subscription version v1).
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_1"));
  const attemptId = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  rig.tick(60_000);

  const resolved = resolveValid(rig, attemptId, "CONFIRMED_LANDING");
  assert.equal(resolved.operatorReviewState, "RESOLVED");
  const record = getResolution(rig.store, attemptId);
  assert.equal(record?.classification, "CONFIRMED_LANDING");
  assert.equal(record?.providerOperationId, "op_58_landing");
  assert.equal(record?.landedStateVersion, "v2", "the landed state version is extracted from the established observed state");

  const standing = rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1"));
  assert.equal(standing.attemptId, attemptId, "same key returns the standing attempt");
  assert.equal(standing.state, "INDETERMINATE", "the landed attempt is never re-armed");
  assert.throws(
    () => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-2")),
    DispatchBlockedError,
    "the landed attempt's own quote never re-dispatches (any key)",
  );

  // R4: the LANDING label alone does NOT unblock the subscription.
  assert.throws(
    () => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-3")),
    DispatchBlockedError,
    "before the reconciliation barrier, even a different quote on the subscription stays blocked",
  );
  assert.equal(landingReconciliation(rig.store, attemptId), undefined);

  // The barrier refuses a landed-state digest that is not the
  // resolution's established observed-state digest.
  assert.throws(
    () =>
      reconcileLanded(rig.store, attemptId, {
        operatorId: "operator-1",
        landedStateDigest: sha256("test58: some other state"),
        financialOutcomeDigest: sha256("test58: reconciled financial outcome record"),
        justification: "Landed state and financial consequences reconciled against provider records.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "a reconciliation bound to a different landed state refuses",
  );
  assert.equal(landingReconciliation(rig.store, attemptId), undefined, "the refused reconciliation records nothing");

  // The barrier satisfied: digests recorded, bound to the landed state.
  const reconciliation = reconcileLanded(rig.store, attemptId, {
    operatorId: "operator-1",
    landedStateDigest: record.observedProviderStateDigest,
    financialOutcomeDigest: sha256("test58: reconciled financial outcome record"),
    justification: "Landed state and financial consequences reconciled against provider records.",
  });
  assert.equal(reconciliation.attemptId, attemptId);
  assert.equal(reconciliation.landedStateVersion, "v2");
  assert.equal(reconciliation.landedStateDigest, record.observedProviderStateDigest);
  assert.match(reconciliation.recordHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(landingReconciliation(rig.store, attemptId), reconciliation);

  // After the barrier: q2 was issued BEFORE the landing (pre-landing
  // terms, pre-landing subscription version) — stale, still refused.
  assert.throws(
    () => rig.store.beginDispatch(INTENT("q2", "sub_1", "key-3")),
    (e: unknown) => e instanceof DispatchBlockedError && /stale/i.test(e.message),
    "a quote issued before the landing must not dispatch on pre-landing terms after unblock",
  );
  // A quote created after the landing but still carrying the
  // PRE-LANDING subscription version is equally stale.
  rig.store.put({ ...makeStoredQuote("q4", "sub_1"), created_at: rig.nowIso(), subscription_version_at_quote: "v1" });
  assert.throws(
    () => rig.store.beginDispatch(INTENT("q4", "sub_1", "key-4")),
    (e: unknown) => e instanceof DispatchBlockedError && /stale/i.test(e.message),
    "a post-landing quote bound to the pre-landing subscription version is stale",
  );
  // A fresh quote, created after the landing AND bound to the landed
  // state version, is the permitted positive case.
  rig.tick(1_000); // a quote issued AT the resolution instant is stale by the <= rule; the fresh quote is issued after it
  rig.store.put({ ...makeStoredQuote("q3", "sub_1"), created_at: rig.nowIso(), subscription_version_at_quote: "v2" });
  const fresh = rig.store.beginDispatch(INTENT("q3", "sub_1", "key-5"));
  assert.equal(fresh.state, "DISPATCHING", "a fresh quote validated against the landed state may dispatch");

  // The landed attempt's own quote remains blocked throughout.
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-9")), DispatchBlockedError);

  // A second reconciliation for the same attempt refuses.
  assert.throws(
    () =>
      reconcileLanded(rig.store, attemptId, {
        operatorId: "operator-1",
        landedStateDigest: record.observedProviderStateDigest,
        financialOutcomeDigest: sha256("test58: reconciled financial outcome record"),
        justification: "Duplicate reconciliation attempt.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "the reconciliation barrier is recorded exactly once",
  );
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.14 Legacy records
// ---------------------------------------------------------------------------

test("Test 58.14a: a legacy RESOLVED flag with NO resolution record still blocks — it is never silently upgraded", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q1", "sub_1"));
  const att = a.beginDispatch(INTENT("q1", "sub_1", "key-1"));
  a.recordAttemptOutcome(att.attemptId, "INDETERMINATE");
  const attemptId = att.attemptId;
  a.close();

  // Simulate a pre-fix resolution: the flag alone, set by raw SQL.
  const db = rawDb(path);
  db.prepare(`UPDATE attempts SET operator_review_state='RESOLVED' WHERE attempt_id = ?`).run(attemptId);
  db.close();

  const b = openStore(path);
  assert.equal(b.getAttempt(attemptId)?.operatorReviewState, "RESOLVED", "the legacy flag is preserved as-is");
  assert.equal(resolutions(b, attemptId).length, 0, "no resolution record was fabricated for it");
  assert.equal(b.findBlockingAttempt("q1", "sub_1")?.attemptId, attemptId, "flag-only legacy resolution remains blocking");
  assert.throws(() => b.beginDispatch(INTENT("q1", "sub_1", "key-2")), DispatchBlockedError);
  b.close();
});

test("Test 58.14b: a hand-built v1 database migrates to schema v3 in place — attempts intact and blocking, resolutions table empty", () => {
  const path = tmpDb();
  // Minimal v1 schema, copied from the baseline (schema v1)
  // SCHEMA_STATEMENTS in durable-store.ts.
  const db = rawDb(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE quotes (
     quote_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, provider TEXT NOT NULL,
     status TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL,
     record_sha TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE receipt_records (
     quote_id TEXT PRIMARY KEY, recorded_json TEXT NOT NULL, current_json TEXT NOT NULL,
     identity_digest TEXT NOT NULL, verifications_json TEXT NOT NULL)`);
  db.exec(`CREATE TABLE attempts (
     attempt_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
     provider TEXT NOT NULL, site TEXT, state TEXT NOT NULL,
     idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
     request_json TEXT NOT NULL, pre_dispatch_fingerprint TEXT,
     recovery_classification TEXT, outcome TEXT, details_json TEXT,
     operator_review_state TEXT NOT NULL DEFAULT 'NONE', version INTEGER NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE attempt_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
     state TEXT NOT NULL, at TEXT NOT NULL, note TEXT)`);
  db.exec(`CREATE INDEX idx_attempts_quote ON attempts(quote_id)`);
  db.exec(`CREATE INDEX idx_attempts_subscription ON attempts(subscription_id)`);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', '2026-10-29T00:00:00.000Z')`).run();
  db.prepare(
    `INSERT INTO attempts (attempt_id, quote_id, subscription_id, provider, site, state, idempotency_key, request_hash, request_json, pre_dispatch_fingerprint, recovery_classification, outcome, details_json, operator_review_state, version, created_at, updated_at)
     VALUES ('att_legacy_v1', 'q-legacy', 'sub_legacy', 'chargebee', 'site-a', 'INDETERMINATE', 'key-legacy', ?, '{}', NULL, NULL, 'INDETERMINATE', NULL, 'REQUIRED', 1, '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z')`,
  ).run(sha256("legacy request"));
  db.close();

  const store = openStore(path);
  const attempt = store.getAttempt("att_legacy_v1");
  assert.ok(attempt, "the pre-existing v1 attempt row is intact after migration");
  assert.equal(attempt.state, "INDETERMINATE");
  assert.equal(store.findBlockingAttempt("q-legacy", "sub_legacy")?.attemptId, "att_legacy_v1", "the migrated attempt still blocks");
  assert.equal(resolutions(store, "att_legacy_v1").length, 0);
  store.close();

  const check = rawDb(path);
  const version = check.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string };
  assert.equal(version.value, "3", "the database was migrated to schema v3");
  const table = check.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='attempt_resolutions'`).get();
  assert.ok(table, "attempt_resolutions exists after migration");
  const count = check.prepare(`SELECT COUNT(*) AS n FROM attempt_resolutions`).get() as { n: number };
  assert.equal(count.n, 0, "migration fabricates no resolution records");
  check.close();
});

test("Test 58.14c: a v2-era terminal resolution row migrates to v3 preserved but NON-LIFTING (no provider finality on record)", () => {
  const path = tmpDb();
  // Hand-built v2 database: base schema + the v2 attempt_resolutions
  // table (schema as of head d0f35c8, before the v3 finality
  // columns), one INDETERMINATE attempt, and one terminal
  // CONFIRMED_NON_EXECUTION resolution row written the v2 way
  // (payload + unkeyed checksum, flag flipped to RESOLVED).
  const db = rawDb(path);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`CREATE TABLE quotes (
     quote_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, provider TEXT NOT NULL,
     status TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL,
     record_sha TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE receipt_records (
     quote_id TEXT PRIMARY KEY, recorded_json TEXT NOT NULL, current_json TEXT NOT NULL,
     identity_digest TEXT NOT NULL, verifications_json TEXT NOT NULL)`);
  db.exec(`CREATE TABLE attempts (
     attempt_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
     provider TEXT NOT NULL, site TEXT, state TEXT NOT NULL,
     idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
     request_json TEXT NOT NULL, pre_dispatch_fingerprint TEXT,
     recovery_classification TEXT, outcome TEXT, details_json TEXT,
     operator_review_state TEXT NOT NULL DEFAULT 'NONE', version INTEGER NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE attempt_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL,
     state TEXT NOT NULL, at TEXT NOT NULL, note TEXT)`);
  db.exec(`CREATE INDEX idx_attempts_quote ON attempts(quote_id)`);
  db.exec(`CREATE INDEX idx_attempts_subscription ON attempts(subscription_id)`);
  db.exec(`CREATE TABLE attempt_resolutions (
     resolution_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, quote_id TEXT NOT NULL,
     subscription_id TEXT NOT NULL, provider TEXT NOT NULL, site TEXT,
     request_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, classification TEXT NOT NULL,
     operator_id TEXT NOT NULL, resolved_at TEXT NOT NULL, evidence_source TEXT NOT NULL,
     evidence_kind TEXT NOT NULL, evidence_reference TEXT NOT NULL, observed_at TEXT NOT NULL,
     observed_provider_state_digest TEXT NOT NULL, provider_operation_id TEXT,
     reconciliation_decision TEXT NOT NULL, justification TEXT NOT NULL,
     evidence_payload_json TEXT NOT NULL, evidence_hash TEXT NOT NULL UNIQUE)`);
  db.exec(`CREATE INDEX idx_attempt_resolutions_attempt ON attempt_resolutions(attempt_id)`);
  db.exec(`CREATE UNIQUE INDEX idx_attempt_resolutions_evidence_ref ON attempt_resolutions(evidence_source, evidence_reference) WHERE classification != 'UNRESOLVED'`);
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '2')`).run();
  db.prepare(`INSERT INTO meta (key, value) VALUES ('created_at', '2026-10-30T00:00:00.000Z')`).run();
  const requestHash = sha256("v2 request");
  db.prepare(
    `INSERT INTO attempts (attempt_id, quote_id, subscription_id, provider, site, state, idempotency_key, request_hash, request_json, pre_dispatch_fingerprint, recovery_classification, outcome, details_json, operator_review_state, version, created_at, updated_at)
     VALUES ('att_v2_legacy', 'q-v2', 'sub_v2', 'chargebee', 'site-a', 'INDETERMINATE', 'key-v2', ?, '{}', NULL, NULL, 'INDETERMINATE', NULL, 'RESOLVED', 3, '2026-10-30T00:00:00.000Z', '2026-10-30T00:01:00.000Z')`,
  ).run(requestHash);
  const payload = {
    resolutionId: "res_v2_legacy",
    attemptId: "att_v2_legacy",
    quoteId: "q-v2",
    subscriptionId: "sub_v2",
    provider: "chargebee",
    site: "site-a",
    requestHash,
    idempotencyKey: "key-v2",
    classification: "CONFIRMED_NON_EXECUTION",
    operatorId: "operator-1",
    resolvedAt: "2026-10-30T00:10:00.000Z",
    evidenceSource: "PROVIDER_OPERATION_LOG",
    evidenceKind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
    evidenceReference: "oplog-v2-ref",
    observedAt: "2026-10-30T00:05:00.000Z",
    observedProviderStateDigest: sha256("v2 observed state"),
    providerOperationId: null,
    reconciliationDecision: "PERMIT_NEW_DISPATCH",
    justification: "v2-era resolution: provider operation log showed no record for the key.",
  };
  db.prepare(
    `INSERT INTO attempt_resolutions (resolution_id, attempt_id, quote_id, subscription_id, provider, site, request_hash, idempotency_key, classification, operator_id, resolved_at, evidence_source, evidence_kind, evidence_reference, observed_at, observed_provider_state_digest, provider_operation_id, reconciliation_decision, justification, evidence_payload_json, evidence_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    payload.resolutionId, payload.attemptId, payload.quoteId, payload.subscriptionId, payload.provider, payload.site,
    payload.requestHash, payload.idempotencyKey, payload.classification, payload.operatorId, payload.resolvedAt,
    payload.evidenceSource, payload.evidenceKind, payload.evidenceReference, payload.observedAt,
    payload.observedProviderStateDigest, payload.providerOperationId, payload.reconciliationDecision,
    payload.justification, JSON.stringify(payload), sha256(canonical(payload)),
  );
  db.close();

  const store = openStore(path);
  const check = rawDb(path);
  const version = check.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string };
  assert.equal(version.value, "3", "the v2 database was migrated to schema v3");
  const logFinal = check.prepare(`SELECT log_final FROM attempt_resolutions WHERE resolution_id='res_v2_legacy'`).get() as { log_final: unknown };
  assert.equal(logFinal.log_final, null, "migration does not backfill provider finality for a v2-era record");
  check.close();

  const record = getResolution(store, "att_v2_legacy");
  assert.ok(record, "the v2-era record is preserved and readable");
  assert.equal(record.classification, "CONFIRMED_NON_EXECUTION");
  assert.equal(record.logFinal, false, "the v2-era record carries no provider-finality attestation");
  assert.equal(
    store.findBlockingAttempt("q-v2", "sub_v2")?.attemptId,
    "att_v2_legacy",
    "COMPATIBILITY RULE: a v2-era terminal record is NON-LIFTING at runtime — the attempt remains blocked",
  );
  store.put(makeStoredQuote("q-v2", "sub_v2"));
  assert.throws(() => store.beginDispatch(INTENT("q-v2", "sub_v2", "key-v2-new")), DispatchBlockedError);
  store.close();
});

// ---------------------------------------------------------------------------
// 58.15 R2 — the trust boundary: only branded, established tokens
// resolve. Raw fabricated evidence, altered tokens, and foreign
// tokens all refuse; unbound records refuse at establishment.
// ---------------------------------------------------------------------------

test("Test 58.15 (R2): resolveAttempt accepts only branded established tokens — fabricated, altered, and foreign tokens refuse", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_2"));
  const att1 = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  const att2 = settleIndeterminate(rig, "q2", "sub_2", "key-2");
  rig.tick(60_000);

  // (a) A fully fabricated RAW evidence object — allowed enum
  // strings, a plausible reference, a well-formed 64-hex digest —
  // presented as the token. It was never established: refused.
  const fabricatedToken = {
    attemptId: att1,
    quoteId: "q1",
    subscriptionId: "sub_1",
    provider: "chargebee",
    site: "site-a",
    classification: "CONFIRMED_NON_EXECUTION",
    source: "PROVIDER_OPERATION_LOG",
    kind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
    reference: "oplog-ref-fabricated",
    observedProviderStateDigest: sha256("fabricated state"),
  };
  assert.throws(
    () => resolve(rig.store, att1, resolveInput("CONFIRMED_NON_EXECUTION", fabricatedToken)),
    (e: unknown) => isEvidenceRefusal(e),
    "a caller-fabricated evidence object is self-asserted and refuses",
  );
  // (b) The round-1 raw input shape (flat evidence fields, no
  // branded token at all): refused.
  assert.throws(
    () =>
      resolve(rig.store, att1, {
        classification: "CONFIRMED_NON_EXECUTION",
        operatorId: "operator-1",
        evidenceSource: "PROVIDER_OPERATION_LOG",
        evidenceKind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
        evidenceReference: "oplog-ref-raw-shape",
        observedAt: rig.nowIso(),
        observedProviderStateDigest: sha256("raw shape state"),
        reconciliationDecision: "PERMIT_NEW_DISPATCH",
        justification: "Round-1 raw evidence shape.",
      }),
    (e: unknown) => isEvidenceRefusal(e),
    "the removed raw-evidence acceptance refuses",
  );
  // (c) A genuinely established token, ALTERED after minting:
  // refused by the minting-time content digest.
  const token = establish(rig, att1, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-genuine" });
  (token as any).reference = "oplog-ref-FORGED";
  assert.throws(
    () => resolve(rig.store, att1, resolveInput("CONFIRMED_NON_EXECUTION", token)),
    (e: unknown) => isEvidenceRefusal(e),
    "a token altered after establishment refuses",
  );
  // (d) A token minted for att1 presented against att2: refused by
  // the token binding.
  const foreignToken = establish(rig, att1, "CONFIRMED_NON_EXECUTION", { reference: "oplog-ref-for-att1" });
  assert.throws(
    () => resolve(rig.store, att2, resolveInput("CONFIRMED_NON_EXECUTION", foreignToken)),
    (e: unknown) => isEvidenceRefusal(e),
    "a token established for a different attempt refuses",
  );
  // (e) Establishment itself refuses records that cannot bind an
  // outcome to this operation: a snapshot kind under an allowed
  // source, a landing kind offered for non-execution, and a record
  // with no observed state at all.
  for (const bad of [
    { kind: "STATE_SNAPSHOT_MATCH" },
    { kind: "OPERATION_LOG_RECORD_FOR_KEY", operationFound: true, providerOperationId: "op_x" },
    { observedState: undefined },
    { observedState: null },
  ]) {
    assert.throws(
      () => establish(rig, att1, "CONFIRMED_NON_EXECUTION", bad),
      (e: unknown) => isEvidenceRefusal(e),
      `unbound record ${JSON.stringify(bad)} must refuse at establishment`,
    );
  }
  assert.equal(resolutions(rig.store, att1).length, 0, "every refusal persisted zero rows");
  assert.equal(resolutions(rig.store, att2).length, 0);
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1b")), DispatchBlockedError);
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.16 R3 — provider finality: absence is not non-execution until
// the provider record is final and complete past the settlement.
// ---------------------------------------------------------------------------

test("Test 58.16 (R3): absence evidence requires post-settlement observation and provider finality — premature or partial records refuse", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  const attemptId = settleIndeterminate(rig);
  const attempt = rig.store.getAttempt(attemptId)!;
  rig.tick(60_000);

  // (a) Observation AT or BEFORE the settlement instant: the attempt
  // had not yet settled INDETERMINATE — an absence then proves
  // nothing about the dispatched operation.
  for (const observedAt of [attempt.updatedAt, attempt.createdAt]) {
    assert.throws(
      () => establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", { observedAt, completeThrough: rig.nowIso() }),
      (e: unknown) => isEvidenceRefusal(e),
      `observedAt ${observedAt} (not strictly after settlement) must refuse`,
    );
  }
  // (b) The provider log is not yet final.
  assert.throws(
    () => establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", { logFinal: false }),
    (e: unknown) => isEvidenceRefusal(e),
    "a not-yet-final provider log cannot establish non-execution",
  );
  // (c) The completeness watermark does not cover the settlement.
  assert.throws(
    () => establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", { completeThrough: attempt.createdAt }),
    (e: unknown) => isEvidenceRefusal(e),
    "a watermark short of the settlement cannot establish non-execution",
  );
  // (d) Idempotency-registry coverage short of FULL.
  for (const registryCoverage of ["PARTIAL", "UNKNOWN"] as const) {
    assert.throws(
      () =>
        establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", {
          source: "PROVIDER_IDEMPOTENCY_REGISTRY",
          kind: "IDEMPOTENCY_REGISTRY_NO_RECORD_FOR_KEY",
          registryCoverage,
        }),
      (e: unknown) => isEvidenceRefusal(e),
      `registry coverage ${registryCoverage} must refuse`,
    );
  }
  // (e) An observation dated after the establishment instant.
  assert.throws(
    () => establish(rig, attemptId, "CONFIRMED_NON_EXECUTION", { observedAt: new Date(T0 + 3600_000).toISOString() }),
    (e: unknown) => isEvidenceRefusal(e),
    "a future-dated observation refuses",
  );
  assert.equal(resolutions(rig.store, attemptId).length, 0, "every finality refusal persisted zero rows");
  assert.throws(() => rig.store.beginDispatch(INTENT("q1", "sub_1", "key-1b")), DispatchBlockedError, "without finality the attempt stays blocked (UNRESOLVED in effect)");

  // Positive control: the same absence, from a FINAL registry with
  // FULL coverage and a watermark past the settlement, establishes
  // and resolves.
  const resolved = resolveValid(rig, attemptId, "CONFIRMED_NON_EXECUTION", {
    source: "PROVIDER_IDEMPOTENCY_REGISTRY",
    kind: "IDEMPOTENCY_REGISTRY_NO_RECORD_FOR_KEY",
    registryCoverage: "FULL",
  });
  assert.equal(resolved.operatorReviewState, "RESOLVED");
  const record = getResolution(rig.store, attemptId);
  assert.equal(record?.evidenceSource, "PROVIDER_IDEMPOTENCY_REGISTRY");
  assert.equal(record?.registryCoverage, "FULL");
  rig.store.close();
});

// ---------------------------------------------------------------------------
// 58.17 recoveryReport derivation: report status follows the actual
// terminal record, while the historical INDETERMINATE outcome stands.
// ---------------------------------------------------------------------------

test("Test 58.17: recoveryReport derives intervention and next action from the attempt's actual resolution state", () => {
  const rig = openRig();
  rig.store.put(makeStoredQuote("q1", "sub_1"));
  rig.store.put(makeStoredQuote("q2", "sub_2"));
  rig.store.put(makeStoredQuote("q3", "sub_3"));
  const attExec = settleIndeterminate(rig, "q1", "sub_1", "key-1");
  const attLand = settleIndeterminate(rig, "q2", "sub_2", "key-2");
  const attOpen = settleIndeterminate(rig, "q3", "sub_3", "key-3");
  rig.tick(60_000);

  resolveValid(rig, attExec, "CONFIRMED_NON_EXECUTION");
  resolveValid(rig, attLand, "CONFIRMED_LANDING");

  const itemFor = (id: string): any => rig.store.recoveryReport().indeterminateOutcomes.find((i) => i.attemptId === id);

  const execItem = itemFor(attExec);
  assert.equal(execItem.state, "INDETERMINATE", "the historical outcome is preserved, not rewritten");
  assert.equal(execItem.operatorInterventionRequired, false, "a terminally resolved attempt needs no further intervention");
  assert.equal(
    execItem.nextPermittedAction,
    "Resolved as CONFIRMED_NON_EXECUTION from established provider evidence; the original quote remains blocked — any re-authorization proceeds as a NEW quote. No automatic re-dispatch is permitted.",
  );

  const landItem = itemFor(attLand);
  assert.equal(landItem.operatorInterventionRequired, true, "an unreconciled landing still requires intervention");
  assert.match(String(landItem.nextPermittedAction), /reconcileLandedAttempt/);
  assert.match(String(landItem.nextPermittedAction), /No automatic re-dispatch is permitted\./);

  const openItem = itemFor(attOpen);
  assert.equal(openItem.operatorInterventionRequired, true);
  assert.match(String(openItem.nextPermittedAction), /Reconcile manually/);

  // After the reconciliation barrier is recorded, the landing item
  // flips to no-intervention with the fresh-quote-only action.
  const landRecord = getResolution(rig.store, attLand);
  reconcileLanded(rig.store, attLand, {
    operatorId: "operator-1",
    landedStateDigest: landRecord.observedProviderStateDigest,
    financialOutcomeDigest: sha256("test58.17: reconciled financial outcome record"),
    justification: "Landed state and financial consequences reconciled against provider records.",
  });
  const reconciledItem = itemFor(attLand);
  assert.equal(reconciledItem.operatorInterventionRequired, false);
  assert.match(String(reconciledItem.nextPermittedAction), /fresh quotes/);
  assert.match(String(reconciledItem.nextPermittedAction), /original quote remains blocked/);
  assert.match(String(reconciledItem.nextPermittedAction), /No automatic re-dispatch is permitted\./);
  rig.store.close();
});
