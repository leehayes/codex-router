import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STATE_DIR } from "./paths.mjs";

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function buildWorkerRuntimeManifest({
  stateDir = STATE_DIR,
  launcherPath = path.join(os.homedir(), ".codex", "skills", "opencode-go-harness", "scripts", "isolation_launcher.py"),
  codexBinary = process.env.CODEX_CLI_PATH,
} = {}) {
  const releaseBytes = readFileSync(path.join(stateDir, "router-release-manifest.json"));
  const release = JSON.parse(releaseBytes.toString("utf8"));
  if (!/^[a-f0-9]{64}$/.test(release.sourceHash || "")) throw new Error("Router release manifest has no valid source identity");
  const launcherBytes = readFileSync(launcherPath);
  const versionMatch = launcherBytes.toString("utf8").match(/^APP_SERVER_CLIENT_VERSION\s*=\s*"([^"\r\n]+)"/m);
  if (!versionMatch) throw new Error("Isolation launcher version is unavailable");
  if (!codexBinary && process.platform === "win32") {
    codexBinary = execFileSync("where.exe", ["codex"], { encoding: "utf8" }).split(/\r?\n/).find(Boolean);
  }
  codexBinary ||= "codex";
  const output = execFileSync(codexBinary, ["--version"], { encoding: "utf8" }).trim();
  const buildMatch = output.match(/^(?:codex(?:-cli)?\s+)?([0-9][A-Za-z0-9.+_-]*)$/);
  if (!buildMatch) throw new Error("Installed Codex build is unverifiable");
  return {
    version: 1,
    router_source_hash: release.sourceHash,
    release_manifest_sha256: sha256(releaseBytes),
    codex_build: buildMatch[1],
    launcher_version: versionMatch[1],
    launcher_sha256: sha256(launcherBytes),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const runtime = buildWorkerRuntimeManifest();
  writeFileSync(path.join(STATE_DIR, "worker-runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${runtime.router_source_hash}\n`);
}
