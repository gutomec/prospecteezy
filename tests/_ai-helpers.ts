import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { openDb } from "../src/db/index.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import type { ModelFactory } from "../src/ai/model-factory.ts";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

export type Chunk = Record<string, unknown>;

export const textStep = (text: string, id = "t1"): Chunk[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
];

export const toolStep = (toolCallId: string, toolName: string, input: unknown): Chunk[] => [
  { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
];

/**
 * AI SDK mock model that plays one scripted step per doStream call. A step
 * can be an Error to make that call fail. `prompts` records what it received.
 */
export function scriptedModel(steps: Array<Chunk[] | Error>) {
  const prompts: unknown[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    // generateText (provider test) path: text deltas become one text part.
    doGenerate: async (options: { prompt: unknown }) => {
      prompts.push(options.prompt);
      const step = steps[call++] ?? textStep("(fim do roteiro)");
      if (step instanceof Error) throw step;
      const text = step
        .filter((c) => c.type === "text-delta")
        .map((c) => String(c.delta))
        .join("");
      const finish = step.find((c) => c.type === "finish")!;
      return { content: [{ type: "text", text }], finishReason: finish.finishReason, usage, warnings: [] };
    },
    doStream: async (options: { prompt: unknown }) => {
      prompts.push(options.prompt);
      const step = steps[call++] ?? textStep("(fim do roteiro)");
      if (step instanceof Error) throw step;
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of step) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  } as never);
  return { model, prompts, calls: () => call };
}

/** Test server: in-memory DB, temp master key dir, no network. */
export function startAiServer(options: Partial<ServerOptions> & { models?: ModelFactory } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prospecteezy-ai-"));
  const db = options.db ?? openDb(":memory:");
  const { server, box } = createServer({
    db,
    port: 0,
    skipEnrichment: true,
    masterKeyPath: join(dir, ".master.key"),
    waSendToLead: async () => ({ ok: false, code: "no_instance", reason: "sem instância (teste)" }),
    ...options,
  });
  const base = `http://localhost:${server.port}`;
  return {
    server,
    db,
    box,
    dir,
    base,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Seeds one search and a lead; returns the lead id. */
export function seedLead(
  db: import("bun:sqlite").Database,
  overrides: Partial<{ name: string; email: string | null; website: string | null; is_whatsapp: number | null; whatsapp_jid: string | null; phone: string | null }> = {},
): number {
  db.query(
    `INSERT OR IGNORE INTO searches (id, query_normalized, niche, city, gl, hl, created_at)
     VALUES (1, 'padarias recife', 'padarias', 'Recife', 'br', 'pt-br', ?)`,
  ).run(new Date().toISOString());
  const result = db
    .query(
      `INSERT INTO leads (search_id, place_id, name, category, address, phone, website, email, is_whatsapp, whatsapp_jid, source, collected_at)
       VALUES (1, ?, ?, 'Padaria', 'Rua A, Recife - PE', ?, ?, ?, ?, ?, 'serper:places', ?)`,
    )
    .run(
      `p-${crypto.randomUUID()}`,
      overrides.name ?? "Padaria Pão Bom",
      overrides.phone ?? "+55 81 99999-0000",
      overrides.website === undefined ? "https://paobom.example" : overrides.website,
      overrides.email ?? null,
      overrides.is_whatsapp ?? null,
      overrides.whatsapp_jid ?? null,
      new Date().toISOString(),
    );
  return Number(result.lastInsertRowid);
}
