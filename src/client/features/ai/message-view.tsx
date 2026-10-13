// One chat message: user bubble, or the assistant's parts in order (text as
// streaming markdown, reasoning, tool calls, URL sources).
import { memo } from "react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import type { AiChatMessage } from "@/lib/api/types";
import { safeUrl } from "@/lib/format";
import { isToolPart } from "./chat-logic";
import { ToolPartView } from "./tool-renderers";

interface MessageViewProps {
  message: AiChatMessage;
  isLast: boolean;
  /** This message is the one receiving the stream right now. */
  streaming: boolean;
  busy: boolean;
  resolvedApprovals: ReadonlySet<string>;
  onRespond: (approvalId: string, approved: boolean, reason?: string) => void;
  onSendDraft: (leadId: number, text: string) => void;
}

export const MessageView = memo(function MessageView({ message, isLast, streaming, busy, resolvedApprovals, onRespond, onSendDraft }: MessageViewProps) {
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return (
      <Message from="user" aria-label="Você">
        <MessageContent className="whitespace-pre-wrap">{text}</MessageContent>
      </Message>
    );
  }

  const sources = message.parts.filter((p): p is Extract<typeof p, { type: "source-url" }> => p.type === "source-url" && Boolean(safeUrl(p.url)));
  const lastIndex = message.parts.length - 1;

  return (
    <Message from="assistant" aria-label="Assistente">
      <MessageContent className="w-full gap-3">
        {message.parts.map((part, index) => {
          const key = `${message.id}-${index}`;
          if (part.type === "text") {
            if (!part.text) return null;
            return (
              <MessageResponse key={key} isAnimating={streaming && index === lastIndex} className="text-sm leading-relaxed">
                {part.text}
              </MessageResponse>
            );
          }
          if (part.type === "reasoning") {
            if (!part.text) return null;
            return (
              <Reasoning key={key} isStreaming={streaming && index === lastIndex} className="w-full">
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          if (isToolPart(part)) {
            return (
              <ToolPartView
                key={part.toolCallId}
                part={part}
                isLastMessage={isLast}
                busy={busy}
                resolvedApprovals={resolvedApprovals}
                onRespond={onRespond}
                onSendDraft={onSendDraft}
              />
            );
          }
          return null; // step-start, data-credits, files…
        })}
        {sources.length > 0 && (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((s) => (
                <Source key={s.sourceId} href={safeUrl(s.url)!} title={s.title ?? s.url} />
              ))}
            </SourcesContent>
          </Sources>
        )}
      </MessageContent>
    </Message>
  );
});
