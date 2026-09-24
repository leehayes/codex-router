import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "opencode-profiles-"));
process.env.CODEX_ROUTER_STATE_DIR = root;
process.env.CODEX_ROUTER_ROUTING_PROFILES = path.join(root, "routing-profiles.json");
process.env.CODEX_ROUTER_PROFILE_DECISIONS = path.join(root, "profile-decisions");

const {
  PROFILE_SLUGS,
  profileCatalogModels,
  resolveOpenCodeProfile,
} = await import("../src/opencode-profiles.mjs");

const policy = {
  version: 1,
  fingerprint: "policy-one",
  profiles: Object.fromEntries(PROFILE_SLUGS.map((slug) => [slug, {
    name: slug.split("/").at(-1),
    floor: slug.endsWith("/premium") ? "premium" : slug.endsWith("/advanced") ? "advanced" : "workhorse",
  }])),
  tasks: {
    build: {
      workhorse: ["deepseek-v4.1-flash", "gpt-5.6-luna"],
      advanced: ["deepseek-v4-pro"],
      premium: ["grok-4.6", "kimi-k3"],
    },
  },
};
writeFileSync(process.env.CODEX_ROUTER_ROUTING_PROFILES, JSON.stringify(policy));

const models = [
  { slug: "opencode-go/deepseek-v4.1-flash", provider: "opencode-go", displayName: "DS", listed: true },
  { slug: "opencode-go-responses/gpt-5.6-luna", provider: "opencode-go-responses", displayName: "Luna", listed: true },
  { slug: "opencode-go/deepseek-v4-pro", provider: "opencode-go", displayName: "DSP", listed: true },
  { slug: "opencode-go-responses/grok-4.6", provider: "opencode-go-responses", displayName: "Grok", listed: true },
  { slug: "opencode-go/kimi-k3", provider: "opencode-go", displayName: "Kimi", listed: true },
];

test.after(() => rmSync(root, { recursive: true, force: true }));

test("profile catalog exposes four virtual entries", () => {
  assert.deepEqual(profileCatalogModels(models).map((model) => model.slug), PROFILE_SLUGS);
});

test("hook decision raises Auto to the classified class and keeps a class chain", () => {
  mkdirSync(process.env.CODEX_ROUTER_PROFILE_DECISIONS, { recursive: true });
  writeFileSync(path.join(process.env.CODEX_ROUTER_PROFILE_DECISIONS, "session-1--turn-1.json"), JSON.stringify({
    version: 1,
    session_id: "session-1",
    turn_id: "turn-1",
    stage: "build",
    lane: "moderate",
    required_class: "advanced",
    policy_fingerprint: "policy-one",
    created_at_utc: new Date().toISOString(),
  }));
  const resolved = resolveOpenCodeProfile("opencode-go-profile/auto", {
    headers: {
      "session-id": "session-1",
      "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn-1" }),
    },
    payload: { input: [] },
    models,
  });
  assert.equal(resolved.requiredClass, "advanced");
  assert.equal(resolved.route.slug, "opencode-go/deepseek-v4-pro");
  assert.deepEqual(resolved.chain, [
    "opencode-go/deepseek-v4-pro",
    "opencode-go-responses/grok-4.6",
    "opencode-go/kimi-k3",
  ]);
});

test("Premium is a floor even for a simple task", () => {
  const resolved = resolveOpenCodeProfile("opencode-go-profile/premium", {
    headers: {},
    payload: { input: [{ role: "user", content: "rename a local variable" }] },
    models,
  });
  assert.equal(resolved.requiredClass, "premium");
  assert.equal(resolved.route.slug, "opencode-go-responses/grok-4.6");
});
