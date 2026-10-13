// Left pane: conversations (or validated leads to start one), search,
// last-message preview with media icons, unread counts, saved-contact marks,
// keyboard navigation (↑/↓/Home/End) and bulk "save contacts".
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookmarkCheckIcon, ListChecksIcon, Loader2Icon, MessageCircleIcon, SearchIcon, UserIcon, UserPlusIcon, UsersIcon, XIcon } from "lucide-react";
import { memo, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorMessage } from "@/lib/api/client";
import { waApi } from "@/lib/api/endpoints";
import type { WaChat, WaLeadContact } from "@/lib/api/types";
import { plural } from "@/lib/format";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { TagList } from "@/components/common/tag-badge";
import { CONTENT_ICONS } from "./message-bubble";
import { chatPreview, chatTitle, formatPhone, initialsOf, listTime } from "./wa-utils";

const AVATAR_TONES = ["bg-brand/15 text-brand", "bg-success/15 text-success", "bg-warning/20 text-warning-foreground dark:text-warning", "bg-chart-4/15 text-chart-4", "bg-chart-5/15 text-chart-5"];

export function Avatar({ name, className }: { name: string; className?: string }) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return (
    <span
      className={cn("flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold", AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length], className)}
      aria-hidden="true"
    >
      {/\p{L}/u.test(name) ? initialsOf(name) : <UserIcon className="size-5" />}
    </span>
  );
}

export type ChatSource = "chats" | "leads";

/** A validated lead as a (possibly new) conversation. */
/** A lead row keeps the lead's own name (several leads can share one WhatsApp) plus the chat's activity. */
export function leadAsChat(lead: WaLeadContact, existing?: WaChat): WaChat {
  if (existing) return { ...existing, name: lead.name, phone: lead.phone ?? existing.phone };
  return { jid: lead.jid, name: lead.name, phone: lead.phone, last_message: null, last_type: null, last_ts: null, unread: 0, saved: false };
}

interface ListRow {
  /** Unique per row: leads sharing a WhatsApp number would collide on the jid. */
  key: string;
  chat: WaChat;
  tags: string[];
}

interface ChatListProps {
  instance: string | null;
  source: ChatSource;
  onSourceChange: (source: ChatSource) => void;
  chats: WaChat[] | undefined;
  chatsLoading: boolean;
  chatsError: unknown;
  leads: WaLeadContact[] | undefined;
  leadsLoading: boolean;
  selectedJid: string | null;
  onSelect: (chat: WaChat) => void;
  /** Disconnected-account call to action rendered above the list. */
  banner?: ReactNode;
  canWrite: boolean;
}

export function ChatList({
  instance,
  source,
  onSourceChange,
  chats,
  chatsLoading,
  chatsError,
  leads,
  leadsLoading,
  selectedJid,
  onSelect,
  banner,
  canWrite,
}: ChatListProps) {
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const queryClient = useQueryClient();

  const term = query.trim().toLowerCase();
  const digits = term.replace(/\D/g, "");
  const chatsByJid = useMemo(() => new Map((chats ?? []).map((c) => [c.jid, c])), [chats]);

  // Tags of every lead behind a WhatsApp number, for the Conversas tab.
  const tagsByJid = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const lead of leads ?? []) {
      if (!lead.tags?.length) continue;
      map.set(lead.jid, [...new Set([...(map.get(lead.jid) ?? []), ...lead.tags])]);
    }
    return map;
  }, [leads]);

  const rows: ListRow[] = useMemo(() => {
    const matches = (name: string, phone: string | null, jid: string, tags: readonly string[]) =>
      !term ||
      name.toLowerCase().includes(term) ||
      tags.some((tag) => tag.toLowerCase().includes(term)) ||
      (digits.length >= 3 && (`${phone ?? ""}${jid}`.replace(/\D/g, "").includes(digits)));
    if (source === "leads") {
      return (leads ?? [])
        .filter((l) => matches(l.name, l.phone, l.jid, l.tags ?? []))
        .map((l) => ({ key: `lead-${l.lead_id}`, chat: leadAsChat(l, chatsByJid.get(l.jid)), tags: l.tags ?? [] }));
    }
    return (chats ?? [])
      .map((c) => ({ key: c.jid, chat: c, tags: tagsByJid.get(c.jid) ?? [] }))
      .filter((r) => matches(chatTitle(r.chat), r.chat.phone, r.chat.jid, r.tags));
  }, [source, leads, chats, chatsByJid, tagsByJid, term, digits]);

  const loading = source === "leads" ? leadsLoading : chatsLoading;

  const save = useMutation({
    mutationFn: (jids: string[]) => waApi.saveContacts(instance!, jids),
    onSuccess: (report) => {
      const parts = [plural(report.saved, "salvo", "salvos")];
      if (report.skipped) parts.push(`${report.skipped} já ${report.skipped === 1 ? "estava salvo" : "estavam salvos"}`);
      if (report.failed) parts.push(`${report.failed} ${report.failed === 1 ? "falhou" : "falharam"}`);
      (report.failed ? toast.warning : toast.success)(`Contatos: ${parts.join(", ")}.`);
      setChecked(new Set());
      setSelecting(false);
      if (instance) void queryClient.invalidateQueries({ queryKey: qk.wa.chats(instance) });
    },
    onError: (e) => toast.error(errorMessage(e, "Falha ao salvar os contatos.")),
  });

  // Roving focus between rows.
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-chat-row]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  const toggle = (jid: string, on: boolean) =>
    setChecked((set) => {
      const next = new Set(set);
      if (on) next.add(jid);
      else next.delete(jid);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b p-2.5">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" aria-hidden="true" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={source === "leads" ? "Buscar lead, número ou tag" : "Buscar conversa, número ou tag"}
              aria-label="Buscar conversas"
              className="h-8 pl-8"
            />
          </div>
          {source === "chats" && canWrite && (
            <Button
              size="icon-sm"
              variant={selecting ? "secondary" : "ghost"}
              onClick={() => {
                setSelecting((v) => !v);
                setChecked(new Set());
              }}
              aria-pressed={selecting}
              aria-label="Selecionar conversas para salvar contatos"
              title="Selecionar para salvar na agenda"
            >
              <ListChecksIcon />
            </Button>
          )}
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={source}
          onValueChange={(v) => v && onSourceChange(v as ChatSource)}
          className="w-full"
          aria-label="Origem da lista"
        >
          <ToggleGroupItem value="chats" className="flex-1 text-xs">
            <MessageCircleIcon /> Conversas
          </ToggleGroupItem>
          <ToggleGroupItem value="leads" className="flex-1 text-xs">
            <UsersIcon /> Leads
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {banner}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <ListSkeleton />
        ) : chatsError && source === "chats" ? (
          <p className="text-destructive p-4 text-sm">{errorMessage(chatsError, "Não consegui carregar as conversas.")}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={source === "leads" ? UsersIcon : MessageCircleIcon}
            title={term ? "Nada encontrado" : source === "leads" ? "Nenhum lead com WhatsApp validado" : instance ? "Nenhuma conversa ainda" : "Nenhuma conta conectada"}
            description={
              term
                ? "Tente outro nome ou parte do número."
                : source === "leads"
                  ? "Valide o WhatsApp dos seus leads na aba Leads para iniciar conversas por aqui."
                  : instance
                    ? "As conversas aparecem a partir do momento em que o WhatsApp conecta."
                    : "Conecte um número para ver e iniciar conversas."
            }
            className="py-10"
          />
        ) : (
          <ul ref={listRef} onKeyDown={onListKeyDown} aria-label={source === "leads" ? "Leads com WhatsApp" : "Conversas"} className="py-1">
            {rows.map(({ key, chat, tags }) => (
              <ChatRow
                key={key}
                chat={chat}
                tags={tags}
                selected={chat.jid === selectedJid}
                onSelect={onSelect}
                isLead={source === "leads"}
                selecting={selecting && !chat.saved}
                checked={checked.has(chat.jid)}
                onCheck={toggle}
              />
            ))}
          </ul>
        )}
      </div>

      {selecting && (
        <div className="flex items-center gap-2 border-t bg-card p-2" role="region" aria-label="Salvar contatos selecionados">
          <span className="text-muted-foreground flex-1 text-xs tabular" aria-live="polite">
            {checked.size ? plural(checked.size, "selecionado", "selecionados") : "Marque os contatos não salvos"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setSelecting(false)}>
            <XIcon /> Cancelar
          </Button>
          <Button size="sm" disabled={checked.size === 0 || save.isPending} onClick={() => save.mutate([...checked])}>
            {save.isPending ? <Loader2Icon className="animate-spin" /> : <UserPlusIcon />} Salvar
          </Button>
        </div>
      )}
    </div>
  );
}

const ChatRow = memo(function ChatRow({
  chat,
  tags,
  selected,
  onSelect,
  isLead,
  selecting,
  checked,
  onCheck,
}: {
  chat: WaChat;
  tags: string[];
  selected: boolean;
  onSelect: (chat: WaChat) => void;
  isLead: boolean;
  selecting: boolean;
  checked: boolean;
  onCheck: (jid: string, on: boolean) => void;
}) {
  const title = chatTitle(chat);
  const preview = chatPreview(chat);
  const Icon = CONTENT_ICONS[preview.kind];
  const showIcon = preview.kind !== "text" && preview.kind !== "other";
  const unread = selected ? 0 : chat.unread;
  const sub = isLead && !chat.last_ts ? formatPhone(chat.phone) || "Iniciar conversa" : preview.text || "Sem mensagens";

  return (
    <li className="flex items-center [content-visibility:auto] [contain-intrinsic-size:auto_64px]">
      {selecting && (
        <span className="pl-3">
          <Checkbox checked={checked} onCheckedChange={(v) => onCheck(chat.jid, v === true)} aria-label={`Selecionar ${title}`} />
        </span>
      )}
      <button
        type="button"
        data-chat-row
        onClick={() => onSelect(chat)}
        aria-current={selected ? "true" : undefined}
        aria-label={`${title}${unread ? `, ${unread} não ${unread === 1 ? "lida" : "lidas"}` : ""}. ${sub}`}
        className={cn(
          "mx-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          selected ? "bg-accent" : "hover:bg-accent/60",
        )}
      >
        <Avatar name={title} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "font-medium")}>{title}</span>
            {chat.last_ts ? (
              <span className={cn("shrink-0 text-[11px] tabular", unread ? "text-success font-medium" : "text-muted-foreground")}>{listTime(chat.last_ts)}</span>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {showIcon && <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />}
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{sub}</span>
            {chat.saved && <BookmarkCheckIcon className="text-muted-foreground/70 size-3.5 shrink-0" aria-label="Salvo na agenda" />}
            {unread > 0 && (
              <span className="bg-success text-success-foreground min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular" aria-hidden="true">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </span>
          {tags.length > 0 && <TagList tags={tags} max={3} interactive={false} className="mt-1" />}
        </span>
      </button>
    </li>
  );
});

function ListSkeleton() {
  return (
    <div className="space-y-1 p-2" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
