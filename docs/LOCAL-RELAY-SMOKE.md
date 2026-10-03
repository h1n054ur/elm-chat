# Real local relay browser smoke

This opt-in check runs the built application against a real local Wrangler Worker
and Durable Object. It creates isolated browser contexts, admits a guest, checks
one decrypted message in each direction on the receiving peer, transfers and
verifies a small synthetic file, destroys the room, and verifies that both peers
and a fresh visitor with a previously unused invite remain unable to send or join.
No room HTTP responses or WebSocket messages are mocked.

## Prerequisites and execution

Use Node.js 24 and `bun install --frozen-lockfile`, then `bun run build`. Install Playwright separately
(for example in a temporary tools directory with `bun install playwright` and
`bunx playwright install chromium`). Set `PLAYWRIGHT_MODULE` to that installation's
absolute `node_modules/playwright/index.mjs` path. If Playwright is already
resolvable from this repository, the variable may be omitted. Optionally set
`CHROME_PATH` to an existing Chromium/Chrome executable.

Start the self-host configuration in a dedicated terminal:

```sh
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID WRANGLER_SEND_METRICS=false \
  bunx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 \
  --port 5210 --inspector-port 9310 --local-upstream 127.0.0.1:5210 --persist-to .wrangler/local-smoke --log-level none
```

After the local server starts, run in another terminal:

```sh
TEST_ORIGIN=http://127.0.0.1:5210 \
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright/index.mjs \
  node scripts/check-local-relay-browser.mjs
```

The script accepts only a plain HTTP loopback origin (localhost, 127.0.0.1, or
[::1]), without credentials, path, query, or fragment. It prints phase results and
the browser version; failures omit raw exception details because browser errors
can include room capabilities. A nonzero exit means the check did not complete.
Stop your dedicated Wrangler process afterward. Its local state is under the
ignored `.wrangler/local-smoke` directory; remove only that test directory if you
want to discard it. Browser contexts close automatically; cleanup attempts to
destroy a room when a phase fails, but stopping/removing local state is still
necessary after an interrupted run.

## Scope and privacy

Use synthetic content and the root self-host configuration, which has no growth
binding. The browser aborts off-origin requests and the unrelated `/api/stars`
and `/api/community` feeds so those endpoints cannot trigger public GitHub reads.
All room requests continue unchanged to the local Worker; the WebSocket relay is
real. Invite capabilities are handed between contexts only in memory. The
synthetic downloaded file is read for byte comparison and deleted; no screenshots,
traces, storage dumps, or capability artifacts are intentionally saved.

This checks a local desktop Chromium path. It does not prove production routing,
mobile behavior, reconnect recovery, clipboard behavior, or cryptographic
security. It does not change the server's visibility, retention, encryption, or
access control and does not deploy anything. It is separate from CI because it
requires a running local Worker and a browser installation.

For a separate real-transport interruption and automatic recovery check, see
[the local reconnect smoke](LOCAL-RECONNECT-SMOKE.md).
