import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { redactSecrets } from "../src/ai/errors.ts";
import {
  buildSerperBody,
  estimateSerperCredits,
  trimSerperBody,
  validateSerperParams,
} from "../src/ai/serper-catalog.ts";
import { createTools } from "../src/ai/tools.ts";

describe("Serper catalog", () => {
  test("per-type required params and unsupported params", () => {
    expect(validateSerperParams("search", { gl: "br" })).toContain('exige "q"');
    expect(validateSerperParams("search", { q: "x", gl: "br", hl: "pt-br" })).toBeNull();
    expect(validateSerperParams("reviews", { q: "x" })).toContain("não aceitos");
    expect(validateSerperParams("reviews", { gl: "br" })).toContain("cid, fid ou placeId");
    expect(validateSerperParams("reviews", { placeId: "abc" })).toBeNull();
    expect(validateSerperParams("lens", { gl: "br" })).toContain('"url"');
    expect(validateSerperParams("maps", { q: "padaria", page: 2 })).toContain('"ll"');
    expect(validateSerperParams("maps", { q: "padaria", page: 2, ll: "@-8.05,-34.9,14z" })).toBeNull();
    expect(validateSerperParams("news", { q: "x", tbs: "ontem" })).toContain("tbs");
  });

  test("credit estimates and request bodies", () => {
    expect(estimateSerperCredits("search", {})).toBe(1);
    expect(estimateSerperCredits("maps", {})).toBe(3);
    expect(estimateSerperCredits("shopping", {})).toBe(2);
    expect(estimateSerperCredits("images", { num: 20 })).toBe(2);
    expect(buildSerperBody("product-reviews", { q: "prod-1", gl: "br" })).toEqual({ productId: "prod-1", gl: "br" });
    expect(buildSerperBody("places", { q: "x", tbs: "qdr:d" })).toEqual({ q: "x" });
  });

  test("results are capped for the model", () => {
    const big = { searchParameters: { q: "x" }, organic: Array.from({ length: 200 }, (_, i) => ({ title: `Resultado ${i}`, snippet: "x".repeat(100) })) };
    const trimmed = trimSerperBody(big) as { organic: unknown[]; searchParameters?: unknown };
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(8000);
    expect(trimmed.searchParameters).toBeUndefined();
    expect(trimmed.organic.length).toBeGreaterThan(0);
  });
});

describe("tools", () => {
  const baseDeps = (serperFetch: typeof fetch) => ({
    db: openDb(":memory:"),
    providerKind: "openai",
    getSerperKey: async () => "k-123456",
    serperFetch,
    sendToLead: async () => ({ ok: false as const, code: "no_instance" as const, reason: "x" }),
    addCredits: () => {},
    crawlerResolveHost: async (host: string) => (host === "interno.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
  });
  const options = { toolCallId: "c", messages: [], abortSignal: new AbortController().signal } as never;

  test("scrape_webpage refuses private hosts (SSRF) without calling Serper", async () => {
    let calls = 0;
    const tools = createTools(baseDeps((async () => {
      calls++;
      return Response.json({ text: "conteúdo", credits: 2 });
    }) as unknown as typeof fetch));
    await expect(tools.scrape_webpage.execute!({ url: "http://interno.example/" }, options)).rejects.toThrow("recusada");
    await expect(tools.scrape_webpage.execute!({ url: "file:///etc/passwd" }, options)).rejects.toThrow("recusada");
    expect(calls).toBe(0);
    const ok = (await tools.scrape_webpage.execute!({ url: "https://site.example/" }, options)) as { text: string; credits: number };
    expect(ok).toMatchObject({ text: "conteúdo", credits: 2 });
    expect(calls).toBe(1);
  });

  test("Serper tools fail clearly without a key", async () => {
    const tools = createTools({ ...baseDeps(fetch), getSerperKey: async () => null });
    await expect(
      tools.serper_search.execute!({ type: "search", q: "x", gl: "br", hl: "pt-br" }, options),
    ).rejects.toThrow("SERPER_API_KEY ausente");
  });
});

describe("errors", () => {
  test("redacts key-like strings", () => {
    expect(redactSecrets("bad key sk-abcdefghijklmnop123 and minha-chave", "minha-chave")).toBe("bad key *** and ***");
  });
});
