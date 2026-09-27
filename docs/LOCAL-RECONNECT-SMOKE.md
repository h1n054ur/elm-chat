# Real local automatic reconnect smoke

This opt-in companion to [the local relay smoke](LOCAL-RELAY-SMOKE.md) interrupts
only the guest's real TCP transport. It keeps the guest page mounted, forwards
bytes unchanged to a local Worker/Durable Object, and does not replace HTTP
responses or WebSocket messages. The original relay/file smoke stays separate.

Follow the linked prerequisites (`npm ci`, built web assets, Playwright and
Chromium). Start your dedicated root Wrangler configuration using its documented
command, then run:

```sh
TEST_ORIGIN=http://127.0.0.1:5210 \
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright/index.mjs \
  node scripts/check-local-reconnect-browser.mjs
```

`CHROME_PATH` optionally selects an existing Chrome/Chromium executable. This
script requires HTTP on **127.0.0.1** with no credentials, query, fragment or path.
It allocates an ephemeral loopback proxy port for the guest. The creator connects
directly to Wrangler; the guest uses the proxy origin from initial admission.
Neither production endpoints nor a deployed app are needed.

The check establishes key-ready composers and exchanges unique baseline messages
both ways. With an unsent guest draft present, it cuts all guest proxy connections
and refuses new ones. It requires an actual guest WebSocket close, creator
presence dropping to one, and the disabled guest composer retaining its draft.
It then restores forwarding and requires a new socket, presence of two and
key-ready composers, the same page, and unchanged session/public identity values.
Comparisons happen in memory; values are never logged.

The restored draft and new messages must appear exactly once at their recipients;
baseline messages must remain exactly once, with no visible room error. Finally,
it destroys the room, rejects an unused invite in a fresh context, and observes
nine seconds (longer than the current maximum retry delay) without a new guest
socket or restored composer.

Output contains fixed phases and browser version. Errors, including cleanup
errors, are redacted because raw browser diagnostics can expose capabilities.
The harness closes its own contexts, browser, proxy connections and listener.
Stop your dedicated Wrangler process and remove only your test state afterward,
as described in the relay guide. Do not enable request/frame logs, traces,
screenshots or storage dumps. Unrelated public feeds/off-origin browser requests
are blocked; room traffic is forwarded unchanged.

This tests one abrupt guest disconnect followed by automatic recovery on local
desktop Chromium. It does not test retry exhaustion, manual Retry, mobile
suspension, packet loss, messages sent while offline, or terminal transitions
during an in-flight crypto operation. Session/public identity continuity and
successful decryption are behavioral checks, not a cryptographic security audit.
The nine-second observation is bounded evidence, not proof against every delayed
race. This script adds no runtime behavior, server logging or retention.
