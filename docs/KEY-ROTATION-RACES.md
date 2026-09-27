# Deterministic key rotation race regressions

This opt-in browser harness runs the real React application and native WebCrypto with synthetic room metadata and WebSocket events. It deliberately holds one completed native crypto operation until a disconnect or a newer membership has arrived. It tests completion ordering; it does **not** measure real-network failure frequency or replace the local relay/reconnect smoke tests.

From the repository root, install dependencies and start Vite on loopback in a separate terminal:

```sh
npm ci
npm run dev --workspace @elm-chat/web -- --host 127.0.0.1 --port 5197 --strictPort
```

Run with an externally installed Playwright module and browser (omit either override to use the normal Playwright resolution/browser installation):

```sh
TEST_ORIGIN=http://127.0.0.1:5197 \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_PATH='/absolute/path/to/Chrome' \
node scripts/check-key-rotation-races.mjs
```

The script accepts only a bare HTTP `127.0.0.1` origin, without credentials, path, query, or fragment. Use a Vite instance serving this checkout: the fixture imports this checkout's crypto module using a repository-relative resolved `/@fs` URL. Off-origin HTTP traffic is blocked; room APIs and room WebSockets are synthetic. No Worker, Cloudflare credentials, live room, or real participant is needed. Each scenario uses a fresh browser context and synthetic UUID identities. The script reports fixed scenario labels and suppresses raw errors, keys, room links, drafts, and frames. It closes contexts and the browser on success or failure; the separately started Vite server remains yours to stop.

Set `TEST_SCENARIO` to one number from `1` through `9` to run just the corresponding scenario below. Invalid selectors fail configuration. Without the selector all nine run, stopping on the first failure.

Nine scenarios assert:

1. A current leader key completion enables the composer and produces an outgoing encrypted envelope at the current epoch.
2. A leader completion after disconnect leaves the composer disabled and the draft intact. A later successful admission at a newer membership restores readiness, retains the draft, and sends at the new epoch.
3. Releasing an older leader derivation after epoch 3 is ready cannot regress outgoing envelopes to epoch 2.
4. A paused pairwise wrap derivation cannot send an obsolete rotation after a newer membership.
5. A paused signature cannot send an obsolete rotation after a newer membership.
6. A destroyed-room screen stays closed after a paused leader derivation completes, without sending a key rotation.
7. A directly received, genuinely signed and wrapped rotation cannot regress the epoch when its room derivation finishes late.
8. The same incoming path cannot regress the epoch when its native unwrap/decrypt finishes late.
9. An incoming room derivation completing after disconnect cannot restore composer readiness.

The incoming fixtures generate real identity/agreement key pairs, wrap secrets for the actual browser session's public agreement key, and sign peer events using the repository crypto API. Positive incoming epoch-3 readiness and outgoing epoch-3 envelopes ensure these fixtures are accepted; an invalid signature silently ignored by the application cannot make these cases pass.

The pause occurs after the native operation has returned a real result, immediately before the application receives it. Releasing the gate waits for its continuation, two animation frames, and a short settling period before negative assertions. The harness checks observable composer state, retained draft, fresh admission counts, outgoing epoch fields, obsolete rotation absence, and absence of page errors. It does not inspect internal React key references or assert successful remote delivery from synthetic transport.

Unmount behavior, stale bootstrap crypto, general signing races outside key rotation, mobile browsers, and protocol/security audits are outside this harness's coverage. The destroyed-screen case verifies visible terminal behavior and no rotation send; it does not claim internal key state is directly observable. The real-relay and real-reconnect scripts remain separate evidence for actual transport and recipient decryption.

Before the guarded-commit fix, the current-completion control passes but the disconnect case fails when the old completion enables the textarea without another admission. Run the same script against the pre-fix application to verify that contrast; copy this harness into the old checkout as an untracked script and point its Vite origin there, then remove that copy after the run. This keeps the `/@fs` fixture import inside the same workspace. The imported crypto fixture implementation is unchanged by the fix.
