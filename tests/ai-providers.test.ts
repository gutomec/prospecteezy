import { afterEach, describe, expect, test } from "bun:test";
import { APICallError } from "ai";
import { call, scriptedModel, startAiServer, textStep } from "./_ai-helpers.ts";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe("AI providers", () => {
  test("CRUD, keys never returned, single active provider", async () => {
    const t = startAiServer();
    stop = t.stop;
    expect((await call(t.base, "GET", "/api/ai/status")).json).toEqual({ enabled: false, provider: null });

    const first = await call(t.base, "POST", "/api/ai/providers", {
      kind: "openai",
      label: "Minha OpenAI",
      model: "gpt-5-mini",
      api_key: "sk-openai-very-secret-1111",
    });
    expect(first.status).toBe(201);
    expect(first.json.provider).toMatchObject({
      kind: "openai",
      label: "Minha OpenAI",
      model: "gpt-5-mini",
      base_url: null,
      has_key: true,
      last4: "1111",
      is_active: true, // first provider becomes active
    });
    expect(first.text).not.toContain("very-secret");

    const second = await call(t.base, "POST", "/api/ai/providers", {
      kind: "openai_compatible",
      label: "Ollama",
      model: "llama3.1",
      base_url: "http://localhost:11434/v1",
    });
    expect(second.status).toBe(201);
    expect(second.json.provider).toMatchObject({ has_key: false, last4: null, is_active: false });

    const list = await call(t.base, "GET", "/api/ai/providers");
    expect(list.json.providers).toHaveLength(2);
    expect(list.text).not.toContain("very-secret");
    const raw = t.db.query("SELECT api_key_enc FROM llm_providers WHERE kind = 'openai'").get() as { api_key_enc: string };
    expect(raw.api_key_enc).not.toContain("very-secret");

    const activated = await call(t.base, "POST", `/api/ai/providers/${second.json.provider.id}/activate`);
    expect(activated.json.provider.is_active).toBe(true);
    const active = t.db.query("SELECT COUNT(*) AS n FROM llm_providers WHERE is_active = 1").get() as { n: number };
    expect(active.n).toBe(1);
    expect((await call(t.base, "GET", "/api/ai/status")).json).toEqual({
      enabled: true,
      provider: { id: second.json.provider.id, kind: "openai_compatible", label: "Ollama", model: "llama3.1" },
    });

    // PATCH without api_key keeps the stored key.
    const patched = await call(t.base, "PATCH", `/api/ai/providers/${first.json.provider.id}`, { model: "gpt-5" });
    expect(patched.json.provider).toMatchObject({ model: "gpt-5", last4: "1111" });
    const rekeyed = await call(t.base, "PATCH", `/api/ai/providers/${first.json.provider.id}`, { api_key: "sk-new-key-2222" });
    expect(rekeyed.json.provider.last4).toBe("2222");

    expect((await call(t.base, "POST", "/api/ai/deactivate")).status).toBe(200);
    expect((await call(t.base, "GET", "/api/ai/status")).json.enabled).toBe(false);

    await call(t.base, "POST", `/api/ai/providers/${first.json.provider.id}/activate`);
    expect((await call(t.base, "DELETE", `/api/ai/providers/${first.json.provider.id}`)).status).toBe(200);
    expect((await call(t.base, "GET", "/api/ai/status")).json.enabled).toBe(false); // deleting the active one disables AI
    expect((await call(t.base, "DELETE", "/api/ai/providers/nao-existe")).status).toBe(404);
    expect((await call(t.base, "POST", "/api/ai/providers/nao-existe/activate")).status).toBe(404);
  });

  test("validation errors are 400 in PT-BR", async () => {
    const t = startAiServer();
    stop = t.stop;
    const cases: Array<[unknown, string]> = [
      [{ kind: "foo", model: "x", api_key: "k" }, "Tipo de provedor inválido"],
      [{ kind: "openai", api_key: "k" }, "Informe o modelo"],
      [{ kind: "openai_compatible", model: "m" }, "URL base"],
      [{ kind: "anthropic", model: "claude-sonnet-5-5" }, "chave de API"],
      [{ kind: "openai_compatible", model: "m", base_url: "ftp://x" }, "URL base inválida"],
    ];
    for (const [body, message] of cases) {
      const res = await call(t.base, "POST", "/api/ai/providers", body);
      expect(res.status).toBe(400);
      expect(res.json.error).toContain(message);
    }
    expect((await call(t.base, "GET", "/api/ai/providers")).json.providers).toHaveLength(0);
  });

  test("GET /api/ai/models returns curated suggestions per kind", async () => {
    const t = startAiServer();
    stop = t.stop;
    const res = await call(t.base, "GET", "/api/ai/models?kind=anthropic");
    expect(res.json.kind).toBe("anthropic");
    expect(res.json.models.map((m: { id: string }) => m.id)).toContain("claude-sonnet-5-5");
    expect((await call(t.base, "GET", "/api/ai/models?kind=nada")).status).toBe(400);
  });

  test("POST /api/ai/providers/:id/test uses the model (mock) and maps errors", async () => {
    let fail = false;
    const t = startAiServer({
      aiModelFactory: () =>
        scriptedModel([
          fail
            ? new APICallError({ message: "bad key sk-openai-very-secret-1111", url: "u", requestBodyValues: {}, statusCode: 401 })
            : textStep("ok"),
        ]).model,
    });
    stop = t.stop;
    const created = await call(t.base, "POST", "/api/ai/providers", {
      kind: "openai",
      model: "gpt-5-mini",
      api_key: "sk-openai-very-secret-1111",
    });
    const id = created.json.provider.id;
    const ok = await call(t.base, "POST", `/api/ai/providers/${id}/test`);
    expect(ok.json.ok).toBe(true);
    expect(typeof ok.json.latency_ms).toBe("number");
    fail = true;
    const bad = await call(t.base, "POST", `/api/ai/providers/${id}/test`);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toContain("recusou a chave");
    expect(bad.text).not.toContain("very-secret");
  });
});
