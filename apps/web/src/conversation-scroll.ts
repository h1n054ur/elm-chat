/** Geometry only: no message text or browser storage is retained. */
export function isNearLatest({ scrollHeight, scrollTop, clientHeight }: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return scrollHeight - Math.max(0, scrollTop) - clientHeight <= 48;
}

/** Keep only unseen IDs that are still in the ephemeral conversation. */
export function unseenMessageIds(
  previousIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
  currentIds: readonly string[],
  followingLatest: boolean
): Set<string> {
  if (followingLatest) return new Set();
  return new Set(currentIds.filter((id) => pendingIds.has(id) || !previousIds.has(id)));
}
