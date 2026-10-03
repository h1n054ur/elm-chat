import { useId, useLayoutEffect, useRef } from "react";
import { t } from "./localization";

export function ManualInviteLink({ url, trigger, focusOwner, fallbackTrigger, onDismiss }: {
  url: string;
  trigger: HTMLElement;
  focusOwner: Element | null;
  fallbackTrigger: HTMLElement | null;
  onDismiss: () => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (document.activeElement === focusOwner) {
      field.current?.focus();
      field.current?.select();
    }
    return () => {
      // Restore focus only when this panel still owns it, never after Tab-away.
      if (element?.contains(document.activeElement)) {
        queueMicrotask(() => {
          // Wait for React to remove invalid invite actions before choosing a target.
          if (element.isConnected || document.activeElement !== document.body) return;
          const target = trigger.isConnected && !trigger.matches(":disabled") ? trigger : fallbackTrigger;
          if (target?.isConnected && !target.matches(":disabled")) target.focus({ preventScroll: true });
        });
      }
    };
  }, [trigger, focusOwner, fallbackTrigger]);

  return (
    <div className="manual-invite grid min-w-0 gap-2 rounded border border-acc2/50 p-3 text-xs" ref={panel} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onDismiss(); }
    }}>
      <label className="font-semibold lowercase text-acc2" htmlFor={id}>{t("manualInviteLabel")}</label>
      <p className="text-dim" id={`${id}-help`}>{t("manualInviteHelp")}</p>
      <input id={id} aria-describedby={`${id}-help`} autoComplete="off" spellCheck={false}
        className="w-full min-w-0 rounded border border-line bg-bg px-2 py-2 text-xs text-fg focus-visible:border-acc2 focus-visible:outline-none"
        readOnly ref={field} value={url} onFocus={(event) => event.currentTarget.select()} />
      <button className="justify-self-start rounded border border-line px-3 py-1.5 text-xs lowercase text-dim hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc"
        type="button" onClick={onDismiss}>{t("dismissManualInvite")}</button>
    </div>
  );
}
