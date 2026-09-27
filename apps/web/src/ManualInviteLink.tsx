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
    <div className="manual-invite" ref={panel} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onDismiss(); }
    }}>
      <label htmlFor={id}>{t("manualInviteLabel")}</label>
      <p id={`${id}-help`}>{t("manualInviteHelp")}</p>
      <input id={id} aria-describedby={`${id}-help`} autoComplete="off" spellCheck={false}
        readOnly ref={field} value={url} onFocus={(event) => event.currentTarget.select()} />
      <button className="secondary-button" type="button" onClick={onDismiss}>{t("dismissManualInvite")}</button>
    </div>
  );
}
