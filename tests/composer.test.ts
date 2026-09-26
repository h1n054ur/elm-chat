import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { handleComposerKeyDown } from "../apps/web/src/composer";

function keyEvent(overrides: Record<string, unknown> = {}) {
  const submit = vi.fn();
  const preventDefault = vi.fn();
  const event = {
    key: "Enter",
    nativeEvent: { isComposing: false, keyCode: 13 },
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    currentTarget: { form: { requestSubmit: submit } },
    preventDefault,
    ...overrides
  } as unknown as KeyboardEvent<HTMLTextAreaElement>;
  return { event, submit, preventDefault };
}

describe("composer keyboard submission", () => {
  it("submits plain Enter through the form and suppresses the newline", () => {
    const { event, submit, preventDefault } = keyEvent();
    handleComposerKeyDown(event);
    expect(submit).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    ["active IME composition", { nativeEvent: { isComposing: true, keyCode: 13 } }],
    ["composition confirmation reported as key code 229", { nativeEvent: { isComposing: false, keyCode: 229 } }],
    ["Shift+Enter newline", { shiftKey: true }],
    ["Ctrl+Enter", { ctrlKey: true }],
    ["Meta+Enter", { metaKey: true }],
    ["Alt+Enter", { altKey: true }],
    ["ordinary typing", { key: "a" }],
    ["missing form", { currentTarget: { form: null } }]
  ])("leaves %s to the browser without sending", (_name, overrides) => {
    const { event, submit, preventDefault } = keyEvent(overrides);
    handleComposerKeyDown(event);
    expect(submit).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
