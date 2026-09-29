export type SearchableMessage = {
  id: string;
  kind: string;
  plaintext?: string;
  expiresAt?: number;
};

/** Return IDs only; plaintext remains owned by the current conversation. */
export function findMessageIds(messages: readonly SearchableMessage[], query: string, now: number): string[] {
  if (!query.trim()) return [];
  const needle = query.toLocaleLowerCase();
  return messages.filter(message => message.kind === "text" &&
    (message.expiresAt === undefined || message.expiresAt > now) &&
    message.plaintext?.toLocaleLowerCase().includes(needle)).map(message => message.id);
}

export function adjacentMatch(ids: readonly string[], selected: string | null, direction: 1 | -1): string | null {
  if (!ids.length) return null;
  const index = selected === null ? -1 : ids.indexOf(selected);
  if (index < 0) return direction === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(index + direction + ids.length) % ids.length];
}
