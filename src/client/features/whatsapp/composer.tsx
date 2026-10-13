// Message composer: multiline text (Enter sends, Shift+Enter breaks line),
// attachments (button, drag-and-drop on the thread, pasted images) uploaded
// right away to POST /api/wa/media with progress, then sent one message per
// attachment via POST /api/wa/send (caption on the first). Voice notes only
// where the browser records OGG/Opus (the backend refuses webm as voice).
import { FileIcon, ImageIcon, Loader2Icon, MicIcon, PaperclipIcon, SendHorizontalIcon, Trash2Icon, VideoIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api/client";
import { uploadWaMedia } from "@/lib/api/endpoints";
import type { WaUploadedMedia } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import type { ChatThread } from "./use-chat-thread";
import { attachmentKind, attachmentLimitError, formatBytes, formatDuration, type AttachmentKind } from "./wa-utils";

const MAX_ATTACHMENTS = 10;
const VOICE_MIME = "audio/ogg;codecs=opus";
export const ACCEPTED_FILES = "image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip";

/* ---------------- attachments ---------------- */

export interface Attachment {
  id: string;
  file: File;
  kind: AttachmentKind;
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  progress: number;
  uploaded: WaUploadedMedia | null;
  error: string | null;
  controller: AbortController;
}

export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const patch = (id: string, next: Partial<Attachment>) => setItems((list) => list.map((a) => (a.id === id ? { ...a, ...next } : a)));

  const add = useCallback((files: File[] | FileList) => {
    const list = [...files];
    const room = MAX_ATTACHMENTS - itemsRef.current.length;
    if (list.length > room) toast.error(`Até ${MAX_ATTACHMENTS} anexos por vez.`);
    for (const file of list.slice(0, Math.max(0, room))) {
      const limit = attachmentLimitError(file);
      if (limit) {
        toast.error(limit);
        continue;
      }
      const kind = attachmentKind(file);
      const attachment: Attachment = {
        id: crypto.randomUUID(),
        file,
        kind,
        previewUrl: kind === "image" || kind === "video" ? URL.createObjectURL(file) : null,
        status: "uploading",
        progress: 0,
        uploaded: null,
        error: null,
        controller: new AbortController(),
      };
      setItems((current) => [...current, attachment]);
      uploadWaMedia(file, { onProgress: (p) => patch(attachment.id, { progress: p }), signal: attachment.controller.signal })
        .then((uploaded) => patch(attachment.id, { status: "ready", progress: 1, uploaded }))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          patch(attachment.id, { status: "error", error: errorMessage(error, "Falha no envio do arquivo.") });
        });
    }
  }, []);

  const remove = useCallback((id: string) => {
    setItems((list) => {
      const target = list.find((a) => a.id === id);
      if (target) {
        target.controller.abort();
        if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
      }
      return list.filter((a) => a.id !== id);
    });
  }, []);

  /** Empties the tray; `keepPreviews` hands the object URLs over to the optimistic bubbles. */
  const clear = useCallback((keepPreviews = false) => {
    setItems((list) => {
      for (const a of list) {
        a.controller.abort();
        if (!keepPreviews && a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
  }, []);

  // Release everything on unmount (chat switch).
  useEffect(
    () => () => {
      for (const a of itemsRef.current) {
        a.controller.abort();
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    },
    [],
  );

  return { items, add, remove, clear };
}

export type Attachments = ReturnType<typeof useAttachments>;

function AttachmentChip({ item, onRemove }: { item: Attachment; onRemove: () => void }) {
  const Icon = item.kind === "video" ? VideoIcon : item.kind === "audio" ? MicIcon : item.kind === "image" ? ImageIcon : FileIcon;
  return (
    <li
      className={cn(
        "relative flex w-52 shrink-0 items-center gap-2 overflow-hidden rounded-lg border bg-background p-1.5 pr-8",
        item.status === "error" && "border-destructive/40",
      )}
    >
      {item.previewUrl && item.kind === "image" ? (
        <img src={item.previewUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
      ) : (
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded" aria-hidden="true">
          <Icon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={item.file.name}>
          {item.file.name}
        </p>
        <p className={cn("text-[11px] leading-tight tabular", item.status === "error" ? "text-destructive line-clamp-2" : "text-muted-foreground truncate")} title={item.error ?? undefined}>
          {item.status === "uploading"
            ? `Enviando… ${Math.round(item.progress * 100)}%`
            : item.status === "error"
              ? item.error
              : formatBytes(item.file.size)}
        </p>
      </div>
      <Button type="button" size="icon-xs" variant="ghost" className="absolute top-1 right-1" onClick={onRemove} aria-label={`Remover ${item.file.name}`}>
        <XIcon />
      </Button>
      {item.status === "uploading" && (
        <span
          className="bg-brand absolute bottom-0 left-0 h-0.5 transition-[width]"
          style={{ width: `${Math.round(item.progress * 100)}%` }}
          role="progressbar"
          aria-label={`Envio de ${item.file.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(item.progress * 100)}
        />
      )}
    </li>
  );
}

/* ---------------- voice ---------------- */

export function voiceRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof MediaRecorder.isTypeSupported === "function" &&
    MediaRecorder.isTypeSupported(VOICE_MIME) &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function useVoiceRecorder(onDone: (file: File, seconds: number) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
    recorder.current = null;
    setRecording(false);
    setSeconds(0);
  };

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: VOICE_MIME });
      chunks.current = [];
      cancelled.current = false;
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        const elapsed = Math.round((Date.now() - started.current) / 1000);
        const blob = new Blob(chunks.current, { type: "audio/ogg" });
        cleanup();
        if (!cancelled.current && blob.size > 0) onDone(new File([blob], `voz-${Date.now()}.ogg`, { type: "audio/ogg" }), elapsed);
      };
      recorder.current = rec;
      started.current = Date.now();
      rec.start();
      setRecording(true);
      timer.current = setInterval(() => setSeconds(Math.round((Date.now() - started.current) / 1000)), 500);
    } catch {
      toast.error("Não consegui acessar o microfone. Verifique a permissão do navegador.");
      cleanup();
    }
  };

  const stop = (cancel: boolean) => {
    cancelled.current = cancel;
    if (recorder.current?.state === "recording") recorder.current.stop();
    else cleanup();
  };

  useEffect(
    () => () => {
      cancelled.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
    },
    [],
  );

  return { recording, seconds, start, stop };
}

/* ---------------- composer ---------------- */

interface ComposerProps {
  thread: ChatThread;
  attachments: Attachments;
  /** Reason the account cannot send right now (null = can send). */
  blockedReason: string | null;
  contactName: string;
}

export function Composer({ thread, attachments, blockedReason, contactName }: ComposerProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [voiceSupported] = useState(voiceRecordingSupported);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const disabled = blockedReason !== null;

  const uploading = attachments.items.some((a) => a.status === "uploading");
  const ready = attachments.items.filter((a) => a.status === "ready" && a.uploaded);
  const canSend = !disabled && !uploading && (text.trim().length > 0 || ready.length > 0);

  // Autosize up to ~6 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    const message = text.trim();
    const files = ready;
    setText("");
    attachments.clear(true);
    // Errored chips are dropped with the tray; their message stayed visible until now.
    for (const a of attachments.items) if (a.status !== "ready" && a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    textareaRef.current?.focus();

    if (files.length === 0) {
      await thread.send({ text: message });
      return;
    }
    // One message per attachment, in order; the caption rides on the first
    // (audio refuses captions, so then the text goes as its own message).
    const captionOnFirst = message && files[0]!.kind !== "audio";
    for (const [index, a] of files.entries()) {
      await thread.send(
        { media_id: a.uploaded!.media_id, caption: index === 0 && captionOnFirst ? message : undefined },
        { kind: a.kind, previewUrl: a.previewUrl ?? undefined, fileName: a.file.name, fileSize: a.file.size },
      );
    }
    if (message && !captionOnFirst) await thread.send({ text: message });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    attachments.add(files);
  };

  const voice = useVoiceRecorder(async (file, seconds) => {
    setVoiceBusy(true);
    try {
      const uploaded = await uploadWaMedia(file);
      await thread.send({ media_id: uploaded.media_id, voice: true }, { kind: "audio", fileName: `Mensagem de voz (${formatDuration(seconds)})`, fileSize: file.size });
    } catch (error) {
      toast.error(errorMessage(error, "Não consegui enviar a mensagem de voz."));
    } finally {
      setVoiceBusy(false);
    }
  });

  return (
    <form onSubmit={submit} className="border-t bg-card px-2 py-2 sm:px-3" aria-label={`Enviar mensagem para ${contactName}`}>
      {attachments.items.length > 0 && (
        <ul className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label="Anexos">
          {attachments.items.map((item) => (
            <AttachmentChip key={item.id} item={item} onRemove={() => attachments.remove(item.id)} />
          ))}
        </ul>
      )}
      {disabled && <p className="text-muted-foreground mb-2 px-1 text-xs">{blockedReason}</p>}
      {voice.recording ? (
        <div className="flex items-center gap-2" role="status" aria-live="polite">
          <Button type="button" size="icon" variant="ghost" onClick={() => voice.stop(true)} aria-label="Cancelar gravação">
            <Trash2Icon />
          </Button>
          <span className="flex flex-1 items-center gap-2 text-sm">
            <span className="bg-destructive size-2.5 animate-pulse rounded-full" aria-hidden="true" />
            Gravando… <span className="tabular">{formatDuration(voice.seconds)}</span>
          </span>
          <Button type="button" size="icon" className="rounded-full" onClick={() => voice.stop(false)} aria-label="Enviar mensagem de voz">
            <SendHorizontalIcon />
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
            aria-label="Anexar arquivos"
            title="Anexar (fotos, vídeos, áudios, documentos)"
          >
            <PaperclipIcon />
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPTED_FILES}
            className="hidden"
            tabIndex={-1}
            onChange={(e) => {
              if (e.target.files) attachments.add(e.target.files);
              e.target.value = "";
            }}
          />
          <Textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
            placeholder={ready.length > 0 ? "Legenda (opcional)" : "Digite uma mensagem"}
            aria-label={ready.length > 0 ? "Legenda" : "Mensagem"}
            aria-describedby="wa-composer-hint"
            maxLength={4096}
            className="max-h-40 min-h-9 resize-none py-2 leading-snug"
          />
          <span id="wa-composer-hint" className="sr-only">
            Enter envia; Shift+Enter quebra a linha. Arraste arquivos ou cole imagens para anexar.
          </span>
          {voiceSupported && !text.trim() && attachments.items.length === 0 ? (
            <Button type="button" size="icon" variant="ghost" className="shrink-0" onClick={voice.start} disabled={disabled || voiceBusy} aria-label="Gravar mensagem de voz">
              {voiceBusy ? <Loader2Icon className="animate-spin" /> : <MicIcon />}
            </Button>
          ) : (
            <Button type="submit" size="icon" className="shrink-0 rounded-full" disabled={!canSend} aria-label={uploading ? "Aguardando o envio dos anexos" : "Enviar"}>
              {uploading ? <Loader2Icon className="animate-spin" /> : <SendHorizontalIcon />}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
