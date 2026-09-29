import { useCallback, useId, useRef, useState } from "react";
import { adjacentMatch, findMessageIds, type SearchableMessage } from "./conversation-find";
import { t } from "./localization";

export function useConversationFind(messages: readonly SearchableMessage[], now: number, onNavigate: (id: string) => void) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusInput = useCallback((element: HTMLInputElement | null) => {
    element?.focus({ preventScroll: true });
  }, []);
  const id = useId();
  const matches = open ? findMessageIds(messages, query, now) : [];
  const selectedId = selection !== null && matches.includes(selection) ? selection : null;

  function close(restoreFocus = false) {
    const ownedFocus = panel.current?.contains(document.activeElement);
    setOpen(false);
    setQuery("");
    setSelection(null);
    if (restoreFocus && ownedFocus) opener.current?.focus({ preventScroll: true });
  }

  function navigate(direction: 1 | -1) {
    const next = adjacentMatch(matches, selectedId, direction);
    if (!next) return;
    setSelection(next);
    onNavigate(next);
  }

  const controls = <div className="conversation-find">
    <button aria-expanded={open} aria-controls={open ? id : undefined} className="secondary-button" ref={opener}
      type="button" onClick={() => { if (open) close(); else setOpen(true); }}>{t("findConversation")}</button>
    {open && <div className="conversation-find-panel" id={id} ref={panel} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
    }}>
      <label htmlFor={`${id}-query`}>{t("findVisibleMessages")}</label>
      <input id={`${id}-query`} type="search" autoComplete="off" spellCheck={false} value={query}
        ref={focusInput}
        onChange={event => { setQuery(event.target.value); setSelection(null); }}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault(); navigate(event.shiftKey ? -1 : 1);
          }
        }} />
      <span aria-live="polite" aria-atomic="true" className="conversation-find-count">
        {!query.trim() ? t("findHint") : !matches.length ? t("findNoMatches") : selectedId === null
          ? t("findMatchCount", { count: matches.length })
          : t("findPosition", { position: matches.indexOf(selectedId) + 1, count: matches.length })}
      </span>
      <div className="conversation-find-actions">
        <button className="secondary-button" type="button" disabled={!matches.length} onClick={() => navigate(-1)}>{t("findPrevious")}</button>
        <button className="secondary-button" type="button" disabled={!matches.length} onClick={() => navigate(1)}>{t("findNext")}</button>
        <button className="secondary-button" type="button" onClick={() => close(true)}>{t("findClose")}</button>
      </div>
    </div>}
  </div>;
  return { open, selectedId, controls, close };
}
