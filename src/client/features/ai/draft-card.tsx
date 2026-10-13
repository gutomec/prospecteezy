// Editable message draft from `present_message_draft`. "Enviar pelo WhatsApp"
// sends the edited text as a `send_draft` action: the server answers with a
// send_whatsapp_message call that still needs approval (nothing is sent here).
import { CheckIcon, CopyIcon, MessageCircleIcon, SendIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { MessageDraftOutput } from "@/lib/api/types";

const MAX_CHARS = 4096;

export function DraftCard({ draft, disabled, onSend }: { draft: MessageDraftOutput; disabled: boolean; onSend: (leadId: number, text: string) => void }) {
  const [text, setText] = useState(draft.text);
  const [copied, setCopied] = useState(false);
  const [requested, setRequested] = useState(false);
  const fieldId = useId();
  const empty = !text.trim();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Não deu para copiar automaticamente.");
    }
  };

  return (
    <div className="space-y-2.5 rounded-lg border bg-card p-3 shadow-xs">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageCircleIcon className="size-4 text-brand" aria-hidden="true" />
        <label htmlFor={fieldId}>
          Rascunho para {draft.lead_name} <span className="text-muted-foreground font-normal">(#{draft.lead_id})</span>
        </label>
      </div>
      <Textarea
        id={fieldId}
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
        rows={5}
        className="max-h-72 min-h-28 text-sm leading-relaxed"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs tabular">
          {text.length.toLocaleString("pt-BR")}/{MAX_CHARS.toLocaleString("pt-BR")}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copy} disabled={empty}>
            {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copiado" : "Copiar"}
          </Button>
          {draft.can_send_whatsapp && (
            <Button
              type="button"
              size="sm"
              disabled={disabled || empty}
              onClick={() => {
                setRequested(true);
                onSend(draft.lead_id, text.trim());
              }}
            >
              <SendIcon /> Enviar pelo WhatsApp
            </Button>
          )}
        </div>
      </div>
      {!draft.can_send_whatsapp && (
        <p className="text-muted-foreground text-xs">{draft.reason ?? "Envio pelo WhatsApp indisponível para este lead."}</p>
      )}
      {requested && draft.can_send_whatsapp && (
        <p className="text-muted-foreground text-xs" role="status">
          Pedido de envio criado: confirme no cartão de aprovação abaixo.
        </p>
      )}
    </div>
  );
}
