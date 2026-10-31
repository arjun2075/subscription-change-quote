// Child-process entry points for the PR-8 durable-store suite.
// These run as GENUINELY NEW processes (spawned with process.execPath
// by test27) against a real temporary database file — durability and
// cross-process claims are proven here, not by re-creating objects
// in the parent process.
//
// Modes:
//   crash-after-intent    <db>                       — beginDispatch commits, then the process exits(42) before any dispatch.
//   crash-after-dispatch  <db>                       — dispatch "succeeds" (in-process), then the process exits(43) before the result is persisted.
//   race                  <db> <markerFile>          — coordinator.execute with a dispatch that appends to markerFile; exit 0 = settled/replay, exit 3 = blocked.
//   hold-lock             <db> <readyFile>           — holds an EXCLUSIVE SQLite lock until killed.
import { appendFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DurableQuoteStore } from "../../src/store/durable-store.js";
import { DurableMutationCoordinator } from "../../src/store/mutation-coordinator.js";
import { makeReceipt } from "./durable-fixtures.js";

const [mode, dbPath, arg3] = process.argv.slice(2);

const intent = {
  quoteId: "q1",
  subscriptionId: "sub_1",
  provider: "chargebee",
  site: "child-test",
  request: { subscription_items: [{ item_price_id: "item_1", quantity: 2 }], replace_items_list: true },
  idempotencyKey: "scq-q1",
  preDispatchFingerprint: "fp-child",
};

async function main(): Promise<void> {
  if (mode === "hold-lock") {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3") as any;
    const db = new Database(dbPath);
    // The connection MUST stay reachable for the life of the
    // process: `db` is otherwise a main()-local with no reference
    // once main() returns (only the interval timer remains), and
    // garbage collection can finalize and CLOSE an unreachable
    // better-sqlite3 connection — silently releasing the EXCLUSIVE
    // lock this mode exists to hold (the test27.22b intermittent
    // flake: whether the lock survived depended on GC timing).
    (globalThis as Record<string, unknown>).__scqHoldLockDb = db;
    db.exec("BEGIN EXCLUSIVE");
    db.prepare(`INSERT INTO meta (key, value) VALUES ('lock_holder', 'child') ON CONFLICT(key) DO UPDATE SET value='child'`).run();
    writeFileSync(arg3, "locked");
    setInterval(() => undefined, 1000);
    return;
  }

  // The parent test pre-creates the database and the quote; children
  // never create quotes (concurrent creation is not under test here).
  const store = new DurableQuoteStore(dbPath, { busyTimeoutMs: 1500 });
  const coordinator = new DurableMutationCoordinator(store);

  if (mode === "crash-after-intent") {
    store.beginDispatch(intent);
    process.exit(42);
  }
  if (mode === "crash-during-dispatch") {
    await coordinator.execute(intent, async () => {
      process.exit(44);
    });
    process.exit(0);
  }
  if (mode === "crash-after-dispatch") {
    const crashing = new DurableMutationCoordinator(store, {
      afterDispatchBeforePersist: () => process.exit(43),
    });
    await crashing.execute(intent, async () => ({ type: "receipt", receipt: makeReceipt("q1", "sub_1") }));
    process.exit(0);
  }
  if (mode === "race") {
    try {
      const result = await coordinator.execute(intent, async () => {
        appendFileSync(arg3, "dispatch\n");
        await new Promise((r) => setTimeout(r, 250));
        return { type: "receipt", receipt: makeReceipt("q1", "sub_1") };
      });
      process.exit(result.type === "replay" ? 0 : 0);
    } catch {
      process.exit(3);
    }
  }
  process.exit(2);
}

main().catch(() => process.exit(1));
