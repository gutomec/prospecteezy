// Top bar: brand, primary navigation, WhatsApp status, assistant, theme.
import { BotIcon, MessageCircleIcon, SettingsIcon, SparklesIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { Link } from "@/app/router";
import { Button } from "@/components/ui/button";
import { useAssistant } from "@/features/assistant/assistant-context";
import { useProspectChat } from "@/features/assistant/prospect-chat-state";
import { WaStatusIndicator } from "@/features/whatsapp/wa-status-indicator";
import { useWaStream } from "@/features/whatsapp/wa-stream";
import { useAiStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ROUTES, type RouteId } from "@/routes";
import { ThemeToggle } from "./theme-toggle";

const NAV: Array<{ id: RouteId; label: string; icon: LucideIcon }> = [
  { id: "leads", label: "Leads", icon: UsersIcon },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircleIcon },
  { id: "settings", label: "Configurações", icon: SettingsIcon },
];

function NavTabs({ route, className }: { route: RouteId; className?: string }) {
  const { unread } = useWaStream();
  return (
    <nav aria-label="Seções" className={className}>
      <ul className="flex items-center gap-1">
        {NAV.map(({ id, label, icon: Icon }) => {
          const current = route === id;
          return (
            <li key={id} className="flex-1 sm:flex-none">
              <Link
                to={ROUTES[id]}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex h-8 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  current ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                <span>{label}</span>
                {id === "whatsapp" && unread && (
                  <>
                    <span className="bg-brand absolute top-1.5 right-1.5 size-1.5 rounded-full" aria-hidden="true" />
                    <span className="sr-only">(novas mensagens)</span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppHeader({ route }: { route: RouteId }) {
  const { setOpen } = useAssistant();
  const { busy } = useProspectChat();
  const ai = useAiStatus();
  return (
    <header className="bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-30 border-b backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <Link to={ROUTES.leads} className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
          <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-lg" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <circle cx="10.5" cy="10.5" r="5.5" />
              <path d="m15 15 4.5 4.5" />
            </svg>
          </span>
          <span>prospecteezy</span>
        </Link>
        <NavTabs route={route} className="ml-4 hidden md:block" />
        <div className="ml-auto flex items-center gap-1.5">
          <WaStatusIndicator />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            aria-label={ai.enabled ? "Abrir assistente de IA" : "Abrir agente de prospecção"}
            className="relative"
          >
            {ai.enabled ? <SparklesIcon className="text-brand" /> : <BotIcon />}
            <span className="hidden lg:inline">{ai.enabled ? "Assistente" : "Agente"}</span>
            {busy && <span className="bg-brand absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full" aria-hidden="true" />}
          </Button>
          <ThemeToggle />
        </div>
      </div>
      <NavTabs route={route} className="border-t px-2 py-1.5 md:hidden" />
    </header>
  );
}
