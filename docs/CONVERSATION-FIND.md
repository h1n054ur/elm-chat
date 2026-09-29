# Find in the current conversation

Use **Find in conversation** to search text messages that are still visible in this room. Matching is a case-insensitive literal substring; punctuation has no special meaning. The count is matching messages, not occurrences. Files, filenames, and system notices are excluded.

Use Next/Previous or Enter/Shift+Enter in the search field to navigate. Navigation wraps and outlines the selected message without changing its contents or moving keyboard focus. Typing a query, receiving a message, or losing an expired result does not navigate. Search pauses automatic following of new messages; Jump to latest remains available. The browser's own Find shortcut is unchanged.

Escape closes search and returns focus to its opener only while the search panel owns focus. Closing clears the query and selection. Room teardown also clears search. Results are IDs derived from the current unexpired messages on each render; no separate plaintext index, query URL, server request, transcript retention, or query telemetry is introduced. Expired messages cannot remain searchable. If a selected message expires, selection resets without scrolling.

English and Spanish controls follow the existing room language. This feature searches the messages currently available in the room, not complete history. Browser behavior and screen-reader speech are distinct verification claims; automated role/focus assertions do not establish spoken output.

The pure matching/navigation tests run with `npm test`. The browser harness uses real local Worker/Durable Object HTTP and WebSocket traffic, native encryption, and a separate synthetic six-second message-policy room for expiry. No room transport or crypto is mocked. Agent3 contributed this fixture; its authorship is distinct from independent review.

Build and start a local Worker in a separate terminal, using free ports and isolated state:

```sh
npm ci
npm run build
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID WRANGLER_SEND_METRICS=false \
  npx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 \
  --port 54541 --inspector-port 54542 --persist-to /tmp/elm-find-test --log-level none
```

Run both `TEST_LOCALE=en-US` and `TEST_LOCALE=es-ES`. Playwright/browser must be installed separately; omit path overrides to use normal Playwright resolution and its installed browser.

```sh
TEST_ORIGIN=http://127.0.0.1:54541 TEST_LOCALE=en-US \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_PATH=/absolute/path/to/Chrome \
node scripts/check-conversation-find-browser.mjs
```

The harness covers literal/case matching, message counts, file exclusion, empty/no results, wrap navigation, input/button focus, explicit scrolling, arrival/query scroll preservation, Jump coexistence, conditional Escape restoration, cleared reopening, terminal rooms, and selected-message expiry. It blocks external feeds and suppresses raw diagnostics/capabilities. Browser contexts close at the end; stop the separately started Worker and remove your isolated state. Mobile and actual screen-reader speech are outside its coverage.
