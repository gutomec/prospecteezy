// CSV export of leads: UTF-8 BOM (Excel opens accents correctly), `;` separator
// (PT-BR Excel default), CRLF line ends, every cell quoted, and spreadsheet
// formula injection neutralized.
import type { Lead } from "./api/types";
import { WHATSAPP_LABELS, whatsappState } from "./format";

/** Cells starting with = + - @ TAB or CR get a leading apostrophe so Excel/Sheets never evaluate them. */
export function csvSafe(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: unknown): string {
  return `"${csvSafe(value).replaceAll('"', '""')}"`;
}

export const LEAD_CSV_HEADER = [
  "nome",
  "categoria",
  "endereco",
  "telefone",
  "website",
  "email",
  "rating",
  "avaliacoes",
  "whatsapp",
  "coletado_em",
  "tags",
] as const;

export function leadsToCsv(leads: Lead[], ambiguous?: ReadonlySet<number>): string {
  const lines = leads.map((lead) =>
    [
      lead.name,
      lead.category,
      lead.address,
      lead.phone,
      lead.website,
      lead.email,
      lead.rating,
      lead.rating_count,
      WHATSAPP_LABELS[whatsappState(lead, ambiguous)],
      lead.collected_at,
      (lead.tags ?? []).join(", "),
    ]
      .map(csvCell)
      .join(";"),
  );
  return "﻿" + [LEAD_CSV_HEADER.join(";"), ...lines].join("\r\n");
}

/** Triggers a browser download of `text` as a UTF-8 CSV file. */
export function downloadCsv(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
