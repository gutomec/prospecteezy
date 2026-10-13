import { describe, expect, test } from "bun:test";
import { createSerperFetcher } from "../src/ingest/serper.ts";

function scripted(responses: (() => Response)[]) {
  const signals: (AbortSignal | null | undefined)[] = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, signals, calls: () => i };
}

describe("Serper fetcher retries (item 10)", () => {
  test("honors Retry-After on 429 (seconds, capped at 30 s) and passes a timeout signal", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, signals } = scripted([
      () => new Response("", { status: 429, headers: { "Retry-After": "2" } }),
      () => new Response("", { status: 429, headers: { "Retry-After": "120" } }),
      () => Response.json({ places: [{ title: "A" }] }),
    ]);
    const fetcher = createSerperFetcher({
      apiKey: "k",
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(await fetcher("q", 1, 10)).toEqual([{ title: "A" }]);
    expect(sleeps).toEqual([2000, 30_000]);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  test("does not sleep after the final failed attempt", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = scripted([() => new Response("", { status: 503 })]);
    const fetcher = createSerperFetcher({
      apiKey: "k",
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(fetcher("q", 1, 10)).rejects.toThrow("Serper indisponível após 4 tentativas");
    expect(calls()).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  test("network errors also skip the final sleep", async () => {
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const fetcher = createSerperFetcher({
      apiKey: "k",
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(fetcher("q", 1, 10)).rejects.toThrow("timeout");
    expect(sleeps.length).toBe(3);
  });
});
