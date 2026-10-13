// Shared Streamdown props for model-written markdown (local adjustment to the
// AI Elements registry files): links only to http(s)/mailto/tel, opened in a
// new tab with rel=noreferrer (Streamdown's default <a>). The link-safety modal
// is off because it portals to <body>, which the assistant Sheet makes inert.
import type { StreamdownProps } from "streamdown";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Absolute http(s)/mailto/tel URL, or "" (drops javascript:, data:, relative paths). */
export function safeMarkdownUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

export const streamdownSafety = {
  urlTransform: (url: string) => safeMarkdownUrl(url),
  linkSafety: { enabled: false },
  translations: {
    close: "Fechar",
    copied: "Copiado",
    copyCode: "Copiar código",
    copyLink: "Copiar link",
    copyTable: "Copiar tabela",
    copyTableAsCsv: "Copiar como CSV",
    copyTableAsMarkdown: "Copiar como Markdown",
    copyTableAsTsv: "Copiar como TSV",
    downloadFile: "Baixar arquivo",
    downloadImage: "Baixar imagem",
    downloadTable: "Baixar tabela",
    downloadTableAsCsv: "Baixar como CSV",
    downloadTableAsMarkdown: "Baixar como Markdown",
    imageNotAvailable: "Imagem indisponível",
    openLink: "Abrir link",
  },
} satisfies Partial<StreamdownProps>;
