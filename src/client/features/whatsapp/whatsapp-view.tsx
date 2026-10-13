// WhatsApp view: account bar (active account, accounts sheet, QR pairing),
// two-pane messenger (chat list + thread; list → thread navigation below md)
// and campaigns (new campaign from validated leads, reopen the last one).
import { useQueryClient } from "@tanstack/react-query";
import { MegaphoneIcon, MessageCircleIcon, PlusIcon, RefreshCwIcon, SmartphoneIcon, WifiIcon, ActivityIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api/client";
import type { WaChat } from "@/lib/api/types";
import { qk, useWaChats, useWaInstances, useWaLeads } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AccountsSheet, instanceLabel, QrDialog, useAccountActions, type QrMode, type QrTarget } from "./accounts";
import { CampaignComposer } from "./campaign-composer";
import { useLastCampaign } from "./campaign-store";
import { ChatList, type ChatSource } from "./chat-list";
import { ChatThread } from "./chat-thread";
import { WA_STATUS_TONES } from "./wa-status-indicator";
import { pickActiveInstance, useWaStreamEvent, WA_STATUS_LABELS } from "./wa-stream";

export function WhatsAppView() {
  const queryClient = useQueryClient();
  const instances = useWaInstances();
  const active = pickActiveInstance(instances.data);
  const instanceId = active?.id ?? null;
  const connected = active?.status === "connected";

  const [source, setSource] = useState<ChatSource>("chats");
  const [selected, setSelected] = useState<WaChat | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [qrTarget, setQrTarget] = useState<QrTarget | null>(null);
  const [campaign, setCampaign] = useState<{ open: boolean; jobId: string | null }>({ open: false, jobId: null });
  const lastCampaign = useLastCampaign();

  const chats = useWaChats(instanceId);
  const leads = useWaLeads(source === "leads");

  const openQr = useCallback((mode: QrMode, id?: string) => setQrTarget({ mode, instanceId: id, nonce: Date.now() }), []);
  const actions = useAccountActions(openQr);

  // Switching/removing the active account resets the open conversation.
  const previousInstance = useRef(instanceId);
  useEffect(() => {
    if (previousInstance.current && previousInstance.current !== instanceId) setSelected(null);
    previousInstance.current = instanceId;
  }, [instanceId]);

  // Live chat list: debounce SSE messages into one refetch.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useWaStreamEvent("message", (data) => {
    if (data.instance !== instanceId || refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void queryClient.invalidateQueries({ queryKey: qk.wa.chats(data.instance) });
    }, 800);
  });
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const current = selected ? (chats.data?.find((c) => c.jid === selected.jid) ?? selected) : null;
  const blockedReason = !active
    ? "Conecte um WhatsApp para enviar mensagens."
    : connected
      ? null
      : `Conta ${WA_STATUS_LABELS[active.status].toLowerCase()}: reconecte para enviar.${active.status_reason ? ` ${active.status_reason}` : ""}`;

  const banner =
    active && !connected && active.status !== "connecting" && active.status !== "qr" ? (
      <div className="space-y-2 border-b bg-warning/10 p-3 text-sm" role="status">
        <p className="font-medium">{active.status === "logged_out" ? "Sessão encerrada" : "Conta desconectada"}</p>
        {active.status_reason && <p className="text-muted-foreground text-xs leading-snug">{active.status_reason}</p>}
        <p className="text-muted-foreground text-xs">As conversas e os contatos foram mantidos. Reconecte para voltar a enviar e receber.</p>
        <div className="flex flex-wrap gap-1.5">
          {active.status !== "logged_out" && (
            <Button size="sm" onClick={() => actions.reconnect.mutate(active.id)} disabled={actions.busy(active.id)}>
              <WifiIcon /> Reconectar
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => actions.repair.mutate(active.id)} disabled={actions.busy(active.id)}>
            <RefreshCwIcon /> Gerar novo QR
          </Button>
        </div>
      </div>
    ) : null;

  const connectedList = instances.data?.filter((i) => i.status === "connected") ?? [];

  return (
    <div className="flex h-[calc(100dvh-9.5rem)] min-h-[480px] flex-col gap-3 md:h-[calc(100dvh-6.5rem)]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0 max-sm:sr-only">
          <h1 className="text-xl font-semibold tracking-tight">WhatsApp</h1>
          <p className="text-muted-foreground hidden text-sm sm:block">Conversas, mídia e campanhas pelo seu número dedicado.</p>
        </div>

        {instances.isPending ? (
          <Skeleton className="h-8 w-48" />
        ) : active ? (
          <Select
            value={active.id}
            onValueChange={(id) => {
              if (id !== active.id) actions.select.mutate(id);
            }}
          >
            <SelectTrigger size="sm" className="max-w-60 min-w-0 max-sm:flex-1" aria-label="Conta ativa">
              <SelectValue>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-success" : active.status === "logged_out" ? "bg-destructive" : "bg-warning")} aria-hidden="true" />
                  <span className="truncate">{instanceLabel(active)}</span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {instances.data?.map((i) => (
                <SelectItem key={i.id} value={i.id} disabled={i.status !== "connected" && i.id !== active.id}>
                  <span className="truncate">{instanceLabel(i)}</span>
                  <StatusBadge tone={WA_STATUS_TONES[i.status]} className="ml-1">
                    {WA_STATUS_LABELS[i.status]}
                  </StatusBadge>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Button size="sm" variant="outline" onClick={() => setAccountsOpen(true)} aria-label="Contas de WhatsApp">
          <SmartphoneIcon /> <span className="hidden sm:inline">Contas</span>
          {instances.data && instances.data.length > 0 && <span className="text-muted-foreground tabular">{instances.data.length}</span>}
        </Button>
        {lastCampaign && (
          <Button size="sm" variant="outline" onClick={() => setCampaign({ open: true, jobId: lastCampaign })} title="Acompanhar a última campanha">
            <ActivityIcon /> <span className="hidden sm:inline">Última campanha</span>
            <span className="sr-only sm:hidden">Última campanha</span>
          </Button>
        )}
        <Button size="sm" onClick={() => setCampaign({ open: true, jobId: null })} disabled={connectedList.length === 0}>
          <MegaphoneIcon /> <span className="hidden sm:inline">Nova campanha</span>
          <span className="sr-only sm:hidden">Nova campanha</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-xs">
        {instances.isError ? (
          <EmptyState
            icon={SmartphoneIcon}
            title="WhatsApp indisponível"
            description={errorMessage(instances.error, "Não consegui consultar as contas.")}
            action={
              <Button variant="outline" size="sm" onClick={() => void instances.refetch()}>
                <RefreshCwIcon /> Tentar de novo
              </Button>
            }
          />
        ) : !instances.isPending && !active ? (
          <EmptyState
            icon={MessageCircleIcon}
            title="Nenhum WhatsApp conectado"
            description="Conecte um número dedicado lendo o QR no celular. Depois as conversas, com fotos, vídeos, áudios e documentos, aparecem aqui."
            action={
              <Button onClick={() => openQr("new")}>
                <PlusIcon /> Conectar WhatsApp
              </Button>
            }
            className="h-full"
          />
        ) : (
          <div className="grid h-full min-h-0 md:grid-cols-[minmax(280px,340px)_minmax(0,1fr)] lg:grid-cols-[380px_minmax(0,1fr)]">
            <aside className={cn("min-h-0 min-w-0 border-r", current ? "hidden md:block" : "block")} aria-label="Lista de conversas">
              <ChatList
                instance={instanceId}
                source={source}
                onSourceChange={setSource}
                chats={chats.data}
                chatsLoading={instances.isPending || chats.isPending}
                chatsError={chats.error}
                leads={leads.data}
                leadsLoading={leads.isPending}
                selectedJid={current?.jid ?? null}
                onSelect={setSelected}
                banner={banner}
                canWrite={connected}
              />
            </aside>
            <div className={cn("min-h-0 min-w-0", current ? "block" : "hidden md:block")}>
              {current && instanceId ? (
                <ChatThread key={`${instanceId}|${current.jid}`} instance={instanceId} chat={current} blockedReason={blockedReason} onBack={() => setSelected(null)} />
              ) : (
                <div className="bg-muted/30 flex h-full items-center justify-center">
                  <EmptyState
                    icon={MessageCircleIcon}
                    title="Selecione uma conversa"
                    description="Escolha uma conversa à esquerda ou comece uma a partir de um lead com WhatsApp validado (aba Leads)."
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <AccountsSheet
        open={accountsOpen}
        onOpenChange={setAccountsOpen}
        instances={instances.data ?? []}
        actions={actions}
        onConnectNew={() => {
          setAccountsOpen(false);
          openQr("new");
        }}
        onShowQr={(id) => {
          setAccountsOpen(false);
          openQr("reconnect", id);
        }}
      />
      <QrDialog target={qrTarget} onClose={() => setQrTarget(null)} instances={instances.data} />
      <CampaignComposer
        open={campaign.open}
        onOpenChange={(open) => setCampaign((c) => ({ ...c, open }))}
        leadIds={[]}
        jobId={campaign.jobId}
      />
    </div>
  );
}
