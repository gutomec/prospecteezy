// AI providers: list, add/edit, test (latency), activate, delete, and
// "Nenhuma — usar modo clássico". Every change invalidates the `ai` queries,
// so AI on/off updates live across the app (assistant panel, lead drawer).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BotIcon, Loader2Icon, MoreHorizontalIcon, PencilIcon, PlusIcon, SparklesIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/common/confirm-dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errorMessage } from "@/lib/api/client";
import { aiApi } from "@/lib/api/endpoints";
import { PROVIDER_KIND_LABELS, type AiProvider } from "@/lib/api/types";
import { formatInt } from "@/lib/format";
import { qk, useAiProviders } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { FormResult, SettingsCard, type Result } from "./settings-card";
import { ProviderDialog } from "./provider-dialog";

function ProviderRow({
  provider,
  test,
  busy,
  onActivate,
  onTest,
  onEdit,
  onDelete,
}: {
  provider: AiProvider;
  test: Result;
  busy: boolean;
  onActivate: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const key = provider.has_key ? (provider.last4 ? `••••${provider.last4}` : "chave salva") : "sem chave";
  return (
    <li className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center", provider.is_active && "bg-brand/5")}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{provider.label || PROVIDER_KIND_LABELS[provider.kind]}</span>
          {provider.is_active && <StatusBadge tone="success">Ativo</StatusBadge>}
        </div>
        <p className="text-muted-foreground text-xs">
          {PROVIDER_KIND_LABELS[provider.kind]} · <span className="font-mono">{provider.model}</span> · <span className="font-mono">{key}</span>
        </p>
        {provider.base_url && <p className="text-muted-foreground truncate font-mono text-xs">{provider.base_url}</p>}
        <FormResult result={test} className="text-xs" />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!provider.is_active && (
          <Button size="sm" variant="outline" onClick={onActivate} disabled={busy}>
            Ativar
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onTest} disabled={test?.ok === null}>
          {test?.ok === null ? <Loader2Icon className="animate-spin" /> : <ZapIcon />}
          Testar
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={`Mais ações para ${provider.label || provider.model}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon /> Editar
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2Icon /> Excluir
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

export function AiProvidersSection() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const providers = useAiProviders();
  const [dialog, setDialog] = useState<{ open: boolean; provider: AiProvider | null }>({ open: false, provider: null });
  const [tests, setTests] = useState<Record<string, Result>>({});

  const refreshAi = () => queryClient.invalidateQueries({ queryKey: qk.ai.root });

  const action = useMutation({
    mutationFn: async (input: { kind: "activate" | "delete"; provider: AiProvider } | { kind: "deactivate" }) => {
      if (input.kind === "deactivate") return aiApi.deactivate();
      if (input.kind === "activate") return aiApi.activate(input.provider.id);
      return aiApi.remove(input.provider.id);
    },
    onSuccess: (_data, input) => {
      if (input.kind === "activate") toast.success(`IA ativada: ${input.provider.label || input.provider.model}`);
      if (input.kind === "deactivate") toast.success("Modo clássico ativado: a IA está desligada.");
      if (input.kind === "delete") toast.success("Provedor excluído.");
    },
    onError: (e) => toast.error(errorMessage(e, "Não consegui concluir a ação. Tente de novo.")),
    onSettled: refreshAi,
  });

  const runTest = async (provider: AiProvider) => {
    setTests((t) => ({ ...t, [provider.id]: { ok: null, text: "Testando…" } }));
    try {
      const r = await aiApi.test(provider.id);
      setTests((t) => ({
        ...t,
        [provider.id]: r.ok
          ? { ok: true, text: `Funcionou (${formatInt(r.latency_ms)} ms).` }
          : { ok: false, text: r.error || "O provedor não respondeu como esperado." },
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [provider.id]: { ok: false, text: errorMessage(e, "Não consegui testar o provedor.") } }));
    }
  };

  const onDelete = async (provider: AiProvider) => {
    const ok = await confirm({
      title: `Excluir o provedor “${provider.label || provider.model}”?`,
      description: "A chave salva é apagada. Se ele estiver ativo, o app volta ao modo clássico.",
      confirmLabel: "Excluir",
      destructive: true,
    });
    if (ok) action.mutate({ kind: "delete", provider });
  };

  const list = providers.data ?? [];
  const anyActive = list.some((p) => p.is_active);
  const unsupported = providers.error instanceof ApiError && providers.error.status === 404;

  return (
    <SettingsCard
      id="ia"
      icon={SparklesIcon}
      title="Provedores de IA"
      description="Opcional. Com um provedor ativo, o assistente entende linguagem natural, pesquisa leads e redige mensagens. Sem nenhum, o app funciona no modo clássico."
      aside={
        <Button size="sm" onClick={() => setDialog({ open: true, provider: null })}>
          <PlusIcon /> Adicionar
        </Button>
      }
    >
      {providers.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : providers.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {unsupported ? "Este servidor ainda não tem suporte a provedores de IA." : errorMessage(providers.error, "Não consegui carregar os provedores de IA.")}
          </AlertDescription>
        </Alert>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border" aria-label="Provedores de IA">
          {list.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              test={tests[p.id] ?? null}
              busy={action.isPending}
              onActivate={() => action.mutate({ kind: "activate", provider: p })}
              onTest={() => runTest(p)}
              onEdit={() => setDialog({ open: true, provider: p })}
              onDelete={() => onDelete(p)}
            />
          ))}
          <li className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center", !anyActive && "bg-brand/5")}>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <BotIcon className="text-muted-foreground size-4" aria-hidden="true" />
                <span className="font-medium">Nenhuma: usar modo clássico</span>
                {!anyActive && <StatusBadge tone="success">Ativo</StatusBadge>}
              </div>
              <p className="text-muted-foreground text-xs">O chat entende só pedidos de busca (ex.: “50 dentistas em Campinas-SP”), sem IA.</p>
            </div>
            {anyActive && (
              <Button size="sm" variant="outline" onClick={() => action.mutate({ kind: "deactivate" })} disabled={action.isPending}>
                Usar modo clássico
              </Button>
            )}
          </li>
        </ul>
      )}
      <ProviderDialog
        open={dialog.open}
        provider={dialog.provider}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        onSaved={() => {
          if (dialog.provider) setTests((t) => ({ ...t, [dialog.provider!.id]: null }));
          void refreshAi();
        }}
      />
    </SettingsCard>
  );
}
