// Leads data table (≥ md) and card list (< md), server-paginated.
// Rows open the lead drawer; the name is a real button for keyboard users.
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, StarIcon } from "lucide-react";
import type { ReactNode } from "react";
import { StatusBadge, type Tone } from "@/components/common/status-badge";
import { TagList } from "@/components/common/tag-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Lead, LeadSort, LeadSortColumn } from "@/lib/api/types";
import { formatInt, formatRating, hostnameOf, safeUrl, WHATSAPP_LABELS, whatsappState, type WhatsAppState } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Density } from "./leads-state";

export const WA_TONES: Record<WhatsAppState, Tone> = { yes: "success", no: "neutral", pending: "info", ambiguous: "warning" };

export function WhatsAppBadge({ lead, ambiguous }: { lead: Lead; ambiguous: ReadonlySet<number> }) {
  const state = whatsappState(lead, ambiguous);
  return <StatusBadge tone={WA_TONES[state]}>{WHATSAPP_LABELS[state]}</StatusBadge>;
}

const Empty = () => (
  <span className="text-muted-foreground/60" aria-label="vazio">
    —
  </span>
);

function Rating({ lead }: { lead: Lead }) {
  if (lead.rating == null) return <Empty />;
  return (
    <span className="inline-flex items-center gap-1 tabular">
      <StarIcon className="size-3.5 fill-amber-400 text-amber-400" aria-hidden="true" />
      <span className="font-medium">{formatRating(lead.rating)}</span>
      {lead.rating_count != null && <span className="text-muted-foreground text-xs">({formatInt(lead.rating_count)})</span>}
    </span>
  );
}

function WebsiteLink({ lead }: { lead: Lead }) {
  const href = safeUrl(lead.website);
  if (!href) return lead.website ? <span className="text-muted-foreground">{lead.website}</span> : <Empty />;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand hover:underline"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Site de ${lead.name}: ${hostnameOf(href)} (abre em nova aba)`}
    >
      {hostnameOf(href)}
    </a>
  );
}

interface SortHeaderProps {
  column: LeadSortColumn;
  sort: LeadSort | null;
  onSort: (sort: LeadSort | null) => void;
  children: ReactNode;
  className?: string;
}

/** asc → desc → none, like the old grid. */
function SortHeader({ column, sort, onSort, children, className }: SortHeaderProps) {
  const active = sort?.column === column;
  const next = () => {
    if (!active) onSort({ column, desc: false });
    else if (!sort.desc) onSort({ column, desc: true });
    else onSort(null);
  };
  const Icon = !active ? ArrowUpDownIcon : sort.desc ? ArrowDownIcon : ArrowUpIcon;
  return (
    <TableHead className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        onClick={next}
        className="hover:text-foreground -ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {children}
        <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden="true" />
      </button>
    </TableHead>
  );
}

interface LeadsTableProps {
  leads: Lead[];
  loading: boolean;
  sort: LeadSort | null;
  onSort: (sort: LeadSort | null) => void;
  selection: ReadonlySet<number>;
  onToggle: (id: number, selected: boolean) => void;
  onTogglePage: (selected: boolean) => void;
  ambiguous: ReadonlySet<number>;
  density: Density;
  onOpen: (id: number) => void;
}

export function LeadsTable({ leads, loading, sort, onSort, selection, onToggle, onTogglePage, ambiguous, density, onOpen }: LeadsTableProps) {
  const selectedOnPage = leads.filter((l) => selection.has(l.id)).length;
  const allState = leads.length > 0 && selectedOnPage === leads.length ? true : selectedOnPage > 0 ? "indeterminate" : false;
  const cell = density === "compact" ? "py-1.5" : "py-2.5";

  return (
    <>
      <div className="hidden md:block">
        <Table aria-label="Leads coletados" aria-busy={loading}>
          <TableHeader className="bg-muted/40 sticky top-0 z-10 backdrop-blur">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 pl-4">
                <Checkbox
                  checked={allState}
                  onCheckedChange={(v) => onTogglePage(v === true)}
                  aria-label="Selecionar todos os leads desta página"
                  disabled={leads.length === 0}
                />
              </TableHead>
              <SortHeader column="name" sort={sort} onSort={onSort} className="min-w-44">
                Nome
              </SortHeader>
              <SortHeader column="category" sort={sort} onSort={onSort} className="hidden xl:table-cell">
                Categoria
              </SortHeader>
              <TableHead className="hidden 2xl:table-cell">Endereço</TableHead>
              <TableHead>Telefone</TableHead>
              <TableHead className="hidden lg:table-cell">Website</TableHead>
              <TableHead className="hidden lg:table-cell">Tags</TableHead>
              <TableHead>E-mail</TableHead>
              <SortHeader column="rating" sort={sort} onSort={onSort}>
                Avaliação
              </SortHeader>
              <SortHeader column="is_whatsapp" sort={sort} onSort={onSort} className="pr-4">
                WhatsApp
              </SortHeader>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && leads.length === 0
              ? Array.from({ length: 8 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell className="pl-4">
                      <Skeleton className="size-4" />
                    </TableCell>
                    {[60, 0, 0, 40, 0, 35, 55, 30, 50].map((w, j) => (
                      <TableCell key={j} className={cn(j === 1 && "hidden xl:table-cell", j === 2 && "hidden 2xl:table-cell", (j === 4 || j === 5) && "hidden lg:table-cell")}>
                        <Skeleton className="h-3.5" style={{ width: `${w || 70}%` }} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : leads.map((lead) => {
                  const selected = selection.has(lead.id);
                  return (
                    <TableRow
                      key={lead.id}
                      data-state={selected ? "selected" : undefined}
                      className="cursor-pointer"
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("a,button,[role=checkbox]")) return;
                        onOpen(lead.id);
                      }}
                    >
                      <TableCell className={cn("pl-4", cell)}>
                        <Checkbox checked={selected} onCheckedChange={(v) => onToggle(lead.id, v === true)} aria-label={`Selecionar ${lead.name}`} />
                      </TableCell>
                      <TableCell className={cn("max-w-60", cell)}>
                        <button
                          type="button"
                          onClick={() => onOpen(lead.id)}
                          className="block max-w-full truncate text-left font-medium hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none rounded-sm"
                          title={lead.name}
                        >
                          {lead.name}
                        </button>
                        {lead.category && density === "comfortable" && (
                          <span className="text-muted-foreground block truncate text-xs xl:hidden">{lead.category}</span>
                        )}
                      </TableCell>
                      <TableCell className={cn("text-muted-foreground hidden max-w-40 truncate xl:table-cell", cell)} title={lead.category ?? ""}>
                        {lead.category ?? <Empty />}
                      </TableCell>
                      <TableCell className={cn("text-muted-foreground hidden max-w-52 truncate 2xl:table-cell", cell)} title={lead.address ?? ""}>
                        {lead.address ?? <Empty />}
                      </TableCell>
                      <TableCell className={cn("font-mono text-xs whitespace-nowrap", cell)}>{lead.phone ?? <Empty />}</TableCell>
                      <TableCell className={cn("hidden max-w-36 truncate lg:table-cell", cell)}>
                        <WebsiteLink lead={lead} />
                      </TableCell>
                      <TableCell className={cn("hidden max-w-52 lg:table-cell", cell)}>
                        {lead.tags?.length ? <TagList tags={lead.tags} max={2} className="flex-nowrap" badgeClassName="max-w-24" /> : <Empty />}
                      </TableCell>
                      <TableCell className={cn("max-w-48 truncate", cell)}>
                        {lead.email ? (
                          <a href={`mailto:${lead.email}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                            {lead.email}
                          </a>
                        ) : (
                          <Empty />
                        )}
                      </TableCell>
                      <TableCell className={cell}>
                        <Rating lead={lead} />
                      </TableCell>
                      <TableCell className={cn("pr-4", cell)}>
                        <WhatsAppBadge lead={lead} ambiguous={ambiguous} />
                      </TableCell>
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: cards */}
      <ul className="divide-y md:hidden" aria-label="Leads coletados" aria-busy={loading}>
        {loading && leads.length === 0
          ? Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="space-y-2 p-4">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </li>
            ))
          : leads.map((lead) => {
              const selected = selection.has(lead.id);
              return (
                <li key={lead.id} className={cn("flex gap-3 px-4 py-3", selected && "bg-muted/50")}>
                  <Checkbox className="mt-0.5" checked={selected} onCheckedChange={(v) => onToggle(lead.id, v === true)} aria-label={`Selecionar ${lead.name}`} />
                  <button type="button" onClick={() => onOpen(lead.id)} className="min-w-0 flex-1 space-y-1 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-sm">
                    <span className="flex items-start justify-between gap-2">
                      <span className="truncate font-medium">{lead.name}</span>
                      <WhatsAppBadge lead={lead} ambiguous={ambiguous} />
                    </span>
                    <span className="text-muted-foreground flex items-center gap-2 text-xs">
                      {lead.category && <span className="truncate">{lead.category}</span>}
                      {lead.rating != null && <Rating lead={lead} />}
                    </span>
                    <span className="block font-mono text-xs">{lead.phone ?? "Sem telefone"}</span>
                    {lead.tags?.length ? <TagList tags={lead.tags} max={3} interactive={false} className="pt-0.5" /> : null}
                  </button>
                </li>
              );
            })}
      </ul>
    </>
  );
}

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}

export const PAGE_SIZES = [25, 50, 100, 200];

export function Pagination({ page, pageSize, total, onPage, onPageSize }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
      <p className="text-muted-foreground tabular" aria-live="polite">
        {formatInt(start)}–{formatInt(end)} de {formatInt(total)}
      </p>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground hidden text-xs sm:inline" id="page-size-label">
            Por página
          </span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger size="sm" className="w-20" aria-labelledby="page-size-label" aria-label="Leads por página">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <nav className="flex items-center gap-1" aria-label="Paginação">
          <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Página anterior">
            <ChevronLeftIcon />
          </Button>
          <span className="min-w-16 text-center text-xs tabular" aria-current="page">
            {formatInt(page)} / {formatInt(pages)}
          </span>
          <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Próxima página">
            <ChevronRightIcon />
          </Button>
        </nav>
      </div>
    </div>
  );
}
