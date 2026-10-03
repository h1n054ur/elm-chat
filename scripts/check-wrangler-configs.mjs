import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const rootConfigPath = resolve("wrangler.jsonc");
const workspaceConfigPath = resolve("workers/api/wrangler.jsonc");

function readJsonc(path) {
  const source = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(source);
}

function normalize(config, path) {
  const normalized = structuredClone(config);
  delete normalized.$schema;
  normalized.main = resolve(dirname(path), normalized.main);
  normalized.assets.directory = resolve(dirname(path), normalized.assets.directory);
  return normalized;
}

assert.deepEqual(
  normalize(readJsonc(rootConfigPath), rootConfigPath),
  normalize(readJsonc(workspaceConfigPath), workspaceConfigPath),
  "Root and workspace Wrangler configurations have drifted"
);

console.log("Wrangler runtime configurations match.");
