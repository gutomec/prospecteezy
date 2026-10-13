// One shared EventSource on GET /api/wa/stream for the whole app.
// - Keeps the instances query fresh (status events patch the cache).
// - Exposes `useWaStreamEvent(name, handler)` so phase 2 (chats, campaigns)
//   subscribes to the same connection instead of opening another one.
// - Tracks an "unread" flag for inbound messages while the user is elsewhere.
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WaInstance, WaStreamEvents } from "@/lib/api/types";
import { qk } from "@/lib/queries";

type EventName = keyof WaStreamEvents;
type Handler<K extends EventName> = (data: WaStreamEvents[K]) => void;

interface WaStreamContextValue {
  subscribe: <K extends EventName>(name: K, handler: Handler<K>) => () => void;
  /** EventSource readyState is OPEN. */
  live: boolean;
  unread: boolean;
  clearUnread: () => void;
}

const WaStreamContext = createContext<WaStreamContextValue | null>(null);

const EVENT_NAMES: EventName[] = ["status", "qr", "message", "message_status", "campaign", "validate", "reaction"];

export function WaStreamProvider({ children, onWhatsAppView }: { children: ReactNode; onWhatsAppView: boolean }) {
  const queryClient = useQueryClient();
  const handlers = useRef(new Map<EventName, Set<(data: unknown) => void>>());
  const [live, setLive] = useState(false);
  const [unread, setUnread] = useState(false);
  const onWhatsAppViewRef = useRef(onWhatsAppView);
  onWhatsAppViewRef.current = onWhatsAppView;

  useEffect(() => {
    if (onWhatsAppView) setUnread(false);
  }, [onWhatsAppView]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/wa/stream");
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(source.readyState === EventSource.OPEN);

    const dispatch = (name: EventName) => (event: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (name === "status") {
        const { instance, status, reason } = data as WaStreamEvents["status"];
        queryClient.setQueryData<WaInstance[]>(qk.wa.instances, (list) =>
          list?.map((i) => (i.id === instance ? { ...i, status, status_reason: reason ?? null } : i)),
        );
        // A new/removed instance or an active-instance change needs a full reload.
        void queryClient.invalidateQueries({ queryKey: qk.wa.instances });
      }
      if (name === "message") {
        const fromMe = (data as WaStreamEvents["message"]).from_me;
        if (!fromMe && !onWhatsAppViewRef.current) setUnread(true);
      }
      for (const handler of handlers.current.get(name) ?? []) handler(data);
    };

    const listeners = EVENT_NAMES.map((name) => {
      const listener = dispatch(name) as EventListener;
      source.addEventListener(name, listener);
      return [name, listener] as const;
    });
    return () => {
      for (const [name, listener] of listeners) source.removeEventListener(name, listener);
      source.close();
    };
  }, [queryClient]);

  const subscribe = useCallback(<K extends EventName>(name: K, handler: Handler<K>) => {
    const set = handlers.current.get(name) ?? new Set();
    set.add(handler as (data: unknown) => void);
    handlers.current.set(name, set);
    return () => set.delete(handler as (data: unknown) => void);
  }, []);

  const clearUnread = useCallback(() => setUnread(false), []);
  const value = useMemo(() => ({ subscribe, live, unread, clearUnread }), [subscribe, live, unread, clearUnread]);
  return <WaStreamContext.Provider value={value}>{children}</WaStreamContext.Provider>;
}

export function useWaStream(): WaStreamContextValue {
  const ctx = useContext(WaStreamContext);
  if (!ctx) throw new Error("useWaStream must be used inside <WaStreamProvider>");
  return ctx;
}

/** Subscribe to one SSE event type for the lifetime of the component. */
export function useWaStreamEvent<K extends EventName>(name: K, handler: Handler<K>) {
  const { subscribe } = useWaStream();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(name, (data) => ref.current(data)), [name, subscribe]);
}

/** The instance the app acts with: the active one, else the first. */
export function pickActiveInstance(instances: WaInstance[] | undefined): WaInstance | null {
  if (!instances?.length) return null;
  return instances.find((i) => i.is_active) ?? instances[0] ?? null;
}

/** Instance usable for lookups/sends: active+connected, else any connected one. */
export function pickConnectedInstance(instances: WaInstance[] | undefined): WaInstance | null {
  if (!instances?.length) return null;
  const active = instances.find((i) => i.is_active);
  if (active?.status === "connected") return active;
  return instances.find((i) => i.status === "connected") ?? null;
}

export const WA_STATUS_LABELS: Record<WaInstance["status"], string> = {
  connected: "Conectado",
  qr: "Aguardando QR",
  connecting: "Conectando…",
  disconnected: "Desconectado",
  logged_out: "Sessão encerrada",
};
