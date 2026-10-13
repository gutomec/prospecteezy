// WhatsApp accounts (instances): list with status + reason, select the active
// one, connect a new number (QR), reconnect, repair (new QR keeping chats),
// disconnect and remove. The QR dialog polls GET /instances/:id/qr and listens
// to SSE `qr`/`status`; every async step bails when the dialog was closed or
// reopened for another account (session counter), like the old UI.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, LogOutIcon, PlusIcon, QrCodeIcon, RefreshCwIcon, SmartphoneIcon, Trash2Icon, WifiIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/common/confirm-dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api/client";
import { waApi } from "@/lib/api/endpoints";
import type { WaInstance } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { WA_STATUS_TONES } from "./wa-status-indicator";
import { WA_STATUS_LABELS, useWaStreamEvent } from "./wa-stream";
import { formatPhone } from "./wa-utils";

export type QrMode = "new" | "reconnect" | "repair";
export interface QrTarget {
  mode: QrMode;
  /** Existing instance (reconnect/repair); `new` creates one. */
  instanceId?: string;
  /** Bumped on every open so reopening the same account restarts cleanly. */
  nonce: number;
}

export function instanceLabel(instance: Pick<WaInstance, "name" | "phone">): string {
  return instance.name?.trim() || (instance.phone ? formatPhone(instance.phone) : "WhatsApp");
}

/* ---------------- actions ---------------- */

export function useAccountActions(openQr: (mode: QrMode, instanceId?: string) => void) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const watchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: qk.wa.instances }), [queryClient]);

  useEffect(() => () => {
    if (watchTimer.current) clearTimeout(watchTimer.current);
  }, []);

  /** After "Reconectar": the session either reopens (connected) or died (qr → open the QR dialog). */
  const watch = useCallback(
    (id: string, attempt = 0) => {
      if (watchTimer.current) clearTimeout(watchTimer.current);
      watchTimer.current = setTimeout(async () => {
        let list: WaInstance[];
        try {
          list = await queryClient.fetchQuery({ queryKey: qk.wa.instances, queryFn: () => waApi.instances().then((r) => r.instances), staleTime: 0 });
        } catch {
          if (attempt < 8) watch(id, attempt + 1);
          return;
        }
        const inst = list.find((i) => i.id === id);
        if (inst?.status === "qr") return openQr("reconnect", id);
        if (inst?.status === "connected") return void toast.success("WhatsApp reconectado.");
        if (attempt < 8) watch(id, attempt + 1);
      }, attempt === 0 ? 1200 : 1600);
    },
    [openQr, queryClient],
  );

  const select = useMutation({
    mutationFn: waApi.select,
    onSuccess: () => toast.success("Conta ativa alterada."),
    onError: (e) => toast.error(errorMessage(e, "Não foi possível selecionar a conta.")),
    onSettled: refresh,
  });
  const disconnect = useMutation({
    mutationFn: waApi.disconnect,
    onSuccess: () => toast.success("WhatsApp desconectado. A sessão foi preservada para reconectar."),
    onError: (e) => toast.error(errorMessage(e, "Falha ao desconectar.")),
    onSettled: refresh,
  });
  const reconnect = useMutation({
    mutationFn: waApi.reconnect,
    onSuccess: (_r, id) => {
      toast("Reconectando…");
      watch(id);
    },
    onError: (e) => toast.error(errorMessage(e, "Falha ao reconectar.")),
    onSettled: refresh,
  });
  const repair = useMutation({
    mutationFn: waApi.repair,
    onSuccess: (_r, id) => openQr("repair", id),
    onError: (e) => toast.error(errorMessage(e, "Falha ao gerar novo QR.")),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: waApi.remove,
    onSuccess: () => toast.success("Conta removida."),
    onError: (e) => toast.error(errorMessage(e, "Falha ao remover.")),
    onSettled: () => {
      void refresh();
      void queryClient.invalidateQueries({ queryKey: qk.wa.root });
    },
  });

  const confirmRemove = async (instance: WaInstance) => {
    const ok = await confirm({
      title: `Remover ${instanceLabel(instance)}?`,
      description:
        "A conta faz logout no aparelho e a sessão é apagada. Para usar de novo, será preciso ler um QR novo. As conversas espelhadas ficam no banco local.",
      confirmLabel: "Remover conta",
      destructive: true,
    });
    if (ok) remove.mutate(instance.id);
  };

  const busy = (id: string) =>
    [select, disconnect, reconnect, repair, remove].some((m) => m.isPending && m.variables === id);

  return { select, disconnect, reconnect, repair, confirmRemove, busy };
}

export type AccountActions = ReturnType<typeof useAccountActions>;

/* ---------------- list (sheet) ---------------- */

function InstanceRow({ instance, actions, onShowQr }: { instance: WaInstance; actions: AccountActions; onShowQr: (id: string) => void }) {
  const label = instanceLabel(instance);
  const busy = actions.busy(instance.id);
  const connected = instance.status === "connected";
  return (
    <li className={cn("space-y-2.5 rounded-lg border p-3", instance.is_active && "border-brand/40 bg-brand/[0.04]")}>
      <div className="flex items-start gap-3">
        <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
          <SmartphoneIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <StatusBadge tone={WA_STATUS_TONES[instance.status]}>{WA_STATUS_LABELS[instance.status]}</StatusBadge>
            {instance.is_active && <StatusBadge tone="info" dot={false}>Ativa</StatusBadge>}
          </div>
          <p className="text-muted-foreground font-mono text-xs">{instance.phone ? formatPhone(instance.phone) : "Número pendente"}</p>
          {instance.status_reason && <p className="text-warning-foreground dark:text-warning text-xs leading-snug">{instance.status_reason}</p>}
        </div>
        {busy && <Loader2Icon className="text-muted-foreground size-4 animate-spin" aria-label="Processando" />}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {!instance.is_active && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={connected ? undefined : 0}>
                <Button size="sm" variant="outline" disabled={!connected || busy} onClick={() => actions.select.mutate(instance.id)}>
                  Usar para enviar
                </Button>
              </span>
            </TooltipTrigger>
            {!connected && <TooltipContent>Conecte a conta para poder enviar por ela.</TooltipContent>}
          </Tooltip>
        )}
        {connected && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.disconnect.mutate(instance.id)} title="Encerra o socket e mantém a sessão">
            <LogOutIcon /> Desconectar
          </Button>
        )}
        {instance.status === "disconnected" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.reconnect.mutate(instance.id)} title="Reabre usando a sessão salva (sem QR quando possível)">
            <WifiIcon /> Reconectar
          </Button>
        )}
        {(instance.status === "disconnected" || instance.status === "logged_out") && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => actions.repair.mutate(instance.id)}
            title="Gera um QR novo para esta conta, mantendo conversas e contatos"
          >
            <RefreshCwIcon /> Gerar novo QR
          </Button>
        )}
        {(instance.status === "qr" || instance.status === "connecting") && (
          <Button size="sm" variant="outline" onClick={() => onShowQr(instance.id)}>
            <QrCodeIcon /> Mostrar QR
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive ml-auto" disabled={busy} onClick={() => actions.confirmRemove(instance)}>
          <Trash2Icon /> Remover
        </Button>
      </div>
    </li>
  );
}

export function AccountsSheet({
  open,
  onOpenChange,
  instances,
  actions,
  onConnectNew,
  onShowQr,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instances: WaInstance[];
  actions: AccountActions;
  onConnectNew: () => void;
  onShowQr: (id: string) => void;
}) {
  const connected = instances.filter((i) => i.status === "connected").length;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Contas de WhatsApp</SheetTitle>
          <SheetDescription>
            {instances.length === 0
              ? "Nenhum número conectado ainda."
              : `${instances.length} ${instances.length === 1 ? "conta" : "contas"} · ${connected} ${connected === 1 ? "conectada" : "conectadas"}. A conta ativa é a usada para enviar.`}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <Button className="w-full" onClick={onConnectNew}>
            <PlusIcon /> Conectar novo número
          </Button>
          <p className="text-muted-foreground text-xs leading-relaxed">
            Use um número dedicado: a automação opera fora da API oficial e a conta pode ser banida. Envios passam sempre pelas travas anti-ban.
          </p>
          <ul className="space-y-2.5" aria-label="Contas">
            {instances.map((i) => (
              <InstanceRow key={i.id} instance={i} actions={actions} onShowQr={onShowQr} />
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ---------------- QR dialog ---------------- */

const QR_POLL_MS = 2500;

const QR_TITLES: Record<QrMode, string> = {
  new: "Conectar WhatsApp",
  reconnect: "Reconectar WhatsApp",
  repair: "Reparar conexão",
};

export function QrDialog({ target, onClose, instances }: { target: QrTarget | null; onClose: () => void; instances: WaInstance[] | undefined }) {
  const queryClient = useQueryClient();
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "Gerando código…" });
  const session = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  const open = target !== null;

  const stop = () => {
    session.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const onConnected = useCallback(
    async (id: string) => {
      stop();
      onClose();
      toast.success("WhatsApp conectado com sucesso.");
      // No usable active account yet → make the new one active.
      const active = instancesRef.current?.find((i) => i.is_active);
      if (!active || active.status !== "connected") {
        try {
          await waApi.select(id);
        } catch {
          /* the list still shows it; the user can pick it */
        }
      }
      void queryClient.invalidateQueries({ queryKey: qk.wa.root });
    },
    [onClose, queryClient],
  );

  // Start (or restart) a session whenever the target changes.
  useEffect(() => {
    stop();
    setQr(null);
    setInstanceId(null);
    if (!target) return;
    const mySession = session.current;
    const stale = () => session.current !== mySession;

    const poll = async (id: string) => {
      if (stale()) return;
      try {
        const res = await waApi.qr(id);
        if (stale()) return;
        if (res.status === "connected") {
          void onConnected(id);
          return;
        }
        if (res.qr) {
          setQr(res.qr);
          setStatus({ text: "Aponte a câmera do WhatsApp para o código." });
        } else if (res.status === "logged_out" || (res.status === "disconnected" && res.status_reason)) {
          setStatus({ text: res.status_reason ?? "A conexão foi encerrada. Feche e tente “Gerar novo QR”.", error: true });
        } else {
          setStatus({ text: "Gerando código…" });
        }
      } catch (error) {
        if (stale()) return;
        setStatus({ text: errorMessage(error, "Não consegui obter o código. Verifique o servidor."), error: true });
      }
      timer.current = setTimeout(() => void poll(id), QR_POLL_MS);
    };

    if (target.mode === "new") {
      setStatus({ text: "Iniciando conexão…" });
      waApi
        .createInstance()
        .then(({ id }) => {
          void queryClient.invalidateQueries({ queryKey: qk.wa.instances });
          if (stale()) return; // closed (or reopened) while creating
          setInstanceId(id);
          void poll(id);
        })
        .catch((error: unknown) => {
          if (stale()) return;
          setStatus({ text: errorMessage(error, "Falha ao iniciar a conexão."), error: true });
        });
    } else if (target.instanceId) {
      setInstanceId(target.instanceId);
      setStatus({ text: "Gerando código…" });
      void poll(target.instanceId);
    }
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one session per target (nonce)
  }, [target?.nonce]);

  useWaStreamEvent("qr", (data) => {
    if (!open || data.instance !== instanceId || !data.qr) return;
    setQr(data.qr);
    setStatus({ text: "Aponte a câmera do WhatsApp para o código." });
  });
  useWaStreamEvent("status", (data) => {
    if (open && data.instance === instanceId && data.status === "connected") void onConnected(data.instance);
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{target ? QR_TITLES[target.mode] : "WhatsApp"}</DialogTitle>
          <DialogDescription>No celular: WhatsApp → Dispositivos conectados → Conectar dispositivo, e escaneie o código.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div className="flex size-64 items-center justify-center rounded-xl border bg-white p-2">
            {qr ? (
              <img src={qr} alt="Código QR para conectar o WhatsApp" className="size-full [image-rendering:pixelated]" />
            ) : (
              <Loader2Icon className="size-6 animate-spin text-neutral-400" aria-hidden="true" />
            )}
          </div>
          <p role="status" aria-live="polite" className={cn("text-center text-sm", status.error ? "text-destructive" : "text-muted-foreground")}>
            {status.text}
          </p>
          {target?.mode === "repair" && (
            <p className="text-muted-foreground text-center text-xs">As conversas e os contatos desta conta são mantidos. O código muda a cada ~20 a 60 segundos.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
