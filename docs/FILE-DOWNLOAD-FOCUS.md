# Keyboard focus when starting a file download

Starting a download replaces its button with progress. The file card now keeps a stable, programmatically focusable group named for the file in English or Spanish. If the activating Download button owns focus, its click handler moves focus to the card before starting the request. The card has a visible keyboard-focus outline and does not add a Tab stop.

There are no completion or failure focus effects. Focus stays on the card while its contents change, or stays wherever the user moves it. Once Save is available, Tab from the card reaches the native Save link. Programmatic activation of an unfocused Download button does not move focus.

Progress retains `aria-live="off"`. This change adds no live announcement region, retry/cancel action, transfer protocol change, or persistence. Expiry/removal of the entire card retains existing behavior; recovery from that removal is outside this scope. Actual screen-reader speech and mobile behavior require separate testing.

For the opt-in browser regression, build and start the real local Worker with isolated state:

```sh
npm ci
npm run build
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID WRANGLER_SEND_METRICS=false \
  npx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 \
  --port 5227 --inspector-port 9327 --local-upstream 127.0.0.1:5227 --persist-to /tmp/elm-file-focus-test
```

Run the checked-in harness with a separately installed Playwright and browser. Omit path overrides to use normal Playwright resolution and its installed browser:

```sh
TEST_ORIGIN=http://127.0.0.1:5227 \
TEST_LOCALE=en-US FAILURE_FOCUS=card \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_PATH=/absolute/path/to/Chrome \
node scripts/check-file-download-focus-browser.mjs
```

Run both `TEST_LOCALE=en-US` and `TEST_LOCALE=es-ES`, each with `FAILURE_FOCUS=card`, `composer`, and `other`, for the full six-run matrix. Each run checks Enter and Space, visible focus, localized group/Save names, Tab to Save, Tab-away/composer/another-file focus preservation on completion, activation of an unfocused button, and sender-departure failure. The failure selector determines whether focus remains on the active card, composer, or another completed file's Save link. `BASELINE=1` asserts the old BODY focus behavior against the pre-fix application; it is diagnostic mode, not acceptance of the fix. Running the normal harness against the old application fails.

The harness uses real local Worker/Durable Object HTTP and WebSocket traffic. Selected encryption calls are deliberately held to inspect progress and move focus before completion; that deterministic hold is not a real-network failure. Synthetic filenames/content and redacted diagnostics avoid recording room capabilities. Browser contexts close after each run. The sender is closed to exercise departure; rooms expire under local policy. Stop your separately launched Worker and remove its isolated state after testing.
