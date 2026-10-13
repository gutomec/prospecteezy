// "Perfil da empresa": context the AI uses to write approaches. PUT replaces
// the whole profile (blank fields are dropped server-side).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BuildingIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api/client";
import { settingsApi } from "@/lib/api/endpoints";
import { COMPANY_PROFILE_KEYS, type CompanyProfile, type CompanyProfileKey, type Settings } from "@/lib/api/types";
import { qk } from "@/lib/queries";
import { FormResult, SettingsCard, type Result } from "./settings-card";

const FIELD_MAX = 4000;

const FIELDS: Record<CompanyProfileKey, { label: string; placeholder: string; help?: string; multiline?: boolean; type?: string; wide?: boolean }> = {
  name: { label: "Nome da empresa", placeholder: "Ex.: Norte Digital" },
  website: { label: "Site", placeholder: "https://suaempresa.com.br", type: "url" },
  description: { label: "O que a empresa faz", placeholder: "Em duas ou três frases, o que vocês fazem e para quem.", multiline: true, wide: true },
  offering: { label: "Oferta principal", placeholder: "O produto ou serviço que você quer apresentar nas abordagens.", multiline: true, wide: true },
  target_customers: {
    label: "Clientes ideais",
    placeholder: "Ex.: clínicas odontológicas com 2 a 10 dentistas no interior de SP.",
    help: "Ajuda a IA a priorizar leads e ajustar a abordagem.",
    multiline: true,
    wide: true,
  },
  differentiators: { label: "Diferenciais", placeholder: "Por que escolher vocês: resultados, prazos, garantias, cases.", multiline: true, wide: true },
  tone: { label: "Tom de voz", placeholder: "Ex.: próximo e direto, sem jargão" },
  signature: { label: "Assinatura", placeholder: "Ex.: Ana, da Norte Digital", help: "Como as mensagens terminam." },
  call_to_action: { label: "Chamada para ação", placeholder: "Ex.: Posso te mostrar em 15 minutos como funciona?", wide: true },
  extra_instructions: {
    label: "Instruções extras para a IA",
    placeholder: "Ex.: nunca prometer preço por mensagem; citar o case da Clínica Sorriso.",
    help: "Regras que a IA deve seguir sempre.",
    multiline: true,
    wide: true,
  },
};

const empty = (): Record<CompanyProfileKey, string> =>
  Object.fromEntries(COMPANY_PROFILE_KEYS.map((k) => [k, ""])) as Record<CompanyProfileKey, string>;

function fromProfile(profile: CompanyProfile | null | undefined) {
  const values = empty();
  for (const key of COMPANY_PROFILE_KEYS) values[key] = profile?.[key] ?? "";
  return values;
}

export function CompanyProfileSection({ settings }: { settings: Settings | undefined }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() => fromProfile(settings?.company_profile));
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<Result>(null);

  // Load server values unless the user is editing.
  useEffect(() => {
    if (!dirty) setValues(fromProfile(settings?.company_profile));
  }, [settings?.company_profile, dirty]);

  const save = useMutation({
    mutationFn: (profile: CompanyProfile) => settingsApi.saveCompany(profile),
    onSuccess: ({ company_profile }) => {
      queryClient.setQueryData<Settings>(qk.settings, (s) => (s ? { ...s, company_profile } : s));
      setDirty(false);
      setValues(fromProfile(company_profile));
      setResult({ ok: true, text: "Perfil salvo." });
    },
    onError: (e) => setResult({ ok: false, text: errorMessage(e, "Não consegui salvar o perfil. Tente de novo.") }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const payload: CompanyProfile = {};
    for (const key of COMPANY_PROFILE_KEYS) payload[key] = values[key].trim();
    save.mutate(payload);
  };

  return (
    <SettingsCard
      id="empresa"
      icon={BuildingIcon}
      title="Perfil da empresa"
      description="O que a IA sabe sobre você para pesquisar leads e redigir mensagens. Todos os campos são opcionais."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {COMPANY_PROFILE_KEYS.map((key) => {
            const field = FIELDS[key];
            const id = `company-${key}`;
            const helpId = field.help ? `${id}-help` : undefined;
            const common = {
              id,
              value: values[key],
              maxLength: FIELD_MAX,
              placeholder: field.placeholder,
              "aria-describedby": helpId,
              onChange: (e: { target: { value: string } }) => {
                setDirty(true);
                setValues((v) => ({ ...v, [key]: e.target.value }));
              },
            };
            return (
              <div key={key} className={field.wide ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
                <Label htmlFor={id}>{field.label}</Label>
                {field.multiline ? <Textarea rows={3} {...common} /> : <Input type={field.type ?? "text"} {...common} />}
                {field.help && (
                  <p id={helpId} className="text-muted-foreground text-xs">
                    {field.help}
                  </p>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Loader2Icon className="animate-spin" />}
            Salvar perfil
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDirty(false);
                setValues(fromProfile(settings?.company_profile));
                setResult(null);
              }}
            >
              Descartar alterações
            </Button>
          )}
          <FormResult result={result} />
        </div>
      </form>
    </SettingsCard>
  );
}
