// Open conversation: header (contact, save to address book), scrollable log
// with day separators and upward infinite scroll, jump-to-bottom with a
// new-message counter, drag-and-drop zone and the composer.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowLeftIcon, BookmarkCheckIcon, Loader2Icon, MessageCircleIcon, RefreshCwIcon, UploadIcon, UserPlusIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api/client";
import { waApi } from "@/lib/api/endpoints";
import type { WaChat } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Composer, useAttachments } from "./composer";
import { MediaLoadButton } from "./media-load-dialog";
import { MessageBubble } from "./message-bubble";
import { useChatThread } from "./use-chat-thread";
import { useWaStreamEvent } from "./wa-stream";
import { Avatar } from "./chat-list";
import { CONTENT_LABELS, chatSubtitle, chatTitle, contentKindOfType, dayKey, dayLabel } from "./wa-utils";

const BOTTOM_THRESHOLD = 96;

interface ChatThreadProps {
  instance: string;
  chat: WaChat;
  /** null = can send; otherwise why not (disconnected account…). */
  blockedReason: string | null;
  onBack: () => void;
}

export function ChatThread({ instance, chat, blockedReason, onBack }: ChatThreadProps) {
  const thread = useChatThread(instance, chat.jid);
  const attachments = useAttachments();
  const queryClient = useQueryClient();
  const title = chatTitle(chat);
  const logRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const lastId = useRef<string | null>(null);
  const firstId = useRef<string | null>(null);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setUnseen(0);
  }, []);

  // Keep the reading position when older messages are prepended; follow new ones at the bottom.
  useLayoutEffect(() => {
    const el = logRef.current;
    const messages = thread.messages;
    if (!el || messages.length === 0) {
      lastId.current = null;
      firstId.current = null;
      return;
    }
    const newFirst = messages[0]!.id;
    const newLast = messages.at(-1)!.id;
    if (prepend.current && firstId.current && newFirst !== firstId.current) {
      el.scrollTop = prepend.current.top + (el.scrollHeight - prepend.current.height);
      prepend.current = null;
    } else if (lastId.current === null) {
      el.scrollTop = el.scrollHeight; // first paint of this chat
    } else if (newLast !== lastId.current) {
      const fresh = messages.slice(messages.findIndex((m) => m.id === lastId.current) + 1);
      const mine = fresh.some((m) => m.from_me);
      if (atBottom.current || mine) el.scrollTop = el.scrollHeight;
      else setUnseen((n) => n + fresh.filter((m) => !m.from_me).length);
    }
    firstId.current = newFirst;
    lastId.current = newLast;
  }, [thread.messages]);

  // Reset per chat.
  useEffect(() => {
    lastId.current = null;
    firstId.current = null;
    atBottom.current = true;
    setUnseen(0);
    setShowJump(false);
  }, [chat.jid]);

  const requestOlder = () => {
    const root = logRef.current;
    if (!root || !thread.hasMore || thread.loadingOlder || thread.status !== "ready") return;
    prepend.current = { height: root.scrollHeight, top: root.scrollTop };
    void thread.loadOlder();
  };

  // Upward infinite scroll: a sentinel at the top of the log.
  useEffect(() => {
    const root = logRef.current;
    const sentinel = topRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (!thread.hasMore || thread.loadingOlder || thread.status !== "ready") return;
        prepend.current = { height: root.scrollHeight, top: root.scrollTop };
        void thread.loadOlder();
      },
      { root, rootMargin: "200px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [thread.hasMore, thread.loadingOlder, thread.status, thread.loadOlder]);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < BOTTOM_THRESHOLD;
    setShowJump(distance > 320);
    if (atBottom.current) setUnseen(0);
    // Fallback to the sentinel observer (throttled in background tabs).
    if (el.scrollTop < 160) requestOlder();
  };

  // Screen-reader announcement for inbound messages of this chat.
  useWaStreamEvent("message", (data) => {
    if (data.instance !== instance || data.chat_jid !== chat.jid || data.from_me) return;
    const kind = contentKindOfType(data.type);
    const preview = data.text?.trim() || (kind === "text" || kind === "other" ? "nova mensagem" : CONTENT_LABELS[kind]);
    setAnnouncement(`Nova mensagem de ${title}: ${preview.slice(0, 140)}`);
  });

  const jumpTo = useCallback((id: string) => {
    const node = logRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!node) {
      toast("A mensagem original não está carregada. Role para cima para buscar mensagens antigas.");
      return;
    }
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlight(id);
    setTimeout(() => setHighlight((h) => (h === id ? null : h)), 1600);
  }, []);

  const save = useMutation({
    mutationFn: () => waApi.saveContacts(instance, [chat.jid]),
    onSuccess: (report) => {
      const r = report.results[0];
      if (r && (r.status === "saved" || r.status === "skipped_already_saved")) {
        toast.success(r.status === "saved" ? "Contato salvo na agenda." : "Este contato já estava salvo.");
        void queryClient.invalidateQueries({ queryKey: qk.wa.chats(instance) });
      } else {
        toast.error(r?.reason ? `Não foi possível salvar: ${r.reason}` : "Não foi possível salvar o contato.");
      }
    },
    onError: (e) => toast.error(errorMessage(e, "Falha ao salvar o contato.")),
  });

  /* ---- drag and drop ---- */
  const dragDepth = useRef(0);
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const dropHandlers = blockedReason
    ? {}
    : {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        },
        onDragOver: (e: DragEvent) => {
          if (hasFiles(e)) e.preventDefault();
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          attachments.add(e.dataTransfer.files);
        },
      };

  const authors = useMemo(() => new Map(thread.messages.map((m) => [m.id, m.from_me])), [thread.messages]);
  const quotedAuthor = (id: string | undefined) => {
    if (!id) return "";
    const fromMe = authors.get(id);
    return fromMe === undefined ? "Resposta a" : fromMe ? "Você" : title;
  };

  const rows = useMemo(() => {
    let previousDay: string | null = null;
    let previousSide: boolean | null = null;
    return thread.messages.map((m) => {
      const day = dayKey(m.ts);
      const newDay = day !== previousDay;
      const first = newDay || previousSide !== m.from_me;
      previousDay = day;
      previousSide = m.from_me;
      return { message: m, newDay, first };
    });
  }, [thread.messages]);

  return (
    <section
      className="relative flex h-full min-h-0 flex-col"
      aria-label={`Conversa com ${title}`}
      onKeyDown={(e) => {
        // Esc returns to the list on small screens (dialogs handle their own Esc).
        if (e.key === "Escape" && !e.defaultPrevented && window.matchMedia("(max-width: 767px)").matches) onBack();
      }}
      {...dropHandlers}
    >
      <header className="flex items-center gap-3 border-b bg-card px-2 py-2 sm:px-3">
        <Button size="icon-sm" variant="ghost" className="md:hidden" onClick={onBack} aria-label="Voltar para as conversas">
          <ArrowLeftIcon />
        </Button>
        <Avatar name={title} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground truncate font-mono text-xs">{chatSubtitle(chat)}</p>
        </div>
        <MediaLoadButton
          instance={instance}
          chatJid={chat.jid}
          disabledReason={blockedReason ? "Conecte o WhatsApp para baixar ou recuperar os arquivos desta conversa." : null}
          onFinished={() => void thread.refresh()}
        />
        {chat.saved ? (
          <span className="text-muted-foreground hidden items-center gap-1 text-xs sm:inline-flex" title="Salvo na agenda do WhatsApp">
            <BookmarkCheckIcon className="text-success size-4" aria-hidden="true" /> Salvo na agenda
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => save.mutate()} disabled={save.isPending || blockedReason !== null}>
            {save.isPending ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon />}
            <span className="hidden sm:inline">Salvar contato</span>
          </Button>
        )}
      </header>

      <div
        ref={logRef}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label={`Mensagens com ${title}`}
        aria-busy={thread.status === "loading" || thread.loadingOlder}
        className="bg-muted/40 relative min-h-0 flex-1 overflow-y-auto px-3 pb-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:ring-inset sm:px-6 dark:bg-background/60"
      >
        <div ref={topRef} className="h-px" aria-hidden="true" />
        {thread.status === "loading" && <ThreadSkeleton />}
        {thread.status === "error" && (
          <EmptyState
            icon={MessageCircleIcon}
            title="Não consegui abrir a conversa"
            description={thread.error}
            action={
              <Button variant="outline" size="sm" onClick={() => void thread.reload()}>
                <RefreshCwIcon /> Tentar de novo
              </Button>
            }
          />
        )}
        {thread.status === "ready" && (
          <p className="text-muted-foreground flex h-8 items-center justify-center gap-2 text-xs" role="status">
            {thread.loadingOlder ? (
              <>
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                {thread.fetching ? "Buscando mensagens antigas no WhatsApp…" : "Carregando mensagens anteriores…"}
              </>
            ) : !thread.hasMore && thread.messages.length > 0 ? (
              "Início da conversa disponível"
            ) : null}
          </p>
        )}
        {thread.status === "ready" && thread.messages.length === 0 && (
          <EmptyState
            icon={MessageCircleIcon}
            title="Sem mensagens por aqui"
            description="As conversas aparecem a partir da conexão do WhatsApp (o histórico antigo é parcial). Escreva a primeira mensagem abaixo."
          />
        )}
        {rows.map(({ message, newDay, first }) => (
          <Fragment key={message.id}>
            {newDay && (
              <div className="sticky top-1 z-[2] my-2 flex justify-center" role="separator" aria-label={dayLabel(message.ts)}>
                <span className="bg-card text-muted-foreground min-w-32 rounded-md border px-2.5 py-0.5 text-center text-xs font-medium shadow-xs">{dayLabel(message.ts)}</span>
              </div>
            )}
            <MessageBubble
              message={message}
              instance={instance}
              chatJid={chat.jid}
              contactName={quotedAuthor(message.quoted?.id)}
              first={first}
              highlighted={highlight === message.id}
              onJumpTo={jumpTo}
              onRetry={thread.retry}
              onDiscard={thread.discard}
            />
          </Fragment>
        ))}
      </div>

      {showJump && (
        <Button
          size="icon"
          variant="outline"
          className="absolute right-4 bottom-20 z-10 rounded-full shadow-md"
          onClick={() => scrollToBottom(true)}
          aria-label={unseen > 0 ? `Ir para o fim: ${unseen} ${unseen === 1 ? "mensagem nova" : "mensagens novas"}` : "Ir para a mensagem mais recente"}
        >
          <ArrowDownIcon />
          {unseen > 0 && (
            <span className="bg-success text-success-foreground absolute -top-1.5 -right-1.5 min-w-5 rounded-full px-1 text-[11px] leading-5 font-semibold tabular">
              {unseen > 99 ? "99+" : unseen}
            </span>
          )}
        </Button>
      )}

      <Composer thread={thread} attachments={attachments} blockedReason={blockedReason} contactName={title} />

      {dragging && (
        <div className="bg-background/85 pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6 backdrop-blur-sm">
          <div className="border-brand/50 text-brand flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-10 py-8 text-sm font-medium">
            <UploadIcon className="size-6" aria-hidden="true" />
            Solte para anexar
          </div>
        </div>
      )}

      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>
    </section>
  );
}

function ThreadSkeleton() {
  return (
    <div className="space-y-3 pt-4" aria-hidden="true">
      {[56, 72, 40, 64, 48].map((w, i) => (
        <div key={i} className={cn("flex", i % 2 ? "justify-end" : "justify-start")}>
          <Skeleton className="h-9 rounded-lg" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}
