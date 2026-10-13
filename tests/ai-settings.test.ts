import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { createSecretBox } from "../src/settings/secrets.ts";
import { getSerperApiKey, setSerperApiKey } from "../src/settings/repo.ts";
import { call, startAiServer } from "./_ai-helpers.ts";

const dirs: string[] = [];
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prospecteezy-secrets-"));
  dirs.push(dir);
  return dir;
}

function withEnvKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = Bun.env.SERPER_API_KEY;
  if (value === undefined) delete Bun.env.SERPER_API_KEY;
  else Bun.env.SERPER_API_KEY = value;
  return fn().finally(() => {
    if (previous === undefined) delete Bun.env.SERPER_API_KEY;
    else Bun.env.SERPER_API_KEY = previous;
  });
}

describe("secrets (AES-256-GCM + master key file)", () => {
  test("roundtrip; key file created on first encrypt with mode 0600", async () => {
    const keyPath = join(tempDir(), "sub", ".master.key");
    const box = createSecretBox({ keyPath });
    expect(existsSync(keyPath)).toBe(false);
    const blob = await box.encrypt("chave-secreta-123");
    expect(blob).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(blob).not.toContain("chave-secreta");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(keyPath).size).toBe(32);
    expect(await box.decrypt(blob)).toBe("chave-secreta-123");
    // A fresh box reading the same file decrypts too.
    expect(await createSecretBox({ keyPath }).decrypt(blob)).toBe("chave-secreta-123");
  });

  test("missing or different key file → decrypt returns null (never throws), no key created", async () => {
    const keyPath = join(tempDir(), ".master.key");
    const blob = await createSecretBox({ keyPath }).encrypt("x-123456");
    unlinkSync(keyPath);
    const box = createSecretBox({ keyPath });
    expect(await box.decrypt(blob)).toBeNull();
    expect(existsSync(keyPath)).toBe(false);
    writeFileSync(keyPath, crypto.getRandomValues(new Uint8Array(32)));
    expect(await createSecretBox({ keyPath }).decrypt(blob)).toBeNull();
    expect(await box.decrypt("lixo")).toBeNull();
  });

  test("injected key works without any file", async () => {
    const box = createSecretBox({ key: crypto.getRandomValues(new Uint8Array(32)) });
    expect(await box.decrypt(await box.encrypt("olá ção"))).toBe("olá ção");
  });

  test("serper key resolution: settings ?? env ?? null", async () => {
    const db = openDb(":memory:");
    const box = createSecretBox({ keyPath: join(tempDir(), ".master.key") });
    await withEnvKey(undefined, async () => expect(await getSerperApiKey(db, box)).toBeNull());
    await withEnvKey("env-key-9999", async () => {
      expect(await getSerperApiKey(db, box)).toBe("env-key-9999");
      await setSerperApiKey(db, box, "db-key-1234");
      expect(await getSerperApiKey(db, box)).toBe("db-key-1234");
    });
  });
});

describe("settings routes", () => {
  test("PUT/GET/DELETE serper key: masked, never returned, env fallback", async () => {
    await withEnvKey(undefined, async () => {
      const t = startAiServer();
      stop = t.stop;
      const empty = await call(t.base, "GET", "/api/settings");
      expect(empty.json).toEqual({
        serper: { configured: false, source: null, last4: null },
        company_profile: null,
        secrets_unreadable: false,
      });

      const put = await call(t.base, "PUT", "/api/settings/serper", { api_key: "  serper-super-secret-7788  " });
      expect(put.status).toBe(200);
      expect(put.json).toEqual({ configured: true, source: "settings", last4: "7788" });

      const got = await call(t.base, "GET", "/api/settings");
      expect(got.json.serper).toEqual({ configured: true, source: "settings", last4: "7788" });
      expect(got.text).not.toContain("serper-super-secret");
      const raw = (t.db.query("SELECT value FROM app_settings WHERE key = 'serper_api_key'").get() as { value: string }).value;
      expect(raw).not.toContain("serper-super-secret");

      expect((await call(t.base, "PUT", "/api/settings/serper", { api_key: "   " })).status).toBe(400);

      await withEnvKey("env-key-4321", async () => {
        const del = await call(t.base, "DELETE", "/api/settings/serper");
        expect(del.json).toEqual({ configured: true, source: "env", last4: "4321" });
      });
    });
  });

  test("secrets_unreadable when the master key disappears", async () => {
    await withEnvKey(undefined, async () => {
      const db = openDb(":memory:");
      const t = startAiServer({ db });
      stop = t.stop;
      await call(t.base, "PUT", "/api/settings/serper", { api_key: "abc-key-0001" });
      t.stop(); // removes its temp dir, master key included
      const again = startAiServer({ db }); // fresh dir: no master key file
      stop = again.stop;
      const got = await call(again.base, "GET", "/api/settings");
      expect(got.status).toBe(200);
      expect(got.json.secrets_unreadable).toBe(true);
      expect(got.json.serper.configured).toBe(false);
      expect(got.json.warning).toContain("Cadastre-as novamente");
    });
  });

  test("POST /api/settings/serper/test uses autocomplete and reports ok / error without the key", async () => {
    const requests: Array<{ url: string; key: string | null; body: unknown }> = [];
    let status = 200;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, key: new Headers(init.headers).get("x-api-key"), body: JSON.parse(String(init.body)) });
      return status === 200
        ? Response.json({ suggestions: [], credits: 1 })
        : new Response("Unauthorized key serper-test-key-5555", { status });
    }) as typeof fetch;
    const t = startAiServer({ serperFetch: fakeFetch });
    stop = t.stop;
    await call(t.base, "PUT", "/api/settings/serper", { api_key: "serper-test-key-5555" });
    const ok = await call(t.base, "POST", "/api/settings/serper/test");
    expect(ok.json).toEqual({ ok: true });
    expect(requests[0]!.url).toBe("https://google.serper.dev/autocomplete");
    expect(requests[0]!.key).toBe("serper-test-key-5555");
    status = 403;
    const bad = await call(t.base, "POST", "/api/settings/serper/test");
    expect(bad.json.ok).toBe(false);
    expect(bad.text).not.toContain("serper-test-key-5555");
  });

  test("PUT /api/settings/company validates and stores the profile", async () => {
    const t = startAiServer();
    stop = t.stop;
    const saved = await call(t.base, "PUT", "/api/settings/company", {
      name: " Acme Consultoria ",
      offering: "Gestão de tráfego",
      unknown_field: "ignorado",
      tone: "",
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({ company_profile: { name: "Acme Consultoria", offering: "Gestão de tráfego" } });
    expect((await call(t.base, "GET", "/api/settings")).json.company_profile).toEqual({
      name: "Acme Consultoria",
      offering: "Gestão de tráfego",
    });
    expect((await call(t.base, "PUT", "/api/settings/company", { name: "x".repeat(4001) })).status).toBe(400);
    expect((await call(t.base, "PUT", "/api/settings/company", { name: 5 })).status).toBe(400);
    expect((await call(t.base, "PUT", "/api/settings/company", {})).json).toEqual({ company_profile: null });
  });

  test("new routes keep the same-origin / Host guard", async () => {
    const t = startAiServer();
    stop = t.stop;
    const foreign = await call(t.base, "PUT", "/api/settings/serper", { api_key: "x-12345" }, { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const chat = await call(t.base, "POST", "/api/chat", {}, { Origin: "https://evil.example" });
    expect(chat.status).toBe(403);
    const providers = await call(t.base, "POST", "/api/ai/providers", {}, { Origin: "https://evil.example" });
    expect(providers.status).toBe(403);
  });
});
