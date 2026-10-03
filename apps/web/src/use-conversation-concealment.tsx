import { useLayoutEffect, useRef, useState } from "react";
import { t } from "./localization";

/** A local display choice, not authentication or a change to room retention. */
export function useConversationConcealment(onHide: () => void) {
  const [hidden, setHidden] = useState(false);
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const focusOwner = useRef<Element | null>(null);
  const handoffPending = useRef(false);

  function changeVisibility(next: boolean) {
    focusOwner.current = document.activeElement;
    handoffPending.current = true;
    if (next) onHide();
    setHidden(next);
  }

  useLayoutEffect(() => {
    if (!handoffPending.current) return;
    handoffPending.current = false;
    // Handoff belongs only to this action, never a later arrival or reconnect.
    if (document.activeElement === focusOwner.current || document.activeElement === document.body) {
      (hidden ? showButton : hideButton).current?.focus({ preventScroll: true });
    }
    focusOwner.current = null;
  }, [hidden]);

  function reset() {
    handoffPending.current = false;
    focusOwner.current = null;
    setHidden(false);
  }

  const control = <button aria-label={t("hideConversation")}
    className="rounded border border-line px-3 py-1.5 text-xs lowercase text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc"
    ref={hideButton} type="button" onClick={() => changeVisibility(true)}>{t("hideShort")}</button>;

  const screen = hidden ? <main className="concealed-conversation flex min-h-dvh flex-col">
    <div aria-hidden="true" className="grad h-0.5 w-full flex-none" />
    <div className="flex flex-1 items-center justify-center px-4 py-8">
      <section className="box w-full max-w-md px-6 pb-6 pt-8" aria-labelledby="concealed-title">
        <span className="box-title">{t("hiddenBoxTitle")}</span>
        <h1 id="concealed-title" className="text-lg font-bold">{t("conversationHidden")}</h1>
        <p className="mt-3 text-sm text-dim">{t("concealmentHint")}</p>
        <button className="grad mt-6 w-full rounded-md px-4 py-3 text-sm font-bold lowercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc"
          ref={showButton} type="button" onClick={() => changeVisibility(false)}>{t("showConversation")}</button>
      </section>
    </div>
  </main> : null;

  return { hidden, control, screen, reset };
}
