import { t, type MessageKey } from "./localization";

export const UPSTREAM_URL = "https://github.com/shawnbure/elm-chat";
// Public mirror of this instance's modified source: the AGPL-3.0 section 13 offer.
export const SOURCE_URL = "https://github.com/bts-io/elm-chat";

// Shared visible focus ring for links and buttons in look B.
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc";

// The 2px gradient rule that sits at the very top of every look-B page.
export function TopRule() {
  return <div aria-hidden="true" className="grad h-0.5 w-full" />;
}

export function SiteHeader() {
  return (
    <header className="flex items-center justify-between gap-4 text-sm">
      <a className={`rounded-sm font-bold tracking-tight ${FOCUS_RING}`} href="/">
        <span className="grad-text">h1n054ur</span>
        <span className="text-dim">/</span>chat
      </a>
      <nav aria-label={t("navLabel")} className="flex gap-4 text-dim">
        <a className={`rounded-sm hover:text-fg ${FOCUS_RING}`} href="/#how">{t("navHow")}</a>
        <a className={`rounded-sm hover:text-fg ${FOCUS_RING}`} href="/limits">{t("navLimits")}</a>
        <a className={`rounded-sm hover:text-fg ${FOCUS_RING}`} href={SOURCE_URL} rel="noreferrer" target="_blank">
          {t("navSource")}
        </a>
      </nav>
    </header>
  );
}

const PROTECTED: MessageKey[] = [
  "limitsProtectedEncryption",
  "limitsProtectedKey",
  "limitsProtectedSigned",
  "limitsProtectedInvites",
  "limitsProtectedTranscript",
  "limitsProtectedTeardown"
];

const NOT_PROTECTED: MessageKey[] = [
  "limitsNotMetadata",
  "limitsNotCopy",
  "limitsNotDevice",
  "limitsNotAudit"
];

function LimitsList({ items, marker, markerClass }: { items: MessageKey[]; marker: string; markerClass: string }) {
  return (
    <ul className="mt-2 space-y-3 text-sm leading-relaxed">
      {items.map((key) => (
        <li className="flex gap-3" key={key}>
          <span aria-hidden="true" className={`shrink-0 font-bold ${markerClass}`}>{marker}</span>
          <span>{t(key)}</span>
        </li>
      ))}
    </ul>
  );
}

export function LimitsPage() {
  return (
    <>
      <TopRule />
      <main className="mx-auto flex min-h-[calc(100dvh-2px)] max-w-3xl flex-col px-4 py-6 sm:px-8">
        <SiteHeader />
        <article className="flex-1 py-10">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            <span className="grad-text">{t("limitsTitle")}</span>
          </h1>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-dim">{t("limitsLede")}</p>

          <section aria-labelledby="limits-protected" className="box mt-10 p-6 pt-7">
            <h2 className="box-title" id="limits-protected">{t("limitsProtected")}</h2>
            <LimitsList items={PROTECTED} marker="+" markerClass="text-acc" />
          </section>

          <section aria-labelledby="limits-not" className="box mt-8 p-6 pt-7">
            <h2 className="box-title" id="limits-not">{t("limitsNotProtected")}</h2>
            <LimitsList items={NOT_PROTECTED} marker="-" markerClass="text-danger" />
          </section>

          <p className="mt-8 text-xs leading-relaxed text-dim">
            {t("limitsUpstream")}{" "}
            <a
              className={`rounded-sm text-acc2 underline underline-offset-2 hover:text-fg ${FOCUS_RING}`}
              href={UPSTREAM_URL}
              rel="noreferrer"
              target="_blank"
            >
              {t("limitsUpstreamLink")}
            </a>
            {" · "}
            <a
              className={`rounded-sm text-acc2 underline underline-offset-2 hover:text-fg ${FOCUS_RING}`}
              href={SOURCE_URL}
              rel="noreferrer"
              target="_blank"
            >
              {t("limitsSourceLink")}
            </a>
          </p>

          <a className={`mt-8 inline-block rounded-sm text-sm text-acc hover:text-fg ${FOCUS_RING}`} href="/">
            <span aria-hidden="true">&larr; </span>
            {t("backHomeShort")}
          </a>
        </article>
      </main>
    </>
  );
}
