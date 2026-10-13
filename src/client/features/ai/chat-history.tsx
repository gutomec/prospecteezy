// Conversation history (GET /api/chat): open, delete (confirm; 409 while the
// conversation is answering). "Nova conversa" lives next to it in the toolbar.
import { useQuery } from "@tanstack/react-query";
import { HistoryIcon, Loader2Icon, MessageSquareIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useConfirm } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { errorMessage } from "@/lib/api/client";
import { aiChatApi } from "@/lib/api/endpoints";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useAiChat } from "./ai-chat-provider";
import { chatDateLabel } from "./chat-logic";

export function ChatHistory() {
  const { chatId, openChat, deleteChat } = useAiChat();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: qk.ai.chats,
    queryFn: () => aiChatApi.list().then((r) => r.chats),
    enabled: open,
    staleTime: 5_000,
  });
  const chats = query.data ?? [];

  const remove = async (id: string, title: string) => {
    const ok = await confirm({
      title: "Excluir conversa?",
      description: `“${title}” e todo o histórico dela serão apagados. Os leads e mensagens já enviadas continuam.`,
      confirmLabel: "Excluir",
      destructive: true,
    });
    if (ok) await deleteChat(id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Histórico de conversas">
          <HistoryIcon /> <span className="hidden sm:inline">Histórico</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">Conversas recentes</div>
        <div className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1">
          {query.isLoading && (
            <p className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> Carregando…
            </p>
          )}
          {query.error && <p className="text-destructive p-3 text-sm">{errorMessage(query.error, "Não consegui listar as conversas.")}</p>}
          {!query.isLoading && !query.error && chats.length === 0 && (
            <p className="text-muted-foreground p-3 text-sm">Nenhuma conversa salva ainda.</p>
          )}
          {chats.length > 0 && (
            <ul aria-label="Conversas">
              {chats.map((chat) => {
                const title = chat.title?.trim() || "Conversa sem título";
                const current = chat.id === chatId;
                return (
                  <li key={chat.id} className={cn("group flex items-center gap-1 rounded-md", current && "bg-muted")}>
                    <button
                      type="button"
                      className="hover:bg-muted focus-visible:ring-ring/50 flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-[3px]"
                      aria-current={current ? "true" : undefined}
                      onClick={() => {
                        setOpen(false);
                        if (!current) void openChat(chat.id);
                      }}
                    >
                      <MessageSquareIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{title}</span>
                        <span className="text-muted-foreground block text-[11px] tabular">
                          {chatDateLabel(chat.updated_at)}
                          {chat.credits_used > 0 ? ` · ${chat.credits_used.toLocaleString("pt-BR")} créditos` : ""}
                        </span>
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-destructive mr-1"
                      aria-label={`Excluir conversa “${title}”`}
                      onClick={() => void remove(chat.id, title)}
                    >
                      <Trash2Icon />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
