import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";
import { providerCooldown } from "./model-failover.mjs";

export const ROUTING_PROFILES_PATH =
  process.env.CODEX_ROUTER_ROUTING_PROFILES || path.join(STATE_DIR, "routing-profiles.json");
export const PROFILE_DECISIONS_DIR =
  process.env.CODEX_ROUTER_PROFILE_DECISIONS || path.join(STATE_DIR, "profile-decisions");

export const PROFILE_SLUGS = Object.freeze([
  "opencode-go-profile/auto",
  "opencode-go-profile/workhorse",
  "opencode-go-profile/advanced",
  "opencode-go-profile/premium",
]);

const CLASS_ORDER = Object.freeze(["workhorse", "advanced", "premium"]);
const PROFILE_NAMES = Object.freeze({
  "opencode-go-profile/auto": "OpenCode Auto",
  "opencode-go-profile/workhorse": "OpenCode Workhorse",
  "opencode-go-profile/advanced": "OpenCode Advanced",
  "opencode-go-profile/premium": "OpenCode Premium",
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function readRoutingProfiles() {
  if (!existsSync(ROUTING_PROFILES_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(ROUTING_PROFILES_PATH, "utf8"));
    if (parsed?.version !== 1 || !object(parsed.profiles) || !object(parsed.tasks)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function isOpenCodeProfileSlug(slug) {
  return PROFILE_SLUGS.includes(String(slug || ""));
}

function profileFloor(slug, policy) {
  const configured = policy?.profiles?.[slug]?.floor;
  if (CLASS_ORDER.includes(configured)) return configured;
  return slug.endsWith("/premium") ? "premium" : slug.endsWith("/advanced") ? "advanced" : "workhorse";
}

function safeId(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(text) ? text : undefined;
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
}

function turnIdentity(headers) {
  const sessionId = safeId(header(headers, "session-id") || header(headers, "session_id"));
  let turnId;
  try {
    turnId = safeId(JSON.parse(header(headers, "x-codex-turn-metadata") || "{}").turn_id);
  } catch {
    turnId = undefined;
  }
  return { sessionId, turnId };
}

function decisionFor(headers, policy) {
  const { sessionId, turnId } = turnIdentity(headers);
  if (!sessionId || !turnId) return undefined;
  const decisionPath = path.join(PROFILE_DECISIONS_DIR, `${sessionId}--${turnId}.json`);
  try {
    const value = JSON.parse(readFileSync(decisionPath, "utf8"));
    const created = Date.parse(value?.created_at_utc);
    if (
      value?.version !== 1 || value.session_id !== sessionId || value.turn_id !== turnId ||
      !CLASS_ORDER.includes(value.required_class) ||
      !Number.isFinite(created) || Date.now() - created > 30 * 60_000 ||
      (policy?.fingerprint && value.policy_fingerprint !== policy.fingerprint)
    ) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function textFromPayload(payload) {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const last = [...input].reverse().find((item) => item?.role === "user") || input.at(-1);
  const content = last?.content;
  if (typeof content === "string") return content.slice(0, 20_000);
  if (!Array.isArray(content)) return "";
  return content.map((item) => item?.text || item?.input_text || "").join(" ").slice(0, 20_000);
}

function inferFallback(payload) {
  const text = textFromPayload(payload).toLowerCase();
  const high = /\b(security|production|migration|irreversible|architecture|high[- ]risk|credential|auth)\b/.test(text);
  const moderate = /\b(review|integration|refactor|multi[- ]file|debug|investigate|moderate|pull request|\bpr\b)\b/.test(text);
  const lane = high ? "high" : moderate ? "moderate" : "low";
  const stage = /\b(review|audit)\b/.test(text) ? "review"
    : /\b(fix|repair|bug|debug)\b/.test(text) ? "fix"
      : /\b(plan|design|architect)\b/.test(text) ? "plan"
        : /\b(research|search|investigate)\b/.test(text) ? "research"
          : /\b(document|report|write)\b/.test(text) ? "documents"
            : /\b(data|scrap|extract|csv|dataset)\b/.test(text) ? "data"
              : "build";
  return { stage, lane, required_class: lane === "high" ? "premium" : lane === "moderate" ? "advanced" : "workhorse" };
}

function modelId(model) {
  const slug = String(model?.slug || "");
  return slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
}

function goModels(models) {
  return (Array.isArray(models) ? models : []).filter(
    (model) => canonicalProviderId(model?.provider) === "opencode-go" && !isOpenCodeProfileSlug(model?.slug),
  );
}

export function profileCatalogModels(models) {
  const policy = readRoutingProfiles();
  const available = goModels(models);
  if (!policy || !available.length) return [];
  const template = available.find((model) => modelId(model) === "gpt-5.6-luna") || available[0];
  return PROFILE_SLUGS.map((slug, index) => ({
    ...template,
    slug,
    displayName: policy.profiles?.[slug]?.name || PROFILE_NAMES[slug],
    listed: true,
    priority: Number(template.priority || 100) - 10 + index,
    behaviorTemplate: policy.profiles?.[slug]?.behavior_template || "gpt-5.6-luna",
    // Profiles can resolve to models with different tool envelopes. Advertise
    // the conservative contract; exact routed models retain their own v2
    // capability when addressed by a broker worker.
    multiAgentVersion: "v1",
  }));
}

function strongerClasses(required) {
  const index = Math.max(0, CLASS_ORDER.indexOf(required));
  return CLASS_ORDER.slice(index);
}

export function resolveOpenCodeProfile(slug, { headers, payload, models } = {}) {
  const policy = readRoutingProfiles();
  if (!policy || !isOpenCodeProfileSlug(slug)) return undefined;
  const decision = decisionFor(headers, policy) || inferFallback(payload);
  const floor = profileFloor(slug, policy);
  const requiredClass = CLASS_ORDER[Math.max(
    CLASS_ORDER.indexOf(floor),
    CLASS_ORDER.indexOf(decision.required_class),
  )];
  const task = policy.tasks[decision.stage] || policy.tasks.build || {};
  const ids = strongerClasses(requiredClass).flatMap((qualityClass) => task[qualityClass] || []);
  const byId = new Map(goModels(models).map((model) => [modelId(model), model]));
  const candidates = [...new Set(ids)]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .filter((model) => !providerCooldown(model.provider, { modelSlug: model.slug }));
  return {
    profile: slug,
    stage: decision.stage,
    lane: decision.lane,
    requiredClass,
    route: candidates[0],
    chain: candidates.map((model) => model.slug),
    nativeClass: requiredClass,
    decisionSource: decision.version === 1 ? "hook" : "router",
  };
}
