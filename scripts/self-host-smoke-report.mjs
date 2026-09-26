import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const usage = `Usage: npm run self-host:smoke-report -- [options]

  --path manual|deploy-button  Deployment path (default: manual)
  --origin URL                 Optional deployment origin (redacted by default)
  --public-origin [true|false] Publish the supplied origin (default: false)
  --help                      Show this help

Options accept either --name value or --name=value.
`;

function parseArgs(argv) {
  const args = new Map();
  const allowed = new Set(["path", "origin", "public-origin", "help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error("Unexpected positional argument");
    const separator = arg.indexOf("=");
    const key = arg.slice(2, separator === -1 ? undefined : separator);
    if (!allowed.has(key)) throw new Error("Unknown option; see --help for supported options");
    if (args.has(key)) throw new Error(`Duplicate --${key} option`);
    let value = separator === -1 ? undefined : arg.slice(separator + 1);
    if (key === "help") {
      if (value !== undefined) throw new Error("--help does not take a value");
      args.set(key, "true");
      continue;
    }
    if (value === undefined) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = argv[++index];
      } else if (key === "public-origin") {
        value = "true";
      }
    }
    if (value === undefined || value.trim() === "") {
      throw new Error(`--${key} requires a value`);
    }
    args.set(key, value);
  }
  const path = args.get("path") ?? "manual";
  if (path !== "manual" && path !== "deploy-button") {
    throw new Error("--path must be manual or deploy-button");
  }
  if (args.has("public-origin") && !["true", "false"].includes(args.get("public-origin"))) {
    throw new Error("--public-origin must be true or false");
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Smoke report: ${error.message}. Run with --help for usage.`);
  process.exit(1);
}
if (args.has("help")) {
  console.log(usage);
  process.exit(0);
}
const path = args.get("path") ?? "manual";

const origin = args.get("origin") ?? "";
const publicOrigin = args.get("public-origin") === "true";
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const rootConfig = readFileSync(resolve("wrangler.jsonc"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

function resultLine(label) {
  return `- ${label}: [ ] pass [ ] fail [ ] blocked — evidence:`;
}

if (!rootConfig.includes('"main": "workers/api/src/index.ts"')) {
  throw new Error("Root wrangler.jsonc does not point at the public Worker entry point");
}
if (rootConfig.includes("analytics_engine_datasets") || rootConfig.includes('"GROWTH"')) {
  throw new Error("Root wrangler.jsonc must omit production-only growth analytics binding");
}
if (!packageJson.scripts?.build || !packageJson.scripts?.deploy) {
  throw new Error("Root package.json must expose build and deploy scripts");
}

const originLine = origin
  ? publicOrigin
    ? origin
    : "[redacted workers.dev origin]"
  : "[not supplied]";

const report = `# elm.chat self-host smoke report

- Commit SHA: \`${commit}\`
- Date tested: ${new Date().toISOString()}
- Deployment path: ${path}
- Public origin: ${originLine}
- Tester opted to publish origin: ${publicOrigin ? "yes" : "no"}

## Local preflight

- [x] Root \`wrangler.jsonc\` points at \`workers/api/src/index.ts\`.
- [x] Root deploy-button config omits the production-only \`GROWTH\` Analytics Engine binding.
- [x] Root \`package.json\` exposes \`build\` and \`deploy\` scripts.

Before marking deployment pass, run:

\`\`\`bash
npm install
npm run check:wrangler-configs
npm run check:growth-privacy
npm run typecheck
npm run build
\`\`\`

For the manual path, deploy with:

\`\`\`bash
npm run deploy
\`\`\`

## Redacted evidence

${resultLine("Deployment")}
${resultLine("Two-browser lifecycle")}
${resultLine("Post-destroy reconnect")}
${resultLine("Known-limit review")}

## Human observations

- Browser A created a room: [ ] yes [ ] no [ ] blocked
- Browser A created a single-use invite: [ ] yes [ ] no [ ] blocked
- Browser B redeemed the invite: [ ] yes [ ] no [ ] blocked
- A low-risk test text message was exchanged: [ ] yes [ ] no [ ] blocked
- The room was destroyed: [ ] yes [ ] no [ ] blocked
- Reloading or reconnecting did not recover the room: [ ] yes [ ] no [ ] blocked

## Redaction checklist

Do not paste account IDs, API tokens, room IDs, room secrets, invite tokens, creator tokens, IP addresses, private deployment logs, message contents, filenames, or screenshots containing secrets.

## Limits

This smoke report is not a security audit. It does not prove anonymity, deletion from endpoints, screenshot/download removal, provider metadata deletion, regulated-data suitability, or protection for high-risk use.
`;

console.log(report);
