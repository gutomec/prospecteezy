// One chat bubble: optional quoted reply, media, caption/text with WhatsApp
// formatting (rendered as React nodes, never HTML), time + delivery ticks,
// reaction chips. Optimistic (local) messages carry `local` state.
import {
  AlertCircleIcon,
  CheckCheckIcon,
  CheckIcon,
  ClockIcon,
  ContactIcon,
  FileIcon,
  ImageIcon,
  ListChecksIcon,
  MapPinIcon,
  MessageSquareIcon,
  MicIcon,
  RefreshCwIcon,
  StickerIcon,
  Trash2Icon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { MediaKey } from "@/lib/api/endpoints";
import type { WaMessage, WaQuoted } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { MessageMedia } from "./message-media";
import {
  CONTENT_LABELS,
  contentKindOfType,
  formatBytes,
  groupReactions,
  messageTime,
  parseWaText,
  type AttachmentKind,
  type TextNode,
  type WaContentKind,
} from "./wa-utils";

/** Optimistic message state (before the backend/SSE echo replaces it). */
export interface LocalState {
  state: "sending" | "error";
  error?: string;
  /** Object URL of an image/video being sent. */
  previewUrl?: string;
  kind?: AttachmentKind;
  fileName?: string;
  fileSize?: number;
}

export type ThreadMessage = WaMessage & { local?: LocalState };

export const CONTENT_ICONS: Record<WaContentKind, LucideIcon> = {
  image: ImageIcon,
  video: VideoIcon,
  audio: MicIcon,
  voice: MicIcon,
  document: FileIcon,
  sticker: StickerIcon,
  location: MapPinIcon,
  contact: ContactIcon,
  poll: ListChecksIcon,
  text: MessageSquareIcon,
  other: MessageSquareIcon,
};

/* ---------------- text ---------------- */

function renderNodes(nodes: TextNode[], keyPrefix = ""): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.type) {
      case "text":
        return <span key={key}>{node.text}</span>;
      case "link":
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow" className="text-brand break-all underline underline-offset-2">
            {node.text}
          </a>
        );
      case "bold":
        return <strong key={key} className="font-semibold">{renderNodes(node.children, `${key}-`)}</strong>;
      case "italic":
        return <em key={key}>{renderNodes(node.children, `${key}-`)}</em>;
      case "strike":
        return <s key={key}>{renderNodes(node.children, `${key}-`)}</s>;
      case "code":
        return (
          <code key={key} className="rounded bg-black/[0.06] px-1 font-mono text-[0.85em] dark:bg-white/10">
            {node.text}
          </code>
        );
      case "codeblock":
        return (
          <pre key={key} className="my-1 overflow-x-auto rounded bg-black/[0.06] p-2 font-mono text-[0.85em] whitespace-pre dark:bg-white/10">
            {node.text}
          </pre>
        );
    }
  });
}

export function WaText({ text, className }: { text: string; className?: string }) {
  return <span className={cn("break-words whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>{renderNodes(parseWaText(text))}</span>;
}

/* ---------------- pieces ---------------- */

const STATUS_LABELS: Record<string, string> = {
  pending: "Enviando",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  played: "Reproduzida",
  error: "Falha no envio",
};

export function StatusTicks({ status, className }: { status: string | null; className?: string }) {
  if (!status) return null;
  const label = STATUS_LABELS[status] ?? status;
  const common = cn("size-3.5 shrink-0", className);
  let icon: ReactNode;
  if (status === "pending") icon = <ClockIcon className={common} />;
  else if (status === "sent") icon = <CheckIcon className={common} />;
  else if (status === "delivered") icon = <CheckCheckIcon className={common} />;
  else if (status === "read" || status === "played") icon = <CheckCheckIcon className={cn(common, "text-brand")} />;
  else if (status === "error") icon = <AlertCircleIcon className={cn(common, "text-destructive")} />;
  else return null;
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex">
      {icon}
    </span>
  );
}

export function QuotedBlock({ quoted, fromMe, contactName, onJump }: { quoted: WaQuoted; fromMe: boolean; contactName: string; onJump?: (id: string) => void }) {
  const kind = contentKindOfType(quoted.type);
  const Icon = CONTENT_ICONS[kind];
  const isMedia = kind !== "text" && kind !== "other";
  const text = quoted.text?.trim() || (isMedia ? CONTENT_LABELS[kind] : "Mensagem");
  return (
    <button
      type="button"
      onClick={() => onJump?.(quoted.id)}
      className={cn(
        "mb-1 flex w-full min-w-0 flex-col items-start rounded-md border-l-4 px-2 py-1 text-left text-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        fromMe ? "border-success bg-black/[0.05] hover:bg-black/[0.08] dark:bg-white/[0.06]" : "border-brand bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.06]",
      )}
      aria-label={`Resposta a: ${text}. Ir para a mensagem original`}
    >
      <span className={cn("font-semibold", fromMe ? "text-success" : "text-brand")}>{contactName}</span>
      <span className="text-muted-foreground flex max-w-full items-center gap-1">
        {isMedia && <Icon className="size-3 shrink-0" aria-hidden="true" />}
        <span className="line-clamp-2">{text}</span>
      </span>
    </button>
  );
}

function Reactions({ message }: { message: WaMessage }) {
  const groups = groupReactions(message.reactions);
  if (groups.length === 0) return null;
  const label = groups.map((g) => `${g.emoji}${g.count > 1 ? ` ${g.count}` : ""}${g.mine ? " (você)" : ""}`).join(", ");
  return (
    <div
      className={cn("relative z-[1] -mt-1.5 flex gap-1", message.from_me ? "justify-end pr-2" : "pl-2")}
      role="img"
      aria-label={`Reações: ${label}`}
    >
      {groups.map((g) => (
        <span
          key={g.emoji}
          className={cn(
            "inline-flex h-6 items-center gap-0.5 rounded-full border bg-card px-1.5 text-sm shadow-xs",
            g.mine && "border-brand/40",
          )}
        >
          <span aria-hidden="true">{g.emoji}</span>
          {g.count > 1 && <span className="text-muted-foreground text-xs tabular">{g.count}</span>}
        </span>
      ))}
    </div>
  );
}

function LocalPreview({ local }: { local: LocalState }) {
  if (local.previewUrl && local.kind === "image") {
    return <img src={local.previewUrl} alt="" className="max-h-64 max-w-[300px] rounded-md object-cover" />;
  }
  if (local.previewUrl && local.kind === "video") {
    return <video src={local.previewUrl} muted className="max-h-64 max-w-[300px] rounded-md bg-black" aria-label="Vídeo sendo enviado" />;
  }
  const Icon = local.kind === "audio" ? MicIcon : local.kind === "video" ? VideoIcon : local.kind === "image" ? ImageIcon : FileIcon;
  return (
    <div className="flex w-64 max-w-full items-center gap-3 rounded-md bg-black/[0.04] p-2.5 dark:bg-white/[0.06]">
      <Icon className="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{local.fileName}</p>
        {local.fileSize != null && <p className="text-muted-foreground text-xs">{formatBytes(local.fileSize)}</p>}
      </div>
    </div>
  );
}

/* ---------------- bubble ---------------- */

interface BubbleProps {
  message: ThreadMessage;
  instance: string;
  chatJid: string;
  contactName: string;
  /** First bubble of a run from the same side (gets the tail spacing). */
  first: boolean;
  highlighted: boolean;
  onJumpTo: (id: string) => void;
  onRetry?: (message: ThreadMessage) => void;
  onDiscard?: (message: ThreadMessage) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  instance,
  chatJid,
  contactName,
  first,
  highlighted,
  onJumpTo,
  onRetry,
  onDiscard,
}: BubbleProps) {
  const { from_me: fromMe, media, local } = message;
  const kind = contentKindOfType(message.type);
  const mediaKey: MediaKey = { instance, chat: chatJid, id: message.id, fromMe };
  const sticker = media?.kind === "sticker" && media.cached;
  const text = message.text?.trim() ? message.text : null;
  const placeholderKind = !media && !local && !text && kind !== "text" ? kind : null;
  const status = local ? (local.state === "error" ? "error" : "pending") : fromMe ? message.status : null;

  return (
    <div className={cn("flex flex-col", fromMe ? "items-end" : "items-start", first ? "mt-2.5" : "mt-0.5")}>
      <div
        data-message-id={message.id}
        className={cn(
          "relative min-w-0 max-w-[min(85%,34rem)] rounded-lg text-sm shadow-xs transition-[box-shadow,background-color] duration-500",
          sticker ? "bg-transparent shadow-none" : fromMe ? "bg-success/12 dark:bg-success/16" : "border bg-card",
          sticker ? "p-0" : media && media.available && media.kind !== "audio" && media.kind !== "voice" && media.kind !== "document" ? "p-1" : "px-2.5 py-1.5",
          first && !sticker && (fromMe ? "rounded-tr-sm" : "rounded-tl-sm"),
          highlighted && "ring-brand/60 ring-2",
          local?.state === "error" && "ring-destructive/40 ring-1",
        )}
      >
        {message.quoted && (
          <div className={cn(media && media.available && "px-1 pt-1")}>
            <QuotedBlock quoted={message.quoted} fromMe={fromMe} contactName={contactName} onJump={onJumpTo} />
          </div>
        )}
        {local && (local.previewUrl || local.fileName) ? (
          <LocalPreview local={local} />
        ) : media ? (
          <MessageMedia media={media} mediaKey={mediaKey} caption={text} fromMe={fromMe} />
        ) : null}
        {placeholderKind && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 italic">
            {(() => {
              const Icon = CONTENT_ICONS[placeholderKind];
              return <Icon className="size-4" aria-hidden="true" />;
            })()}
            {CONTENT_LABELS[placeholderKind]}
          </span>
        )}
        <div className={cn("flex flex-wrap items-end justify-end gap-x-2", media && media.available && !sticker && media.kind !== "audio" && media.kind !== "voice" && media.kind !== "document" && "px-1.5 pb-0.5")}>
          {text && <WaText text={text} className={cn("min-w-0 flex-1 basis-auto leading-snug", media && "pt-1")} />}
          <span
            className={cn(
              "text-muted-foreground ml-auto inline-flex shrink-0 translate-y-0.5 items-center gap-1 text-[11px] tabular",
              sticker && "rounded-full bg-black/45 px-1.5 text-white",
            )}
          >
            {messageTime(message.ts)}
            <StatusTicks status={status} />
          </span>
        </div>
        {local?.state === "error" && (
          <div className="mt-1.5 space-y-1.5 border-t border-destructive/20 pt-1.5" role="alert">
            <p className="text-destructive text-xs leading-snug">{local.error}</p>
            <div className="flex gap-1.5">
              {onRetry && (
                <Button size="xs" variant="outline" onClick={() => onRetry(message)}>
                  <RefreshCwIcon /> Tentar de novo
                </Button>
              )}
              {onDiscard && (
                <Button size="xs" variant="ghost" onClick={() => onDiscard(message)}>
                  <Trash2Icon /> Descartar
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      <Reactions message={message} />
    </div>
  );
});
