import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CODEX_HOME } from "./paths.mjs";

export const WORKER_LEDGER_PATH = process.env.CODEX_WORKER_LEDGER_PATH ||
  path.join(process.env.OPENCODE_GO_HARNESS_STATE || path.join(CODEX_HOME, "model-router"), "usage.sqlite3");
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_REQUEST_INPUT = 32768;
const MAX_REQUEST_OUTPUT = 8000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const CERTIFICATION_ROUTES = new Set([
    "opencode-go-messages/minimax-m3", "opencode-go/mimo-v2.5",
  "opencode-go/glm-5.3-flash", "opencode-go-responses/grok-4.6",
  "opencode-go/kimi-k3",
]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS router_turns (task_id TEXT NOT NULL, turn_id TEXT NOT NULL, coordinator_model TEXT NOT NULL, coordinator_reasoning TEXT, PRIMARY KEY (task_id, turn_id));
CREATE TABLE IF NOT EXISTS router_jobs (
 job_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, turn_id TEXT NOT NULL,
 backend TEXT NOT NULL CHECK (backend = 'router'), route TEXT NOT NULL,
 coordinator_model TEXT NOT NULL, coordinator_reasoning TEXT, child_session_id TEXT UNIQUE,
 scope_sha256 TEXT NOT NULL, approved_file_count INTEGER NOT NULL,
 approved_command_count INTEGER NOT NULL, allows_edits INTEGER NOT NULL,
 budget_json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','completed','failed')),
 created_utc TEXT NOT NULL, finished_utc TEXT, accepted INTEGER,
 review_minutes REAL, budget_overrun INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_router_jobs_task ON router_jobs(task_id, turn_id);
CREATE TABLE IF NOT EXISTS router_requests (
 request_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES router_jobs(job_id),
 child_session_id TEXT NOT NULL, kind TEXT NOT NULL, route TEXT NOT NULL,
 provider_request_id TEXT, state TEXT NOT NULL, reserved_input_tokens INTEGER NOT NULL,
 reserved_output_tokens INTEGER NOT NULL, reserved_cost_microusd INTEGER NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, actual_cost_microusd INTEGER,
 error_code TEXT, created_utc TEXT NOT NULL, updated_utc TEXT NOT NULL,
 UNIQUE(route, provider_request_id)
);
CREATE INDEX IF NOT EXISTS idx_router_requests_job ON router_requests(job_id);
CREATE TABLE IF NOT EXISTS router_request_events (event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, event_type TEXT NOT NULL, event_sha256 TEXT NOT NULL, timestamp_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS router_allowance_claims (job_id TEXT PRIMARY KEY REFERENCES router_jobs(job_id), model_id TEXT NOT NULL, timestamp_utc TEXT NOT NULL, normalized_usd REAL NOT NULL, tariff_usd REAL NOT NULL);
CREATE TABLE IF NOT EXISTS router_admissions (job_id TEXT PRIMARY KEY REFERENCES router_jobs(job_id), policy_json TEXT NOT NULL, runtime_sha256 TEXT NOT NULL, created_utc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS router_worker_leases (
 job_id TEXT PRIMARY KEY REFERENCES router_jobs(job_id), capability_sha256 TEXT NOT NULL,
 metadata_sha256 TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('active','expired','finished','failed','accounting_blocked')),
 created_utc TEXT NOT NULL, closed_utc TEXT
);
CREATE TABLE IF NOT EXISTS router_worker_denials (
 denial_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES router_jobs(job_id),
 request_id TEXT NOT NULL, reason TEXT NOT NULL, created_utc TEXT NOT NULL,
 UNIQUE(job_id, request_id, reason)
);
`;

let database;
function db() {
  if (!database) {
    mkdirSync(path.dirname(WORKER_LEDGER_PATH), { recursive: true, mode: 0o700 });
    database = new DatabaseSync(WORKER_LEDGER_PATH);
    database.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    database.exec(SCHEMA);
  }
  return database;
}
function digest(value) { return createHash("sha256").update(String(value), "utf8").digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function immutableDigest(value) { return digest(stableJson(value)); }
function now() { return new Date().toISOString(); }
function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error(`Invalid worker ${label}`);
  return value;
}
function safeInteger(value, label, { min = 0, max = MAX_SAFE } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid worker ${label}`);
  return value;
}
function finite(value, label, { min = 0, max = MAX_SAFE } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid worker ${label}`);
  return value;
}
function transaction(action) {
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try { const result = action(connection); connection.exec("COMMIT"); return result; }
  catch (error) { try { connection.exec("ROLLBACK"); } catch {} throw error; }
}
function normalizeBudget(budget) {
  const maxRequests = safeInteger(Number(budget?.maxRequests ?? budget?.max_requests), "maxRequests", { min: 1, max: 100 });
  const totalCost = safeInteger(Number(budget?.totalCostMicrousd ?? budget?.total_cost_microusd), "totalCostMicrousd", { min: 1 });
  const derivedRequestCost = Math.ceil(totalCost / maxRequests);
  const suppliedRequestCost = budget?.requestCostMicrousd ?? budget?.request_cost_microusd;
  if (suppliedRequestCost != null && safeInteger(Number(suppliedRequestCost), "requestCostMicrousd") !== derivedRequestCost) throw new Error("Worker request cost must match its conservative budget ceiling");
  const normalized = {
    max_requests: maxRequests,
    request_input_tokens: safeInteger(Number(budget?.requestInputTokens ?? budget?.request_input_tokens), "requestInputTokens", { min: 1, max: MAX_REQUEST_INPUT }),
    request_output_tokens: safeInteger(Number(budget?.requestOutputTokens ?? budget?.request_output_tokens), "requestOutputTokens", { min: 1, max: MAX_REQUEST_OUTPUT }),
    total_tokens: safeInteger(Number(budget?.totalTokens ?? budget?.total_tokens), "totalTokens", { min: 1 }),
    total_cost_microusd: totalCost,
    request_cost_microusd: derivedRequestCost,
  };
  if (normalized.total_tokens < normalized.request_input_tokens + normalized.request_output_tokens || normalized.total_cost_microusd < normalized.request_cost_microusd) throw new Error("Invalid worker aggregate budget");
  return normalized;
}
function camelBudget(b) { return { maxRequests: b.max_requests, requestInputTokens: b.request_input_tokens, requestOutputTokens: b.request_output_tokens, totalTokens: b.total_tokens, totalCostMicrousd: b.total_cost_microusd, requestCostMicrousd: b.request_cost_microusd }; }
function ledgerBudget(b) { return { max_requests: b.max_requests, request_input_tokens: b.request_input_tokens, request_output_tokens: b.request_output_tokens, total_tokens: b.total_tokens, total_cost_microusd: b.total_cost_microusd }; }
function parseBudget(row) { try { return normalizeBudget(JSON.parse(row.budget_json)); } catch { throw new Error("Worker budget ledger is corrupt"); } }
function event(connection, requestId, type, payload) {
  const eventId = `${requestId}:${type}`;
  const eventHash = immutableDigest(payload);
  const prior = connection.prepare("SELECT event_sha256 FROM router_request_events WHERE event_id=?").get(eventId);
  if (prior) { if (prior.event_sha256 !== eventHash) throw new Error("Conflicting worker request event"); return false; }
  connection.prepare("INSERT INTO router_request_events VALUES (?,?,?,?,?)").run(eventId, requestId, type, eventHash, now());
  return true;
}
function block(connection, jobId) {
  connection.prepare("UPDATE router_worker_leases SET state='accounting_blocked' WHERE job_id=?").run(jobId);
  connection.prepare("UPDATE router_jobs SET budget_overrun=1 WHERE job_id=? AND state='active'").run(jobId);
}
function leaseRow(connection, jobId) {
  return connection.prepare(`SELECT j.*, l.capability_sha256, l.metadata_sha256, l.expires_at_ms, l.state AS lease_state, l.created_utc AS lease_created_utc, l.closed_utc FROM router_jobs j JOIN router_worker_leases l USING(job_id) WHERE j.job_id=?`).get(jobId);
}
function usageTotals(connection, jobId) {
  const row = connection.prepare(`SELECT COUNT(*) requests,
    COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL THEN input_tokens ELSE reserved_input_tokens END),0) input_tokens,
    COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL THEN output_tokens ELSE reserved_output_tokens END),0) output_tokens,
    COALESCE(SUM(CASE WHEN actual_cost_microusd IS NOT NULL THEN actual_cost_microusd ELSE reserved_cost_microusd END),0) cost_microusd
    FROM router_requests WHERE job_id=?`).get(jobId);
  return { requests: Number(row.requests), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), tokens: Number(row.input_tokens) + Number(row.output_tokens), costMicrousd: Number(row.cost_microusd) };
}
function cleanJob(connection, row) {
  if (!row) return undefined;
  const b = parseBudget(row);
  const attempts = connection.prepare(`SELECT request_id requestId, kind, state status, reserved_input_tokens reservedInputTokens, reserved_output_tokens reservedOutputTokens, reserved_cost_microusd reservedCostMicrousd, input_tokens inputTokens, output_tokens outputTokens, actual_cost_microusd costMicrousd, provider_request_id providerRequestId, error_code errorCode FROM router_requests WHERE job_id=? ORDER BY created_utc, request_id`).all(row.job_id);
  const denials = connection.prepare("SELECT request_id requestId,reason,created_utc createdUtc FROM router_worker_denials WHERE job_id=? ORDER BY created_utc,request_id").all(row.job_id);
  const providerForwardCount = Number(connection.prepare("SELECT count(*) count FROM router_request_events e JOIN router_requests r ON r.request_id=e.request_id WHERE r.job_id=? AND e.event_type='forwarded'").get(row.job_id).count);
  const reserved = { requests: 0, inputTokens: 0, outputTokens: 0, tokens: 0, costMicrousd: 0 };
  const used = { requests: 0, inputTokens: 0, outputTokens: 0, tokens: 0, costMicrousd: 0 };
  for (const item of attempts) {
    if (item.inputTokens != null && item.outputTokens != null) used.requests++; else reserved.requests++;
    if (item.inputTokens != null) { used.inputTokens += Number(item.inputTokens); used.tokens += Number(item.inputTokens); }
    else { reserved.inputTokens += Number(item.reservedInputTokens); reserved.tokens += Number(item.reservedInputTokens); }
    if (item.outputTokens != null) { used.outputTokens += Number(item.outputTokens); used.tokens += Number(item.outputTokens); }
    else { reserved.outputTokens += Number(item.reservedOutputTokens); reserved.tokens += Number(item.reservedOutputTokens); }
    if (item.costMicrousd != null) used.costMicrousd += Number(item.costMicrousd); else reserved.costMicrousd += Number(item.reservedCostMicrousd);
  }
  return { jobId: row.job_id, route: row.route, expiresAt: Number(row.expires_at_ms), state: row.lease_state, budget: camelBudget(b), reserved, used, attempts, denials,
    requestCount: attempts.length, providerForwardCount, budgetDeniedRequests: denials.filter((item) => item.reason === "job_budget_exhausted").length,
    childSessionId: row.child_session_id,
    metadata: { taskId: row.task_id, turnId: row.turn_id, coordinatorModel: row.coordinator_model, coordinatorReasoning: row.coordinator_reasoning, scopeSha256: row.scope_sha256 },
    outcome: { state: row.state, accepted: row.accepted == null ? null : Boolean(row.accepted), reviewMinutes: row.review_minutes } };
}
function validateAllowance(connection, allowance) {
  const modelId = identifier(allowance?.model_id ?? allowance?.modelId, "allowance model id");
  const normalizedUsd = finite(Number(allowance?.normalized_usd ?? allowance?.normalizedUsd), "normalized allowance");
  const tariffUsd = finite(Number(allowance?.tariff_usd ?? allowance?.tariffUsd), "tariff allowance");
  const monthly = finite(Number(allowance?.monthly_allowance_usd ?? allowance?.monthlyAllowanceUsd), "monthly allowance", { min: Number.EPSILON });
  const threshold = finite(Number(allowance?.safety_threshold ?? allowance?.safetyThreshold), "safety threshold", { min: Number.EPSILON, max: 1 });
  for (const [hours, globalLimit, fraction] of [[5, 12, .20], [168, 30, .50], [744, 60, 1]]) {
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    let globalUsed = 0; let modelUsed = 0;
    for (const table of ["claims", "router_allowance_claims"]) {
      if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns = connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (!columns.includes("timestamp_utc") || !columns.includes("normalized_usd")) throw new Error("Accounting history is unverifiable");
      globalUsed += Number(connection.prepare(`SELECT COALESCE(SUM(normalized_usd),0) value FROM ${table} WHERE timestamp_utc>=?`).get(since).value);
      if (columns.includes("model_id") && columns.includes("tariff_usd")) modelUsed += Number(connection.prepare(`SELECT COALESCE(SUM(tariff_usd),0) value FROM ${table} WHERE model_id=? AND timestamp_utc>=?`).get(modelId, since).value);
    }
    if (!Number.isFinite(globalUsed) || !Number.isFinite(modelUsed)) throw new Error("Accounting history is unverifiable");
  }
  return { modelId, normalizedUsd, tariffUsd };
}

function reconcileClosedAllowanceClaims(connection) {
  const rows = connection.prepare(`SELECT c.job_id,c.normalized_usd,c.tariff_usd
    FROM router_allowance_claims c JOIN router_jobs j USING(job_id)
    WHERE j.state<>'active'`).all();
  const totals = connection.prepare(`SELECT COALESCE(SUM(
    CASE WHEN actual_cost_microusd IS NOT NULL THEN actual_cost_microusd
         ELSE reserved_cost_microusd END),0) charged_cost_microusd
    FROM router_requests WHERE job_id=?`);
  const update = connection.prepare("UPDATE router_allowance_claims SET normalized_usd=?,tariff_usd=? WHERE job_id=?");
  for (const row of rows) {
    const reservedNormalized = finite(Number(row.normalized_usd), "normalized allowance history");
    const reservedTariff = finite(Number(row.tariff_usd), "tariff allowance history");
    if (reservedTariff === 0) {
      if (reservedNormalized !== 0) throw new Error("Invalid worker normalized allowance history");
      continue;
    }
    const chargedMicrousd = safeInteger(Number(totals.get(row.job_id).charged_cost_microusd), "charged worker cost");
    const chargedTariff = chargedMicrousd / 1_000_000;
    const chargedNormalized = chargedTariff * reservedNormalized / reservedTariff;
    update.run(chargedNormalized, chargedTariff, row.job_id);
  }
}

export function createWorkerLease({ jobId, route, budget, metadata = {}, ttlMs = 10 * 60 * 1000, policy, runtimeSha256, allowance, approvedFileCount, approvedCommandCount, allowsEdits }) {
  identifier(jobId, "job id");
  if (typeof route !== "string" || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(route)) throw new Error("Invalid exact worker route");
  const ttl = safeInteger(Number(ttlMs), "ttl", { min: 1000, max: MAX_TTL_MS });
  const b = normalizeBudget(budget);
  const m = { taskId: identifier(metadata.taskId, "task id"), turnId: identifier(metadata.turnId, "turn id"), coordinatorModel: identifier(metadata.coordinatorModel, "coordinator model"), coordinatorReasoning: metadata.coordinatorReasoning == null ? null : identifier(metadata.coordinatorReasoning, "coordinator reasoning"), scopeSha256: String(metadata.scopeSha256 || "") };
  if (!/^[a-f0-9]{64}$/.test(m.scopeSha256) || !/^[a-f0-9]{64}$/.test(runtimeSha256 || "")) throw new Error("Invalid worker scope or runtime digest");
  const files = safeInteger(Number(approvedFileCount), "approved file count");
  const commands = safeInteger(Number(approvedCommandCount), "approved command count");
  if (typeof allowsEdits !== "boolean" || !policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("Invalid worker admission policy");
  const capability = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ttl;
  const metadataHash = immutableDigest({ jobId, route, budget: b, metadata: m, ttlMs: ttl, policy, runtimeSha256, approvedFileCount: files, approvedCommandCount: commands, allowsEdits });
  transaction((connection) => {
    const settings = Object.fromEntries(connection.prepare("SELECT key,value FROM settings WHERE key IN ('mode','execution_backend')").all().map((row) => [row.key, row.value]));
    const certification = policy.purpose === "certification";
    if (certification) {
      if (settings.mode !== "adaptive" || settings.execution_backend !== "direct" || !CERTIFICATION_ROUTES.has(route)) throw new Error("Worker certification state is not valid");
    } else if (!["adaptive", "auto"].includes(settings.mode) || settings.execution_backend !== "router") {
      throw new Error("Router worker execution is not active");
    }
    if (connection.prepare("SELECT count(*) count FROM router_jobs WHERE state='active'").get().count >= 2) throw new Error("At most two active workers are allowed");
    for (const table of ["claims", "events"]) {
      if (!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns = connection.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      if (columns.includes("job_id") && connection.prepare(`SELECT 1 FROM ${table} WHERE job_id=? LIMIT 1`).get(jobId)) throw new Error("Worker job id was used by the legacy backend");
    }
    const priorTurn = connection.prepare("SELECT coordinator_model,coordinator_reasoning FROM router_turns WHERE task_id=? AND turn_id=?").get(m.taskId, m.turnId);
    if (priorTurn && (priorTurn.coordinator_model !== m.coordinatorModel || priorTurn.coordinator_reasoning !== m.coordinatorReasoning)) throw new Error("Coordinator identity is locked for the turn");
    if (connection.prepare("SELECT 1 FROM router_jobs WHERE job_id=?").get(jobId)) throw new Error("Worker job already exists; its capability cannot be reissued");
    reconcileClosedAllowanceClaims(connection);
    const claim = validateAllowance(connection, allowance);
    const created = now();
    connection.prepare("INSERT OR IGNORE INTO router_turns VALUES (?,?,?,?)").run(m.taskId, m.turnId, m.coordinatorModel, m.coordinatorReasoning);
    connection.prepare(`INSERT INTO router_jobs (job_id,task_id,turn_id,backend,route,coordinator_model,coordinator_reasoning,scope_sha256,approved_file_count,approved_command_count,allows_edits,budget_json,state,created_utc) VALUES (?,?,?,'router',?,?,?,?,?,?,?,?,'active',?)`).run(jobId, m.taskId, m.turnId, route, m.coordinatorModel, m.coordinatorReasoning, m.scopeSha256, files, commands, allowsEdits ? 1 : 0, stableJson(ledgerBudget(b)), created);
    connection.prepare("INSERT INTO router_allowance_claims VALUES (?,?,?,?,?)").run(jobId, claim.modelId, created, claim.normalizedUsd, claim.tariffUsd);
    connection.prepare("INSERT INTO router_admissions VALUES (?,?,?,?)").run(jobId, stableJson(policy), runtimeSha256, created);
    connection.prepare("INSERT INTO router_worker_leases VALUES (?,?,?,?, 'active',?,NULL)").run(jobId, digest(capability), metadataHash, expiresAt, created);
  });
  return { capability, jobId, route, expiresAt, budget: camelBudget(b) };
}

export function bindWorkerLease({ jobId, childSessionId }) {
  identifier(childSessionId, "child session id");
  return transaction((connection) => {
    const row = leaseRow(connection, jobId);
    if (!row || row.lease_state !== "active" || row.state !== "active") throw new Error("Worker job is not active");
    if (row.child_session_id && row.child_session_id !== childSessionId) throw new Error("Worker child identity cannot be replaced");
    if (connection.prepare("SELECT 1 FROM router_jobs WHERE child_session_id=? AND job_id<>?").get(childSessionId, jobId)) throw new Error("Worker child identity is already bound");
    connection.prepare("UPDATE router_jobs SET child_session_id=? WHERE job_id=?").run(childSessionId, jobId);
    return cleanJob(connection, leaseRow(connection, jobId));
  });
}
export function authorizeWorkerCapability(capability, jobId, route) {
  if (typeof capability !== "string" || capability.length < 40 || capability.length > 128) return { ok: false, reason: "invalid_capability" };
  return transaction((connection) => {
    const row = leaseRow(connection, jobId);
    if (!row) return { ok: false, reason: "unknown_job" };
    if (row.lease_state !== "active" || row.state !== "active") return { ok: false, reason: "job_not_active" };
    if (Date.now() >= Number(row.expires_at_ms)) { connection.prepare("UPDATE router_worker_leases SET state='expired' WHERE job_id=?").run(jobId); return { ok: false, reason: "capability_expired" }; }
    if (row.route !== route) return { ok: false, reason: "route_mismatch" };
    return digest(capability) === row.capability_sha256 ? { ok: true, job: cleanJob(connection, row) } : { ok: false, reason: "invalid_capability" };
  });
}
export function reserveWorkerAttempt({ capability, jobId, route, requestId, kind }) {
  if (!["initial", "followup", "retry", "compaction"].includes(kind)) return { ok: false, reason: "invalid_attempt_kind" };
  try { identifier(requestId, "request id"); } catch { return { ok: false, reason: "invalid_request_id" }; }
  return transaction((connection) => {
    const row = leaseRow(connection, jobId);
    if (!row || row.lease_state !== "active" || row.state !== "active") return { ok: false, reason: row ? "job_not_active" : "unknown_job" };
    if (Date.now() >= Number(row.expires_at_ms)) { connection.prepare("UPDATE router_worker_leases SET state='expired' WHERE job_id=?").run(jobId); return { ok: false, reason: "capability_expired" }; }
    if (row.route !== route || digest(capability) !== row.capability_sha256) return { ok: false, reason: "capability_or_route_mismatch" };
    if (!row.child_session_id) return { ok: false, reason: "child_not_bound" };
    const b = parseBudget(row);
    const immutable = immutableDigest({ requestId, kind, route, input: b.request_input_tokens, output: b.request_output_tokens, cost: b.request_cost_microusd });
    const prior = connection.prepare("SELECT * FROM router_requests WHERE request_id=?").get(requestId);
    if (prior) {
      const priorHash = immutableDigest({ requestId: prior.request_id, kind: prior.kind, route: prior.route, input: prior.reserved_input_tokens, output: prior.reserved_output_tokens, cost: prior.reserved_cost_microusd });
      if (prior.job_id !== jobId || priorHash !== immutable) { block(connection, jobId); return { ok: false, reason: "conflicting_duplicate_request" }; }
      return { ok: true, duplicate: true, reservation: { inputTokens: prior.reserved_input_tokens, outputTokens: prior.reserved_output_tokens, costMicrousd: prior.reserved_cost_microusd } };
    }
    const totals = usageTotals(connection, jobId);
    const requestTokens = b.request_input_tokens + b.request_output_tokens;
    if (totals.requests + 1 > b.max_requests || totals.tokens + requestTokens > b.total_tokens || totals.costMicrousd + b.request_cost_microusd > b.total_cost_microusd) {
      connection.prepare("INSERT OR IGNORE INTO router_worker_denials VALUES (?,?,?,?,?)").run(`${requestId}:budget`, jobId, requestId, "job_budget_exhausted", now());
      return { ok: false, reason: "job_budget_exhausted" };
    }
    const timestamp = now();
    connection.prepare(`INSERT INTO router_requests (request_id,job_id,child_session_id,kind,route,state,reserved_input_tokens,reserved_output_tokens,reserved_cost_microusd,created_utc,updated_utc) VALUES (?,?,?,?,?,'reserved',?,?,?,?,?)`).run(requestId, jobId, row.child_session_id, kind, route, b.request_input_tokens, b.request_output_tokens, b.request_cost_microusd, timestamp, timestamp);
    return { ok: true, duplicate: false, reservation: { inputTokens: b.request_input_tokens, outputTokens: b.request_output_tokens, costMicrousd: b.request_cost_microusd }, remaining: { requests: b.max_requests - totals.requests - 1, tokens: b.total_tokens - totals.tokens - requestTokens, costMicrousd: b.total_cost_microusd - totals.costMicrousd - b.request_cost_microusd } };
  });
}
export function markWorkerAttemptForwarded({ jobId, requestId, providerRequestId = null }) {
  let deferredError;
  const result = transaction((connection) => {
    const row = connection.prepare("SELECT * FROM router_requests WHERE job_id=? AND request_id=?").get(jobId, requestId);
    if (!row) throw new Error("Unknown worker request");
    const payload = { requestId, state: "forwarded", providerRequestId };
    if (row.state === "forwarded") {
      if (row.provider_request_id !== providerRequestId) { block(connection, jobId); deferredError = new Error("Conflicting worker provider request identity"); return; }
      event(connection, requestId, "forwarded", payload); return;
    }
    if (row.state !== "reserved") { block(connection, jobId); throw new Error("Invalid worker request transition"); }
    connection.prepare("UPDATE router_requests SET state='forwarded',provider_request_id=?,updated_utc=? WHERE request_id=?").run(providerRequestId, now(), requestId);
    event(connection, requestId, "forwarded", payload);
  });
  if (deferredError) throw deferredError;
  return result;
}
export function settleWorkerAttempt({ jobId, requestId, status, usage = undefined, errorCode = null }) {
  let deferredError;
  const result = transaction((connection) => {
    const row = connection.prepare("SELECT * FROM router_requests WHERE job_id=? AND request_id=?").get(jobId, requestId);
    if (!row) return;
    const terminal = status === "completed" ? "completed" : status === "failed" ? "failed" : "ambiguous";
    let input = null; let output = null; let cost = null;
    if (usage != null) {
      input = usage.inputTokens == null ? null : safeInteger(Number(usage.inputTokens), "actual input tokens");
      output = usage.outputTokens == null ? null : safeInteger(Number(usage.outputTokens), "actual output tokens");
      cost = usage.costMicrousd == null ? null : safeInteger(Number(usage.costMicrousd), "actual cost");
      if ((input != null && input > row.reserved_input_tokens) || (output != null && output > row.reserved_output_tokens) || (cost != null && cost > row.reserved_cost_microusd)) {
        block(connection, jobId); deferredError = new Error("Worker usage exceeded its reservation"); return;
      }
    }
    const payload = { requestId, state: terminal, inputTokens: input, outputTokens: output, costMicrousd: cost, errorCode };
    if (["completed", "failed", "ambiguous"].includes(row.state)) {
      if (row.state !== terminal || row.input_tokens !== input || row.output_tokens !== output || row.actual_cost_microusd !== cost || row.error_code !== errorCode) {
        block(connection, jobId); deferredError = new Error("Conflicting worker settlement event"); return;
      }
      event(connection, requestId, terminal, payload); return;
    }
    if (!["reserved", "forwarded"].includes(row.state)) { block(connection, jobId); throw new Error("Invalid worker request transition"); }
    connection.prepare("UPDATE router_requests SET state=?,input_tokens=?,output_tokens=?,actual_cost_microusd=?,error_code=?,updated_utc=? WHERE request_id=?").run(terminal, input, output, cost, errorCode, now(), requestId);
    event(connection, requestId, terminal, payload);
  });
  if (deferredError) throw deferredError;
  return result;
}
export function fillCertificationBudget({ capability, jobId, route }) {
  identifier(jobId, "job id");
  const connection = db();
  const admission = connection.prepare("SELECT policy_json FROM router_admissions WHERE job_id=?").get(jobId);
  let policy;
  try { policy = admission ? JSON.parse(admission.policy_json) : null; } catch { policy = null; }
  if (!policy || policy.purpose !== "certification") throw new Error("Budget fill is certification-only");
  let status = workerLeaseStatus(jobId);
  if (status.state !== "active" || status.route !== route) throw new Error("Certification worker is not active");
  for (let index = status.requestCount; index < status.budget.maxRequests; index++) {
    const requestId = `${jobId}:budget-fill:${index}`;
    const reservation = reserveWorkerAttempt({ capability, jobId, route, requestId, kind: "retry" });
    if (!reservation.ok) throw new Error(`Certification budget fill failed: ${reservation.reason}`);
    settleWorkerAttempt({ jobId, requestId, status: "completed",
      usage: { inputTokens: 0, outputTokens: 0, costMicrousd: 0 } });
  }
  status = workerLeaseStatus(jobId);
  if (status.requestCount !== status.budget.maxRequests) throw new Error("Certification budget was not exhausted");
  return status;
}

export function closeWorkerLease({ jobId, outcome = "finished", accepted = null, reviewMinutes = null }) {
  return transaction((connection) => {
    const row = leaseRow(connection, jobId);
    if (!row) return;
    const jobState = outcome === "finished" || outcome === "completed" ? "completed" : "failed";
    const leaseState = jobState === "completed" ? "finished" : "failed";
    const acceptedValue = accepted == null ? null : accepted === true ? 1 : accepted === false ? 0 : (() => { throw new Error("Invalid worker acceptance outcome"); })();
    const review = reviewMinutes == null ? null : finite(Number(reviewMinutes), "review minutes");
    if (row.state !== "active" || ["finished", "failed"].includes(row.lease_state)) {
      if (row.state === jobState && row.lease_state === leaseState && row.accepted === acceptedValue && row.review_minutes === review) return;
      throw new Error("Conflicting worker finish outcome");
    }
    if (connection.prepare("SELECT 1 FROM router_requests WHERE job_id=? AND state IN ('reserved','forwarded') LIMIT 1").get(jobId)) throw new Error("Cannot close a worker lease with pending attempts");
    if (jobState === "completed" && row.lease_state !== "active") throw new Error("A blocked or expired worker cannot be accepted");
    const timestamp = now();
    connection.prepare("UPDATE router_jobs SET state=?,finished_utc=?,accepted=?,review_minutes=? WHERE job_id=? AND state='active'").run(jobState, timestamp, acceptedValue, review, jobId);
    connection.prepare("UPDATE router_worker_leases SET state=?,closed_utc=? WHERE job_id=? AND state NOT IN ('finished','failed')").run(leaseState, timestamp, jobId);
    reconcileClosedAllowanceClaims(connection);
  });
}
export function workerLeaseStatus(jobId) {
  const connection = db();
  if (jobId) return cleanJob(connection, leaseRow(connection, jobId)) || { jobId, state: "unknown", attempts: [], reserved: {}, used: {}, budget: {} };
  return connection.prepare("SELECT job_id FROM router_worker_leases ORDER BY created_utc").all().map((row) => cleanJob(connection, leaseRow(connection, row.job_id)));
}
