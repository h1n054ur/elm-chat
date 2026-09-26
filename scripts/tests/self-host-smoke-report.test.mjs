import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("../self-host-smoke-report.mjs", import.meta.url));
function run(args, cwd = root) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

test("defaults label a manual deployment without an origin", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deployment path: manual/);
  assert.match(result.stdout, /Public origin: \[not supplied\]/);
  assert.match(result.stdout, /Tester opted to publish origin: no/);
});

for (const args of [["--path", "deploy-button"], ["--path=deploy-button"]]) {
  test(`documented deployment path: ${args.join(" ")}`, () => {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Deployment path: deploy-button/);
  });
}

for (const optIn of [[], ["--public-origin", "false"], ["--public-origin=false"]]) {
  test(`origin remains redacted: ${optIn.join(" ") || "default"}`, () => {
    const result = run(["--origin", "https://example.workers.dev", ...optIn]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Public origin: \[redacted workers.dev origin\]/);
    assert.doesNotMatch(result.stdout, /https:\/\/example.workers.dev/);
  });
}

for (const optIn of [["--public-origin"], ["--public-origin", "true"], ["--public-origin=true"]]) {
  test(`explicit origin publication: ${optIn.join(" ")}`, () => {
    const result = run(["--origin=https://example.workers.dev", ...optIn]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Public origin: https:\/\/example.workers.dev/);
    assert.match(result.stdout, /Tester opted to publish origin: yes/);
  });
}

for (const [args, message] of [
  [["--paht", "deploy-button"], /Unknown option/],
  [["deploy-button"], /Unexpected positional argument/],
  [["--path"], /--path requires a value/],
  [["--origin", "--path", "manual"], /--origin requires a value/],
  [["--origin="], /--origin requires a value/],
  [["--path="], /--path requires a value/],
  [["--path", "other"], /--path must be manual or deploy-button/],
  [["--public-origin", "yes"], /--public-origin must be true or false/],
  [["--public-origin="], /--public-origin requires a value/],
  [["--path", "manual", "--path=deploy-button"], /Duplicate --path/],
  [["--public-origin=false", "--public-origin"], /Duplicate --public-origin/],
  [["--help=true"], /--help does not take a value/],
]) {
  test(`invalid options do not produce a report: ${args.join(" ")}`, () => {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    assert.match(result.stderr, /--help/);
  });
}

test("help works outside a repository without running preflight", () => {
  const result = run(["--help"], "/tmp");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--path/);
  assert.doesNotMatch(result.stdout, /Commit SHA/);
});
