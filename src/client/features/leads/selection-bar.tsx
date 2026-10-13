// Floating bulk-action bar for the cross-page selection.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, Loader2Icon, MailSearchIcon, MoreHorizontalIcon, SendIcon, ShieldCheckIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/common/confirm-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CampaignComposer } from "@/features/whatsapp/campaign-composer";
import { errorMessage } from "@/lib/api/client";
import { fetchAllLeads, leadsApi } from "@/lib/api/endpoints";
import { downloadCsv, leadsToCsv } from "@/lib/csv";
import { formatInt, plural } from "@/lib/format";
import { qk } from "@/lib/queries";
import { useLeadJobs } from "./jobs/lead-jobs";
import { LeadTagsPopover } from "./lead-tags-popover";
import { selectionLabel, useLeadsState } from "./leads-state";

export function SelectionBar({ pageIds }: { pageIds: number[] }) {
  const { selection, clearSelection, ambiguous } = useLeadsState();
  const { validate, enrich } = useLeadJobs();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [composerOpen, setComposerOpen] = useState(false);

  const ids = [...selection];
  const visible = new Set(pageIds);
  const hidden = ids.filter((id) => !visible.has(id)).length;

  const remove = useMutation({
    mutationFn: (leadIds: number[]) => leadsApi.remove(leadIds),
    onSuccess: ({ deleted }, leadIds) => {
      clearSelection();
      const n = deleted ?? leadIds.length;
      toast.success(n === 1 ? "1 lead excluído" : `${formatInt(n)} leads excluídos`);
    },
    onError: (error) => toast.error(errorMessage(error, "Não foi possível excluir os leads. Tente de novo.")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.leads.root }),
  });

  if (selection.size === 0 && !composerOpen) return null;

  const onDelete = async () => {
    const count = ids.length;
    const ok = await confirm({
      title: `Excluir ${plural(count, "lead", "leads")}?`,
      description: (
        <>
          <p>
            Esta ação é permanente: {count === 1 ? "o lead e seu histórico somem" : `os ${formatInt(count)} leads e seus históricos somem`} do banco, sem
            lixeira nem desfazer. Uma nova busca da mesma consulta pode coletá-{count === 1 ? "lo" : "los"} de novo.
          </p>
          {hidden > 0 && (
            <p className="mt-2 font-medium text-foreground">
              Atenção: {hidden === 1 ? "1 lead selecionado não está visível" : `${formatInt(hidden)} leads selecionados não estão visíveis`} nesta página.
            </p>
          )}
        </>
      ),
      confirmLabel: `Excluir ${formatInt(count)}`,
      destructive: true,
    });
    if (ok) remove.mutate(ids);
  };

  const onExport = async () => {
    try {
      const data = await queryClient.fetchQuery({ queryKey: qk.leads.all, queryFn: ({ signal }) => fetchAllLeads(signal) });
      const chosen = data.leads.filter((l) => selection.has(l.id));
      if (chosen.length === 0) {
        toast("Nenhum lead selecionado.");
        return;
      }
      downloadCsv(leadsToCsv(chosen, ambiguous), "prospecteezy-leads-selecionados.csv");
      toast.success(`${plural(chosen.length, "lead exportado", "leads exportados")}`);
    } catch (error) {
      toast.error(errorMessage(error, "Não deu para exportar: o servidor não respondeu."));
    }
  };

  return (
    <>
      {selection.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4" role="region" aria-label="Ações em massa">
          <div className="flex w-full max-w-5xl items-center gap-2 rounded-xl border bg-popover p-2 pl-4 text-popover-foreground shadow-lg">
            <p className="min-w-0 flex-1 truncate text-sm font-medium tabular lg:shrink-0" aria-live="polite">
              {selectionLabel(selection.size, hidden)}
            </p>

            <LeadTagsPopover ids={ids} />

            <div className="hidden items-center gap-1 xl:flex">
              <Button size="sm" variant="ghost" onClick={() => validate.start(ids)} disabled={validate.phase.kind === "starting"}>
                {validate.running ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
                {validate.running ? "Validando…" : "Validar WhatsApp"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => enrich.start(ids)}>
                {enrich.running ? <Loader2Icon className="animate-spin" /> : <MailSearchIcon />}
                {enrich.running ? "Enriquecendo…" : "Enriquecer e-mails"}
              </Button>
              <Button size="sm" variant="ghost" onClick={onExport}>
                <DownloadIcon /> Exportar CSV
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete} disabled={remove.isPending}>
                <Trash2Icon /> Excluir
              </Button>
              <Button size="sm" onClick={() => setComposerOpen(true)}>
                <SendIcon /> Enviar mensagem
              </Button>
            </div>

            <div className="flex items-center gap-1 xl:hidden">
              <Button size="sm" onClick={() => setComposerOpen(true)} aria-label="Enviar mensagem">
                <SendIcon />
                <span className="hidden sm:inline">Enviar</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="outline" aria-label="Mais ações">
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onSelect={() => validate.start(ids)}>
                    <ShieldCheckIcon /> {validate.running ? "Ver validação" : "Validar WhatsApp"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => enrich.start(ids)}>
                    <MailSearchIcon /> {enrich.running ? "Ver enriquecimento" : "Enriquecer e-mails"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onExport}>
                    <DownloadIcon /> Exportar CSV
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2Icon /> Excluir
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <Button size="icon-sm" variant="ghost" onClick={clearSelection} aria-label="Limpar seleção">
              <XIcon />
            </Button>
          </div>
        </div>
      )}
      <CampaignComposer open={composerOpen} onOpenChange={setComposerOpen} leadIds={ids} />
    </>
  );
}
