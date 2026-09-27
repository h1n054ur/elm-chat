import { describe, expect, it } from "vitest";
import { canShareInvite } from "../apps/web/src/manual-invite";
const invite = { token: "synthetic", createdAt: 10, expiresAt: 100 };
describe("manual invite validity", () => {
  it("allows an unused invite only before its expiry boundary", () => {
    expect(canShareInvite(invite, 99)).toBe(true);
    expect(canShareInvite(invite, 100)).toBe(false);
    expect(canShareInvite(invite, 101)).toBe(false);
    expect(canShareInvite(undefined, 20)).toBe(false);
  });
  it.each(["revokedAt", "consumedAt", "claimedAt", "admittedAt"])("rejects %s even before expiry", (field) => {
    expect(canShareInvite({ ...invite, [field]: 15 }, 20)).toBe(false);
  });
});
