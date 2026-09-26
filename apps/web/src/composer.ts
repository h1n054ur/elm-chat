import type { KeyboardEvent } from "react";

export function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  // Enter confirms IME candidates; some browsers report keyCode 229 while
  // finishing composition even when isComposing has already become false.
  if (
    event.key !== "Enter" ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return;
  }

  const form = event.currentTarget.form;
  if (!form) return;
  event.preventDefault();
  form.requestSubmit();
}
