// The right-side assistant panel (Sheet). Its content depends on AI mode:
//   AI disabled → classic rule-based prospect chat (this phase)
//   AI enabled  → AI chat (phase 3 fills <AiChatSlot/>)
// Anything in the app can open it, optionally with a prefilled prompt.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export interface PendingPrompt {
  text: string;
  /** true = send right away (AI chat); false = only prefill the composer. */
  autoSend: boolean;
  /** Increments on every request so the same text can be sent twice. */
  nonce: number;
}

interface AssistantContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Opens the panel with a prompt waiting to be consumed by the active chat. */
  openWithPrompt: (text: string, options?: { autoSend?: boolean }) => void;
  pendingPrompt: PendingPrompt | null;
  /** The chat calls this once it took the prompt. */
  consumePrompt: () => PendingPrompt | null;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);

  const openWithPrompt = useCallback((text: string, options?: { autoSend?: boolean }) => {
    setPendingPrompt((previous) => ({ text, autoSend: options?.autoSend ?? true, nonce: (previous?.nonce ?? 0) + 1 }));
    setOpen(true);
  }, []);

  const pendingRef = useRef(pendingPrompt);
  pendingRef.current = pendingPrompt;
  const consumePrompt = useCallback(() => {
    const taken = pendingRef.current;
    pendingRef.current = null;
    setPendingPrompt(null);
    return taken;
  }, []);

  const value = useMemo(
    () => ({ open, setOpen, openWithPrompt, pendingPrompt, consumePrompt }),
    [open, openWithPrompt, pendingPrompt, consumePrompt],
  );
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant must be used inside <AssistantProvider>");
  return ctx;
}
