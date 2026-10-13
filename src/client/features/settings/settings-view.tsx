import { AlertTriangleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { errorMessage } from "@/lib/api/client";
import { useSettings } from "@/lib/queries";
import { AiProvidersSection } from "./ai-providers-section";
import { CompanyProfileSection } from "./company-profile-section";
import { SerperSection } from "./serper-section";

const SECTIONS = [
  ["serper", "Serper"],
  ["empresa", "Perfil da empresa"],
  ["ia", "Provedores de IA"],
] as const;

export function SettingsView() {
  const settings = useSettings();
  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-12">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-muted-foreground text-sm">Chaves, perfil da sua empresa e inteligência artificial. Tudo fica salvo só neste computador.</p>
        <nav aria-label="Seções de Configurações" className="mt-3 flex flex-wrap gap-1.5">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="hover:bg-accent text-muted-foreground rounded-full border px-3 py-1 text-xs">
              {label}
            </a>
          ))}
        </nav>
      </div>

      {settings.isError && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Não consegui carregar as configurações</AlertTitle>
          <AlertDescription>{errorMessage(settings.error)}</AlertDescription>
        </Alert>
      )}
      {(settings.data?.secrets_unreadable || settings.data?.warning) && (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Chaves ilegíveis</AlertTitle>
          <AlertDescription>
            {settings.data.warning ?? "Algumas chaves salvas não puderam ser lidas (a chave mestra mudou). Cadastre-as novamente."}
          </AlertDescription>
        </Alert>
      )}

      <SerperSection settings={settings.data} loading={settings.isPending} />
      <CompanyProfileSection settings={settings.data} />
      <AiProvidersSection />
    </div>
  );
}
