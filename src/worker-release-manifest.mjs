import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT, STATE_DIR } from "./paths.mjs";

const EXCLUDED_TOP_LEVEL = new Set([".git", ".venv", "node_modules", "playwright-report", "test-results"]);

function filesBelow(root, relative = "") {
  const entries = readdirSync(path.join(root, relative), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Release manifest refuses symlink: ${child}`);
    if (entry.isDirectory()) result.push(...filesBelow(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildWorkerReleaseManifest(root = SOURCE_ROOT) {
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const files = filesBelow(root).sort().map((relative) => {
    const absolute = path.join(root, ...relative.split("/"));
    const stats = statSync(absolute);
    return { path: relative, bytes: stats.size, sha256: sha256(readFileSync(absolute)) };
  });
  const canonical = JSON.stringify({ version: 1, baseCommit, packageVersion, files });
  return { version: 1, baseCommit, packageVersion, sourceHash: sha256(canonical), files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const manifest = buildWorkerReleaseManifest();
  const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(STATE_DIR, "router-release-manifest.json");
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(path.dirname(output), "router-source-hash"), `${manifest.sourceHash}\n`, { mode: 0o600 });
  process.stdout.write(`${manifest.sourceHash}\n`);
}
