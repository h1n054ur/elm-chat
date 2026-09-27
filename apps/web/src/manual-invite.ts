import type { RoomInvite } from "@elm-chat/shared";

export function canShareInvite(invite: RoomInvite | undefined, now: number): invite is RoomInvite {
  return Boolean(invite && invite.expiresAt > now && !invite.revokedAt &&
    !invite.consumedAt && !invite.claimedAt && !invite.admittedAt);
}
