import { useCallback, useId, useRef, useState } from "react";
import { adjacentMatch, findMessageIds, type SearchableMessage } from "./conversation-find";
import { t } from "./localization";

const buttonClass = "rounded border px-3 py-1.5 text-xs lowercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc disabled:cursor-not-allowed disabled:opacity-40";

export function useConversationFind(messages: readonly SearchableMessage[], now: number, onNavigate: (id: string) => void) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusInput = useCallback((element: HTMLInputElement | null) => {
    element?.focus({ preventScroll: true });
  }, []);
  const id = useId();
  const matches = open ? findMessageIds(messages, query, now) : [];
  const selectedId = selection !== null && matches.includes(selection) ? selection : null;

  function close(restoreFocus = false) {
    const ownedFocus = panelRef.current?.contains(document.activeElement);
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

  // The toggle sits with the room actions; the panel opens at the top of the messages box.
  const toggle = <button aria-expanded={open} aria-controls={open ? id : undefined} aria-label={t("findConversation")}
    className={`conversation-find ${buttonClass} ${open ? "border-acc2 text-acc2" : "border-line text-dim hover:text-fg"}`}
    ref={opener} type="button" onClick={() => { if (open) close(); else setOpen(true); }}>{t("findShort")}</button>;
  const panel = open ? <div className="conversation-find-panel flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 pb-3 pt-5 text-xs"
    id={id} ref={panelRef} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(true); }
    }}>
    <label className="lowercase text-dim" htmlFor={`${id}-query`}>{t("findVisibleMessages")}</label>
    <input id={`${id}-query`} type="search" autoComplete="off" spellCheck={false} value={query}
      className="min-w-0 flex-[1_1_12rem] rounded border border-line bg-bg px-2 py-1.5 text-sm text-fg focus-visible:border-acc2 focus-visible:outline-none"
      ref={focusInput}
      onChange={event => { setQuery(event.target.value); setSelection(null); }}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault(); navigate(event.shiftKey ? -1 : 1);
        }
      }} />
    <span aria-live="polite" aria-atomic="true" className="conversation-find-count text-dim">
      {!query.trim() ? t("findHint") : !matches.length ? t("findNoMatches") : selectedId === null
        ? t("findMatchCount", { count: matches.length })
        : t("findPosition", { position: matches.indexOf(selectedId) + 1, count: matches.length })}
    </span>
    <div className="conversation-find-actions flex flex-wrap gap-2">
      <button className={`${buttonClass} border-line text-dim hover:text-fg`} type="button" disabled={!matches.length} onClick={() => navigate(-1)}>{t("findPrevious")}</button>
      <button className={`${buttonClass} border-line text-dim hover:text-fg`} type="button" disabled={!matches.length} onClick={() => navigate(1)}>{t("findNext")}</button>
      <button className={`${buttonClass} border-line text-dim hover:text-fg`} type="button" onClick={() => close(true)}>{t("findClose")}</button>
    </div>
  </div> : null;
  return { open, selectedId, toggle, panel, close };
}
