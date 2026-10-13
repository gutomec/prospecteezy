// KPI cards over the full lead list: total (+today, 14-day sparkline),
// WhatsApp-validated share, e-mail share.
import { AtSignIcon, MessageCircleIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Lead } from "@/lib/api/types";
import { formatInt, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

const DAYS = 14;

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function computeMetrics(leads: Lead[], now = new Date()) {
  const counts = new Map<string, number>();
  const days: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = localDayKey(d);
    days.push(key);
    counts.set(key, 0);
  }
  let withWhatsapp = 0;
  let withEmail = 0;
  for (const lead of leads) {
    if (lead.is_whatsapp === 1) withWhatsapp++;
    if (lead.email) withEmail++;
    const collected = new Date(lead.collected_at);
    if (!Number.isNaN(collected.getTime())) {
      const key = localDayKey(collected);
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const series = days.map((key) => counts.get(key) ?? 0);
  return { total: leads.length, withWhatsapp, withEmail, today: series.at(-1) ?? 0, series };
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 116 + 2).toFixed(1)},${(34 - (v / max) * 30).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 120 36" className="h-9 w-28 text-brand" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Metric({ icon: Icon, label, value, hint, aside, loading, className }: { icon: LucideIcon; label: string; value: number; hint?: ReactNode; aside?: ReactNode; loading: boolean; className?: string }) {
  return (
    <section className={cn("flex items-end justify-between gap-3 rounded-xl border bg-card p-4 shadow-xs", className)} aria-label={label}>
      <div className="min-w-0 space-y-1.5">
        <h2 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </h2>
        {loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <p className="text-2xl font-semibold tracking-tight tabular">{formatInt(value)}</p>
        )}
        <div className="text-muted-foreground h-4 text-xs tabular">{!loading && hint}</div>
      </div>
      {!loading && aside}
    </section>
  );
}

export function MetricCards({ leads, loading }: { leads: Lead[]; loading: boolean }) {
  const m = useMemo(() => computeMetrics(leads), [leads]);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Metric
        icon={UsersIcon}
        label="Leads coletados"
        className="col-span-2 sm:col-span-1"
        value={m.total}
        loading={loading}
        hint={m.today > 0 ? <span className="text-success font-medium">+{formatInt(m.today)} hoje</span> : "Últimos 14 dias"}
        aside={<Sparkline values={m.series} />}
      />
      <Metric icon={MessageCircleIcon} label="No WhatsApp" value={m.withWhatsapp} loading={loading} hint={`${formatPercent(m.withWhatsapp, m.total)} do total`} />
      <Metric icon={AtSignIcon} label="Com e-mail" value={m.withEmail} loading={loading} hint={`${formatPercent(m.withEmail, m.total)} do total`} />
    </div>
  );
}
