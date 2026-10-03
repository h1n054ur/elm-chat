# Composer send race regressions

This opt-in browser harness exercises the real React composer with native WebCrypto and synthetic room HTTP/WebSocket responses. It holds a native encryption or signing result until a second user action or lifecycle event occurs. Rejection cases deliberately reject that completion after the native operation succeeds. These are deterministic ordering and failure-injection tests, not real-relay delivery evidence.

Start a local Vite server from the repository root:

```sh
bun install --frozen-lockfile
bun run dev --workspace @elm-chat/web -- --host 127.0.0.1 --port 5197 --strictPort
```

Then run the harness with your external Playwright/browser installation, or omit these overrides to use Playwright's normal resolution and browser:

```sh
TEST_ORIGIN=http://127.0.0.1:5197 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_PATH='/absolute/path/to/Chrome' \
node scripts/check-composer-send-races.mjs
```

`TEST_ORIGIN` must be a bare HTTP `127.0.0.1` origin with no credentials, path, query, or fragment. Off-origin HTTP traffic is blocked. Synthetic room metadata, admission, and transport require no Worker, real room, or credentials. Each case runs in a fresh context. Browser/context cleanup runs on success and failure; stop the separately started Vite server yourself. Logs contain only fixed scenario labels and suppress raw errors, frames, drafts, identities, and URLs.

Set `TEST_SCENARIO=1` through `10` to run one case; invalid selectors fail configuration. Without a selector all cases run, stopping at the first failure:

1. A successful send clears an unchanged draft and creates exactly one outgoing event and one local bubble.
2. New text typed while encryption is pending survives completion of the previous send.
3. Repeated form submissions while encryption is pending send only once.
4. Repeated form submissions while signing is pending send only once.
5. Encryption rejection preserves the original draft, creates no bubble/event, and permits a subsequent successful retry.
6. Signing rejection preserves the original draft, creates no bubble/event, and permits a subsequent successful retry.
7. Disconnect during encryption preserves the draft and creates no stale local bubble or outgoing event.
8. A terminal room event during encryption keeps the closed screen visible, with no outgoing event or visible bubble.

9. Editing away from and back to the original text while encryption is pending preserves that newer draft revision.
10. Membership changes during signing cancel the old send; retrying sends once at the newer epoch.

Repeated submission uses `form.requestSubmit()` directly so the test checks the synchronous handler guard independently of a disabled button. Native results are retained while paused; no fake encrypted envelopes or signatures are supplied. The harness releases the result, drains two animation frames, and allows a short settling interval before negative assertions. Successful cases require both an outgoing chat event and a visible bubble; all cases require no uncaught page errors.

To verify old-fails/new-passes, serve a clean pre-fix checkout on another loopback port and run this same harness with that `TEST_ORIGIN`. It makes no source-module imports and does not need to be copied into the old checkout. Run selected cases independently to capture more than the first failure. The successful-send control should continue to pass on the old code.

The terminal case cannot observe hidden React draft/message state after the composer has unmounted from the DOM; it verifies the visible terminal UI and absence of transport sends. The harness does not cover component unmount, file transfers, delivery acknowledgements, mobile browsers, or real-network reliability. Keep the existing real-relay and reconnect smoke tests as separate evidence.
