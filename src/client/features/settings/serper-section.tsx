// Serper API key: status (Configurações / .env / none, ••••last4), save,
// remove (falls back to .env) and test (spends 1 credit, confirmed first).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useConfirm } from "@/components/common/confirm-dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api/client";
import { settingsApi } from "@/lib/api/endpoints";
import type { Settings } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { FormResult, SettingsCard, type Result } from "./settings-card";

export function SerperSection({ settings, loading }: { settings: Settings | undefined; loading: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [key, setKey] = useState("");
  const [result, setResult] = useState<Result>(null);
  const serper = settings?.serper;

  const applySerper = (next: Settings["serper"]) =>
    queryClient.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, serper: next } : s));

  const save = useMutation({
    mutationFn: (apiKey: string) => settingsApi.saveSerper(apiKey),
    onSuccess: (next) => {
      applySerper(next);
      setKey("");
      setResult({ ok: true, text: "Chave salva." });
      void queryClient.invalidateQueries({ queryKey: qk.settings });
    },
    onError: (e) => setResult({ ok: false, text: errorMessage(e, "Não consegui salvar a chave. Tente de novo.") }),
  });

  const remove = useMutation({
    mutationFn: settingsApi.removeSerper,
    onSuccess: (next) => {
      applySerper(next);
      setResult({ ok: true, text: "Chave removida." });
    },
    onError: (e) => setResult({ ok: false, text: errorMessage(e, "Não consegui remover a chave.") }),
  });

  const test = useMutation({
    mutationFn: settingsApi.testSerper,
    onMutate: () => setResult({ ok: null, text: "Testando…" }),
    onSuccess: (r) => setResult(r.ok ? { ok: true, text: "A chave funcionou." } : { ok: false, text: r.error || "O Serper recusou a chave." }),
    onError: (e) => setResult({ ok: false, text: errorMessage(e, "Não consegui testar a chave.") }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!value) {
      setResult({ ok: false, text: "Cole a chave do Serper antes de salvar." });
      return;
    }
    save.mutate(value);
  };

  const onRemove = async () => {
    const ok = await confirm({
      title: "Remover a chave do Serper?",
      description: "A chave salva em Configurações é apagada. Se houver SERPER_API_KEY no arquivo .env, ela passa a ser usada.",
      confirmLabel: "Remover",
      destructive: true,
    });
    if (ok) remove.mutate();
  };

  const onTest = async () => {
    const ok = await confirm({
      title: "Testar a chave do Serper?",
      description: "O teste faz 1 consulta real e gasta 1 crédito da sua conta Serper.",
      confirmLabel: "Testar (gasta 1 crédito)",
    });
    if (ok) test.mutate();
  };

  const last4 = serper?.last4 ? ` · ••••${serper.last4}` : "";
  const status = !serper ? null : serper.source === "settings" ? (
    <StatusBadge tone="success">Configurada em Configurações{last4}</StatusBadge>
  ) : serper.source === "env" ? (
    <StatusBadge tone="info">Usando o arquivo .env{last4}</StatusBadge>
  ) : (
    <StatusBadge tone="warning">Não configurada</StatusBadge>
  );

  return (
    <SettingsCard
      id="serper"
      icon={KeyRoundIcon}
      title="Chave do Serper"
      description={
        <>
          Usada nas buscas de empresas (Google Places via{" "}
          <a href="https://serper.dev" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
            serper.dev
          </a>
          ). A chave salva aqui tem prioridade sobre SERPER_API_KEY do .env e fica cifrada no banco local.
        </>
      }
      aside={loading ? <Skeleton className="h-5 w-40" /> : status}
    >
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="serper-key">{serper?.source === "settings" ? "Trocar chave" : "Chave de API"}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="serper-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={serper?.last4 ? `••••${serper.last4}` : "Cole a chave do Serper"}
              maxLength={500}
              className="font-mono"
            />
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2Icon className="animate-spin" />}
              Salvar
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={!serper?.configured || test.isPending}>
            {test.isPending && <Loader2Icon className="animate-spin" />}
            Testar chave
          </Button>
          {serper?.source === "settings" && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onRemove} disabled={remove.isPending}>
              Remover chave salva
            </Button>
          )}
          <FormResult result={result} />
        </div>
      </form>
    </SettingsCard>
  );
}
