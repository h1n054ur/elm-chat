import { describe, expect, it } from "vitest";
import { adjacentMatch, findMessageIds } from "../apps/web/src/conversation-find";

describe("find in visible conversation", () => {
  const messages = [
    { id: "first", kind: "text", plaintext: "Hello [world]. Hello again", expiresAt: 200 },
    { id: "spanish", kind: "text", plaintext: "HOLA MUNDO", expiresAt: 300 },
    { id: "file", kind: "file", plaintext: "hello.png" },
    { id: "system", kind: "system", plaintext: "hello joined" },
    { id: "last", kind: "text", plaintext: "hello", expiresAt: 400 }
  ];
  it("matches literal text case-insensitively and counts each text message once", () => {
    expect(findMessageIds(messages, "HELLO", 100)).toEqual(["first", "last"]);
    expect(findMessageIds(messages, "[world].", 100)).toEqual(["first"]);
    expect(findMessageIds(messages, ".*", 100)).toEqual([]);
    expect(findMessageIds(messages, "hola", 100)).toEqual(["spanish"]);
  });
  it("excludes expired content at the boundary and empty queries", () => {
    expect(findMessageIds(messages, "hello", 200)).toEqual(["last"]);
    expect(findMessageIds(messages, "hello", 400)).toEqual([]);
    expect(findMessageIds(messages, "", 100)).toEqual([]);
    expect(findMessageIds(messages, "   ", 100)).toEqual([]);
  });
  it("navigates in order with wrap and handles vanished selections", () => {
    expect(adjacentMatch(["a", "b"], null, 1)).toBe("a");
    expect(adjacentMatch(["a", "b"], null, -1)).toBe("b");
    expect(adjacentMatch(["a", "b"], "b", 1)).toBe("a");
    expect(adjacentMatch(["a", "b"], "a", -1)).toBe("b");
    expect(adjacentMatch(["b"], "a", 1)).toBe("b");
    expect(adjacentMatch([], "a", 1)).toBeNull();
  });
});
