// Classic prospect chat UI (AI disabled): bubbles, step-by-step job progress,
// "mais N" shortcuts and the Serper-key hint.
import { ArrowUpIcon, Loader2Icon, SettingsIcon, TagIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { navigate } from "@/app/router";
import { progressFromSteps, StepList } from "@/components/common/step-list";
import { TagInput } from "@/components/common/tag-input";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { formatInt, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/routes";
import { useAssistant } from "./assistant-context";
import { useProspectChat, type ChatItem } from "./prospect-chat-state";

const EXAMPLES = [
  "Busque os 50 principais escritórios de advocacia de São Paulo-SP",
  "top 30 clínicas odontológicas em Campinas-SP",
];
const CONTINUE_SHORTCUTS = [20, 50, 100];

export function JobCard({ item }: { item: Extract<ChatItem, { kind: "job" }> }) {
  const { job } = item;
  const running = job.status === "running";
  const failed = job.status === "failed";
  const progress = running ? progressFromSteps(job.steps) : null;
  const title = running ? "Busca em andamento" : failed ? "Busca interrompida" : "Busca concluída";
  return (
    <div className="rounded-lg border bg-card p-3 shadow-xs">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        {running && <Loader2Icon className="size-3.5 animate-spin text-brand" aria-hidden="true" />}
        {title}
      </div>
      <StepList steps={job.steps} running={running} failed={failed} />
      {progress && (
        <div className="mt-3 space-y-1">
          <Progress
            value={(progress.done / progress.target) * 100}
            aria-label="Progresso da busca"
            aria-valuetext={`${progress.done} de ${progress.target} leads`}
          />
          <p className="text-muted-foreground text-xs tabular">
            {formatInt(progress.done)} de {formatInt(progress.target)}
          </p>
        </div>
      )}
    </div>
  );
}

function Bubble({ item, onOpenSettings }: { item: Extract<ChatItem, { kind: "user" | "agent" | "error" }>; onOpenSettings: () => void }) {
  const mine = item.kind === "user";
  return (
    <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap",
          mine && "rounded-br-md bg-primary text-primary-foreground",
          item.kind === "agent" && "rounded-bl-md bg-muted",
          item.kind === "error" && "rounded-bl-md border border-destructive/30 bg-destructive/8 text-destructive",
        )}
      >
        {item.text}
        {item.action === "open-settings" && (
          <Button size="sm" variant="outline" className="mt-2 flex" onClick={onOpenSettings}>
            <SettingsIcon /> Abrir Configurações
          </Button>
        )}
      </div>
      <span className="text-muted-foreground px-1 text-[11px] tabular">{formatTime(new Date(item.at))}</span>
    </div>
  );
}

export function ClassicProspectChat() {
  const { items, busy, canContinue, submit } = useProspectChat();
  const { setOpen, pendingPrompt, consumePrompt } = useAssistant();
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [showTags, setShowTags] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A prompt requested elsewhere is only prefilled here (classic mode can't run AI prompts).
  useEffect(() => {
    if (!pendingPrompt) return;
    const taken = consumePrompt();
    if (taken) {
      setText(taken.text);
      inputRef.current?.focus();
    }
  }, [pendingPrompt, consumePrompt]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [items]);

  const send = (value: string, withTags = tags) => {
    if (!value.trim() || busy) return;
    setText("");
    setTags([]);
    setShowTags(false);
    void submit(value, withTags);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(text);
    }
  };

  const openSettings = () => {
    setOpen(false);
    navigate(ROUTES.settings);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={logRef}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversa com o agente de prospecção"
      >
        {items.map((item) =>
          item.kind === "job" ? <JobCard key={item.id} item={item} /> : <Bubble key={item.id} item={item} onOpenSettings={openSettings} />,
        )}
      </div>

      <div className="border-t bg-background/80 px-4 pt-3 pb-4">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {canContinue
            ? CONTINUE_SHORTCUTS.map((n) => (
                <Button key={n} type="button" variant="outline" size="xs" disabled={busy} onClick={() => send(`mais ${n}`, tags)}>
                  mais {n}
                </Button>
              ))
            : items.length <= 1 &&
              EXAMPLES.map((example) => (
                <Button
                  key={example}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="h-auto max-w-full py-1 text-left whitespace-normal"
                  onClick={() => setText(example)}
                >
                  {example}
                </Button>
              ))}
        </div>
        {(showTags || tags.length > 0) && (
          <div className="mb-2 space-y-1">
            <label htmlFor="prospect-tags" className="text-muted-foreground text-xs">
              Tags da busca (opcional): aplicadas aos leads coletados
            </label>
            <TagInput id="prospect-tags" value={tags} onChange={setTags} autoFocus={showTags && tags.length === 0} />
          </div>
        )}
        <form onSubmit={onSubmit} className="relative">
          <label htmlFor="prospect-input" className="sr-only">
            Pedido de prospecção
          </label>
          <Textarea
            id="prospect-input"
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ex.: Busque os 100 principais escritórios de advocacia de São Paulo-SP"
            rows={2}
            className="max-h-40 min-h-16 resize-none pr-12"
          />
          <Button
            type="submit"
            size="icon-sm"
            className="absolute right-2 bottom-2"
            disabled={busy || !text.trim()}
            aria-label={busy ? "Buscando…" : "Enviar pedido"}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
          </Button>
        </form>
        <div className="mt-2 flex items-start justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            Enter envia · Shift+Enter quebra linha · “mais N” continua a última pesquisa
          </p>
          {!showTags && tags.length === 0 && (
            <Button type="button" variant="ghost" size="xs" className="shrink-0" onClick={() => setShowTags(true)}>
              <TagIcon /> Tags
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
