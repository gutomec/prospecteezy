// Header pill: state of the active WhatsApp account (live via SSE).
import { Link } from "@/app/router";
import { StatusDot, type Tone } from "@/components/common/status-badge";
import type { WaStatus } from "@/lib/api/types";
import { useWaInstances } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/routes";
import { pickActiveInstance, WA_STATUS_LABELS } from "./wa-stream";

export const WA_STATUS_TONES: Record<WaStatus, Tone> = {
  connected: "success",
  qr: "warning",
  connecting: "warning",
  disconnected: "neutral",
  logged_out: "danger",
};

export function WaStatusIndicator({ className }: { className?: string }) {
  const instances = useWaInstances();
  const active = pickActiveInstance(instances.data);
  const tone: Tone = instances.isError ? "danger" : active ? WA_STATUS_TONES[active.status] : "neutral";
  const label = instances.isPending
    ? "Verificando WhatsApp…"
    : instances.isError
      ? "WhatsApp indisponível"
      : active
        ? `WhatsApp: ${WA_STATUS_LABELS[active.status].toLowerCase()}`
        : "WhatsApp não conectado";

  return (
    <Link
      to={ROUTES.whatsapp}
      className={cn(
        "hover:bg-accent text-muted-foreground inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
      title={active?.status_reason ?? label}
    >
      <StatusDot tone={tone} className={cn(active?.status === "connecting" && "animate-pulse")} />
      <span className="sr-only sm:not-sr-only" role="status" aria-live="polite">
        {label}
      </span>
    </Link>
  );
}
