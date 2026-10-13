// Approval card of a tool call (`state: "approval-requested"`), built on the
// AI Elements Confirmation. Data comes from `part.approval.descriptor`
// (title, description, params, estimated_credits; see src/ai/tools.ts).
import { CheckIcon, CoinsIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Confirmation, ConfirmationAction, ConfirmationTitle } from "@/components/ai-elements/confirmation";
import { StatusBadge, type Tone } from "@/components/common/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { readDescriptor, toolLabel, type ApprovalView, type ToolPart } from "./chat-logic";

const VIEW_BADGES: Record<Exclude<ApprovalView, "pending">, { tone: Tone; label: string }> = {
  sending: { tone: "info", label: "Enviando resposta…" },
  stale: { tone: "neutral", label: "Recusado (nova mensagem)" },
  approved: { tone: "success", label: "Aprovado" },
  denied: { tone: "warning", label: "Recusado" },
  failed: { tone: "danger", label: "Aprovado, mas falhou" },
};

interface ApprovalCardProps {
  part: ToolPart;
  toolName: string;
  view: ApprovalView;
  /** False while a request is in flight (answers would be sent mid-stream). */
  canRespond: boolean;
  onRespond: (approvalId: string, approved: boolean, reason?: string) => void;
}

export function ApprovalCard({ part, toolName, view, canRespond, onRespond }: ApprovalCardProps) {
  const approval = (part as { approval: { id: string; descriptor?: unknown; reason?: string } }).approval;
  const descriptor = readDescriptor(approval.descriptor) ?? {
    title: `Executar ${toolLabel(toolName)}`,
    description: "Ação que requer sua aprovação.",
    params: [],
    estimated_credits: 0,
  };
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const pending = view === "pending";
  const badge = pending ? null : VIEW_BADGES[view];
  const errorText = (part as { errorText?: string }).errorText;

  return (
    <Confirmation
      approval={approval as never}
      state={part.state === "input-streaming" || part.state === "input-available" ? "approval-requested" : part.state}
      className={cn("items-stretch gap-3 rounded-lg", pending ? "border-brand/40 bg-brand/5" : "bg-card")}
      role="group"
      aria-label={`Aprovação: ${descriptor.title}`}
    >
      <div className="col-span-2 flex items-start gap-2">
        <ShieldQuestionIcon className={cn("mt-0.5 size-4 shrink-0", pending ? "text-brand" : "text-muted-foreground")} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <ConfirmationTitle className="text-foreground block text-sm font-medium">{descriptor.title}</ConfirmationTitle>
          {descriptor.description && <p className="text-muted-foreground text-xs leading-relaxed">{descriptor.description}</p>}
        </div>
      </div>

      {descriptor.params.length > 0 && (
        <dl className="col-span-2 grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 rounded-md border bg-background/60 p-2.5 text-xs">
          {descriptor.params.map((p, index) => (
            <div key={`${p.label}-${index}`} className="contents">
              <dt className="text-muted-foreground">{p.label}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap">{p.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="col-span-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs tabular">
          <CoinsIcon className="size-3.5" aria-hidden="true" />
          {descriptor.estimated_credits > 0
            ? `≈ ${descriptor.estimated_credits.toLocaleString("pt-BR")} ${descriptor.estimated_credits === 1 ? "crédito" : "créditos"} Serper`
            : "Sem custo de créditos Serper"}
        </span>
        {badge && (
          <span role="status">
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          </span>
        )}
      </div>

      {view === "denied" && approval.reason && (
        <p className="text-muted-foreground col-span-2 text-xs">Motivo: {approval.reason}</p>
      )}
      {view === "failed" && errorText && <p className="text-destructive col-span-2 text-xs">{errorText}</p>}

      {pending && !rejecting && (
        <div className="col-span-2 flex justify-end gap-2">
          <ConfirmationAction variant="outline" disabled={!canRespond} onClick={() => setRejecting(true)}>
            <XIcon /> Recusar
          </ConfirmationAction>
          <ConfirmationAction disabled={!canRespond} onClick={() => onRespond(approval.id, true)}>
            <CheckIcon /> Aprovar
          </ConfirmationAction>
        </div>
      )}

      {pending && rejecting && (
        <form
          className="col-span-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            onRespond(approval.id, false, reason);
          }}
        >
          <label htmlFor={reasonId} className="text-xs font-medium">
            Motivo da recusa (opcional)
          </label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Ex.: caro demais, prefiro outra cidade…"
            className="min-h-14 resize-none text-sm"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <ConfirmationAction variant="ghost" onClick={() => setRejecting(false)}>
              Voltar
            </ConfirmationAction>
            <ConfirmationAction type="submit" variant="destructive" disabled={!canRespond}>
              Confirmar recusa
            </ConfirmationAction>
          </div>
        </form>
      )}
    </Confirmation>
  );
}
