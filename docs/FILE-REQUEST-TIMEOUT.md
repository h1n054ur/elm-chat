# File request timeout regression

An incoming file offer remains available until its message policy expires or its sender/room becomes unavailable. The 30-second inactivity timer starts when the recipient selects Download, including when the sender never sends a chunk. Valid chunks refresh that timer. Completed, expired, replaced, and removed transfers invalidate their old callbacks.

Build and start the local Worker with isolated state:

```sh
npm ci
npm run build
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID WRANGLER_SEND_METRICS=false \
  npx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 \
  --port 5222 --inspector-port 9322 --persist-to /tmp/elm-file-timeout-test
```

In another terminal, run the opt-in browser regression (about 75 seconds). Playwright and Chrome must be installed separately; omit the overrides to use normal Playwright resolution and its installed browser.

```sh
TEST_ORIGIN=http://127.0.0.1:5222 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_PATH=/absolute/path/to/Chrome \
node scripts/check-file-request-timeout-browser.mjs
```

The script uses independent browser contexts, real local Worker/Durable Object HTTP and WebSocket traffic, and native WebCrypto. It blocks unrelated external feeds. It checks:

- An untouched offer remains downloadable after 31 seconds, creates no transfer timer, and produces exactly the offered bytes when downloaded.
- A requested transfer with zero chunks and one with partial data both time out without an incomplete Save link.
- Sender departure invalidates a partial transfer without a Save link.
- An unrequested offer disappears under message expiry, using a separate synthetic six-second policy room.
- Deliberately replayed cleared callbacks cannot fail a refreshed partial transfer or a completed download.

Stalls are deterministic: the harness holds selected native encryption calls before they complete. Callback replay is also injected; normal timers still run in real time. These cases test lifecycle handling, not real-network failure frequency. Replacement identity guards receive source review; the script does not inject a same-ID replacement offer. Room termination is exercised during cleanup, not during an active transfer. Mobile, screen-reader announcements, focus recovery, retry, and cancel controls are outside this regression.

Output uses fixed phase labels and suppresses raw errors, capabilities, keys, and room links. Rooms and browser contexts are cleaned up; stop the separately launched Worker and remove your isolated state afterward. Against the old application, the untouched-offer check fails because the offer's timer starts before Download.
