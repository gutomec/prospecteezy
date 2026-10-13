// State of the open conversation: newest page, upward pagination
// (before_id; polls while the backend fetches older history from WhatsApp),
// live SSE merges (message upserts by id, delivery ticks, reactions) and optimistic sends
// replaced by the backend echo.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api/client";
import { waApi } from "@/lib/api/endpoints";
import type { WaMessage, WaMirroredMessage, WaSendInput } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import type { LocalState, ThreadMessage } from "./message-bubble";
import { useWaStreamEvent } from "./wa-stream";
import { applyMessageStatus, applyReaction, fromMirrored, mergeMessages, sendErrorMessage } from "./wa-utils";

const PAGE_SIZE = 40;
const HISTORY_POLL_MS = 2500;
const HISTORY_POLL_MAX = 15;

interface ThreadState {
  messages: ThreadMessage[];
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  hasMore: boolean;
  /** Backend is asking WhatsApp for older history. */
  fetching: boolean;
  loadingOlder: boolean;
}

const INITIAL: ThreadState = { messages: [], status: "idle", error: null, hasMore: false, fetching: false, loadingOlder: false };

export interface SendOutcome {
  ok: boolean;
  error?: string;
}

export function useChatThread(instance: string | null, jid: string | null) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ThreadState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;
  const key = instance && jid ? `${instance}|${jid}` : null;
  const keyRef = useRef(key);
  keyRef.current = key;
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttempts = useRef(0);
  const pending = useRef(new Map<string, WaSendInput>());
  const olderBusy = useRef(false);

  const refreshChats = useCallback(() => {
    if (instance) void queryClient.invalidateQueries({ queryKey: qk.wa.chats(instance) });
  }, [instance, queryClient]);

  /* ---- first page ---- */
  const load = useCallback(async () => {
    if (!instance || !jid) return;
    const myKey = `${instance}|${jid}`;
    setState({ ...INITIAL, status: "loading" });
    try {
      const page = await waApi.messages(instance, jid, { limit: PAGE_SIZE });
      if (keyRef.current !== myKey) return;
      setState({ messages: page.messages, status: "ready", error: null, hasMore: page.has_more, fetching: page.fetching, loadingOlder: false });
    } catch (error) {
      if (keyRef.current !== myKey) return;
      setState({ ...INITIAL, status: "error", error: errorMessage(error, "Não consegui carregar a conversa.") });
    }
  }, [instance, jid]);

  useEffect(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollAttempts.current = 0;
    olderBusy.current = false;
    for (const m of state.messages) if (m.local?.previewUrl) URL.revokeObjectURL(m.local.previewUrl);
    pending.current.clear();
    if (key) void load();
    else setState(INITIAL);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the chat changes
  }, [key]);

  /** Re-reads the loaded messages in place (e.g. media just downloaded) without a loading state. */
  const refresh = useCallback(async () => {
    if (!instance || !jid) return;
    const myKey = `${instance}|${jid}`;
    const loaded = stateRef.current.messages.filter((m) => !m.local).length;
    try {
      const page = await waApi.messages(instance, jid, { limit: Math.min(500, Math.max(PAGE_SIZE, loaded)) });
      if (keyRef.current !== myKey) return;
      setState((s) => (s.status === "ready" ? { ...s, messages: mergeMessages(s.messages, page.messages) } : s));
    } catch {
      /* best-effort: the next load shows the same data */
    }
  }, [instance, jid]);

  /* ---- older pages ---- */
  const loadOlder = useCallback(async () => {
    if (!instance || !jid || olderBusy.current) return;
    const current = stateRef.current;
    if (!current.hasMore || current.status !== "ready") return;
    const oldest = current.messages.find((m) => !m.local);
    const myKey = `${instance}|${jid}`;
    olderBusy.current = true;
    setState((s) => ({ ...s, loadingOlder: true }));
    try {
      const page = await waApi.messages(instance, jid, oldest ? { limit: PAGE_SIZE, beforeId: oldest.id, before: oldest.ts } : { limit: PAGE_SIZE });
      if (keyRef.current !== myKey) return;
      if (page.messages.length > 0) {
        pollAttempts.current = 0;
        olderBusy.current = false;
        setState((s) => ({ ...s, messages: mergeMessages(page.messages, s.messages), hasMore: page.has_more, fetching: page.fetching, loadingOlder: false }));
        return;
      }
      if (page.has_more && page.fetching && pollAttempts.current < HISTORY_POLL_MAX) {
        // Mirror exhausted; WhatsApp is sending older history → poll (capped).
        pollAttempts.current++;
        setState((s) => ({ ...s, fetching: true, loadingOlder: true }));
        pollTimer.current = setTimeout(() => {
          olderBusy.current = false;
          setState((s) => ({ ...s, loadingOlder: false }));
          void loadOlderRef.current();
        }, HISTORY_POLL_MS);
        return;
      }
      olderBusy.current = false;
      setState((s) => ({ ...s, hasMore: false, fetching: false, loadingOlder: false }));
    } catch {
      if (keyRef.current !== myKey) return;
      olderBusy.current = false;
      setState((s) => ({ ...s, loadingOlder: false }));
    }
  }, [instance, jid]);

  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  /* ---- live updates ---- */
  useWaStreamEvent("message", (data) => {
    if (!instance || data.instance !== instance || data.chat_jid !== jid || !data.message_id) return;
    setState((s) => {
      if (s.status !== "ready") return s;
      const previous = s.messages.find((m) => m.id === data.message_id);
      return { ...s, messages: mergeMessages(s.messages, [fromMirrored(data, previous)]) };
    });
  });

  useWaStreamEvent("message_status", (data) => {
    if (!instance || data.instance !== instance || data.chat_jid !== jid) return;
    setState((s) => {
      const messages = applyMessageStatus(s.messages, data);
      return messages === s.messages ? s : { ...s, messages };
    });
  });

  useWaStreamEvent("reaction", (data) => {
    if (!instance || data.instance !== instance || data.chat_jid !== jid) return;
    setState((s) => ({
      ...s,
      messages: s.messages.map((m) => (m.id === data.target_id ? { ...m, reactions: applyReaction(m.reactions, data) } : m)),
    }));
  });

  /* ---- sending ---- */
  const patchLocal = useCallback((localId: string, patch: (m: ThreadMessage) => ThreadMessage | null) => {
    setState((s) => ({
      ...s,
      messages: s.messages.flatMap((m) => {
        if (m.id !== localId) return [m];
        const next = patch(m);
        return next ? [next] : [];
      }),
    }));
  }, []);

  const deliver = useCallback(
    async (localId: string, input: WaSendInput, myKey: string): Promise<SendOutcome> => {
      try {
        const result = await waApi.send(input);
        pending.current.delete(localId);
        if (keyRef.current !== myKey) return { ok: true };
        const echo: WaMirroredMessage | undefined = result.message;
        setState((s) => {
          const local = s.messages.find((m) => m.id === localId);
          if (local?.local?.previewUrl) URL.revokeObjectURL(local.local.previewUrl);
          const without = s.messages.filter((m) => m.id !== localId);
          if (!echo) {
            return { ...s, messages: local ? mergeMessages(without, [{ ...local, local: undefined, status: "sent" }]) : without };
          }
          const previous = without.find((m) => m.id === echo.message_id);
          return { ...s, messages: mergeMessages(without, [fromMirrored(echo, previous)]) };
        });
        refreshChats();
        return { ok: true };
      } catch (error) {
        const message = sendErrorMessage(error);
        if (keyRef.current === myKey) {
          patchLocal(localId, (m) => ({ ...m, status: "error", local: { ...(m.local ?? { state: "error" }), state: "error", error: message } }));
        }
        return { ok: false, error: message };
      }
    },
    [patchLocal, refreshChats],
  );

  /** Adds an optimistic bubble and sends. `local` describes a media attachment preview. */
  const send = useCallback(
    async (input: Omit<WaSendInput, "instance" | "jid">, local?: Omit<LocalState, "state">): Promise<SendOutcome> => {
      if (!instance || !jid) return { ok: false, error: "Nenhuma conversa aberta." };
      const myKey = `${instance}|${jid}`;
      const localId = `local-${crypto.randomUUID()}`;
      const full: WaSendInput = { instance, jid, ...input };
      pending.current.set(localId, full);
      const optimistic: ThreadMessage = {
        id: localId,
        from_me: true,
        text: input.caption ?? input.text ?? null,
        type: input.media_id ? null : "conversation",
        ts: Math.floor(Date.now() / 1000),
        status: "pending",
        media: null,
        quoted: null,
        reactions: [],
        local: { state: "sending", ...local },
      };
      setState((s) => ({ ...s, messages: [...s.messages, optimistic] }));
      return deliver(localId, full, myKey);
    },
    [deliver, instance, jid],
  );

  const retry = useCallback(
    (message: ThreadMessage) => {
      const input = pending.current.get(message.id);
      if (!input || !key) return;
      patchLocal(message.id, (m) => ({ ...m, status: "pending", local: { ...(m.local ?? { state: "sending" }), state: "sending", error: undefined } }));
      void deliver(message.id, input, key);
    },
    [deliver, key, patchLocal],
  );

  const discard = useCallback(
    (message: ThreadMessage) => {
      pending.current.delete(message.id);
      if (message.local?.previewUrl) URL.revokeObjectURL(message.local.previewUrl);
      patchLocal(message.id, () => null);
    },
    [patchLocal],
  );

  return { ...state, reload: load, refresh, loadOlder, send, retry, discard };
}

export type ChatThread = ReturnType<typeof useChatThread>;
export type { WaMessage };
