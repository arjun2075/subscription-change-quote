import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// Temp-dir cleanup (test infrastructure): every directory handed out via
// trackTempDir is removed when this file's tests finish — pass or fail —
// so repeated suite runs do not accumulate scq-* litter in the OS temp
// dir. Cleanup runs only after the owning tests complete; durable-store
// tests that reopen a store across simulated restarts within one test
// are unaffected.
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function trackTempDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCQError,
  type CommercialEffect,
  type ProviderObservation,
  type SubscriptionChangeReceipt,
} from "../src/core/types.js";
import { QuoteStore, establishVerification, type StoredQuote } from "../src/store/quote-store.js";
import { DispatchBlockedError, DurableQuoteStore, ResolutionEvidenceError } from "../src/store/durable-store.js";
import * as durableModule from "../src/store/durable-store.js";
import { createHash } from "node:crypto";
import { ChargebeeAdapter } from "../src/adapters/chargebee-adapter.js";
import { freshChargebeeFixture } from "./fixtures.js";
import { makeStoredQuote } from "./helpers/durable-fixtures.js";

// Test 56 — SCQ v0.6.2 conformance closure (issue #29): G-21
// Finding-7 residuals. TEST-ONLY pins of CURRENT behaviour plus
// documentation; no behaviour changes. Where a pin holds a
// documented limitation in place it is labelled a LIMITATION PIN:
// the test's purpose is to make the limitation executable and
// regression-visible, not to endorse it. Any behaviour change is
// a maintainer decision item (see the PR body), never enacted here.
//
// Item map (G-21 register entry, research/v0.6.2-release-gaps.md):
//   (3) Exclusion keying — findBlockingAttempt keys on
//       (quote_id OR subscription_id) with no provider/site
//       predicate (§6.16 as implemented): 56.1, 56.2.
//   (2) resolveAttempt attestation — an INDETERMINATE attempt was
//       unblocked by an operator's free-text note alone: 56.3–56.5.
//       That limitation (G-21(2)) is now FIXED by the P0 issue-#43
//       change: resolution requires structured, operation-bound
//       evidence (pinned exhaustively by test58), and 56.4/56.5
//       below pin the fixed semantics at this suite's level. The
//       PR #50 correction round (R1–R4) tightened the boundary
//       further: evidence must be ESTABLISHED (branded token from
//       the establishment procedure over an actual provider record,
//       with provider finality), and a resolved INDETERMINATE
//       attempt's own quote stays blocked for any key —
//       re-authorization proceeds as a new quote (§6.15).
//       The CONFIRMED_NON_EXECUTION same-key re-arm itself is
//       already pinned at the coordinator level by test29.8/29.9,
//       and key non-reassociation (incl. across sites) by
//       test29.10 — cited, not duplicated.
//   (1) EXACT state-side source — the branch Finding 7 substantiated
//       is the STRIPE simulator's (stripe-adapter.ts: the
//       `isCancel || effectiveMode === "EXACT"` branch records
//       committed := quoted as defined_equal_exact from the mutation
//       call's return value, with no independent post-commit
//       re-read). Its happy path is pinned by test17.12. A
//       wrong-state NEGATIVE is NOT CONSTRUCTIBLE through the
//       Stripe simulator's public API: the sim's only fault hooks
//       are _debugOmitIncurredAmount (preview surface),
//       _debugFailInvoiceReads (REVALIDATE-branch reads) and
//       _debugLoseNextUpdateResponse (lost response — the
//       INDETERMINATE path, which never reaches this branch), and
//       cancel()/update() always apply exactly the requested
//       change. There is no misexecution hook, so no honest test
//       can make the mutation return a wrong state; manufacturing
//       one would require reaching into sim internals, which this
//       suite does not do. That non-constructibility is itself the
//       finding, recorded here and in the register: the branch's
//       state side remains unverified BY CONSTRUCTION until a
//       misexecution fault exists (maintainer decision item).
//       The CHARGEBEE simulator is the contrast case: its cancel
//       branch DOES establish independently (artifact read-back +
//       state re-read + fingerprint bracket), its wrong-state and
//       wrong-actual negatives are pinned by test25.17b and
//       test25.20, and an EXACT-guarantee CANCEL does not exist
//       there at all — 56.6 pins its refusal at quote creation.
//   (4) Post-commit evidence attribution residue — test50 pins the
//       token binding across quote+subscription (50.6), foreign
//       snapshots (50.7), presented-receipt conflicts (50.5) and
//       restore-set tampering (50.20/50.22/50.23/50.25/50.36).
//       The residue pinned here: the quote binding ISOLATED from
//       the subscription binding (56.7), and a WHOLESALE trail
//       transplant — a genuine, internally valid trail re-filed
//       under a different record — at both restore paths
//       (56.8, 56.9).
//
// All evidence is SIMULATED (durable-store SQLite files in a temp
// dir; simulator adapters). No live provider is touched.

function tmpDb(name = "scq.db"): string {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "scq-g21-")));
  return join(dir, name);
}
function openStore(path: string): DurableQuoteStore {
  return new DurableQuoteStore(path, { recoveryGraceMs: 0 });
}
const INTENT = (quoteId: string, subscriptionId: string, site: string, key: string) => ({
  quoteId,
  subscriptionId,
  provider: "chargebee",
  site,
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
  idempotencyKey: key,
  preDispatchFingerprint: "fp-1",
});

// ---------------------------------------------------------------------------
// (3) Exclusion keying — the over-broad cross-site block (§6.16 as
// implemented). LIMITATION PIN: the behaviour pinned here is the
// documented divergence tracked in G-21, not a conformance claim.
// ---------------------------------------------------------------------------

test("Test 56.1 (G-21(3), LIMITATION PIN): a DISPATCHING attempt under one Chargebee site blocks a dispatch for the same subscription id under a DIFFERENT site", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("qA", "sub_xsite"));
  store.put(makeStoredQuote("qB", "sub_xsite"));
  store.put(makeStoredQuote("qC", "sub_other"));

  const attA = store.beginDispatch(INTENT("qA", "sub_xsite", "site-a", "key-a"));
  assert.equal(attA.state, "DISPATCHING");
  assert.equal(attA.site, "site-a");

  // The site-b intent names a different quote AND a different site;
  // only the subscription id matches. It is refused, and the
  // blocking record it is refused BY is the site-a attempt — the
  // site predicate's absence made observable.
  assert.throws(
    () => store.beginDispatch(INTENT("qB", "sub_xsite", "site-b", "key-b")),
    (e: unknown) =>
      e instanceof DispatchBlockedError &&
      (e.details as { attemptId?: string } | undefined)?.attemptId === attA.attemptId &&
      /DISPATCHING/.test(e.message),
    "the cross-site intent must be refused by the site-a attempt",
  );
  const blocking = store.findBlockingAttempt("qB", "sub_xsite");
  assert.equal(blocking?.attemptId, attA.attemptId);
  assert.equal(blocking?.site, "site-a", "the blocking attempt belongs to a different site than the refused intent");
  assert.equal(store.attemptsForQuote("qB").length, 0, "the refusal records zero attempts for the blocked quote");

  // Control: a different subscription id is NOT blocked by attA —
  // the block above is the subscription keying, not a global lock.
  const attC = store.beginDispatch(INTENT("qC", "sub_other", "site-b", "key-c"));
  assert.equal(attC.state, "DISPATCHING");
  store.close();
});

test("Test 56.2 (G-21(3), boundary): once the blocking attempt reaches a terminal record, the other site's dispatch is no longer blocked", () => {
  const store = openStore(tmpDb());
  store.put(makeStoredQuote("qA", "sub_xsite"));
  store.put(makeStoredQuote("qB", "sub_xsite"));

  const attA = store.beginDispatch(INTENT("qA", "sub_xsite", "site-a", "key-a"));
  assert.throws(() => store.beginDispatch(INTENT("qB", "sub_xsite", "site-b", "key-b")), DispatchBlockedError);

  store.recordAttemptOutcome(attA.attemptId, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.getAttempt(attA.attemptId)?.state, "CONFIRMED_NON_EXECUTION");
  assert.equal(store.findBlockingAttempt("qB", "sub_xsite"), undefined, "a terminal attempt does not block");

  const attB = store.beginDispatch(INTENT("qB", "sub_xsite", "site-b", "key-b"));
  assert.equal(attB.state, "DISPATCHING");
  assert.equal(attB.site, "site-b");
  store.close();
});

// ---------------------------------------------------------------------------
// (2) resolveAttempt attestation (§6.16): the INDETERMINATE block,
// the structured-evidence resolution record (G-21(2) FIXED by the
// P0 issue-#43 change; the exhaustive evidence matrix is test58),
// and the post-resolution dispatch semantics.
// ---------------------------------------------------------------------------

function indeterminateStore(): { store: DurableQuoteStore; attemptId: string; clockNow: () => Date } {
  // Manual clock: dispatch, settlement (attempt.updatedAt), and the
  // provider observation must be strictly ordered for the finality
  // rules (PR #50 review R3) to be exercisable deterministically.
  let nowMs = Date.parse("2026-10-31T12:00:00.000Z");
  const store = new DurableQuoteStore(tmpDb(), { recoveryGraceMs: 0, now: () => new Date(nowMs) });
  store.put(makeStoredQuote("q1", "sub_1"));
  const att = store.beginDispatch(INTENT("q1", "sub_1", "site-a", "key-1"));
  nowMs += 60_000;
  store.recordAttemptOutcome(att.attemptId, "INDETERMINATE");
  nowMs += 60_000;
  return { store, attemptId: att.attemptId, clockNow: () => new Date(nowMs) };
}

const establishResolutionEvidence56: any = (durableModule as any).establishResolutionEvidence;

/**
 * The legitimate resolution path after the PR #50 correction round:
 * a simulated provider record is validated by the establishment
 * procedure (binding, operation-bound kind, provider finality) and
 * minted into a branded token; resolveAttempt accepts only that
 * token. See test58 for the full matrix.
 */
function establishedNonExecutionInput(store: DurableQuoteStore, attemptId: string, clockNow: () => Date) {
  const attempt = store.getAttempt(attemptId)!;
  const now = clockNow();
  const token = establishResolutionEvidence56(
    attempt,
    {
      source: "PROVIDER_OPERATION_LOG",
      kind: "OPERATION_LOG_NO_RECORD_FOR_KEY",
      reference: "oplog-ref-56",
      provider: attempt.provider,
      site: attempt.site ?? undefined,
      subscriptionId: attempt.subscriptionId,
      quoteId: attempt.quoteId,
      idempotencyKey: attempt.idempotencyKey,
      requestHash: attempt.requestHash,
      operationFound: false,
      observedState: { lookupResult: "NO_RECORD_FOR_KEY", idempotencyKey: attempt.idempotencyKey },
      observedAt: now.toISOString(),
      logFinal: true,
      completeThrough: now.toISOString(),
    },
    "CONFIRMED_NON_EXECUTION",
    now,
  );
  return {
    evidence: token,
    operatorId: "operator-1",
    reconciliationDecision: "PERMIT_NEW_DISPATCH",
    justification: "Provider operation log, final through the settlement, records no operation for this attempt's idempotency key.",
  };
}

test("Test 56.3 (G-21(2)): an unresolved INDETERMINATE attempt refuses both same-key retry and new-key dispatch until an operator resolves it", () => {
  const { store, attemptId } = indeterminateStore();
  const att = store.getAttempt(attemptId)!;
  assert.equal(att.state, "INDETERMINATE");
  assert.equal(att.operatorReviewState, "REQUIRED", "an INDETERMINATE terminal record demands operator review");

  assert.throws(
    () => store.beginDispatch(INTENT("q1", "sub_1", "site-a", "key-1")),
    (e: unknown) => e instanceof DispatchBlockedError && /blind retry is prohibited/.test(e.message),
    "the same key may not blindly retry an unresolved INDETERMINATE attempt",
  );
  assert.throws(
    () => store.beginDispatch(INTENT("q1", "sub_1", "site-a", "key-2")),
    (e: unknown) => e instanceof DispatchBlockedError && /INDETERMINATE and unresolved/.test(e.message),
    "a new key does not launder the unresolved attempt",
  );
  assert.equal(store.attemptsForQuote("q1").length, 1, "both refusals record zero new attempts");
  store.close();
});

test("Test 56.4 (G-21(2), FIXED by P0 #43): resolution requires established evidence — a free-text note refuses, and a branded-token resolution produces a bound, readable resolution record", () => {
  const { store, attemptId, clockNow } = indeterminateStore();
  const NOTE = "reconciled against the provider console, 2026-10-30";

  // The pre-fix call shape: a free-text note alone. It now refuses
  // and persists nothing (the full refusal matrix is test58).
  assert.throws(
    () => (store as unknown as { resolveAttempt: (id: string, ev: unknown) => unknown }).resolveAttempt(attemptId, NOTE),
    (e: unknown) => e instanceof ResolutionEvidenceError && e.code === "RESOLUTION_EVIDENCE_REFUSED",
    "a free-text operator note is not resolution evidence",
  );
  assert.equal(store.getAttempt(attemptId)?.operatorReviewState, "REQUIRED", "the refusal leaves the attempt unresolved");
  assert.equal(store.resolutionsForAttempt(attemptId).length, 0, "the refusal persists zero resolution rows");

  const resolved = (store as unknown as { resolveAttempt: (id: string, ev: unknown) => ReturnType<DurableQuoteStore["getAttempt"]> }).resolveAttempt(
    attemptId,
    establishedNonExecutionInput(store, attemptId, clockNow),
  )!;
  assert.equal(resolved.operatorReviewState, "RESOLVED");
  assert.equal(resolved.state, "INDETERMINATE", "resolution changes no outcome — the attempt's landing remains unestablished");
  assert.equal(resolved.outcome, "INDETERMINATE");

  // The structured record lives in its own append-only table and is
  // readable through the store, bound to the attempt in every
  // identity field.
  const record = store.getResolution(attemptId);
  assert.ok(record, "a structured resolution record exists and is readable");
  assert.equal(record.attemptId, attemptId);
  assert.equal(record.quoteId, "q1");
  assert.equal(record.subscriptionId, "sub_1");
  assert.equal(record.provider, "chargebee");
  assert.equal(record.site, "site-a");
  assert.equal(record.requestHash, resolved.requestHash, "the record is bound to the attempt's request hash");
  assert.equal(record.idempotencyKey, "key-1");
  assert.equal(record.classification, "CONFIRMED_NON_EXECUTION");
  assert.equal(record.evidenceSource, "PROVIDER_OPERATION_LOG");
  assert.equal(record.evidenceReference, "oplog-ref-56");
  assert.match(record.evidenceHash, /^[0-9a-f]{64}$/);
  assert.equal(store.resolutionsForAttempt(attemptId).length, 1);

  assert.deepEqual(
    Object.keys(resolved).sort(),
    [
      "attemptId", "createdAt", "details", "idempotencyKey", "operatorReviewState", "outcome",
      "preDispatchFingerprint", "provider", "quoteId", "recoveryClassification", "request",
      "requestHash", "site", "state", "subscriptionId", "updatedAt", "version",
    ],
    "the StoredAttempt shape itself is unchanged — resolution evidence is a separate bound record, not a new attempt field",
  );
  store.close();
});

test("Test 56.5 (G-21(2)): after an established-evidence resolution, the same key returns the standing INDETERMINATE attempt un-re-armed, the SAME quote stays blocked for a new key (R1 / §6.15 new-quote rule), and a new quote may dispatch", () => {
  const { store, attemptId, clockNow } = indeterminateStore();
  store.put(makeStoredQuote("q2", "sub_1"));
  (store as unknown as { resolveAttempt: (id: string, ev: unknown) => unknown }).resolveAttempt(
    attemptId,
    establishedNonExecutionInput(store, attemptId, clockNow),
  );

  const standing = store.beginDispatch(INTENT("q1", "sub_1", "site-a", "key-1"));
  assert.equal(standing.attemptId, attemptId, "the original attempt stands under its key");
  assert.equal(standing.state, "INDETERMINATE", "resolution does not convert the attempt into a re-dispatch authorisation for its own key");
  assert.equal(store.attemptsForQuote("q1").length, 1, "no new attempt was created by the re-presentment");

  // PR #50 review R1: retroactive resolution of an INDETERMINATE
  // attempt is NOT the originally-terminal CONFIRMED_NON_EXECUTION
  // re-arm exception — the old quote remains blocked for any key,
  // and re-authorization proceeds as a NEW quote (§6.15).
  assert.throws(
    () => store.beginDispatch(INTENT("q1", "sub_1", "site-a", "key-2")),
    DispatchBlockedError,
    "a new key on the resolved attempt's own quote is refused",
  );
  assert.equal(store.attemptsForQuote("q1").length, 1, "the refusal records no new attempt for the old quote");

  const fresh = store.beginDispatch(INTENT("q2", "sub_1", "site-a", "key-3"));
  assert.equal(fresh.state, "DISPATCHING", "a genuinely new quote on the same subscription dispatches under the usual §6.16 gates");
  store.close();
});

// ---------------------------------------------------------------------------
// (1) EXACT state-side source — Chargebee half: an EXACT-guarantee
// CANCEL is refused at quote creation, so the defined_equal_exact-
// without-re-read branch does not exist on this adapter (contrast
// test25.17b/25.20, where the REVALIDATE cancel's wrong state and
// wrong actual are caught by independent establishment).
// ---------------------------------------------------------------------------

test("Test 56.6 (G-21(1)): a Chargebee CANCEL quote requesting the EXACT guarantee is refused at creation (UNSUPPORTED_CHANGE)", async () => {
  const { sim, sub } = freshChargebeeFixture();
  const store = new QuoteStore();
  const adapter = new ChargebeeAdapter(sim, store);
  for (const type of ["TERM_END", "IMMEDIATE"] as const) {
    await assert.rejects(
      () => adapter.createChangeQuote(sub.id, {
        changes: [{ action: "CANCEL" }],
        effectiveIntent: { type },
        guaranteeMode: "EXACT",
      }),
      (e: unknown) => e instanceof SCQError && e.code === "UNSUPPORTED_CHANGE" && /EXACT/.test(e.message),
      `EXACT-guarantee CANCEL (${type}) must be refused — Chargebee's cancel coverage is REVALIDATE`,
    );
  }
  assert.equal(store.all().length, 0, "the refusal happens at quote creation; nothing is stored");
  assert.equal(sim.mutationsFor(sub.id).length, 0, "and nothing is dispatched");
});

// ---------------------------------------------------------------------------
// (4) Evidence attribution residue. Fixtures follow test50's
// discipline: recorded figures are CANDIDATES (literals are the
// point — they are what the mutation response stated); the
// observation's actuals are uncontested (they equal the quoted
// figures), because this section's subject is BINDING, not
// figures. Binding across quote+subscription is test50.6; the
// residue is the quote binding alone, and trail transplants.
// ---------------------------------------------------------------------------

const SUB53 = "sub_53";
const QUOTED53 = { immediate: 20000, recurring: 80900 };

function makeQuote53(quoteId: string): StoredQuote {
  return {
    quote_id: quoteId,
    provider: "stripe",
    subscription_id: SUB53,
    subscription_version_at_quote: "v1",
    proposal: {
      changes: [{ action: "CHANGE_QUANTITY", itemId: "item_1", quantity: 2 }],
      effectiveIntent: { type: "IMMEDIATE" },
    } as StoredQuote["proposal"],
    effective_guarantee_mode: "REVALIDATE",
    guarantee_coverage: {
      immediateFinancialEffect: "REVALIDATE",
      recurringFinancialEffect: "REVALIDATE",
      termEffect: "UNKNOWN",
      effectiveAt: "REVALIDATE",
    },
    multi_change_consistency: "ATOMIC",
    provider_preview_input: null,
    quoted_effect: {
      immediate: { net: QUOTED53.immediate },
      recurring: { resultingAmount: QUOTED53.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "test53: quote-time preview", recurring: "test53: quote-time preview" },
    },
    created_at: "2026-10-30T00:00:00.000Z",
    expires_at: "2026-10-30T01:00:00.000Z",
    status: "ACTIVE",
  };
}

function candidateReceipt53(quoteId: string): SubscriptionChangeReceipt {
  return {
    quoteId,
    subscriptionRef: SUB53,
    receiptId: `rcpt_${quoteId}`,
    status: "COMMITTED_UNVERIFIED",
    outcome: "COMMITTED_UNVERIFIED",
    resultingSnapshot: {
      id: SUB53,
      version: "v2",
      status: "active",
      items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
      billing: { currency: "USD", cadence: "MONTHLY" },
    },
    quotedEffect: {
      immediate: { net: QUOTED53.immediate },
      recurring: { resultingAmount: QUOTED53.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: { immediate: "test53: quote-time preview", recurring: "test53: quote-time preview" },
    },
    committedEffect: {
      immediate: { net: QUOTED53.immediate },
      recurring: { resultingAmount: QUOTED53.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "UNKNOWN", recurringFinancialEffect: "UNKNOWN" },
      provenance: {
        immediate: "candidate: mutation response figures (unverified)",
        recurring: "candidate: mutation response figures (unverified)",
        committedSource: "unestablished",
      },
    } as CommercialEffect,
    guaranteeMode: "REVALIDATE",
    consistencyGuarantee: "BEST_EFFORT",
    multiChangeConsistency: "ATOMIC",
    reconciliation: {
      status: "UNVERIFIED",
      reason: "committed figures are candidates from the mutation response; no independent establishment",
      undeterminedDimensions: ["immediateFinancialEffect", "recurringFinancialEffect"],
    },
    committedAt: "2026-10-30T00:05:00.000Z",
  };
}

function observation53(): ProviderObservation {
  return {
    subscriptionRef: SUB53,
    source: "test53: independent post-commit provider reads (mocked)",
    observedAt: "2026-10-30T00:06:00.000Z",
    committedEffect: {
      immediate: { net: QUOTED53.immediate },
      recurring: { resultingAmount: QUOTED53.recurring, currency: "USD", cadence: "MONTHLY" },
      determinacy: { immediateFinancialEffect: "DETERMINED", recurringFinancialEffect: "DETERMINED" },
      provenance: {
        immediate: "test53: provider's operation-bound record for this mutation (mocked)",
        recurring: "test53: independent post-commit read (mocked)",
        committedSource: "provider_actual",
      },
    },
    resultingSnapshot: {
      id: SUB53,
      version: "v2",
      status: "active",
      items: [{ id: "item_1", offeringRef: "plan", quantity: 2 }],
      billing: { currency: "USD", cadence: "MONTHLY", recurringAmount: QUOTED53.recurring },
    },
  };
}

/** Two quotes on the SAME subscription, each with its own recorded candidate receipt. */
function twoQuoteStore(): QuoteStore {
  const store = new QuoteStore();
  store.put(makeQuote53("q53_a"));
  store.put(makeQuote53("q53_b"));
  store.recordCommitReceipt("q53_a", candidateReceipt53("q53_a"));
  store.recordCommitReceipt("q53_b", candidateReceipt53("q53_b"));
  return store;
}

test("Test 56.7 (G-21(4)): evidence minted for one quote is refused for another quote on the SAME subscription — the quote/operation binding isolated", () => {
  const store = twoQuoteStore();
  const tokenA = establishVerification(store.get("q53_a")!, observation53());

  // Both live entry points refuse the foreign-quote token, even
  // though the subscription — and every figure — is identical.
  assert.throws(() => store.recordReceiptEvidence("q53_b", tokenA), /bound|binding|different quote|another/i);
  assert.throws(() => store.verifyCommitReceipt("q53_b", tokenA), /bound|binding|different quote|another/i);
  assert.equal(store.get("q53_b")!.commit_receipt_verifications?.length ?? 0, 0, "nothing was appended to quote B");

  // Control: the same token IS accepted for its own quote — the
  // refusal above is the binding, not the token's quality.
  const view = store.recordReceiptEvidence("q53_a", tokenA);
  assert.equal(view.outcome, "COMMITTED_AND_VERIFIED");
  assert.equal(store.get("q53_a")!.commit_receipt_verifications?.length, 1);
});

/** A genuine trail minted for quote A, re-filed under quote B's own record (B's receipts and identity digest intact). */
function transplantedPayload(): string {
  const store = twoQuoteStore();
  const tokenA = establishVerification(store.get("q53_a")!, observation53());
  store.recordReceiptEvidence("q53_a", tokenA);
  const data = JSON.parse(store.serializeReceiptRecords()) as {
    records: Array<Record<string, unknown> & { quote_id: string; verifications?: unknown[] }>;
  };
  const recA = data.records.find((r) => r.quote_id === "q53_a")!;
  const recB = data.records.find((r) => r.quote_id === "q53_b")!;
  assert.ok((recA.verifications?.length ?? 0) === 1, "fixture: quote A carries a one-entry genuine trail");
  recB.verifications = recA.verifications;
  return JSON.stringify({ records: [recB] });
}

test("Test 56.8 (G-21(4)): a wholesale trail transplant — genuine entries re-filed under a different record — refuses restore; nothing is adopted", () => {
  const restored = new QuoteStore();
  restored.put(makeQuote53("q53_b"));
  assert.throws(
    () => restored.restoreReceiptRecords(transplantedPayload()),
    (e: unknown) => e instanceof SCQError && e.code === "CONFLICTING_RECEIPT_IDENTITY",
    "every entry is internally genuine (50.22 forges one entry's digest string); only the record binding can refuse this set",
  );
  assert.equal(restored.get("q53_b")!.commit_receipt, undefined, "no partial adoption from a transplanted trail");
});

test("Test 56.9 (G-21(4)): the transplant is refused at the DURABLE restore path too, and a reopen adopts nothing", () => {
  const path = tmpDb();
  const a = openStore(path);
  a.put(makeStoredQuote("q53_b", SUB53));
  // The durable destination holds quote B (its own subscription
  // binding — makeStoredQuote's provider is chargebee; the record
  // machinery under test is provider-agnostic).
  assert.throws(
    () => a.restoreReceiptRecords(transplantedPayload()),
    (e: unknown) => e instanceof SCQError && e.code === "CONFLICTING_RECEIPT_IDENTITY",
  );
  a.close();

  const b = openStore(path);
  assert.equal(b.get("q53_b")!.commit_receipt, undefined, "the refused set persisted nothing");
  assert.equal(b.get("q53_b")!.commit_receipt_verifications?.length ?? 0, 0);
  b.close();
});
