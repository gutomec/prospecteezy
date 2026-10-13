// Add/edit an AI provider. `kind` is fixed after creation; an empty key on
// edit keeps the stored one; base URL is required for "Compatível com OpenAI".
import { useMutation } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/api/client";
import { aiApi } from "@/lib/api/endpoints";
import { PROVIDER_KIND_LABELS, type AiProvider, type ProviderCreateInput, type ProviderKind, type ProviderUpdateInput } from "@/lib/api/types";
import { FormResult, type Result } from "./settings-card";
import { ModelCombobox } from "./model-combobox";

const KINDS = Object.keys(PROVIDER_KIND_LABELS) as ProviderKind[];

interface ProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create */
  provider: AiProvider | null;
  onSaved: () => void;
}

export function ProviderDialog({ open, onOpenChange, provider, onSaved }: ProviderDialogProps) {
  const editing = provider !== null;
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [label, setLabel] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [result, setResult] = useState<Result>(null);
  const [invalid, setInvalid] = useState<"model" | "key" | "url" | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(provider?.kind ?? "openai");
    setLabel(provider?.label ?? "");
    setModel(provider?.model ?? "");
    setApiKey("");
    setBaseUrl(provider?.base_url ?? "");
    setResult(null);
    setInvalid(null);
  }, [open, provider]);

  const compatible = kind === "openai_compatible";

  const save = useMutation({
    mutationFn: async () => {
      if (provider) {
        const input: ProviderUpdateInput = { label: label.trim() || PROVIDER_KIND_LABELS[kind], model: model.trim(), base_url: baseUrl.trim() };
        if (apiKey.trim()) input.api_key = apiKey.trim();
        return aiApi.update(provider.id, input);
      }
      const input: ProviderCreateInput = { kind, label: label.trim() || PROVIDER_KIND_LABELS[kind], model: model.trim() };
      if (apiKey.trim()) input.api_key = apiKey.trim();
      if (baseUrl.trim()) input.base_url = baseUrl.trim();
      return aiApi.create(input);
    },
    onSuccess: () => {
      toast.success(editing ? "Provedor atualizado." : "Provedor adicionado.");
      onSaved();
      onOpenChange(false);
    },
    onError: (e) => setResult({ ok: false, text: errorMessage(e, "Não consegui salvar o provedor.") }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!model.trim()) {
      setInvalid("model");
      setResult({ ok: false, text: "Informe o modelo." });
      return;
    }
    if (compatible && !baseUrl.trim()) {
      setInvalid("url");
      setResult({ ok: false, text: "Informe a URL base do servidor compatível com OpenAI." });
      return;
    }
    if (!editing && !compatible && !apiKey.trim()) {
      setInvalid("key");
      setResult({ ok: false, text: "Cole a chave de API do provedor." });
      return;
    }
    setInvalid(null);
    save.mutate();
  };

  const keyPlaceholder = provider?.has_key
    ? `Deixe em branco para manter ${provider.last4 ? `••••${provider.last4}` : "a chave atual"}`
    : compatible
      ? "Opcional (ex.: Ollama não usa chave)"
      : "Cole a chave de API";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{editing ? "Editar provedor" : "Adicionar provedor de IA"}</DialogTitle>
            <DialogDescription>A chave fica cifrada no banco local e nunca volta para a tela: só os 4 últimos caracteres.</DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="provider-kind">Tipo</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ProviderKind)} disabled={editing}>
              <SelectTrigger id="provider-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {PROVIDER_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {editing && <p className="text-muted-foreground text-xs">O tipo não muda depois de criado.</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-label">Nome (opcional)</Label>
            <Input id="provider-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={PROVIDER_KIND_LABELS[kind]} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-model">Modelo</Label>
            <ModelCombobox id="provider-model" kind={kind} value={model} onChange={setModel} invalid={invalid === "model"} describedBy="provider-model-help" />
            <p id="provider-model-help" className="text-muted-foreground text-xs">
              Escolha uma sugestão ou digite qualquer id de modelo aceito pelo provedor.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-key">{compatible ? "Chave de API (opcional)" : "Chave de API"}</Label>
            <Input
              id="provider-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyPlaceholder}
              aria-invalid={invalid === "key" || undefined}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provider-url">{compatible ? "URL base" : "URL base (opcional)"}</Label>
            <Input
              id="provider-url"
              type="url"
              inputMode="url"
              className="font-mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={compatible ? "http://localhost:11434/v1" : "Em branco usa o endereço oficial"}
              aria-invalid={invalid === "url" || undefined}
              aria-describedby="provider-url-help"
            />
            <p id="provider-url-help" className="text-muted-foreground text-xs">
              {compatible
                ? "Para Ollama, LM Studio, vLLM e outros servidores compatíveis com a API da OpenAI."
                : "Só preencha se usar um proxy ou endpoint próprio."}
            </p>
          </div>

          <FormResult result={result} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2Icon className="animate-spin" />}
              {editing ? "Salvar alterações" : "Adicionar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
