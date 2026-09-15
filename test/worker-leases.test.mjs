import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// The router path module is intentionally evaluated against a temporary state
// root so these tests never mutate the installed lease ledger.
const state = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-lease-"));
process.env.CODEX_ROUTER_STATE_DIR = state;
process.env.CODEX_WORKER_LEDGER_PATH = path.join(state, "usage.sqlite3");
const leases = await import("../src/worker-leases.mjs?test=" + Date.now());
const setup = new DatabaseSync(process.env.CODEX_WORKER_LEDGER_PATH);
setup.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT OR REPLACE INTO settings VALUES ('mode','adaptive'),('execution_backend','router');");
setup.close();

test.afterEach(() => {
  const cleanup = new DatabaseSync(process.env.CODEX_WORKER_LEDGER_PATH);
  cleanup.exec("DELETE FROM router_request_events; DELETE FROM router_worker_denials; DELETE FROM router_requests; DELETE FROM router_worker_leases; DELETE FROM router_admissions; DELETE FROM router_allowance_claims; DELETE FROM router_jobs; DELETE FROM router_turns;");
  cleanup.close();
});

const budget = {
  maxRequests: 3, requestInputTokens: 1000, requestOutputTokens: 500,
  totalTokens: 4500, totalCostMicrousd: 300, requestCostMicrousd: 100,
};
const metadata = {
  taskId: "task-test", turnId: "turn-test", coordinatorModel: "gpt-5.6-sol",
  coordinatorReasoning: "medium", scopeSha256: "a".repeat(64),
};

function create(jobId) {
  const created = leases.createWorkerLease({jobId, route: "opencode-go/mimo-v2.5", budget, metadata,
    policy: {risk: "low"}, runtimeSha256: "b".repeat(64),
    allowance: {modelId: "mimo-v2.5", normalizedUsd: 0.01, tariffUsd: 0.001,
      monthlyAllowanceUsd: 60, safetyThreshold: 0.6},
    approvedFileCount: 2, approvedCommandCount: 1, allowsEdits: true});
  leases.bindWorkerLease({jobId, childSessionId: `child-${jobId}`});
  return created;
}

test("capability is exact-route and short-lived", () => {
  const created = create("job-test");
  assert.equal(leases.authorizeWorkerCapability(created.capability, "job-test", created.route).ok, true);
  assert.equal(leases.authorizeWorkerCapability(created.capability, "job-test", "opencode-go/grok-4.6").reason, "route_mismatch");
  assert.equal(leases.authorizeWorkerCapability("wrong-capability-value", "job-test", created.route).ok, false);
});

test("reservations are idempotent and conservative until usage is known", () => {
  const created = create("job-budget");
  const args = {capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "initial", inputTokens: 100, outputTokens: 20, costMicrousd: 10};
  const first = leases.reserveWorkerAttempt(args);
  assert.equal(first.ok, true);
  assert.equal(leases.reserveWorkerAttempt(args).duplicate, true);
  leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-1", status: "failed"});
  const status = leases.workerLeaseStatus(created.jobId);
  assert.equal(status.reserved.requests, 1);
  assert.equal(status.attempts[0].status, "failed");
});

test("known usage releases ceiling and records actual totals", () => {
  const created = create("job-known");
  leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "followup", inputTokens: 100, outputTokens: 20, costMicrousd: 10});
  leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-1", status: "completed",
    usage: {inputTokens: 40, outputTokens: 5, costMicrousd: 2}});
  const status = leases.workerLeaseStatus(created.jobId);
  assert.equal(status.reserved.requests, 0);
  assert.equal(status.used.tokens, 45);
  assert.equal(status.used.costMicrousd, 2);
});

test("conflicting duplicate reservations block the job", () => {
  const created = create("job-conflict");
  const common = {capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "initial", inputTokens: 100, outputTokens: 20, costMicrousd: 10};
  assert.equal(leases.reserveWorkerAttempt(common).ok, true);
  assert.equal(leases.reserveWorkerAttempt({...common, kind: "retry"}).reason, "conflicting_duplicate_request");
  assert.equal(leases.workerLeaseStatus(created.jobId).state, "accounting_blocked");
});

test("negative or over-reservation usage is rejected", () => {
  const created = create("job-overrun");
  leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "initial", inputTokens: 100, outputTokens: 20, costMicrousd: 10});
  assert.throws(() => leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-1", status: "completed",
    usage: {inputTokens: 1001, outputTokens: 1, costMicrousd: 1}}), /exceeded/);
  assert.equal(leases.workerLeaseStatus(created.jobId).state, "accounting_blocked");
});

test("missing authoritative cost retains the cost reservation", () => {
  const created = create("job-cost-unknown");
  leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "initial", inputTokens: 100, outputTokens: 20, costMicrousd: 10});
  leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-1", status: "completed",
    usage: {inputTokens: 2, outputTokens: 3}});
  const status = leases.workerLeaseStatus(created.jobId);
  assert.equal(status.reserved.costMicrousd, 100);
  assert.equal(status.used.costMicrousd, 0);
});

test("partial usage releases only the authoritative component", () => {
  const created = create("job-partial");
  leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "compaction", inputTokens: 1, outputTokens: 1});
  leases.markWorkerAttemptForwarded({jobId: created.jobId, requestId: "request-1", providerRequestId: "provider-1"});
  leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-1", status: "completed",
    usage: {inputTokens: 12}});
  const status = leases.workerLeaseStatus(created.jobId);
  assert.equal(status.used.inputTokens, 12);
  assert.equal(status.reserved.inputTokens, 0);
  assert.equal(status.reserved.outputTokens, 500);
  assert.equal(status.attempts[0].providerRequestId, "provider-1");
});

test("conflicting terminal events block further accounting", () => {
  const created = create("job-terminal-conflict");
  leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "initial", inputTokens: 1, outputTokens: 1});
  leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-1", status: "completed",
    usage: {inputTokens: 1, outputTokens: 1, costMicrousd: 1}});
  assert.throws(() => leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-1", status: "ambiguous"}), /Conflicting/);
  assert.equal(leases.workerLeaseStatus(created.jobId).state, "accounting_blocked");
});

test("request count budget is enforced before forwarding", () => {
  const created = create("job-exhausted");
  for (let index = 0; index < 3; index++) {
    const requestId = `request-${index}`;
    assert.equal(leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId,
      route: created.route, requestId, kind: index ? "retry" : "initial", inputTokens: 1, outputTokens: 1}).ok, true);
    leases.settleWorkerAttempt({jobId: created.jobId, requestId, status: "failed"});
  }
  assert.equal(leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId,
    route: created.route, requestId: "request-4", kind: "retry", inputTokens: 1, outputTokens: 1}).reason, "job_budget_exhausted");
  const status = leases.workerLeaseStatus(created.jobId);
  assert.equal(status.requestCount, 3);
  assert.equal(status.providerForwardCount, 0);
  assert.equal(status.budgetDeniedRequests, 1);
});

test("a lease with a pending attempt cannot be closed", () => {
  const created = create("job-pending");
  leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "initial", inputTokens: 100, outputTokens: 20, costMicrousd: 10});
  assert.throws(() => leases.closeWorkerLease({jobId: created.jobId}), /pending attempts/);
});

test("provider attempts are denied until the child is bound", () => {
  const created = leases.createWorkerLease({jobId: "job-unbound", route: "opencode-go/mimo-v2.5", budget, metadata,
    policy: {risk: "low"}, runtimeSha256: "b".repeat(64), allowance: {modelId: "mimo-v2.5",
      normalizedUsd: 0.01, tariffUsd: 0.001, monthlyAllowanceUsd: 60, safetyThreshold: 0.6},
    approvedFileCount: 2, approvedCommandCount: 1, allowsEdits: true});
  const result = leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId, route: created.route,
    requestId: "request-1", kind: "initial", inputTokens: 1, outputTokens: 1, costMicrousd: 1});
  assert.equal(result.reason, "child_not_bound");
});

test("a duplicate job never rotates its capability", () => {
  create("job-duplicate");
  assert.throws(() => leases.createWorkerLease({jobId: "job-duplicate", route: "opencode-go/mimo-v2.5", budget, metadata,
    policy: {risk: "low"}, runtimeSha256: "b".repeat(64), allowance: {modelId: "mimo-v2.5",
      normalizedUsd: 0.01, tariffUsd: 0.001, monthlyAllowanceUsd: 60, safetyThreshold: 0.6},
    approvedFileCount: 2, approvedCommandCount: 1, allowsEdits: true}), /cannot be reissued/);
});

test("finish retries are idempotent but cannot rewrite the outcome", () => {
  const created = create("job-finish");
  leases.closeWorkerLease({jobId: created.jobId, outcome: "completed", accepted: true, reviewMinutes: 2});
  leases.closeWorkerLease({jobId: created.jobId, outcome: "completed", accepted: true, reviewMinutes: 2});
  assert.throws(() => leases.closeWorkerLease({jobId: created.jobId, outcome: "failed", accepted: false, reviewMinutes: 2}), /Conflicting/);
});
