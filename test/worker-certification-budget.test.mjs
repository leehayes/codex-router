import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-cert-budget-"));
process.env.CODEX_ROUTER_STATE_DIR = state;
process.env.CODEX_WORKER_LEDGER_PATH = path.join(state, "usage.sqlite3");
const leases = await import("../src/worker-leases.mjs?cert-budget-test=" + Date.now());
const setup = new DatabaseSync(process.env.CODEX_WORKER_LEDGER_PATH);
setup.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT OR REPLACE INTO settings VALUES ('mode','adaptive'),('execution_backend','direct');");
setup.close();

const budget = {
  maxRequests: 8, requestInputTokens: 1000, requestOutputTokens: 500,
  totalTokens: 12000, totalCostMicrousd: 800, requestCostMicrousd: 100,
};

test("certification budget fill consumes no provider forwarding", () => {
  const created = leases.createWorkerLease({
    jobId: "cert-budget-test", route: "opencode-go/mimo-v2.5", budget,
    metadata: {taskId: "task-test", turnId: "turn-test", coordinatorModel: "gpt-5.6-sol",
      coordinatorReasoning: "medium", scopeSha256: "a".repeat(64)},
    policy: {risk: "low", purpose: "certification"}, runtimeSha256: "b".repeat(64),
    allowance: {modelId: "mimo-v2.5", normalizedUsd: 0.01, tariffUsd: 0.001,
      monthlyAllowanceUsd: 60, safetyThreshold: 0.6},
    approvedFileCount: 2, approvedCommandCount: 1, allowsEdits: true,
  });
  leases.bindWorkerLease({jobId: created.jobId, childSessionId: "child-cert-budget"});
  leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId,
    route: created.route, requestId: "request-live", kind: "initial"});
  leases.settleWorkerAttempt({jobId: created.jobId, requestId: "request-live", status: "completed",
    usage: {inputTokens: 3, outputTokens: 2, costMicrousd: 1}});
  const filled = leases.fillCertificationBudget({capability: created.capability,
    jobId: created.jobId, route: created.route});
  assert.equal(filled.requestCount, budget.maxRequests);
  assert.equal(filled.providerForwardCount, 0);
  assert.equal(leases.reserveWorkerAttempt({capability: created.capability, jobId: created.jobId,
    route: created.route, requestId: "request-excess", kind: "followup"}).reason, "job_budget_exhausted");
  const status = leases.workerLeaseStatus(created.jobId);
  assert.equal(status.providerForwardCount, 0);
  assert.equal(status.budgetDeniedRequests, 1);
});

test("known-broken Qwen Flash route is quarantined from worker certification", () => {
  assert.throws(() => leases.createWorkerLease({
    jobId: "cert-qwen-quarantine", route: "opencode-go-messages/qwen3.8-flash", budget,
    metadata: {taskId: "task-qwen", turnId: "turn-qwen", coordinatorModel: "gpt-5.6-sol",
      coordinatorReasoning: "medium", scopeSha256: "c".repeat(64)},
    policy: {risk: "low", purpose: "certification"}, runtimeSha256: "d".repeat(64),
    allowance: {modelId: "qwen3.8-flash", normalizedUsd: 0.01, tariffUsd: 0.001,
      monthlyAllowanceUsd: 30, safetyThreshold: 0.8},
    approvedFileCount: 1, approvedCommandCount: 1, allowsEdits: true,
  }), /certification state is not valid/);
});
