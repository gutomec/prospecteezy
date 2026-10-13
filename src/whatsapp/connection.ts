// Baileys connection — minimal port of the agentic-whatsapp-nirvana squad's
// template/lib/connection.ts: SQLite auth state, real WA Web protocol version,
// exponential reconnection, and the pairing-flow close semantics. This project
// has no ingestion pipeline — the socket exists only to pair, run onWhatsApp
// lookups and (optionally) push contacts, always behind the gate.
import type { Database } from "bun:sqlite";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
} from "baileys";
import { clearInstanceAuth, useSQLiteAuthState, isPaired } from "./auth-state.ts";
import { nowIso, setState } from "./db.ts";
import { stateKey } from "./instances.ts";

export interface ConnectionHandle {
  getSocket: () => WASocket;
  close: () => void;
}

export interface ConnectionCallbacks {
  onQr?: (qr: string) => void;
  onOpen?: (meJid: string | null) => void;
  /** `detail` is a PT-BR, user-facing explanation when the close is terminal
   *  (or needs attention); undefined for routine transient drops. */
  onClose?: (reason: string, willReconnect: boolean, statusCode: number | undefined, detail?: string) => void;
  // Raw Baileys event forwards (wa-backend). The manager wires these to the
  // ingestion mirror so connection.ts stays generic and offline-testable.
  onMessagesUpsert?: (payload: unknown) => void;
  onHistorySet?: (payload: unknown) => void;
  onMessagesUpdate?: (updates: unknown) => void;
  onContactsUpsert?: (contacts: unknown) => void;
  /** Initial address book. In Baileys 7.x it arrives via messaging-history.set;
   *  `contacts.set` is handled defensively for versions/paths that emit it. */
  onContactsSet?: (contacts: unknown) => void;
}

export interface ConnectionOptions {
  /** Auth scope: 'main' (default) uses the legacy unprefixed session. */
  instanceId?: string;
}

export interface CloseDecision {
  reconnect: boolean;
  /** immediate reconnect (pairing completed: the server ASKS for the restart) */
  immediate: boolean;
  /** wipe this instance's auth before deciding (dead/invalid session) */
  clearAuth: boolean;
  /** PT-BR explanation for the user (terminal or attention-worthy closes) */
  detail?: string;
}

/** Unpaired sockets that time out their QR rotation this many times in a row
 *  stop reconnecting until the user explicitly asks again (reconnect/repair). */
export const MAX_QR_CYCLES = 5;

export interface CloseContext {
  /** Consecutive QR-rotation timeouts (408 after a QR, never opened). */
  qrTimeouts?: number;
}

/**
 * Pure decision about a connection close (offline-testable).
 * - `restartRequired` (515): the NORMAL post-scan pairing flow — the server
 *   requests a restart and login only completes on the reconnected socket.
 *   Reconnect immediately.
 * - `loggedOut` (401): session unlinked on the phone. Wipe this instance's
 *   auth (re-pairing then works without deleting the DB) and do not reconnect.
 * - `badSession` (500): corrupted credentials. Wipe auth and reconnect (→ QR).
 * - `connectionReplaced` (440), `forbidden` (403), `multideviceMismatch`
 *   (411): terminal. Reconnecting would fight another session or hammer a
 *   restricted account.
 * - QR rotation timeouts (408) while unpaired: stop after MAX_QR_CYCLES.
 * - Everything else: reconnect with backoff.
 */
export function closeDecision(statusCode: number | undefined, ctx: CloseContext = {}): CloseDecision {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return {
        reconnect: false,
        immediate: false,
        clearAuth: true,
        detail: "Sessão desconectada no celular (401). Escaneie um novo QR para parear de novo.",
      };
    case DisconnectReason.restartRequired:
      return { reconnect: true, immediate: true, clearAuth: false };
    case DisconnectReason.badSession:
      return {
        reconnect: true,
        immediate: false,
        clearAuth: true,
        detail: "Sessão corrompida (500): credenciais apagadas, escaneie um novo QR.",
      };
    case DisconnectReason.connectionReplaced:
      return {
        reconnect: false,
        immediate: false,
        clearAuth: false,
        detail: "Sessão substituída (440): esta conta foi aberta em outro lugar. Reconecte manualmente.",
      };
    case DisconnectReason.forbidden:
      return {
        reconnect: false,
        immediate: false,
        clearAuth: false,
        detail: "Acesso negado pelo WhatsApp (403): a conta pode estar restrita ou banida.",
      };
    case DisconnectReason.multideviceMismatch:
      return {
        reconnect: false,
        immediate: false,
        clearAuth: false,
        detail: "Incompatibilidade de multi-dispositivo (411): pareie a conta novamente.",
      };
  }
  if ((ctx.qrTimeouts ?? 0) >= MAX_QR_CYCLES) {
    return {
      reconnect: false,
      immediate: false,
      clearAuth: false,
      detail: `QR expirou ${MAX_QR_CYCLES} vezes sem leitura. Clique em reconectar para gerar um novo.`,
    };
  }
  return { reconnect: true, immediate: false, clearAuth: false };
}

// ---------------------------------------------------------------------------
// WhatsApp Web protocol version. Baileys embeds a version that ages with every
// WhatsApp release; when stale, the server drops the pairing handshake and NO
// QR is ever emitted. Fetch the real version once per process (with TTL) and
// fall back to the lib default when offline.
// ---------------------------------------------------------------------------
let cachedWaVersion: [number, number, number] | null = null;
let cachedWaVersionAt = 0;
const WA_VERSION_TTL_MS = 6 * 3600_000;

// Recent, known-good WhatsApp Web version — the value fetchLatestBaileysVersion
// returns today (2026-08, verified live). This is the FALLBACK when the live
// fetch fails: the socket must NEVER be created with `version: undefined`, which
// makes Baileys use its embedded default ([2,3000,1035194821] in 7.0.0-rc13,
// already stale) — the server then drops the pairing handshake with "error in
// validating connection" and no QR is ever emitted. Bump when it ages.
export const FALLBACK_WA_VERSION: [number, number, number] = [2, 3000, 1043857760];

/** Refreshes the version cache. Never throws: failure keeps whatever we have. */
export async function refreshWaWebVersion(): Promise<[number, number, number] | null> {
  if (cachedWaVersion && Date.now() - cachedWaVersionAt < WA_VERSION_TTL_MS) return cachedWaVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    if (Array.isArray(version) && version.length === 3) {
      cachedWaVersion = version as [number, number, number];
      cachedWaVersionAt = Date.now();
    }
  } catch {
    /* offline or endpoint down: fall back to the hardcoded known-good version */
  }
  return cachedWaVersion;
}

/**
 * Always resolves to a CONCRETE version, never null/undefined. Every socket must
 * go through here before makeWASocket. Live fetch first (cached, TTL); on any
 * failure returns FALLBACK_WA_VERSION. This closes the first-connection race
 * where the manager created a socket before the async fetch had populated the
 * cache — the cause of the "QR never emits" regression (revision 1).
 */
export async function resolveWaWebVersion(): Promise<[number, number, number]> {
  return (await refreshWaWebVersion()) ?? FALLBACK_WA_VERSION;
}

/** Structural match of Baileys' ILogger (Utils/logger.ts). */
interface WaLogger {
  level: string;
  child(obj: Record<string, unknown>): WaLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Quiet logger: Baileys' default pino at "info" floods the CLI. */
function quietLogger(): WaLogger {
  const logger: WaLogger = {
    level: "error",
    child: () => logger,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (obj: unknown, msg?: string) => {
      const text = msg ?? (obj instanceof Error ? obj.message : "");
      if (text) console.error(`[baileys] ${text}`);
    },
  };
  return logger;
}

/**
 * Opens the socket and keeps the session alive with exponential backoff
 * (2^n s, cap 60 s). `loggedOut` does not reconnect (a new pairing is needed).
 */
export function createWaConnection(
  db: Database,
  callbacks: ConnectionCallbacks = {},
  options: ConnectionOptions = {},
): ConnectionHandle {
  const instanceId = options.instanceId;
  const key = (k: string): string => stateKey(k, instanceId);
  let sock: WASocket | undefined;
  let closed = false;
  let reconnectAttempts = 0;
  let qrTimeouts = 0;

  const logError = (where: string, error: unknown): void => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[wa:${instanceId ?? "main"}] ${where}: ${msg}`);
  };

  // A throw anywhere here (SQLITE_BUSY, a malformed row) must never become an
  // unhandled rejection: under Bun that exits the whole server.
  const scheduleStart = (delayMs: number): void => {
    setTimeout(() => {
      if (closed) return;
      start().catch((error) => {
        logError("falha ao abrir o socket", error);
        reconnectAttempts++;
        scheduleStart(Math.min(2 ** reconnectAttempts * 1000, 60_000));
      });
    }, delayMs);
  };

  const start = async (): Promise<void> => {
    // ALWAYS resolve a concrete WA Web version BEFORE creating the socket.
    // Passing `undefined` here makes Baileys use its stale embedded version and
    // the server rejects the handshake ("error in validating connection") — the
    // QR is then never emitted (revision 1 regression on the manager path,
    // which never awaited the version like wa:pair/connectAndWaitOpen did).
    const version = await resolveWaWebVersion();
    if (closed) return;
    const { state, saveCreds } = useSQLiteAuthState(db, instanceId);
    const s = makeWASocket({
      auth: state,
      version,
      logger: quietLogger(),
      markOnlineOnConnect: false,
      // Pull the message/contact history the phone is willing to push. Takes
      // effect on the NEXT pairing (a fresh link re-syncs); an already-paired
      // session backfills older messages on demand via fetchMessageHistory.
      syncFullHistory: true,
    });
    sock = s;
    let sawQr = false;
    let opened = false;

    // Each forward is isolated: one failing handler (e.g. an ingestion write)
    // must neither crash the process nor skip the connection.update below.
    const guard = (where: string, fn: () => void | Promise<void>): Promise<void> =>
      Promise.resolve()
        .then(fn)
        .catch((error) => logError(where, error));

    s.ev.process(async (events) => {
      if (events["creds.update"]) await guard("creds.update", () => saveCreds());

      // Mirror ingestion forwards (no-op when the manager did not wire them).
      const history = events["messaging-history.set"];
      if (history) await guard("messaging-history.set", () => callbacks.onHistorySet?.(history));
      const upsert = events["messages.upsert"];
      if (upsert) await guard("messages.upsert", () => callbacks.onMessagesUpsert?.(upsert));
      const update = events["messages.update"];
      if (update) await guard("messages.update", () => callbacks.onMessagesUpdate?.(update));
      const contactsUpsert = events["contacts.upsert"];
      if (contactsUpsert) await guard("contacts.upsert", () => callbacks.onContactsUpsert?.(contactsUpsert));
      // Defensive: some Baileys versions emit `contacts.set` (initial address
      // book). Not in 7.0.0-rc13's typed map, so read it through a cast.
      const contactsSet = (events as Record<string, unknown>)["contacts.set"];
      if (contactsSet) await guard("contacts.set", () => callbacks.onContactsSet?.(contactsSet));

      const connUpdate = events["connection.update"];
      if (!connUpdate) return;

      if (connUpdate.qr) {
        sawQr = true;
        const qr = connUpdate.qr;
        await guard("qr", () => callbacks.onQr?.(qr));
      }

      if (connUpdate.connection === "open") {
        opened = true;
        reconnectAttempts = 0;
        qrTimeouts = 0;
        await guard("open", () => {
          setState(db, key("connection_status"), "open");
          setState(db, key("me_jid"), s.user?.id ?? "");
          callbacks.onOpen?.(s.user?.id ?? null);
        });
      }

      if (connUpdate.connection === "close") {
        const statusCode = (connUpdate.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (statusCode === DisconnectReason.timedOut && sawQr && !opened) qrTimeouts++;
        const decision = closeDecision(statusCode, { qrTimeouts });
        // A handle closed on purpose (replaced/removed) must not touch the
        // shared runtime_state or the auth of whatever replaced it.
        if (!closed) {
          await guard("close state", () => {
            if (decision.clearAuth) clearInstanceAuth(db, instanceId);
            setState(db, key("connection_status"), "closed");
            setState(
              db,
              key("last_disconnect"),
              JSON.stringify({ at: nowIso(), status_code: statusCode ?? null }),
            );
          });
        }
        const willReconnect = decision.reconnect && !closed;
        await guard("close", () =>
          callbacks.onClose?.(String(statusCode ?? "unknown"), willReconnect, statusCode, decision.detail),
        );
        if (willReconnect) {
          let delayMs: number;
          if (decision.immediate) {
            delayMs = 250; // restartRequired: reconnect now to finish the login
          } else {
            reconnectAttempts++;
            delayMs = Math.min(2 ** reconnectAttempts * 1000, 60_000);
          }
          scheduleStart(delayMs);
        }
      }
    });
  };

  scheduleStart(0);

  return {
    getSocket: () => sock as WASocket,
    close: () => {
      closed = true;
      try {
        sock?.end(undefined);
      } catch {
        // best-effort shutdown
      }
    },
  };
}

export class NotPairedError extends Error {
  constructor() {
    super("Nenhuma conta pareada. Rode `bun run wa:pair` e escaneie o QR com o número dedicado.");
    this.name = "NotPairedError";
  }
}

/**
 * Connects an already-paired session and resolves when the socket is open.
 * Throws NotPairedError when there are no credentials, or a timeout error when
 * the connection does not open in time. Caller must close() the handle.
 */
export async function connectAndWaitOpen(
  db: Database,
  timeoutMs = 60_000,
): Promise<{ handle: ConnectionHandle; sock: WASocket; meJid: string | null }> {
  if (!isPaired(db).paired) throw new NotPairedError();
  await refreshWaWebVersion();

  type OpenOutcome = { kind: "open"; meJid: string | null } | { kind: "closed" } | { kind: "timeout" };
  let resolveOpen: (outcome: OpenOutcome) => void;
  const opened = new Promise<OpenOutcome>((resolve) => {
    resolveOpen = resolve;
  });

  const handle = createWaConnection(db, {
    onOpen: (meJid) => resolveOpen({ kind: "open", meJid }),
    onClose: (_reason, willReconnect) => {
      if (!willReconnect) resolveOpen({ kind: "closed" });
    },
  });

  const timer = new Promise<OpenOutcome>((resolve) =>
    setTimeout(() => resolve({ kind: "timeout" }), timeoutMs),
  );
  const result = await Promise.race([opened, timer]);
  if (result.kind === "timeout") {
    handle.close();
    throw new Error(`Conexão não abriu em ${Math.round(timeoutMs / 1000)}s (rede indisponível?).`);
  }
  if (result.kind === "closed") {
    handle.close();
    if (!isPaired(db).paired) throw new NotPairedError();
    throw new Error("Conexão fechada antes de abrir (sessão deslogada? pareie novamente com `bun run wa:pair`).");
  }
  return { handle, sock: handle.getSocket(), meJid: result.meJid };
}
