// Provider stack, outermost first. Order matters: jobs read leads state;
// the WA stream needs the query client.
import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ConfirmProvider } from "@/components/common/confirm-dialog";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiChatProvider } from "@/features/ai/ai-chat-provider";
import { AssistantProvider } from "@/features/assistant/assistant-context";
import { ProspectChatProvider } from "@/features/assistant/prospect-chat-state";
import { LeadJobsProvider } from "@/features/leads/jobs/lead-jobs";
import { LeadsStateProvider } from "@/features/leads/leads-state";
import { WaStreamProvider } from "@/features/whatsapp/wa-stream";
import { createQueryClient } from "@/lib/queries";
import type { RouteId } from "@/routes";

export function AppProviders({ children, route }: { children: ReactNode; route: RouteId }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <ConfirmProvider>
            <WaStreamProvider onWhatsAppView={route === "whatsapp"}>
              <AssistantProvider>
                <ProspectChatProvider>
                  <AiChatProvider>
                    <LeadsStateProvider>
                      <LeadJobsProvider>{children}</LeadJobsProvider>
                    </LeadsStateProvider>
                  </AiChatProvider>
                </ProspectChatProvider>
              </AssistantProvider>
            </WaStreamProvider>
          </ConfirmProvider>
        </TooltipProvider>
        <Toaster position="top-right" richColors={false} closeButton />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
