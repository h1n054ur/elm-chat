# Reading position and Jump to latest

The conversation follows arrivals while the reader is within 48 CSS pixels of the bottom. Scrolling farther up pauses following and exposes a localized Jump to latest button. New-message counts include only IDs still present in the conversation. Sending text or attaching a file resumes following. No query, message text, or scroll state is persisted or sent to the server.

## Regression checks

`bun run test` covers the follow threshold, short/overscrolled logs, arrival accumulation, expiry pruning, same-count replacements, duplicate updates, and clearing pending IDs when following resumes.

For browser verification, use a local room with enough messages to overflow:

1. At the bottom, receive another message: the log follows it.
2. Scroll up and receive messages: the viewport stays on earlier content and the button shows the new count.
3. Expire a message above the viewport: surviving content stays anchored where supported by native browser scroll anchoring; the UI never explicitly jumps to the bottom while detached.
4. Expire an unseen message: it disappears from the count. File progress and timer updates do not create new arrivals.
5. Focus Jump to latest and press Enter: return to the bottom and move keyboard focus to the conversation. The button disappears.
6. While scrolled up, send text or attach a file: return to the latest message. This local display behavior does not prove delivery.
7. Expire the entire conversation: clear the pending count and button; future arrivals follow normally.
8. Repeat in English and Spanish, with reduced motion, and on narrow mobile viewports.

During development, a React StrictMode harness using the actual scroll hook passed nine browser scenarios in each of English and Spanish in headless desktop Chrome. These included native anchoring on removal above the viewport, keyboard focus, own-send updates, and empty-list reset. The harness used synthetic messages, not live transport. Mobile Safari, real screen readers, and the full two-browser room flow remain release checks; native scroll anchoring differs by browser.
