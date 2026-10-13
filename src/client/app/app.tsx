import { useEffect, type ComponentType } from "react";
import { AppHeader } from "@/components/app-shell/app-header";
import { AssistantPanel } from "@/features/assistant/assistant-panel";
import { JobDock } from "@/features/leads/jobs/job-dock";
import { LeadsView } from "@/features/leads/leads-view";
import { SettingsView } from "@/features/settings/settings-view";
import { WhatsAppView } from "@/features/whatsapp/whatsapp-view";
import { ROUTES, type RouteId } from "@/routes";
import { AppProviders } from "./providers";
import { navigate, useRoute } from "./router";

const TITLES: Record<RouteId, string> = {
  leads: "Leads",
  whatsapp: "WhatsApp",
  settings: "Configurações",
};

const VIEWS: Record<RouteId, ComponentType> = {
  leads: LeadsView,
  whatsapp: WhatsAppView,
  settings: SettingsView,
};

function Shell() {
  const route = useRoute();
  const View = VIEWS[route];

  useEffect(() => {
    // "/" and unknown paths land on Leads with a canonical URL.
    if (window.location.pathname !== ROUTES[route]) navigate(ROUTES[route], { replace: true });
    document.title = `${TITLES[route]} · prospecteezy`;
  }, [route]);

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Pular para o conteúdo
      </a>
      <AppHeader route={route} />
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1440px] px-4 py-6 outline-none sm:px-6">
        <View />
      </main>
      <AssistantPanel />
      <JobDock />
    </div>
  );
}

export function App() {
  const route = useRoute();
  return (
    <AppProviders route={route}>
      <Shell />
    </AppProviders>
  );
}
