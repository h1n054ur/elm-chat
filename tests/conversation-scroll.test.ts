import { describe, expect, it } from "vitest";
import { isNearLatest, unseenMessageIds } from "../apps/web/src/conversation-scroll";

describe("conversation scroll position", () => {
  it("follows at the 48px boundary but preserves reading position beyond it", () => {
    expect(isNearLatest({ scrollHeight: 1000, scrollTop: 552, clientHeight: 400 })).toBe(true);
    expect(isNearLatest({ scrollHeight: 1000, scrollTop: 551, clientHeight: 400 })).toBe(false);
    expect(isNearLatest({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isNearLatest({ scrollHeight: 1000, scrollTop: 0, clientHeight: 400 })).toBe(false);
  });

  it("follows short conversations and bottom overscroll", () => {
    expect(isNearLatest({ scrollHeight: 200, scrollTop: 0, clientHeight: 400 })).toBe(true);
    expect(isNearLatest({ scrollHeight: 0, scrollTop: 0, clientHeight: 400 })).toBe(true);
    expect(isNearLatest({ scrollHeight: 1000, scrollTop: 630, clientHeight: 400 })).toBe(true);
    expect(isNearLatest({ scrollHeight: 1000, scrollTop: -20, clientHeight: 400 })).toBe(false);
  });
});

describe("unseen conversation message IDs", () => {
  it("tracks arrivals while reading earlier messages and preserves pending arrivals", () => {
    const previous = new Set(["read", "pending"]);
    const pending = new Set(["pending"]);
    expect(unseenMessageIds(previous, pending, ["read", "pending", "new"], false))
      .toEqual(new Set(["pending", "new"]));
  });

  it("removes expired pending IDs without marking surviving old messages unseen", () => {
    expect(unseenMessageIds(
      new Set(["read", "expired", "pending"]),
      new Set(["expired", "pending"]),
      ["read", "pending"],
      false
    )).toEqual(new Set(["pending"]));
    expect(unseenMessageIds(new Set(["expired"]), new Set(["expired"]), [], false))
      .toEqual(new Set());
  });

  it("detects an arrival when expiry keeps the total message count unchanged", () => {
    expect(unseenMessageIds(
      new Set(["read", "expired"]),
      new Set(["expired"]),
      ["read", "replacement"],
      false
    )).toEqual(new Set(["replacement"]));
  });

  it("does not count duplicate IDs or repeated updates as additional arrivals", () => {
    const first = unseenMessageIds(new Set(["read"]), new Set(), ["read", "new", "new"], false);
    expect(first).toEqual(new Set(["new"]));
    expect(unseenMessageIds(new Set(["read", "new"]), first, ["read", "new"], false))
      .toEqual(new Set(["new"]));
    expect(unseenMessageIds(new Set(["read"]), new Set(), ["read"], false))
      .toEqual(new Set());
  });

  it("clears pending arrivals when following latest, including an own-send jump", () => {
    expect(unseenMessageIds(
      new Set(["read", "pending"]),
      new Set(["pending"]),
      ["read", "pending", "own-message"],
      true
    )).toEqual(new Set());
    expect(unseenMessageIds(new Set(), new Set(), ["initial-history"], true))
      .toEqual(new Set());
  });

  it("does not mutate prior state and retains only IDs still in the conversation", () => {
    const previous = new Set(["read", "expired"]);
    const pending = new Set(["expired"]);
    const current = ["read", "new"] as const;
    const result = unseenMessageIds(previous, pending, current, false);
    expect(result).toEqual(new Set(["new"]));
    expect(previous).toEqual(new Set(["read", "expired"]));
    expect(pending).toEqual(new Set(["expired"]));
    expect(current).toEqual(["read", "new"]);
    expect(result).not.toBe(pending);
  });
});
