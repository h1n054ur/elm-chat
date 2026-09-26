import type { RoomMetadata } from "@elm-chat/shared";

export class RoomMetadataError extends Error {
  constructor(readonly kind: "missing" | "temporary" | "failed") {
    super(`Room metadata request ${kind}`);
  }
}

export async function loadRoomMetadata(roomId: string): Promise<RoomMetadata> {
  let response: Response;
  try {
    response = await fetch(`/api/rooms/${roomId}`);
  } catch {
    throw new RoomMetadataError("temporary");
  }
  if (response.status === 404 || response.status === 410) {
    throw new RoomMetadataError("missing");
  }
  if (response.status === 408 || response.status >= 500) {
    throw new RoomMetadataError("temporary");
  }
  if (!response.ok) throw new RoomMetadataError("failed");
  return response.json();
}
