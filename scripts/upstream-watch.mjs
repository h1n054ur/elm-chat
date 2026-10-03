// Weekly upstream check: lists upstream elm.chat commits that are not merged into this
// repository yet and keeps one Forgejo issue in step with that list (opens, updates or
// closes it). Run from a full clone after `git fetch <upstream> main`, with:
//   FORGEJO_URL (e.g. https://git.h1n054ur.dev), FORGEJO_REPO (owner/name),
//   FORGEJO_TOKEN, and optionally UPSTREAM_REF (default FETCH_HEAD) and DRY_RUN=1.
import { execFileSync } from "node:child_process";

const UPSTREAM_WEB = "https://github.com/shawnbure/elm-chat";
const TITLE = "Upstream: new elm.chat commits to review";
const SYNC_HINT = "See docs/UPSTREAM-SYNC.md for the merge routine.";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
};
const forgejo = env("FORGEJO_URL").replace(/\/$/, "");
const repo = env("FORGEJO_REPO");
const token = env("FORGEJO_TOKEN");
const upstreamRef = env("UPSTREAM_REF", "FETCH_HEAD");
const dryRun = process.env.DRY_RUN === "1";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const upstreamHead = git("rev-parse", upstreamRef);
const pending = git("log", "--no-merges", "--format=%H%x09%s", `HEAD..${upstreamRef}`)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, ...subject] = line.split("\t");
    return { sha, subject: subject.join("\t") };
  });

async function api(method, path, body) {
  const response = await fetch(`${forgejo}/api/v1/repos/${repo}${path}`, {
    method,
    headers: { authorization: `token ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const open = (await api("GET", `/issues?state=open&type=issues&limit=50&q=${encodeURIComponent(TITLE)}`))
  .find((issue) => issue.title === TITLE);

if (pending.length === 0) {
  console.log(`Up to date with upstream ${upstreamHead.slice(0, 12)}.`);
  if (open && !dryRun) {
    await api("POST", `/issues/${open.number}/comments`, {
      body: `All upstream commits up to \`${upstreamHead.slice(0, 12)}\` are merged. Closing.`
    });
    await api("PATCH", `/issues/${open.number}`, { state: "closed" });
    console.log(`Closed #${open.number}.`);
  }
  process.exit(0);
}

const shown = pending.slice(0, 50);
const body = [
  `${pending.length} upstream commit(s) on \`main\` are not merged here yet (upstream head \`${upstreamHead.slice(0, 12)}\`).`,
  "",
  `Compare: ${UPSTREAM_WEB}/compare/${git("merge-base", "HEAD", upstreamRef)}...${upstreamHead}`,
  "",
  ...shown.map(({ sha, subject }) => `- [\`${sha.slice(0, 7)}\`](${UPSTREAM_WEB}/commit/${sha}) ${subject}`),
  ...(pending.length > shown.length ? [`- ... and ${pending.length - shown.length} more`] : []),
  "",
  SYNC_HINT,
  "",
  `_Updated ${new Date().toISOString().slice(0, 10)} by the upstream-watch workflow._`
].join("\n");

console.log(`${pending.length} upstream commit(s) pending.`);
if (dryRun) {
  console.log(body);
} else if (open) {
  await api("PATCH", `/issues/${open.number}`, { body });
  console.log(`Updated #${open.number}.`);
} else {
  const created = await api("POST", "/issues", { title: TITLE, body });
  console.log(`Opened #${created.number}.`);
}
