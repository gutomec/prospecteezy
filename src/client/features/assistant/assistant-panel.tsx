// Right-side assistant Sheet. Picks the chat by AI mode (live: settings
// changes invalidate the ai/status query and this re-renders).
import { BotIcon, SparklesIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AiChatSlot } from "@/features/ai/ai-chat-slot";
import { useAiStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useAssistant } from "./assistant-context";
import { ClassicProspectChat } from "./classic-prospect-chat";

export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const ai = useAiStatus();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        // AI chat: full-screen sheet up to 768 px, wider panel above (tool cards need room).
        className={cn("flex w-full flex-col gap-0 p-0", ai.enabled ? "sm:max-w-none md:max-w-lg" : "sm:max-w-md")}
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            {ai.enabled ? <SparklesIcon className="size-4 text-brand" /> : <BotIcon className="size-4 text-brand" />}
            {ai.enabled ? "Assistente de IA" : "Agente de prospecção"}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {ai.enabled
              ? "Peça buscas, pesquisas e rascunhos em linguagem natural."
              : "Modo clássico: entende pedidos de busca como “50 dentistas em Campinas-SP”."}
          </SheetDescription>
        </SheetHeader>
        {ai.enabled ? <AiChatSlot provider={ai.provider} /> : <ClassicProspectChat />}
      </SheetContent>
    </Sheet>
  );
}
