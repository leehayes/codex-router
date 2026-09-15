import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildWorkerReleaseManifest } from "../src/worker-release-manifest.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "worker-release-manifest-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.5.1+test" }));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "tracked.mjs"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

test("release manifest includes tracked and untracked source bytes", () => {
  const root = fixture();
  const first = buildWorkerReleaseManifest(root);
  writeFileSync(path.join(root, "src", "untracked.mjs"), "export const extra = 2;\n");
  const second = buildWorkerReleaseManifest(root);
  assert.notEqual(first.sourceHash, second.sourceHash);
  assert.ok(second.files.some((entry) => entry.path === "src/untracked.mjs"));
});

test("release manifest excludes dependency and VCS directories", () => {
  const root = fixture();
  mkdirSync(path.join(root, "node_modules", "ignored"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "ignored", "value"), "ignored");
  const manifest = buildWorkerReleaseManifest(root);
  assert.equal(manifest.files.some((entry) => entry.path.startsWith("node_modules/")), false);
  assert.equal(manifest.files.some((entry) => entry.path.startsWith(".git/")), false);
});
