# Manual invite fallback

When a deliberate Copy action fails, or a native share fails without cancellation,
show a read-only selectable invite link. Instructions and labels are available in
English and Spanish. The URL is never placed in a live region. Selection does not
mean copying or sharing succeeded and does not record a handoff metric.

The displayed link is derived from the current room and invite state. It disappears
on expiry, claim, admission, consumption, revocation, or room closure. No URL,
clipboard contents, or fallback state is added to persistent storage or telemetry.

Browser release checks (use synthetic local invites only):

- Deny clipboard access: Copy exposes and selects the labeled field. Escape or Hide
  returns focus to the initiating button, including when pointer activation had
  left focus on the body. A removed/disabled trigger falls back to the create-invite button.
- Delay clipboard rejection, then tab away: the field appears without stealing focus.
- Expire or consume the invite while clipboard is pending: the delayed rejection
  does not expose a usable link or instructions for a missing field.
- Start a newer successful copy while an earlier copy is pending: the earlier
  failure must not overwrite the success or restore a fallback.
- Revoke/expire an exposed invite: remove the field, restoring focus only if it
  owned focus. Ending the room removes the entire fallback.
- Cancel native sharing: retain normal cancellation. Non-cancel share failure may
  expose the manual fallback; displaying/selecting it must not record a handoff.
- Repeat in both locales, with keyboard Enter/Space, and on mobile screen readers.

Development verification used the actual App in headless desktop Chrome, with
synthetic HTTP/WebSocket/clipboard/share responses. It covered the cases above
in English and Spanish; no real room capabilities were published. Real mobile
native-share sheets and screen readers remain manual release checks.
