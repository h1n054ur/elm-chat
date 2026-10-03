import {
  createIdentityKeyPair,
  createAuthenticatedPeerEvent,
  createAgreementKeyPair,
  decryptBytes,
  deriveRoomKey,
  encryptBytes,
  encryptMessage,
  exportIdentityPublicKey,
  exportIdentityPrivateKey,
  exportAgreementPrivateKey,
  exportAgreementPublicKey,
  generateMessageId,
  generateRoomSecret,
  generateSessionId,
  importIdentityPrivateKey,
  importIdentityPublicKey,
  importAgreementPrivateKey,
  sha256Base64Url,
  verifyAuthenticatedPeerEvent,
  unwrapRoomSecret,
  wrapRoomSecret
} from "@elm-chat/crypto";
import {
  FILE_CHUNK_BYTES,
  MESSAGE_PROTOCOL_VERSION,
  MAX_FILE_BYTES,
  MAX_TRANSCRIPT_SYNC_MESSAGES,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type EncryptedMessageEnvelope,
  type AuthenticatedPeerEvent,
  type PeerDataEvent,
  type PeerFileChunk,
  type PeerDescriptor,
  type PresenceSnapshot,
  type RoomInvite,
  type RoomMetadata,
  type ServerEvent,
} from "@elm-chat/shared";
import { startTransition, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FOCUS_RING, LimitsPage, SiteHeader, TopRule } from "./LimitsPage";
import { locale, t, type MessageKey } from "./localization";
import { InvalidMessageEnvelopeError, receiveTextMessage } from "./message-receive";
import { ReplayGuard } from "./replay";
import { handleComposerKeyDown } from "./composer";
import { ReconnectScheduler } from "./reconnect";
import { loadRoomMetadata, RoomMetadataError } from "./room-metadata";
import { ManualInviteLink } from "./ManualInviteLink";
import { canShareInvite } from "./manual-invite";
import { useConversationScroll } from "./use-conversation-scroll";
import { useConversationFind } from "./use-conversation-find";
import { useConversationConcealment } from "./use-conversation-concealment";

type View = "landing" | "limits" | "room";

type FileTransferState =
  | "offered"
  | "requesting"
  | "transferring"
  | "ready"
  | "sent"
  | "error";

type UiFile = {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  state: FileTransferState;
  progress: number;
  url?: string;
  outgoing: boolean;
};

type UiMessage = {
  id: string;
  senderSessionId: string;
  sentAt: number;
  expiresAt?: number;
  kind: "text" | "file";
  plaintext?: string;
  file?: UiFile;
};

type IncomingFile = {
  name: string;
  mimeType: string;
  size: number;
  totalChunks: number;
  received: number;
  receivedBytes: number;
  chunks: (Uint8Array | undefined)[];
  senderSessionId: string;
  sha256: string;
  keyEpoch: number;
  requested: boolean;
  timeoutId?: number;
};

type ActionFeedback = "idle" | "success";
type InviteFeedback = "idle" | "copied" | "shared";
type InviteAccess = "checking" | "granted" | "invalid" | "claimed" | "used";
type DurationUnit = "minutes" | "hours" | "days";
type DurationDraft = {
  amount: string;
  unit: DurationUnit;
  indefinite: boolean;
};
type InviteDurationDraft = {
  amount: string;
  unit: DurationUnit;
};

function roomPathname(): { view: View; roomId?: string } {
  const match = window.location.pathname.match(/^\/c\/([^/]+)$/);
  if (match) {
    return { view: "room", roomId: match[1] };
  }
  if (/^\/limits\/?$/.test(window.location.pathname)) {
    return { view: "limits" };
  }
  return { view: "landing" };
}

function formatRelativeDuration(target: number): string {
  const deltaSeconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  const minutes = Math.floor(deltaSeconds / 60);
  const seconds = deltaSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function formatStaticDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    return "0s";
  }

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function creatorTokenKey(roomId: string): string {
  return `elm-chat:creator:${roomId}`;
}

function sessionKey(roomId: string): string {
  return `elm-chat:session:${roomId}`;
}

function identityKeyPairKey(roomId: string, sessionId: string): string {
  return `elm-chat:identity:${roomId}:${sessionId}`;
}

function replayStateKey(roomId: string, sessionId: string, kind: "message" | "event"): string {
  return `elm-chat:replay:${kind}:${roomId}:${sessionId}`;
}

async function loadIdentityKeyPair(roomId: string, sessionId: string): Promise<{
  privateKey: CryptoKey;
  publicKey: string;
  agreementPrivateKey: CryptoKey;
  agreementPublicKey: string;
}> {
  const storageKey = identityKeyPairKey(roomId, sessionId);
  const stored = safeStorageGet("session", storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as {
        privateKey: JsonWebKey;
        publicKey: string;
        agreementPrivateKey: JsonWebKey;
        agreementPublicKey: string;
      };
      return {
        privateKey: await importIdentityPrivateKey(parsed.privateKey),
        publicKey: parsed.publicKey,
        agreementPrivateKey: await importAgreementPrivateKey(parsed.agreementPrivateKey),
        agreementPublicKey: parsed.agreementPublicKey
      };
    } catch {
      // Replace corrupt or legacy identity state with a fresh tab-scoped key.
    }
  }
  const [pair, agreementPair] = await Promise.all([
    createIdentityKeyPair(),
    createAgreementKeyPair()
  ]);
  const result = {
    privateKey: pair.privateKey,
    publicKey: await exportIdentityPublicKey(pair.publicKey),
    agreementPrivateKey: agreementPair.privateKey,
    agreementPublicKey: await exportAgreementPublicKey(agreementPair.publicKey)
  };
  safeStorageSet("session", storageKey, JSON.stringify({
    privateKey: await exportIdentityPrivateKey(pair.privateKey),
    publicKey: result.publicKey,
    agreementPrivateKey: await exportAgreementPrivateKey(agreementPair.privateKey),
    agreementPublicKey: result.agreementPublicKey
  }));
  return result;
}

function safeStorageGet(storage: "local" | "session", key: string): string | null {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    return target.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage: "local" | "session", key: string, value: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.setItem(key, value);
  } catch {
    // Private browsing and restrictive browser contexts can block storage access.
  }
}

function safeStorageRemove(storage: "local" | "session", key: string): void {
  try {
    const target = storage === "local" ? window.localStorage : window.sessionStorage;
    target.removeItem(key);
  } catch {
    // Storage cleanup is best effort in restrictive browser contexts.
  }
}

function durationUnitLabel(unit: DurationUnit): string {
  switch (unit) {
    case "minutes":
      return t("minutes").toLowerCase();
    case "hours":
      return t("hours").toLowerCase();
    case "days":
      return t("days").toLowerCase();
  }
}

function durationToMs(amount: number, unit: DurationUnit): number {
  switch (unit) {
    case "minutes":
      return amount * 60 * 1000;
    case "hours":
      return amount * 60 * 60 * 1000;
    case "days":
      return amount * 24 * 60 * 60 * 1000;
  }
}

function durationToSeconds(amount: number, unit: DurationUnit): number {
  return Math.floor(durationToMs(amount, unit) / 1000);
}

function formatSelectedDuration(amount: string, unit: DurationUnit, indefinite: boolean): string {
  if (indefinite) {
    return t("indefinite");
  }
  const value = Number(amount) || 0;
  const label = durationUnitLabel(unit);
  return `${value} ${label}`;
}

function parseDurationDraft(
  draft: DurationDraft,
  fallbackValue: number,
  fallbackUnit: DurationUnit,
  kind: "seconds" | "milliseconds"
): number | null {
  if (draft.indefinite) {
    return null;
  }

  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
  const unit = draft.unit || fallbackUnit;
  return kind === "seconds"
    ? durationToSeconds(safeAmount, unit)
    : durationToMs(safeAmount, unit);
}

function parseInviteDurationDraft(draft: InviteDurationDraft): number {
  const parsed = Number(draft.amount);
  const safeAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  return durationToMs(safeAmount, draft.unit || "minutes");
}

function toggleIndefiniteDuration(
  current: DurationDraft,
  checked: boolean,
  fallbackAmount: string
): DurationDraft {
  if (checked) {
    return {
      ...current,
      indefinite: true
    };
  }

  return {
    ...current,
    indefinite: false,
    amount: current.amount || fallbackAmount
  };
}

let turnstileScriptPromise: Promise<void> | null = null;
let turnstileWidgetId: string | undefined;
let turnstilePendingResolve: ((token: string | undefined) => void) | null = null;

function resolveTurnstile(token: string | undefined): void {
  const resolve = turnstilePendingResolve;
  turnstilePendingResolve = null;
  resolve?.(token);
}

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) {
    return Promise.resolve();
  }
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("challenge script failed to load"));
      document.head.appendChild(script);
    });
  }
  return turnstileScriptPromise;
}

// Runs an invisible Turnstile challenge when a site key is configured. Returns
// the token, or undefined when Turnstile is not configured (local dev) or the
// challenge could not run: the server decides whether a token is required.
async function getTurnstileToken(): Promise<string | undefined> {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  if (!siteKey) {
    return undefined;
  }
  try {
    await loadTurnstileScript();
  } catch {
    return undefined;
  }
  const turnstile = window.turnstile;
  if (!turnstile) {
    return undefined;
  }
  return new Promise<string | undefined>((resolve) => {
    turnstilePendingResolve = resolve;
    let container = document.getElementById("turnstile-holder");
    if (!container) {
      container = document.createElement("div");
      container.id = "turnstile-holder";
      container.style.position = "fixed";
      container.style.bottom = "-9999px";
      container.style.left = "-9999px";
      document.body.appendChild(container);
    }
    try {
      if (turnstileWidgetId === undefined) {
        turnstileWidgetId = turnstile.render(container, {
          sitekey: siteKey,
          execution: "execute",
          appearance: "interaction-only",
          callback: (token: string) => resolveTurnstile(token),
          "error-callback": () => resolveTurnstile(undefined),
          "timeout-callback": () => resolveTurnstile(undefined),
          "expired-callback": () => resolveTurnstile(undefined)
        });
      } else {
        turnstile.reset(turnstileWidgetId);
      }
      turnstile.execute(turnstileWidgetId, { sitekey: siteKey });
    } catch {
      resolveTurnstile(undefined);
    }
    // Never let a stuck challenge block room creation indefinitely.
    window.setTimeout(() => resolveTurnstile(undefined), 8000);
  });
}

async function createRoom(body: CreateRoomRequest): Promise<CreateRoomResponse> {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? t("failedCreateRoom"));
  }
  return response.json();
}

async function destroyRoom(roomId: string, creatorToken: string): Promise<RoomMetadata> {
  const response = await fetch(`/api/rooms/${roomId}/destroy`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ creatorToken })
  });
  if (!response.ok) {
    throw new Error(t("destroyRoomFailed"));
  }
  return response.json();
}

async function createInvite(roomId: string, creatorToken: string, ttlMs = 10 * 60 * 1000): Promise<RoomInvite> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, ttlMs })
  });
  if (!response.ok) {
    throw new Error(t("createInviteFailed"));
  }
  return response.json();
}

async function listInvites(roomId: string, creatorToken: string): Promise<RoomInvite[]> {
  const response = await fetch(`/api/rooms/${roomId}/invites`, {
    headers: { authorization: `Bearer ${creatorToken}` }
  });
  if (!response.ok) {
    throw new Error(t("failedLoadInvites"));
  }
  return response.json();
}

async function revokeInvite(roomId: string, creatorToken: string, token: string): Promise<void> {
  const response = await fetch(`/api/rooms/${roomId}/invites/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creatorToken, token })
  });
  if (!response.ok) {
    throw new Error(t("revokeInviteFailed"));
  }
}

async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function wsUrl(path: string): string {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  return url.toString();
}

function messageStatus(message: UiMessage): string {
  if (message.expiresAt) {
    return t("vanishesIn", { duration: formatRelativeDuration(message.expiresAt) });
  }
  return t("untilRoomCloses");
}

function upsertMessage(messages: UiMessage[], next: UiMessage): UiMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === next.id);
  if (existingIndex === -1) {
    return [...messages, next].sort((left, right) => left.sentAt - right.sentAt);
  }

  const copy = [...messages];
  copy[existingIndex] = {
    ...copy[existingIndex],
    ...next
  };
  return copy;
}

function colorFromSessionId(sessionId: string): string {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(index)) >>> 0;
  }
  const hue = hash % 360;
  const saturation = 62 + (hash % 12);
  const lightness = 48 + (hash % 10);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function inviteColor(invite: RoomInvite): string {
  return colorFromSessionId(invite.consumedBySessionId ?? invite.token);
}

// Look B message row: a left bar in the sender's identity colour over a 10% tint of it.
function bubbleStyle(sessionId: string): CSSProperties {
  const color = colorFromSessionId(sessionId);
  return {
    borderLeftColor: color,
    backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`
  };
}

// Joined invites show their guest's identity square; unused ones show an empty outline.
function inviteAccentStyle(invite: RoomInvite): CSSProperties | undefined {
  if (!(invite.consumedAt || invite.admittedAt || invite.consumedBySessionId)) {
    return undefined;
  }
  return { backgroundColor: inviteColor(invite) };
}

function inviteStatusLabel(invite: RoomInvite): string {
  if (invite.revokedAt) {
    return t("inviteStatusRevoked");
  }
  if (invite.consumedAt || invite.admittedAt) {
    return t("inviteStatusJoined");
  }
  if (invite.claimedAt) {
    return t("inviteStatusJoining");
  }
  if (invite.expiresAt <= Date.now()) {
    return t("inviteStatusExpired");
  }
  return t("inviteStatusExpires", { duration: formatRelativeDuration(invite.expiresAt) });
}

function buildInviteUrl(roomId: string, inviteToken: string, roomSecret: string): string {
  return `${window.location.origin}/c/${roomId}?invite=${encodeURIComponent(inviteToken)}#${roomSecret}`;
}

function roomStateMessage(status: RoomMetadata["status"], reason?: string): string {
  if (status === "destroyed") {
    return t("destroyed");
  }

  switch (reason) {
    case "join-timeout":
      return t("joinTimeout");
    case "inactive":
      return t("inactive");
    case "max-age":
      return t("maxAge");
    default:
      return t("unavailable");
  }
}

type RecoveryFocusTarget = { focusRef?: React.RefCallback<HTMLElement> };

const STATE_TITLE = "text-xl font-bold tracking-tight outline-none";
const STATE_COPY = "mt-3 text-sm leading-relaxed text-dim";
const STATE_LINK = `mt-6 inline-block rounded-sm text-sm text-acc hover:text-fg ${FOCUS_RING}`;

// Centered look-B box shared by the full-screen invite and room states.
function StateScreen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <TopRule />
      <main className="flex min-h-[calc(100dvh-2px)] items-center justify-center px-4 py-10">
        <section aria-live="polite" className="box w-full max-w-md p-6 pt-7">
          <span className="box-title">{label}</span>
          {children}
        </section>
      </main>
    </>
  );
}

function BackHomeLink() {
  return (
    <a className={STATE_LINK} href="/">
      <span aria-hidden="true">&larr; </span>
      {t("backHomeShort")}
    </a>
  );
}

function InvalidInviteScreen({ reason, focusRef }: { reason: InviteAccess } & RecoveryFocusTarget) {
  const copy =
    reason === "claimed"
      ? t("inviteClaimed")
      : reason === "used"
        ? t("inviteUsed")
        : t("inviteInvalid");
  return (
    <StateScreen label={t("boxInvite")}>
      <h1 className={STATE_TITLE} ref={focusRef} tabIndex={-1}>{t("invalidLink")}</h1>
      <p className={STATE_COPY}>{copy}</p>
      <BackHomeLink />
    </StateScreen>
  );
}

function RemovedFromRoomScreen({ focusRef }: RecoveryFocusTarget) {
  return (
    <StateScreen label={t("boxRoom")}>
      <h1 className={STATE_TITLE} ref={focusRef} tabIndex={-1}>{t("removedTitle")}</h1>
      <p className={STATE_COPY}>{t("removedCopy")}</p>
      <BackHomeLink />
    </StateScreen>
  );
}

function FileCard({ file, onDownload }: { file: UiFile; onDownload: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const progress = file.progress ?? 0;
  const percent = Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0;
  return (
    <div
      aria-label={t("fileCardLabel", { name: file.name })}
      className="file-card mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-acc"
      ref={cardRef}
      role="group"
      tabIndex={-1}
    >
      <span className="file-name min-w-0 truncate">{file.name}</span>
      <span className="file-size whitespace-nowrap text-dim">{formatBytes(file.size)}</span>
      {file.outgoing ? (
        <span className="file-status ml-auto text-xs text-dim">{t("fileSharedNote")}</span>
      ) : file.state === "offered" ? (
        <button aria-label={t("downloadFileLabel", { name: file.name })} className={`file-action ml-auto ${roomButtonClass} border-acc2 px-2 py-0.5 text-acc2`} onClick={(event) => {
          // Preserve the initiating control's focus before progress replaces it.
          if (document.activeElement === event.currentTarget) cardRef.current?.focus({ preventScroll: true });
          onDownload();
        }} type="button">
          {t("fileGet")}
        </button>
      ) : file.state === "requesting" || file.state === "transferring" ? (
        <div
          aria-label={t("fileProgressLabel", { name: file.name })}
          aria-live="off"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="file-progress ml-auto flex items-center gap-2"
          role="progressbar"
        >
          <div className="file-progress-track h-1 w-20 overflow-hidden rounded-full bg-line">
            <div className="file-progress-bar grad h-full" style={{ width: `${percent}%` }} />
          </div>
          <span className="file-progress-label text-xs tabular-nums text-dim">{percent}%</span>
        </div>
      ) : file.state === "ready" && file.url ? (
        <a aria-label={t("saveFileLabel", { name: file.name })} className={`file-action ml-auto ${roomButtonClass} border-acc2 px-2 py-0.5 text-acc2`} download={file.name} href={file.url}>
          {t("fileSave")}
        </a>
      ) : file.state === "error" ? (
        <span className="file-status file-status-error basis-full text-xs text-danger">{t("transferFailed")}</span>
      ) : null}
    </div>
  );
}

function InviteCheckingScreen({ connection, error, onRetry, focusRef }: {
  connection: string;
  error: string | null;
  onRetry?: () => void;
} & RecoveryFocusTarget) {
  return (
    <StateScreen label={t("boxInvite")}>
      <h1 className={STATE_TITLE}>{t("checkingInvite")}</h1>
      <p className={STATE_COPY}>{t("verifyingInvite")}</p>
      <p className="mt-4 text-xs text-acc2 outline-none" ref={focusRef} tabIndex={-1}>
        <span aria-hidden="true">&gt; </span>
        {connection}
      </p>
      {error ? <p className="error-text mt-3 text-sm text-danger" role="alert">{error}</p> : null}
      {onRetry ? (
        <button
          className={`mt-6 rounded-md border border-line px-4 py-2 text-sm hover:border-acc hover:text-acc ${FOCUS_RING}`}
          onClick={onRetry}
          type="button"
        >
          {t("retryConnection")}
        </button>
      ) : null}
    </StateScreen>
  );
}

function RoomGoneScreen({ fromInvite, reason, focusRef }: { fromInvite: boolean; reason?: string } & RecoveryFocusTarget) {
  return (
    <StateScreen label={fromInvite ? t("boxInvite") : t("boxRoom")}>
      <h1 className={STATE_TITLE} ref={focusRef} tabIndex={-1}>{t("roomGone")}</h1>
      <p className={STATE_COPY}>{reason ?? t("roomGoneCopy")}</p>
      <a
        className={`grad mt-6 inline-block rounded-md px-4 py-2.5 text-sm font-bold lowercase ${FOCUS_RING}`}
        href="/"
      >
        {t("startNew")}
        <span aria-hidden="true"> &rarr;</span>
      </a>
    </StateScreen>
  );
}

export function App() {
  const route = roomPathname();
  useEffect(() => {
    const previousLanguage = document.documentElement.lang;
    // Every view, including the limits page, uses the catalog locale.
    document.documentElement.lang = locale;
    return () => {
      document.documentElement.lang = previousLanguage;
    };
  }, []);
  if (route.view === "room" && route.roomId) {
    return <RoomPage roomId={route.roomId} />;
  }
  if (route.view === "limits") {
    return <LimitsPage />;
  }
  return <LandingPage />;
}

type DurationPreset = { label: string; amount: string; unit: DurationUnit } | { label: string; never: true };

const MESSAGE_PRESETS: DurationPreset[] = [
  { label: "1m", amount: "1", unit: "minutes" },
  { label: "7m", amount: "7", unit: "minutes" },
  { label: "1h", amount: "1", unit: "hours" },
  { label: "1d", amount: "1", unit: "days" },
  { label: "never", never: true }
];

const ROOM_PRESETS: DurationPreset[] = [
  { label: "10m", amount: "10", unit: "minutes" },
  { label: "1h", amount: "1", unit: "hours" },
  { label: "1d", amount: "1", unit: "days" },
  { label: "7d", amount: "7", unit: "days" },
  { label: "never", never: true }
];

function presetMatches(preset: DurationPreset, draft: DurationDraft): boolean {
  if ("never" in preset) {
    return draft.indefinite;
  }
  return !draft.indefinite && Number(draft.amount) === Number(preset.amount) && draft.unit === preset.unit;
}

const CHIP = `rounded border px-3 py-1.5 text-sm ${FOCUS_RING}`;
const CHIP_ON = "border-acc font-semibold text-acc";
const CHIP_OFF = "border-line text-dim hover:border-dim hover:text-fg";
const FIELD = `rounded border border-line bg-bg px-2 py-1.5 text-sm text-fg ${FOCUS_RING}`;

// Preset chips for one duration policy, plus a "custom" disclosure that keeps
// the original amount and unit inputs so any value the old form allowed still works.
function DurationPicker({
  id,
  label,
  summary,
  draft,
  presets,
  fallbackAmount,
  amountLabel,
  unitLabel,
  onChange
}: {
  id: string;
  label: string;
  summary: string;
  draft: DurationDraft;
  presets: DurationPreset[];
  fallbackAmount: string;
  amountLabel: string;
  unitLabel: string;
  onChange: (update: (current: DurationDraft) => DurationDraft) => void;
}) {
  const matched = presets.some((preset) => presetMatches(preset, draft));
  const [customOpen, setCustomOpen] = useState(false);
  // A value no chip matches keeps the custom inputs open so it stays visible and editable.
  const showCustom = customOpen || !matched;
  return (
    <div aria-labelledby={`${id}-label`} role="group">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-dim" id={`${id}-label`}>{label}</span>
        <span className="text-xs text-acc2">{summary}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {presets.map((preset) => {
          const active = presetMatches(preset, draft);
          return (
            <button
              aria-pressed={active}
              className={`${CHIP} ${active ? CHIP_ON : CHIP_OFF}`}
              key={preset.label}
              onClick={() =>
                onChange((current) =>
                  "never" in preset
                    ? toggleIndefiniteDuration(current, true, fallbackAmount)
                    : { amount: preset.amount, unit: preset.unit, indefinite: false }
                )
              }
              type="button"
            >
              {"never" in preset ? t("presetNever") : preset.label}
            </button>
          );
        })}
        <button
          aria-controls={`${id}-custom`}
          aria-expanded={showCustom}
          className={`${CHIP} ${matched ? CHIP_OFF : CHIP_ON}`}
          onClick={() => setCustomOpen((open) => (matched ? !open : true))}
          type="button"
        >
          {t("customDuration")}
          <span aria-hidden="true">{showCustom ? " -" : " +"}</span>
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2" hidden={!showCustom} id={`${id}-custom`}>
        <input
          aria-label={amountLabel}
          className={`${FIELD} w-24`}
          inputMode="numeric"
          min="1"
          onChange={(event) => {
            const amount = event.target.value;
            onChange((current) => ({ ...current, amount, indefinite: false }));
          }}
          type="number"
          value={draft.indefinite ? "" : draft.amount}
        />
        <select
          aria-label={unitLabel}
          className={FIELD}
          onChange={(event) => {
            const unit = event.target.value as DurationUnit;
            onChange((current) => ({
              ...current,
              unit,
              indefinite: false,
              amount: current.amount || fallbackAmount
            }));
          }}
          value={draft.unit}
        >
          <option value="minutes">{t("minutes")}</option>
          <option value="hours">{t("hours")}</option>
          <option value="days">{t("days")}</option>
        </select>
      </div>
    </div>
  );
}

const HOW_STEPS: [MessageKey, MessageKey][] = [
  ["howCreateTitle", "howCreateCopy"],
  ["howInviteTitle", "howInviteCopy"],
  ["howDestroyTitle", "howDestroyCopy"]
];

function LandingPage() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageDuration, setMessageDuration] = useState<DurationDraft>({
    amount: "7",
    unit: "minutes",
    indefinite: false
  });
  const [roomDuration, setRoomDuration] = useState<DurationDraft>({
    amount: "10",
    unit: "minutes",
    indefinite: false
  });

  async function handleCreate() {
    try {
      setCreating(true);
      setError(null);
      const secret = generateRoomSecret();
      const turnstileToken = await getTurnstileToken();
      const room = await createRoom({
        disappearAfterReadSeconds: parseDurationDraft(
          messageDuration,
          7,
          "minutes",
          "seconds"
        ),
        inactivityTimeoutMs: parseDurationDraft(roomDuration, 10, "minutes", "milliseconds"),
        maxAgeMs: null,
        turnstileToken
      });
      safeStorageSet("local", creatorTokenKey(room.roomId), room.creatorToken);
      window.location.assign(`${room.roomUrl}#${secret}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("unableCreateRoom"));
      setCreating(false);
    }
  }

  return (
    <>
      <TopRule />
      <main className="mx-auto flex min-h-[calc(100dvh-2px)] max-w-5xl flex-col px-4 py-6 sm:px-8">
        <SiteHeader />

        <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[1.15fr_1fr]">
          <div className="min-w-0">
            <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
              {t("heroLineOne")}
              <br />
              <span className="grad-text">{t("heroLineTwo")}</span>
            </h1>
            <p className="mt-6 max-w-md text-[15px] leading-relaxed text-dim">{t("heroLede")}</p>
            <dl
              aria-label={t("stripLabel")}
              className="mt-8 grid max-w-md grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line text-xs"
            >
              <div className="bg-panel p-3">
                <dt className="text-dim">{t("stripCipher")}</dt>
                <dd className="mt-1 font-semibold">AES-GCM</dd>
              </div>
              <div className="bg-panel p-3">
                <dt className="text-dim">{t("stripKey")}</dt>
                <dd className="mt-1 font-semibold">#fragment</dd>
              </div>
              <div className="bg-panel p-3">
                <dt className="text-dim">{t("stripFiles")}</dt>
                <dd className="mt-1 font-semibold">{MAX_FILE_BYTES / (1024 * 1024)} MiB</dd>
              </div>
            </dl>
          </div>

          <section aria-labelledby="new-room-title" className="box min-w-0 p-5 pt-7 sm:p-6 sm:pt-7">
            <h2 className="box-title" id="new-room-title">{t("newRoom")}</h2>
            <DurationPicker
              amountLabel={t("messageDurationAmount")}
              draft={messageDuration}
              fallbackAmount="7"
              id="message-policy"
              label={t("vanishAfter")}
              onChange={setMessageDuration}
              presets={MESSAGE_PRESETS}
              summary={formatSelectedDuration(
                messageDuration.amount,
                messageDuration.unit,
                messageDuration.indefinite
              )}
              unitLabel={t("messageDurationUnit")}
            />
            <div className="mt-6">
              <DurationPicker
                amountLabel={t("roomDurationAmount")}
                draft={roomDuration}
                fallbackAmount="10"
                id="room-policy"
                label={t("selfDestructAfter")}
                onChange={setRoomDuration}
                presets={ROOM_PRESETS}
                summary={
                  roomDuration.indefinite
                    ? t("onlyManualDestroy")
                    : `${formatSelectedDuration(roomDuration.amount, roomDuration.unit, false)} ${t("idle")}`
                }
                unitLabel={t("roomDurationUnit")}
              />
            </div>
            <button
              className={`grad mt-8 w-full rounded-md px-4 py-3 text-sm font-bold lowercase disabled:opacity-60 ${FOCUS_RING}`}
              disabled={creating}
              onClick={handleCreate}
              type="button"
            >
              {creating ? t("creatingRoom") : t("createRoom")}
              {creating ? null : <span aria-hidden="true"> &rarr;</span>}
            </button>
            {error ? <p className="error-text mt-4 text-sm text-danger" role="alert">{error}</p> : null}
            <p className="mt-4 text-[11px] leading-relaxed text-dim">
              {t("createFootnote")}
              {" · "}
              <a className={`rounded-sm text-acc2 underline underline-offset-2 hover:text-fg ${FOCUS_RING}`} href="/limits">
                {t("readLimits")}
              </a>
            </p>
          </section>
        </section>

        <section aria-labelledby="how-title" className="scroll-mt-6 border-t border-line py-10" id="how">
          <h2 className="text-xs uppercase tracking-[0.12em] text-dim" id="how-title">{t("howTitle")}</h2>
          <ol className="mt-6 grid gap-6 sm:grid-cols-3">
            {HOW_STEPS.map(([title, copy], index) => (
              <li className="min-w-0" key={title}>
                <p className="text-sm font-bold">
                  <span className="grad-text">{String(index + 1).padStart(2, "0")}</span> {t(title)}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-dim">{t(copy)}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </>
  );
}

function RoomPage({ roomId }: { roomId: string }) {
  const roomSecret = window.location.hash.replace(/^#/, "");
  const inviteToken = new URLSearchParams(window.location.search).get("invite") ?? "";
  const storedCreatorToken = safeStorageGet("local", creatorTokenKey(roomId)) ?? "";
  const isInviteGuest = Boolean(inviteToken && !storedCreatorToken);
  const [room, setRoom] = useState<RoomMetadata | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [invites, setInvites] = useState<RoomInvite[]>([]);
  const [manualInvite, setManualInvite] = useState<{ token: string; trigger: HTMLButtonElement; focusOwner: Element | null } | null>(null);
  const inviteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const inviteActionRef = useRef(0);
  const currentInvitesRef = useRef(invites);
  currentInvitesRef.current = invites;
  const [draft, setDraft] = useState("");
  const draftRevisionRef = useRef(0);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState(t("connecting"));
  const [canRetryConnection, setCanRetryConnection] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const retryConnectionRef = useRef<(() => void) | null>(null);
  const retryFocusTargetRef = useRef<HTMLElement | null>(null);
  const preserveRetryFocusRef = useRef(false);
  const setRetryFocusTarget = useCallback((element: HTMLElement | null) => {
    if (!element) {
      // Follow a replacement view only while the manually focused status owns focus.
      preserveRetryFocusRef.current = preserveRetryFocusRef.current &&
        document.activeElement === retryFocusTargetRef.current;
    }
    retryFocusTargetRef.current = element;
    if (element && preserveRetryFocusRef.current) element.focus();
  }, []);
  const [keyReady, setKeyReady] = useState(false);
  const [presence, setPresence] = useState<PresenceSnapshot>({ count: 0, connectedSessionIds: [] });
  const [now, setNow] = useState(Date.now());
  const conversationFind = useConversationFind(messages, now, (id) => {
    const log = chatLogRef.current;
    const article = log?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!log || !article) return;
    log.scrollTop += article.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
    handleConversationScroll();
  });
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const concealment = useConversationConcealment(() => conversationFind.close());
  const [notFound, setNotFound] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<ActionFeedback>("idle");
  const [destroyFeedback, setDestroyFeedback] = useState<ActionFeedback>("idle");
  const [inviteFeedback, setInviteFeedback] = useState<InviteFeedback>("idle");
  const [destroying, setDestroying] = useState(false);
  const [inviteAccess, setInviteAccess] = useState<InviteAccess>(isInviteGuest ? "checking" : "granted");
  const [removedFromRoom, setRemovedFromRoom] = useState(false);
  // Below lg the invites panel is folded away behind a header toggle.
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [inviteDuration, setInviteDuration] = useState<InviteDurationDraft>({
    amount: "10",
    unit: "minutes"
  });
  const [sessionId] = useState(() => {
    const stored = safeStorageGet("session", sessionKey(roomId));
    if (stored) {
      return stored;
    }
    const next = generateSessionId();
    safeStorageSet("session", sessionKey(roomId), next);
    return next;
  });
  const creatorToken = storedCreatorToken;
  const socketRef = useRef<WebSocket | null>(null);
  const roomKeyRef = useRef<CryptoKey | null>(null);
  const roomKeysRef = useRef(new Map<number, CryptoKey>());
  const keyEpochRef = useRef(1);
  const keyReadyRef = useRef(false);
  const membershipVersionRef = useRef(0);
  const keyWorkGenerationRef = useRef(0);
  const identityKeyRef = useRef<string>("");
  const identityPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPrivateKeyRef = useRef<CryptoKey | null>(null);
  const agreementPublicKeyRef = useRef<string>("");
  const peerIdentityKeysRef = useRef(new Map<string, string>());
  const peersRef = useRef(new Map<string, PeerDescriptor>());
  const joinedRef = useRef(false);
  // Mirror of the latest room status so the socket close handler (captured once
  // by the connection effect) can distinguish a live-room drop from an
  // already-closed room without reading a stale `room` value.
  const roomStatusRef = useRef<RoomMetadata["status"] | null>(null);
  const { chatLogRef, awayFromLatest, newMessageCount, jumpToLatest, handleConversationScroll } =
    useConversationScroll(messages, ready, conversationFind.open || concealment.hidden);
  const messageRef = useRef(new Map<string, AuthenticatedPeerEvent>());
  const replayGuardRef = useRef<ReplayGuard | null>(null);
  const eventReplayGuardRef = useRef<ReplayGuard | null>(null);
  if (!replayGuardRef.current) {
    replayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "message")
    );
  }
  if (!eventReplayGuardRef.current) {
    eventReplayGuardRef.current = new ReplayGuard(
      10000,
      window.sessionStorage,
      replayStateKey(roomId, sessionId, "event")
    );
  }
  const shouldRequestSyncRef = useRef(false);
  // Files being served by this client (we are the sender), kept in memory so we
  // can stream chunks on demand when a peer requests them.
  const outgoingFilesRef = useRef(new Map<string, File>());
  const outgoingFileHashesRef = useRef(new Map<string, string>());
  const outgoingFileEpochsRef = useRef(new Map<string, number>());
  // Files being received by this client, accumulating decrypted chunks.
  const incomingFilesRef = useRef(new Map<string, IncomingFile>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Object URLs created for received files, revoked on expiry/unmount.
  const objectUrlsRef = useRef(new Set<string>());

  async function sendPeerData(payload: PeerDataEvent, toSessionId?: string, isCurrent?: () => boolean) {
    const socket = socketRef.current;
    const privateKey = identityPrivateKeyRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !joinedRef.current || !privateKey || (isCurrent && !isCurrent())) return null;
    const data = await createAuthenticatedPeerEvent(
      privateKey,
      roomId,
      sessionId,
      toSessionId ?? null,
      payload
    );
    // Signing yields to the browser; the connection may close before it finishes.
    if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN || !joinedRef.current || (isCurrent && !isCurrent())) return null;
    socket.send(JSON.stringify({ type: "peer_data", toSessionId, data }));
    eventReplayGuardRef.current?.markLocal(data.eventId);
    return data;
  }

  function currentKeyLeader(): PeerDescriptor | undefined {
    return [...peersRef.current.values()].sort((left, right) =>
      Number(right.creator) - Number(left.creator) ||
      left.connectedAt - right.connectedAt ||
      left.sessionId.localeCompare(right.sessionId)
    )[0];
  }

  // Crypto can finish after a disconnect, a new membership, or effect cleanup.
  function captureKeyWork(keyEpoch: number, leader: PeerDescriptor): () => boolean {
    const socket = socketRef.current;
    const generation = keyWorkGenerationRef.current;
    return () => {
      const currentLeader = currentKeyLeader();
      return generation === keyWorkGenerationRef.current &&
        socket !== null && socketRef.current === socket && socket.readyState === WebSocket.OPEN &&
        joinedRef.current && roomStatusRef.current === "open" &&
        membershipVersionRef.current === keyEpoch &&
        currentLeader?.sessionId === leader.sessionId &&
        currentLeader.identityKey === leader.identityKey &&
        currentLeader.agreementKey === leader.agreementKey;
    };
  }

  async function rotateRoomKey(keyEpoch: number) {
    const leader = currentKeyLeader();
    const agreementPrivateKey = agreementPrivateKeyRef.current;
    if (!leader || leader.sessionId !== sessionId || !agreementPrivateKey) return;
    const isCurrent = captureKeyWork(keyEpoch, leader);
    if (!isCurrent()) return;
    const roomSecretForEpoch = generateRoomSecret();
    const nextKey = await deriveRoomKey(roomSecretForEpoch);
    if (!isCurrent()) return;
    roomKeysRef.current.set(keyEpoch, nextKey);
    roomKeyRef.current = nextKey;
    keyEpochRef.current = keyEpoch;
    keyReadyRef.current = true;
    setKeyReady(true);
    setConnection(t("connected"));
    await Promise.all([...peersRef.current.values()]
      .filter((peer) => peer.sessionId !== sessionId)
      .map(async (peer) => {
        const wrapped = await wrapRoomSecret(
          agreementPrivateKey,
          peer.agreementKey,
          roomId,
          keyEpoch,
          sessionId,
          peer.sessionId,
          roomSecretForEpoch
        );
        if (!isCurrent()) return;
        await sendPeerData({
          type: "key_rotation",
          keyEpoch,
          senderAgreementKey: agreementPublicKeyRef.current,
          ...wrapped
        }, peer.sessionId, isCurrent);
      }));
  }

  function beginMembershipChange(keyEpoch: number) {
    if (keyEpoch <= membershipVersionRef.current) return;
    membershipVersionRef.current = keyEpoch;
    keyReadyRef.current = false;
    setKeyReady(false);
    setConnection(t("securing"));
    void rotateRoomKey(keyEpoch);
  }

  function clearRoomSecurityState() {
    conversationFind.close();
    for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    replayGuardRef.current?.clear();
    eventReplayGuardRef.current?.clear();
    roomKeysRef.current.clear();
    keyReadyRef.current = false;
    setKeyReady(false);
    safeStorageRemove("session", identityKeyPairKey(roomId, sessionId));
    safeStorageRemove("session", sessionKey(roomId));
  }

  async function refreshInvites() {
    if (!creatorToken) {
      return;
    }
    try {
      const nextInvites = await listInvites(roomId, creatorToken);
      currentInvitesRef.current = nextInvites;
      setInvites(nextInvites);
    } catch {
      // Keep the last known invite state if the refresh fails.
    }
  }

  function updateFileMessage(fileId: string, patch: Partial<UiFile>) {
    startTransition(() => {
      setMessages((current) =>
        current.map((message) =>
          message.kind === "file" && message.file?.fileId === fileId
            ? { ...message, file: { ...message.file, ...patch } }
            : message
        )
      );
    });
  }

  function removeIncomingFile(fileId: string, entry = incomingFilesRef.current.get(fileId)) {
    if (!entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (incomingFilesRef.current.get(fileId) === entry) incomingFilesRef.current.delete(fileId);
  }

  function armFileTimeout(fileId: string, entry: IncomingFile) {
    if (!entry.requested || incomingFilesRef.current.get(fileId) !== entry) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    const timeoutId = window.setTimeout(() => {
      // A cleared/queued callback must not remove a replacement or refreshed transfer.
      if (incomingFilesRef.current.get(fileId) !== entry || entry.timeoutId !== timeoutId) return;
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      void sendPeerData({ type: "file_cancel", fileId, reason: "timeout" }, entry.senderSessionId);
    }, 30_000);
    entry.timeoutId = timeoutId;
  }

  async function waitForSocketDrain() {
    const socket = socketRef.current;
    if (!socket) {
      return;
    }
    const maxBuffer = 4 * 1024 * 1024;
    while (socket.bufferedAmount > maxBuffer && socket.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
  }

  // Sender side: stream an outgoing file to the requesting peer as encrypted chunks.
  async function serveFile(fileId: string, requesterSessionId: string) {
    const file = outgoingFilesRef.current.get(fileId);
    const keyEpoch = outgoingFileEpochsRef.current.get(fileId);
    const key = typeof keyEpoch === "number" ? roomKeysRef.current.get(keyEpoch) : undefined;
    if (!file || !key) {
      return;
    }
    const buffer = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.max(1, Math.ceil(buffer.byteLength / FILE_CHUNK_BYTES));
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * FILE_CHUNK_BYTES;
      const slice = buffer.subarray(start, Math.min(start + FILE_CHUNK_BYTES, buffer.byteLength));
      const { ciphertext, nonce } = await encryptBytes(key, slice);
      await waitForSocketDrain();
      const delivered = await sendPeerData(
        { type: "file_chunk", fileId, chunkIndex: index, totalChunks, ciphertext, nonce, keyEpoch: keyEpoch! },
        requesterSessionId
      );
      if (!delivered) {
        return;
      }
    }
    const sha256 = outgoingFileHashesRef.current.get(fileId);
    if (sha256) await sendPeerData({ type: "file_complete", fileId, sha256 }, requesterSessionId);
  }

  // Receiver side: decrypt and store an incoming chunk, updating transfer progress.
  async function receiveChunk(payload: PeerFileChunk) {
    const key = roomKeysRef.current.get(payload.keyEpoch);
    if (!key) {
      return;
    }
    const entry = incomingFilesRef.current.get(payload.fileId);
    if (!entry?.requested) return;
    if (entry.keyEpoch !== payload.keyEpoch) return;
    if (entry.chunks.length !== payload.totalChunks) {
      entry.chunks = new Array<Uint8Array | undefined>(payload.totalChunks);
      entry.received = 0;
      entry.receivedBytes = 0;
      entry.totalChunks = payload.totalChunks;
    }
    if (!entry.chunks[payload.chunkIndex]) {
      try {
        const chunk = await decryptBytes(key, payload.ciphertext, payload.nonce);
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        if (entry.receivedBytes + chunk.byteLength > entry.size || chunk.byteLength > FILE_CHUNK_BYTES) {
          throw new Error("File chunk exceeds declared bounds.");
        }
        entry.chunks[payload.chunkIndex] = chunk;
        entry.received += 1;
        entry.receivedBytes += chunk.byteLength;
      } catch {
        if (incomingFilesRef.current.get(payload.fileId) !== entry) return;
        removeIncomingFile(payload.fileId, entry);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }
    }
    updateFileMessage(payload.fileId, {
      state: "transferring",
      progress: entry.totalChunks ? entry.received / entry.totalChunks : 0
    });
    armFileTimeout(payload.fileId, entry);
  }

  // Receiver side: reassemble a completed file into a downloadable blob URL.
  async function finalizeIncoming(fileId: string, announcedSha256: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry?.requested) return;
    if (entry.timeoutId !== undefined) window.clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    if (entry.totalChunks === 0 || entry.received < entry.totalChunks) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      return;
    }
    const parts = entry.chunks.filter((chunk): chunk is Uint8Array => Boolean(chunk));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const digest = await sha256Base64Url(bytes);
    if (incomingFilesRef.current.get(fileId) !== entry) return;
    if (bytes.byteLength !== entry.size || digest !== entry.sha256 || digest !== announcedSha256) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      await sendPeerData({ type: "file_cancel", fileId, reason: "integrity" }, entry.senderSessionId);
      return;
    }
    const blob = new Blob(parts as BlobPart[], { type: entry.mimeType });
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.add(url);
    removeIncomingFile(fileId, entry);
    updateFileMessage(fileId, { state: "ready", progress: 1, url });
  }

  async function handleAttachFiles(fileList: FileList | null) {
    if (!fileList || !room || room.status !== "open" || !keyReadyRef.current) {
      return;
    }
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(t("fileTooLarge", { name: file.name, limit: formatBytes(MAX_FILE_BYTES) }));
        continue;
      }
      const fileId = generateMessageId();
      const sentAt = Date.now();
      const mimeType = file.type || "application/octet-stream";
      const expiresAfterReadSeconds = room.disappearAfterReadSeconds ?? null;
      const expiresAt =
        typeof expiresAfterReadSeconds === "number"
          ? sentAt + expiresAfterReadSeconds * 1000
          : undefined;
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = await sha256Base64Url(fileBytes);
      outgoingFilesRef.current.set(fileId, file);
      outgoingFileHashesRef.current.set(fileId, sha256);
      outgoingFileEpochsRef.current.set(fileId, keyEpochRef.current);
      setError(null);
      jumpToLatest();
      startTransition(() => {
        setMessages((current) =>
          upsertMessage(current, {
            id: fileId,
            senderSessionId: sessionId,
            sentAt,
            expiresAt,
            kind: "file",
            file: {
              fileId,
              name: file.name,
              mimeType,
              size: file.size,
              state: "sent",
              progress: 1,
              outgoing: true
            }
          })
        );
      });
      const delivered = await sendPeerData({
        type: "file_offer",
        fileId,
        senderSessionId: sessionId,
        name: file.name,
        mimeType,
        size: file.size,
        sentAt,
        expiresAfterReadSeconds,
        sha256,
        keyEpoch: keyEpochRef.current
      });
      if (!delivered) {
        setError(t("fileDeliveryPending"));
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleRequestFile(fileId: string, senderSessionId: string) {
    const entry = incomingFilesRef.current.get(fileId);
    if (!entry || entry.senderSessionId !== senderSessionId || entry.requested) return;
    entry.requested = true;
    armFileTimeout(fileId, entry);
    updateFileMessage(fileId, { state: "transferring", progress: 0 });
    const requested = await sendPeerData({ type: "file_request", fileId }, senderSessionId);
    if (!requested && incomingFilesRef.current.get(fileId) === entry) {
      removeIncomingFile(fileId, entry);
      updateFileMessage(fileId, { state: "error" });
      setError(t("fileRequestFailed"));
    }
  }

  useEffect(() => {
    if (!roomSecret) {
      setError(t("missingSecret"));
      return;
    }

    let active = true;
    let reconnectAllowed = true;
    const connectionAllowed = () => active && reconnectAllowed &&
      (roomStatusRef.current === null || roomStatusRef.current === "open");
    const reconnect = new ReconnectScheduler(
      connectionAllowed,
      () => { void bootstrap(); },
      (delay) => {
        setCanRetryConnection(false);
        setConnection(t("reconnecting", { seconds: Math.ceil(delay / 1000) }));
      }
    );
    function stopReconnecting() {
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
      keyWorkGenerationRef.current += 1;
      reconnectAllowed = false;
      reconnect.cancel();
      if (active) setCanRetryConnection(false);
    }
    retryConnectionRef.current = () => {
      if (!reconnect.canRetry) return;
      const focusTarget = retryFocusTargetRef.current;
      focusTarget?.focus({ preventScroll: true });
      preserveRetryFocusRef.current = Boolean(focusTarget && document.activeElement === focusTarget);
      setCanRetryConnection(false);
      setConnectionError(null);
      setConnection(t("connecting"));
      reconnect.retryNow();
    };
    const tick = window.setInterval(() => setNow(Date.now()), 1000);

    async function bootstrap() {
      try {
        const [metadata, key, identity] = await Promise.all([
          loadRoomMetadata(roomId),
          deriveRoomKey(roomSecret),
          loadIdentityKeyPair(roomId, sessionId)
        ]);
        if (!connectionAllowed()) {
          return;
        }
        roomKeyRef.current = key;
        roomKeysRef.current.set(0, key);
        identityPrivateKeyRef.current = identity.privateKey;
        identityKeyRef.current = identity.publicKey;
        agreementPrivateKeyRef.current = identity.agreementPrivateKey;
        agreementPublicKeyRef.current = identity.agreementPublicKey;
        peerIdentityKeysRef.current.set(sessionId, identity.publicKey);
        roomStatusRef.current = metadata.status;
        setRoom(metadata);
        if (metadata.status !== "open") {
          stopReconnecting();
          setReady(true);
          setConnection(t("closed"));
          setRoomNotice(roomStateMessage(metadata.status));
          return;
        }

        const socket = new WebSocket(wsUrl(`/api/rooms/${roomId}/ws`));
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t("connected"));
          joinedRef.current = false;
          socket.send(
            JSON.stringify({
              type: "join",
              sessionId,
              identityKey: identityKeyRef.current,
              agreementKey: agreementPublicKeyRef.current,
              creatorToken: creatorToken || undefined,
              inviteToken: inviteToken || undefined
            })
          );
        });

        socket.addEventListener("close", (closeEvent) => {
          if (!active || socketRef.current !== socket) return;
          keyWorkGenerationRef.current += 1;
          joinedRef.current = false;
          keyReadyRef.current = false;
          setKeyReady(false);
          if (isInviteGuest && closeEvent.code === 4403) {
            stopReconnecting();
            setInviteAccess((current) => {
              if (current === "claimed" || current === "used") {
                return current;
              }
              if (closeEvent.reason === "invite claimed") {
                return "claimed";
              }
              if (closeEvent.reason === "invite used") {
                return "used";
              }
              return "invalid";
            });
            setError(null);
            setRoom(null);
            setRoomNotice(null);
            setReady(true);
            return;
          }
          if (reconnect.schedule()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(roomStatusRef.current === "open" ? t("disconnected") : t("closed"));
        });

        socket.addEventListener("error", () => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          setConnection(t("connectionError"));
        });

        socket.addEventListener("message", async (event) => {
          if (!connectionAllowed() || socketRef.current !== socket) return;
          const payload = JSON.parse(String(event.data)) as ServerEvent;
          if (payload.type === "joined") {
            joinedRef.current = true;
            reconnect.reset();
            setCanRetryConnection(false);
            setConnectionError(null);
            startTransition(() => {
              setInviteAccess("granted");
              setRoom(payload.room);
              setPresence(payload.presence);
              setReady(true);
            });
            if (creatorToken) {
              void refreshInvites();
            }
            peersRef.current.clear();
            peersRef.current.set(sessionId, payload.self);
            for (const peer of payload.peers) {
              peersRef.current.set(peer.sessionId, peer);
              peerIdentityKeysRef.current.set(peer.sessionId, peer.identityKey);
            }
            beginMembershipChange(payload.room.membershipVersion);
            shouldRequestSyncRef.current = payload.peers.length > 0;
            if (payload.peers.length > 0 && keyReadyRef.current) {
              await sendPeerData({ type: "sync_request" });
            }
            return;
          }

          if (payload.type === "presence") {
            startTransition(() => setPresence(payload.presence));
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "peer_joined") {
            peerIdentityKeysRef.current.set(payload.peer.sessionId, payload.peer.identityKey);
            peersRef.current.set(payload.peer.sessionId, payload.peer);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => ({
                count: current.connectedSessionIds.includes(payload.peer.sessionId)
                  ? current.count
                  : current.count + 1,
                connectedSessionIds: current.connectedSessionIds.includes(payload.peer.sessionId)
                  ? current.connectedSessionIds
                  : [...current.connectedSessionIds, payload.peer.sessionId]
              }))
            );
            if (creatorToken) {
              void refreshInvites();
            }
            if (messageRef.current.size > 0) {
              await sendPeerData({
                type: "sync_response",
                messages: [...messageRef.current.values()]
                  .sort((left, right) => left.sentAt - right.sentAt)
                  .slice(-MAX_TRANSCRIPT_SYNC_MESSAGES),
                completeness: "peer-partial",
                truncated: messageRef.current.size > MAX_TRANSCRIPT_SYNC_MESSAGES
              }, payload.peer.sessionId);
            }
            return;
          }

          if (payload.type === "peer_left") {
            peersRef.current.delete(payload.sessionId);
            beginMembershipChange(payload.membershipVersion);
            startTransition(() =>
              setPresence((current) => {
                const nextIds = current.connectedSessionIds.filter((id) => id !== payload.sessionId);
                return {
                  count: nextIds.length,
                  connectedSessionIds: nextIds
                };
              })
            );
            if (creatorToken) {
              void refreshInvites();
            }
            for (const [fileId, transfer] of incomingFilesRef.current) {
              if (transfer.senderSessionId === payload.sessionId) {
                removeIncomingFile(fileId, transfer);
                updateFileMessage(fileId, { state: "error" });
              }
            }
            return;
          }

          if (payload.type === "peer_data") {
            await handlePeerData(payload.fromSessionId, payload.data, socket);
            return;
          }

          if (payload.type === "room_state") {
            stopReconnecting();
            roomStatusRef.current = payload.status;
            startTransition(() => {
              setRoom((current) =>
                current
                  ? {
                      ...current,
                      status: payload.status
                    }
                  : current
              );
              setRoomNotice(roomStateMessage(payload.status, payload.reason));
              setDestroying(false);
              setDestroyFeedback(payload.status === "destroyed" ? "success" : "idle");
              setConnection(t("closed"));
            });
            clearRoomSecurityState();
            await sendPeerData({ type: "peer_destroy" });
            return;
          }

          if (payload.type === "participant_kicked") {
            if (payload.sessionId === sessionId) {
              stopReconnecting();
              setRemovedFromRoom(true);
              setRoomNotice(null);
              setError(null);
              setConnection(t("closed"));
              joinedRef.current = false;
              clearRoomSecurityState();
              socket.close();
            }
            if (creatorToken) {
              void refreshInvites();
            }
            return;
          }

          if (payload.type === "error") {
            if (
              payload.code === "invite_required" ||
              payload.code === "invite_claimed" ||
              payload.code === "invite_used"
            ) {
              stopReconnecting();
              setInviteAccess(
                payload.code === "invite_claimed"
                  ? "claimed"
                  : payload.code === "invite_used"
                    ? "used"
                    : "invalid"
              );
              setError(null);
              setRoom(null);
              setRoomNotice(null);
              setReady(true);
              socket.close(4403, "invalid-invite");
              return;
            }
            if (payload.code === "peer_missing") {
              return;
            }
            setError(payload.message);
          }
        });
      } catch (cause) {
        if (!connectionAllowed()) return;
        if (cause instanceof RoomMetadataError && cause.kind === "missing") {
          stopReconnecting();
          setNotFound(true);
          setReady(true);
          return;
        }
        if (cause instanceof RoomMetadataError && cause.kind === "temporary") {
          if (reconnect.schedule()) return;
          setCanRetryConnection(reconnect.canRetry);
          setConnection(t("disconnected"));
          setConnectionError(t("failedJoinRoom"));
          return;
        }
        setCanRetryConnection(false);
        setConnection(t("disconnected"));
        setError(cause instanceof RoomMetadataError ? t("failedJoinRoom") :
          cause instanceof Error ? cause.message : t("failedJoinRoom"));
      }
    }

    async function verifyPeerEvent(
      event: AuthenticatedPeerEvent,
      relaySenderId?: string
    ): Promise<boolean> {
      if (
        event.roomId !== roomId ||
        (relaySenderId && event.senderSessionId !== relaySenderId) ||
        (event.targetSessionId !== null && event.targetSessionId !== sessionId) ||
        event.sentAt > Date.now() + 5 * 60 * 1000
      ) return false;
      const encodedKey = peerIdentityKeysRef.current.get(event.senderSessionId);
      if (!encodedKey) return false;
      try {
        return await eventReplayGuardRef.current!.accept(event.eventId, null, async () => {
          const key = await importIdentityPublicKey(encodedKey);
          if (!(await verifyAuthenticatedPeerEvent(key, event))) {
            throw new Error("Peer signature verification failed.");
          }
        });
      } catch {
        return false;
      }
    }

    async function addEnvelope(event: AuthenticatedPeerEvent) {
      if (event.payload.type !== "chat_message") return;
      const envelope = event.payload.envelope;
      const messageKey = roomKeysRef.current.get(envelope.keyEpoch);
      if (!messageKey) return;

      try {
        const received = await receiveTextMessage(
          messageKey, roomId, envelope, replayGuardRef.current!, event.senderSessionId
        );
        if (!received) return;
        const { plaintext, expiresAt } = received;
        messageRef.current.set(envelope.messageId, event);

        startTransition(() => {
          setMessages((current) =>
            upsertMessage(current, {
              id: envelope.messageId,
              senderSessionId: envelope.senderSessionId,
              plaintext,
              sentAt: envelope.sentAt,
              expiresAt,
              kind: "text"
            })
          );
        });
      } catch (cause) {
        setError(
          cause instanceof InvalidMessageEnvelopeError
            ? t("alteredMessage")
            : cause instanceof Error && cause.message === "Message replay limit reached."
            ? t("replayLimit")
            : t("authFailed")
        );
      }
    }

    async function handlePeerData(peerId: string, event: AuthenticatedPeerEvent, sourceSocket: WebSocket) {
      const verified = await verifyPeerEvent(event, peerId);
      if (!connectionAllowed() || socketRef.current !== sourceSocket || !joinedRef.current) return;
      if (!verified) {
        setError(t("authFailed"));
        return;
      }
      const payload = event.payload;
      if (payload.type === "key_rotation") {
        const leader = currentKeyLeader();
        const agreementPrivateKey = agreementPrivateKeyRef.current;
        if (
          !leader ||
          event.senderSessionId !== leader.sessionId ||
          payload.senderAgreementKey !== leader.agreementKey ||
          payload.keyEpoch !== membershipVersionRef.current ||
          payload.keyEpoch <= keyEpochRef.current ||
          !agreementPrivateKey
        ) return;
        const isCurrent = captureKeyWork(payload.keyEpoch, leader);
        if (!isCurrent()) return;
        try {
          const nextSecret = await unwrapRoomSecret(
            agreementPrivateKey,
            payload.senderAgreementKey,
            roomId,
            payload.keyEpoch,
            event.senderSessionId,
            sessionId,
            payload.ciphertext,
            payload.nonce
          );
          if (!isCurrent()) return;
          const nextKey = await deriveRoomKey(nextSecret);
          if (!isCurrent() || payload.keyEpoch <= keyEpochRef.current) return;
          roomKeysRef.current.set(payload.keyEpoch, nextKey);
          roomKeyRef.current = nextKey;
          keyEpochRef.current = payload.keyEpoch;
          keyReadyRef.current = true;
          setKeyReady(true);
          setConnection(t("connected"));
          if (shouldRequestSyncRef.current) await sendPeerData({ type: "sync_request" });
        } catch {
          if (isCurrent()) setError(t("authFailed"));
        }
        return;
      }
      if (payload.type === "chat_message") {
        await addEnvelope(event);
        return;
      }

      if (payload.type === "sync_request") {
        const transcript = [...messageRef.current.values()]
          .sort((left, right) => left.sentAt - right.sentAt)
          .slice(-MAX_TRANSCRIPT_SYNC_MESSAGES);
        await sendPeerData({
          type: "sync_response",
          messages: transcript,
          completeness: "peer-partial",
          truncated: messageRef.current.size > MAX_TRANSCRIPT_SYNC_MESSAGES
        }, peerId);
        return;
      }

      if (payload.type === "sync_response") {
        if (
          payload.completeness !== "peer-partial" ||
          payload.messages.length > MAX_TRANSCRIPT_SYNC_MESSAGES
        ) return;
        shouldRequestSyncRef.current = false;
        setRoomNotice(
          payload.messages.length === 0
            ? t("syncEmpty")
            : payload.truncated
              ? t("syncTruncated")
              : t("syncPartial")
        );
        for (const syncedEvent of payload.messages.slice(-MAX_TRANSCRIPT_SYNC_MESSAGES)) {
          if (await verifyPeerEvent(syncedEvent)) await addEnvelope(syncedEvent);
        }
        return;
      }

      if (payload.type === "file_offer") {
        if (
          payload.senderSessionId !== event.senderSessionId ||
          payload.size < 0 ||
          payload.size > MAX_FILE_BYTES ||
          !/^[A-Za-z0-9_-]{43}$/.test(payload.sha256)
        ) {
          setError(t("authFailed"));
          return;
        }
        const expiresAt =
          typeof payload.expiresAfterReadSeconds === "number"
            ? payload.sentAt + payload.expiresAfterReadSeconds * 1000
            : undefined;
        if (typeof expiresAt === "number" && expiresAt <= Date.now()) {
          return;
        }
        removeIncomingFile(payload.fileId);
        incomingFilesRef.current.set(payload.fileId, {
          requested: false,
          name: payload.name,
          mimeType: payload.mimeType || "application/octet-stream",
          size: payload.size,
          totalChunks: 0,
          received: 0,
          receivedBytes: 0,
          chunks: [],
          senderSessionId: payload.senderSessionId,
          sha256: payload.sha256,
          keyEpoch: payload.keyEpoch
        });
        startTransition(() => {
          setMessages((current) =>
            upsertMessage(current, {
              id: payload.fileId,
              senderSessionId: payload.senderSessionId,
              sentAt: payload.sentAt,
              expiresAt,
              kind: "file",
              file: {
                fileId: payload.fileId,
                name: payload.name,
                mimeType: payload.mimeType || "application/octet-stream",
                size: payload.size,
                state: "offered",
                progress: 0,
                outgoing: false
              }
            })
          );
        });
        return;
      }

      if (payload.type === "file_request") {
        void serveFile(payload.fileId, peerId);
        return;
      }

      if (payload.type === "file_chunk") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (
          !incoming ||
          incoming.senderSessionId !== event.senderSessionId ||
          !Number.isSafeInteger(payload.chunkIndex) ||
          !Number.isSafeInteger(payload.totalChunks) ||
          payload.chunkIndex < 0 ||
          payload.totalChunks < 1 ||
          payload.chunkIndex >= payload.totalChunks ||
          payload.totalChunks > Math.ceil(MAX_FILE_BYTES / FILE_CHUNK_BYTES) ||
          payload.totalChunks !== Math.max(1, Math.ceil(incoming.size / FILE_CHUNK_BYTES)) ||
          payload.keyEpoch !== incoming.keyEpoch
        ) {
          return;
        }
        await receiveChunk(payload);
        return;
      }

      if (payload.type === "file_complete") {
        const incoming = incomingFilesRef.current.get(payload.fileId);
        if (!incoming || incoming.senderSessionId !== event.senderSessionId) return;
        await finalizeIncoming(payload.fileId, payload.sha256);
        return;
      }

      if (payload.type === "file_cancel") {
        removeIncomingFile(payload.fileId);
        updateFileMessage(payload.fileId, { state: "error" });
        return;
      }

      if (payload.type === "peer_destroy") {
        stopReconnecting();
        setRoomNotice(t("peerDestroyed"));
        setConnection(t("closed"));
        clearRoomSecurityState();
      }
    }

    void bootstrap();

    return () => {
      active = false;
      stopReconnecting();
      retryConnectionRef.current = null;
      window.clearInterval(tick);
      socketRef.current?.close();
      for (const [fileId, transfer] of incomingFilesRef.current) removeIncomingFile(fileId, transfer);
    };
  }, [creatorToken, inviteToken, roomId, roomSecret, sessionId]);

  useEffect(() => {
    if (copyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyFeedback]);

  useEffect(() => {
    if (inviteFeedback === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setInviteFeedback("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [inviteFeedback]);

  useEffect(() => {
    if (destroyFeedback !== "success") {
      return;
    }
    const timeout = window.setTimeout(() => setDestroyFeedback("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [destroyFeedback]);

  useEffect(() => {
    if (!ready || room?.status !== "open") {
      return;
    }
    const interval = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && joinedRef.current) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
    return () => window.clearInterval(interval);
  }, [ready, room?.status]);

  useEffect(() => {
    startTransition(() => {
      setMessages((current) =>
        current.filter((message) => {
          const keep = !message.expiresAt || message.expiresAt > now;
          if (!keep && message.kind === "file") {
            if (message.file?.url) {
              URL.revokeObjectURL(message.file.url);
              objectUrlsRef.current.delete(message.file.url);
            }
            outgoingFilesRef.current.delete(message.id);
            outgoingFileHashesRef.current.delete(message.id);
            removeIncomingFile(message.id);
          }
          return keep;
        })
      );
    });
    for (const [messageId, envelope] of messageRef.current.entries()) {
      const message = envelope.payload.type === "chat_message" ? envelope.payload.envelope : null;
      const expiresAt =
        typeof message?.expiresAfterReadSeconds === "number"
          ? message.sentAt + message.expiresAfterReadSeconds * 1000
          : undefined;
      if (typeof expiresAt === "number" && expiresAt <= now) {
        messageRef.current.delete(messageId);
      }
    }
  }, [now]);

  useEffect(() => {
    void refreshInvites();
  }, [creatorToken, roomId]);

  useEffect(() => {
    roomStatusRef.current = room?.status ?? null;
  }, [room?.status]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  async function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendingRef.current) return;
    const trimmed = draft.trim();
    const key = roomKeyRef.current;
    const leader = currentKeyLeader();
    if (!trimmed || !key || !leader || !room || room.status !== "open") return;
    if (!keyReadyRef.current) {
      setError(t("securing"));
      return;
    }
    const keyEpoch = keyEpochRef.current;
    const keyWorkIsCurrent = captureKeyWork(keyEpoch, leader);
    const isCurrent = () => keyWorkIsCurrent() && roomKeyRef.current === key;
    if (!isCurrent()) return;
    const draftRevision = draftRevisionRef.current;
    // A ref blocks same-tick Enter/click submissions before React renders.
    sendingRef.current = true;
    setSending(true);
    try {
      const sentAt = Date.now();
      const expiresAt = typeof room.disappearAfterReadSeconds === "number"
        ? sentAt + room.disappearAfterReadSeconds * 1000 : undefined;
      const envelope: EncryptedMessageEnvelope = {
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        messageId: generateMessageId(),
        senderSessionId: sessionId,
        ciphertext: "",
        nonce: "",
        sentAt,
        expiresAfterReadSeconds: room.disappearAfterReadSeconds ?? null,
        keyEpoch
      };
      const encrypted = await encryptMessage(key, roomId, envelope, trimmed);
      if (!isCurrent()) return;
      envelope.ciphertext = encrypted.ciphertext;
      envelope.nonce = encrypted.nonce;
      try {
        replayGuardRef.current!.markLocal(envelope.messageId, expiresAt ?? null);
      } catch {
        setError(t("replayLimit"));
        return;
      }
      const sentEvent = await sendPeerData({ type: "chat_message", envelope }, undefined, isCurrent);
      if (!sentEvent) {
        if (isCurrent()) setError(t("messageSendFailed"));
        return;
      }
      messageRef.current.set(envelope.messageId, sentEvent);
      // Keep edits made while encryption/signing was pending, even if the user
      // edited back to the same text. Failed attempts also retain the draft.
      if (draftRevisionRef.current === draftRevision) setDraft("");
      jumpToLatest();
      setError(null);
      startTransition(() => {
        setMessages((current) => upsertMessage(current, {
          id: envelope.messageId,
          senderSessionId: sessionId,
          plaintext: trimmed,
          sentAt,
          expiresAt,
          kind: "text"
        }));
      });
    } catch {
      if (isCurrent()) setError(t("messageSendFailed"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function handleCopyLink() {
    if (await copyText(window.location.href)) {
      setCopyFeedback("success");
      setError(null);
      return;
    }
    setError(t("clipboardLinkFailed"));
  }

  function inviteActionIsCurrent(action: number, token: string) {
    return action === inviteActionRef.current && roomStatusRef.current === "open" &&
      canShareInvite(currentInvitesRef.current.find((invite) => invite.token === token), Date.now());
  }

  async function handleShareInvite(event: React.MouseEvent<HTMLButtonElement>) {
    const trigger = event.currentTarget;
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (!creatorToken) {
      return;
    }
    try {
      const inviteTtlMs = parseInviteDurationDraft(inviteDuration);
      const invite = await createInvite(roomId, creatorToken, inviteTtlMs);
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      currentInvitesRef.current = [invite, ...currentInvitesRef.current];
      setInvites(currentInvitesRef.current);
      if (!inviteActionIsCurrent(action, invite.token)) return;
      const inviteUrl = buildInviteUrl(roomId, invite.token, roomSecret);
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({
            title: "chat invite",
            text: t("inviteShareText"),
            url: inviteUrl
          });
          if (!inviteActionIsCurrent(action, invite.token)) return;
          setInviteFeedback("shared");
          setRoomNotice(t("sharedInviteNotice"));
          setError(null);
          return;
        } catch (cause) {
          if (!inviteActionIsCurrent(action, invite.token)) return;
          if (cause instanceof DOMException && cause.name === "AbortError") {
            setInviteFeedback("idle");
            setRoomNotice(t("createdInviteNotice"));
            setError(null);
            return;
          }
        }
      }
      if (await copyText(inviteUrl)) {
        if (!inviteActionIsCurrent(action, invite.token)) return;
        setInviteFeedback("copied");
        setRoomNotice(t("copiedInviteNotice"));
        setError(null);
        return;
      }
      if (!inviteActionIsCurrent(action, invite.token)) return;
      setManualInvite({ token: invite.token, trigger, focusOwner });
      setInviteFeedback("idle");
    } catch (cause) {
      if (action !== inviteActionRef.current || roomStatusRef.current !== "open") return;
      setError(cause instanceof Error ? cause.message : t("createInviteFailed"));
    }
  }

  async function handleCopyInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (await copyText(buildInviteUrl(roomId, token, roomSecret))) {
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("copied");
      setRoomNotice(t("copiedInviteNotice"));
      setError(null);
      return;
    }
    if (!inviteActionIsCurrent(action, token)) return;
    setManualInvite({ token, trigger, focusOwner });
  }

  async function handleNativeShareInvite(token: string, trigger: HTMLButtonElement) {
    const focusOwner = document.activeElement;
    const action = ++inviteActionRef.current;
    setManualInvite(null);
    setRoomNotice(null);
    setError(null);
    if (typeof navigator.share !== "function") {
      return;
    }
    try {
      await navigator.share({
        title: "chat invite",
        text: t("inviteShareText"),
        url: buildInviteUrl(roomId, token, roomSecret)
      });
      if (!inviteActionIsCurrent(action, token)) return;
      setInviteFeedback("shared");
      setRoomNotice(t("sharedInviteNotice"));
      setError(null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        if (!inviteActionIsCurrent(action, token)) return;
        setManualInvite({ token, trigger, focusOwner });
      }
    }
  }

  async function handleRevokeInvite(token: string) {
    // Removing an invite supersedes any copy/share still awaiting browser APIs.
    inviteActionRef.current += 1;
    if (!creatorToken) {
      return;
    }
    try {
      await revokeInvite(roomId, creatorToken, token);
      setInvites((current) =>
        current.map((invite) =>
          invite.token === token ? { ...invite, revokedAt: Date.now() } : invite
        )
      );
      setRoomNotice(t("removedInviteNotice"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("revokeInviteFailed"));
    }
  }

  function handleKickParticipant(targetSessionId: string) {
    if (!creatorToken || targetSessionId === sessionId) {
      return;
    }
    socketRef.current?.send(
      JSON.stringify({
        type: "kick_participant",
        creatorToken,
        targetSessionId
      })
    );
  }

  async function handleDestroy() {
    if (!creatorToken) {
      return;
    }
    try {
      setDestroying(true);
      setDestroyFeedback("idle");
      const next = await destroyRoom(roomId, creatorToken);
      await sendPeerData({ type: "peer_destroy" });
      setRoomNotice(null);
      setRoom(next);
    } catch (cause) {
      setDestroying(false);
      setError(cause instanceof Error ? cause.message : t("destroyRoomFailed"));
    }
  }

  const presentCount = presence.count;
  const sortedPresenceIds = [...presence.connectedSessionIds].sort((left, right) =>
    left === sessionId ? -1 : right === sessionId ? 1 : left.localeCompare(right)
  );
  const messagePolicyLabel =
    typeof room?.disappearAfterReadSeconds === "number"
      ? t("messagesVanish", { duration: formatStaticDuration(room.disappearAfterReadSeconds) })
      : t("messagesStay");
  const idleDeadline =
    typeof room?.inactivityTimeoutMs === "number"
      ? room.lastActivityAt + room.inactivityTimeoutMs
      : null;
  const roomDeadline =
    typeof room?.expiresAt === "number" && typeof idleDeadline === "number"
      ? Math.min(room.expiresAt, idleDeadline)
      : typeof room?.expiresAt === "number"
        ? room.expiresAt
        : idleDeadline;
  const roomPolicyLabel =
    typeof roomDeadline === "number"
      ? t("roomExpires", { duration: formatRelativeDuration(roomDeadline) })
      : t("roomStays");
  const isCreator = Boolean(creatorToken);
  const manualInviteRecord = invites.find((invite) => invite.token === manualInvite?.token);
  const showManualInvite = isCreator && room?.status === "open" &&
    canShareInvite(manualInviteRecord, Math.max(now, Date.now()));
  function dismissManualInvite() {
    inviteActionRef.current += 1;
    setManualInvite(null);
  }

  useEffect(() => {
    if (removedFromRoom || notFound || (room && room.status !== "open") ||
      ["invalid", "claimed", "used"].includes(inviteAccess)) {
      conversationFind.close();
      concealment.reset();
    }
  }, [removedFromRoom, notFound, room?.status, inviteAccess]);

  if (removedFromRoom) {
    return <RemovedFromRoomScreen focusRef={setRetryFocusTarget} />;
  }

  if (inviteAccess === "invalid" || inviteAccess === "claimed" || inviteAccess === "used") {
    return <InvalidInviteScreen reason={inviteAccess} focusRef={setRetryFocusTarget} />;
  }

  if (notFound) {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={t("roomNotFound")}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (ready && room && room.status !== "open") {
    return (
      <RoomGoneScreen
        fromInvite={isInviteGuest}
        reason={roomNotice ?? roomStateMessage(room.status)}
        focusRef={setRetryFocusTarget}
      />
    );
  }

  if (!concealment.hidden && isInviteGuest && (inviteAccess !== "granted" || !room || !ready)) {
    return <InviteCheckingScreen connection={connection} error={connectionError ?? error}
      focusRef={setRetryFocusTarget}
      onRetry={canRetryConnection ? () => retryConnectionRef.current?.() : undefined} />;
  }

  const connectionTone =
    connection === t("connected")
      ? "bg-acc shadow-[0_0_8px_var(--acc)]"
      : connection === t("disconnected") || connection === t("connectionError") || connection === t("closed")
        ? "bg-danger"
        : "bg-acc2 motion-safe:animate-pulse";
  const showInvitesPanel = invitesOpen || Boolean(showManualInvite && manualInvite);

  return (
    <>
    {concealment.screen}
    <main className="room-shell room-content flex h-dvh flex-col overflow-hidden" hidden={concealment.hidden} style={concealment.hidden ? { display: "none" } : undefined}>
      <div aria-hidden="true" className="grad h-0.5 w-full flex-none" />
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
      <header className="room-header box flex flex-none flex-wrap items-center gap-x-5 gap-y-2 px-4 pb-3 pt-4 text-sm">
        <span className="box-title">{t("roomBoxTitle")}</span>
        <h1 className="text-base font-bold">{roomId.slice(0, 8)}</h1>
        <div className="room-meta flex items-center gap-3 rounded-sm text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc" aria-live="polite" ref={setRetryFocusTarget} tabIndex={-1}>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2 flex-none rounded-full ${connectionTone}`} />
            <span className="lowercase">{connection}</span>
          </span>
          <span className="text-dim">{t("present", { count: presentCount })}</span>
        </div>
        {canRetryConnection ? (
          <button className={`${roomButtonClass} border-acc2 text-acc2`} onClick={() => retryConnectionRef.current?.()} type="button">
            {t("retryConnection")}
          </button>
        ) : null}
        <span className="text-xs text-dim" title={messagePolicyLabel}>
          {t("vanishShort")} <b className="font-semibold text-fg">
            {typeof room?.disappearAfterReadSeconds === "number" ? formatStaticDuration(room.disappearAfterReadSeconds) : t("vanishOff")}
          </b>
        </span>
        <span className="text-xs text-dim" title={roomPolicyLabel}>
          {t("endsShort")} <b className="font-semibold text-fg">
            {typeof roomDeadline === "number" ? formatClock(roomDeadline) : t("endsManual")}
          </b>
        </span>
        <div className="participant-strip flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim" aria-label={t("participants")} role="group">
          {sortedPresenceIds.length === 0 ? (
            <span className="participant-empty">{t("waiting")}</span>
          ) : (
            sortedPresenceIds.map((id) => (
              <span className={`participant-chip flex items-center gap-1.5 ${id === sessionId ? "participant-chip-self text-fg" : ""}`} key={id}>
                <span aria-hidden="true" className="participant-dot size-2.5 flex-none rounded-sm" style={{ backgroundColor: colorFromSessionId(id) }} />
                <span className="lowercase">{id === sessionId ? t("you") : t("guest")}</span>
                {isCreator && id !== sessionId ? (
                  <button
                    className="participant-kick lowercase text-dim hover:text-danger focus-visible:outline-2 focus-visible:outline-acc"
                    onClick={() => handleKickParticipant(id)}
                    type="button"
                  >
                    {t("remove")}
                  </button>
                ) : null}
              </span>
            ))
          )}
        </div>
        <div className="room-actions flex flex-wrap gap-2 sm:ml-auto">
          {isCreator ? (
            <button
              className={`${roomButtonClass} font-semibold ${inviteFeedback !== "idle" ? "button-success border-acc bg-acc/10 text-acc" : "border-acc text-acc"}`}
              onClick={handleShareInvite}
              ref={inviteTriggerRef}
              type="button"
            >
              {inviteFeedback === "shared"
                ? t("inviteShared")
                : inviteFeedback === "copied"
                  ? t("inviteCopiedSend")
                  : typeof navigator.share === "function"
                    ? t("sendInvite")
                    : t("inviteOne")}
            </button>
          ) : (
            <button
              className={`${roomButtonClass} font-semibold border-acc ${copyFeedback === "success" ? "button-success bg-acc/10 text-acc" : "text-acc"}`}
              onClick={handleCopyLink}
              type="button"
            >
              {copyFeedback === "success" ? t("copied") : t("copyMyLink")}
            </button>
          )}
          {isCreator ? (
            <button
              aria-controls="room-invites"
              aria-expanded={showInvitesPanel}
              className={`${roomButtonClass} lg:hidden ${showInvitesPanel ? "border-acc2 text-acc2" : "border-line text-dim hover:text-fg"}`}
              onClick={() => setInvitesOpen((current) => !current)}
              type="button"
            >
              {t("invites")}{invites.length > 0 ? ` ${invites.length}` : ""}
            </button>
          ) : null}
          {conversationFind.toggle}
          {concealment.control}
          <button
            className={`${roomButtonClass} ${destroyFeedback === "success" ? "button-success border-danger bg-danger/10 text-danger" : "border-danger/50 text-danger hover:border-danger"}`}
            disabled={!creatorToken || destroying || room?.status !== "open"}
            onClick={handleDestroy}
            type="button"
          >
            {destroying ? t("destroying") : t("destroy")}
          </button>
        </div>
        <span className="sr-only" role="status" aria-live="polite">
          {inviteFeedback === "shared"
            ? t("inviteSharedStatus")
            : inviteFeedback === "copied"
              ? t("inviteCopiedStatus")
              : copyFeedback === "success"
                ? t("roomLinkCopiedStatus")
                : ""}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:grid-rows-[minmax(0,1fr)]">
      {isCreator ? (
        <aside
          aria-label={t("invites")}
          className={`invite-panel box max-h-[40dvh] min-h-0 flex-none flex-col text-xs lg:col-start-2 lg:row-start-1 lg:flex lg:max-h-none ${showInvitesPanel ? "flex" : "hidden"}`}
          id="room-invites"
        >
          <span className="box-title">{t("invites")}</span>
          {/* The box itself must not scroll, or it clips its title; the contents scroll instead. */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 pt-6">
            <p className="invite-guidance text-dim">{t("inviteGuidance")}</p>
            {showManualInvite && manualInvite ? (
              <ManualInviteLink key={manualInvite.token} url={buildInviteUrl(roomId, manualInvite.token, roomSecret)}
                trigger={manualInvite.trigger} focusOwner={manualInvite.focusOwner} fallbackTrigger={inviteTriggerRef.current} onDismiss={dismissManualInvite} />
            ) : null}
            {invites.length > 0 ? (
              <ul className="space-y-3">
                {invites.slice(0, 4).map((invite) => {
                  const accent = inviteAccentStyle(invite);
                  return (
                    <li className="invite-row flex flex-wrap items-center gap-x-2 gap-y-1" key={invite.token}>
                      <span aria-hidden="true" className={`size-2 flex-none rounded-sm ${accent ? "" : "border border-dim"}`} style={accent} />
                      <span className={invite.revokedAt ? "text-dim line-through" : ""}>{inviteStatusLabel(invite)}</span>
                      <div className="invite-actions ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
                        {canShareInvite(invite, now) ? (
                          <>
                            {typeof navigator.share === "function" ? (
                              <button
                                className={`invite-copy ${roomLinkButtonClass} text-acc2`}
                                onClick={(event) => handleNativeShareInvite(invite.token, event.currentTarget)}
                                type="button"
                              >
                                {t("share")}
                              </button>
                            ) : null}
                            <button className={`invite-copy ${roomLinkButtonClass} text-acc2`} onClick={(event) => handleCopyInvite(invite.token, event.currentTarget)} type="button">
                              {t("copyInvite")}
                            </button>
                          </>
                        ) : null}
                        {!invite.revokedAt ? (
                          <button className={`invite-revoke ${roomLinkButtonClass} text-dim hover:text-danger`} onClick={() => handleRevokeInvite(invite.token)} type="button">
                            {t("remove")}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <section className="invite-settings mt-auto border-t border-line pt-4 text-dim" aria-label={t("inviteExpiration")}>
              <p className="setting-label lowercase">{t("newInviteExpires")}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {INVITE_PRESETS.map((preset) => {
                  const active = inviteDuration.amount === preset.amount && inviteDuration.unit === preset.unit;
                  return (
                    <button
                      aria-pressed={active}
                      className={`rounded border px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc ${active ? "border-acc text-acc" : "border-line hover:text-fg"}`}
                      key={preset.label}
                      onClick={() => setInviteDuration({ amount: preset.amount, unit: preset.unit })}
                      type="button"
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
              <div className="setting-controls mt-2 flex gap-2">
                <input
                  aria-label={t("inviteLifetimeAmount")}
                  className="setting-input w-16 min-w-0 rounded border border-line bg-bg px-2 py-1 text-fg focus-visible:border-acc focus-visible:outline-none"
                  inputMode="numeric"
                  min="1"
                  onChange={(event) =>
                    setInviteDuration((current) => ({ ...current, amount: event.target.value }))
                  }
                  type="number"
                  value={inviteDuration.amount}
                />
                <select
                  aria-label={t("inviteLifetimeUnit")}
                  className="setting-select min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 lowercase text-fg focus-visible:border-acc focus-visible:outline-none"
                  onChange={(event) =>
                    setInviteDuration((current) => ({
                      ...current,
                      unit: event.target.value as DurationUnit
                    }))
                  }
                  value={inviteDuration.unit}
                >
                  <option value="minutes">{t("minutes")}</option>
                  <option value="hours">{t("hours")}</option>
                  <option value="days">{t("days")}</option>
                </select>
              </div>
              <p className="setting-note mt-2">{t("inviteNextOnly")}</p>
            </section>
          </div>
        </aside>
      ) : null}

      <section className="box flex min-h-0 flex-1 flex-col lg:col-start-1 lg:row-start-1" aria-label={t("messagesBoxTitle")}>
        <span className="box-title">{t("messagesBoxTitle")}</span>
        {conversationFind.panel}
        {roomNotice ? (
          <p className="room-notice flex-none px-4 pt-4 text-center text-[11px] text-dim" role="status" aria-live="polite">
            {roomNotice}
          </p>
        ) : null}
        {error ? <p className="room-error flex-none px-4 pt-4 text-xs text-danger" role="alert">{error}</p> : null}
        {connectionError ? <p className="room-error flex-none px-4 pt-4 text-xs text-danger" role="alert">{connectionError}</p> : null}
        <div className="chat-stage relative flex min-h-0 flex-1 flex-col">
          <section aria-label={t("conversationLog")} aria-live="polite" aria-relevant="additions" className="chat-log min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pt-6 [scrollbar-width:thin] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-acc" ref={chatLogRef} role="log" tabIndex={0} onScroll={handleConversationScroll}>
          <div className="chat-thread flex min-h-full flex-col gap-3 text-sm">
            {!ready ? <p className="system-line text-center text-[11px] text-dim">{t("deriving")}</p> : null}
            {messages.length === 0 && ready ? (
              <p className="system-line text-center text-[11px] text-dim">{messagePolicyLabel}</p>
            ) : null}
            {messages.map((message) => {
              const mine = message.senderSessionId === sessionId;
              return (
                <article
                  className={`bubble ${mine ? "bubble-mine ml-auto" : "bubble-theirs"} w-fit min-w-0 max-w-[88%] border-l-2 px-3 py-2 sm:max-w-[min(66ch,80%)]${conversationFind.selectedId === message.id ? " bubble-find-selected outline-2 -outline-offset-2 outline-acc2" : ""}`}
                  data-message-id={message.id}
                  key={message.id}
                  style={bubbleStyle(message.senderSessionId)}
                >
                  <div className="flex justify-between gap-4 text-[11px] text-dim">
                    <span className="bubble-author lowercase">
                      {mine ? t("you") : t("guest")}{message.kind === "file" ? ` · ${t("fileTag")}` : ""}
                    </span>
                    <span className="whitespace-nowrap tabular-nums">
                      <time dateTime={new Date(message.sentAt).toISOString()}>{formatClock(message.sentAt)}</time>
                      {message.expiresAt ? (
                        <span aria-hidden="true"> · -{formatRelativeDuration(message.expiresAt)}</span>
                      ) : null}
                      <span className="sr-only">{messageStatus(message)}</span>
                    </span>
                  </div>
                  {message.kind === "file" && message.file ? (
                    <FileCard
                      file={message.file}
                      onDownload={() =>
                        handleRequestFile(message.file!.fileId, message.senderSessionId)
                      }
                    />
                  ) : (
                    <p className="mt-1 break-words [overflow-wrap:anywhere]">{message.plaintext}</p>
                  )}
                </article>
              );
            })}
          </div>
          </section>
          {awayFromLatest ? (
            <button
              className={`jump-to-latest absolute bottom-3 left-1/2 z-10 max-w-[calc(100%-2rem)] -translate-x-1/2 bg-panel shadow-lg ${roomButtonClass} border-acc2 text-acc2`}
              type="button"
              onClick={() => {
                jumpToLatest();
                chatLogRef.current?.focus({ preventScroll: true });
              }}
            >
              {newMessageCount > 0 ? t("newMessagesJump", { count: newMessageCount }) : t("jumpToLatest")}
            </button>
          ) : null}
        </div>

        <form className="composer flex flex-none items-end gap-2 border-t border-line p-3 focus-within:border-acc/60" onSubmit={handleSend}>
          <button
            aria-label={t("attachFileLabel")}
            className={`composer-attach ${roomButtonClass} border-line px-2.5 py-2 text-dim hover:text-fg`}
            disabled={room?.status !== "open" || !keyReady}
            onClick={() => fileInputRef.current?.click()}
            title={t("attachFile")}
            type="button"
          >
            {t("composerAttach")}
          </button>
          <input
            hidden
            multiple
            onChange={(event) => void handleAttachFiles(event.target.files)}
            ref={fileInputRef}
            type="file"
          />
          <textarea
            aria-label={t("writeMessageLabel")}
            className="max-h-40 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-sm text-fg outline-none [field-sizing:content] placeholder:text-dim disabled:cursor-not-allowed disabled:opacity-60"
            value={draft}
            onChange={(event) => {
              draftRevisionRef.current += 1;
              setDraft(event.target.value);
            }}
            onKeyDown={handleComposerKeyDown}
            disabled={room?.status !== "open" || !keyReady}
            placeholder={room?.status === "open" ? (keyReady ? t("writeMessage") : t("securing")) : roomNotice ?? t("roomClosed")}
            rows={1}
          />
          <button
            aria-label={t("sendEncrypted")}
            className="grad rounded px-3 py-2 text-xs font-bold lowercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc disabled:cursor-not-allowed disabled:opacity-40"
            type="submit"
            disabled={sending || !draft.trim() || room?.status !== "open" || !keyReady}
          >
            {t("sendShort")}
          </button>
        </form>
      </section>
      </div>
      </div>
    </main>
    </>
  );
}

// Look B controls shared by the room and its file rows.
const roomButtonClass = "rounded border px-3 py-1.5 text-xs lowercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc disabled:cursor-not-allowed disabled:opacity-40";
const roomLinkButtonClass = "lowercase hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc";

const INVITE_PRESETS: readonly { amount: string; unit: DurationUnit; label: string }[] = [
  { amount: "10", unit: "minutes", label: "10m" },
  { amount: "1", unit: "hours", label: "1h" },
  { amount: "1", unit: "days", label: "1d" }
];
