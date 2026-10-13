import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetJobs } from "../src/agent/jobs.ts";
import { createTools, describeApproval } from "../src/ai/tools.ts";
import { openDb } from "../src/db/index.ts";
import { deleteLeads, findOrCreateSearch, insertLeadIfNew, listLeads } from "../src/db/repository.ts";
import {
  ensureTags,
  listTags,
  normalizeTagName,
  parseTagList,
  setSearchTags,
  tagSlug,
  updateLeadTags,
} from "../src/db/tags.ts";
import type { PlacesFetcher, SerperPlace } from "../src/ingest/serper.ts";
import { createServer } from "../src/server.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetJobs();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prospecteezy-tags-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tempDb(): Database {
  return openDb(join(tempDir(), "test.db"));
}

let placeSeq = 0;
function addLead(db: Database, searchId: number, name = `Lead ${++placeSeq}`): number {
  const placeId = `p-${++placeSeq}`;
  insertLeadIfNew(db, {
    search_id: searchId,
    place_id: placeId,
    cid: null,
    position: 1,
    name,
    category: null,
    address: null,
    latitude: null,
    longitude: null,
    phone: null,
    website: null,
    rating: null,
    rating_count: null,
    source: "test",
  });
  return (db.query("SELECT id FROM leads WHERE place_id = ?").get(placeId) as { id: number }).id;
}

function tagsOf(db: Database, leadId: number): string[] {
  return (
    db
      .query("SELECT t.name FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = ? ORDER BY t.slug")
      .all(leadId) as { name: string }[]
  ).map((r) => r.name);
}

function events(db: Database, leadId: number, event: string) {
  return (
    db.query("SELECT payload_json FROM lead_events WHERE lead_id = ? AND event = ? ORDER BY id").all(leadId, event) as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json));
}

/** Fake Serper: `available` results per query, pages of `num`. */
function fakeFetcher(available: number): PlacesFetcher {
  return async (query, page, num) => {
    const startIndex = (page - 1) * num;
    const size = Math.max(0, Math.min(num, available - startIndex));
    return Array.from({ length: size }, (_, i): SerperPlace => ({
      title: `${query} ${startIndex + i}`,
      placeId: `${query}-p${startIndex + i}`,
      cid: `${query}-c${startIndex + i}`,
    }));
  };
}

function start(fetcher: PlacesFetcher = fakeFetcher(50)) {
  const dir = tempDir();
  const db = openDb(join(dir, "test.db"));
  const { server } = createServer({ db, port: 0, skipEnrichment: true, fetcher, masterKeyPath: join(dir, ".master.key") });
  cleanups.push(() => server.stop(true));
  return { db, base: `http://localhost:${server.port}` };
}

async function call(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function waitForJob(base: string, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const { json } = await call(base, "GET", `/api/progress/${jobId}`);
    if (json.job.status !== "running") return json.job;
    await Bun.sleep(10);
  }
  throw new Error("job não terminou a tempo");
}

describe("tag identity", () => {
  test("normalization and slug: case, accents and whitespace", () => {
    expect(normalizeTagName("  Academia   de  Bairro ")).toBe("Academia de Bairro");
    expect(normalizeTagName("   ")).toBeNull();
    expect(normalizeTagName("x".repeat(41))).toBeNull();
    expect(normalizeTagName("x".repeat(40))).toBe("x".repeat(40));
    expect(tagSlug("Ação  Social")).toBe("acao social");
    expect(tagSlug("ACADEMIA")).toBe(tagSlug("academia"));
  });

  test("parseTagList dedupes by slug (first spelling wins) and rejects bad input", () => {
    expect(parseTagList(["Academia", "academia", "Acadêmia ", "Quente"])).toEqual({ tags: ["Academia", "Quente"] });
    expect(parseTagList(["Prioridade", "PRIORIDADE"])).toEqual({ tags: ["Prioridade"] });
    expect("error" in parseTagList("academia")).toBe(true);
    expect("error" in parseTagList([1])).toBe(true);
    expect("error" in parseTagList([""])).toBe(true);
    expect("error" in parseTagList(Array.from({ length: 21 }, (_, i) => `t${i}`))).toBe(true);
  });

  test("ensureTags keeps the first-seen display name for the same slug", () => {
    const db = tempDb();
    const [first] = ensureTags(db, ["Médico"]);
    const [again] = ensureTags(db, ["medico"]);
    expect(again!.id).toBe(first!.id);
    expect(again!.name).toBe("Médico");
    expect(listTags(db)).toEqual([{ id: first!.id, name: "Médico", slug: "medico", lead_count: 0 }]);
  });
});

describe("lead tags (repository)", () => {
  test("bulk add/remove, idempotent, with batched events only for real changes", () => {
    const db = tempDb();
    const search = findOrCreateSearch(db, "academias", "Recife-PE");
    const a = addLead(db, search.id);
    const b = addLead(db, search.id);

    expect(updateLeadTags(db, [a, b, 999_999], ["Quente", "academia"], [])).toEqual({ updated: 2 });
    expect(tagsOf(db, a)).toEqual(["academia", "Quente"]);
    expect(events(db, a, "tags_added")).toEqual([{ tags: ["Quente", "academia"] }]);

    // Same tags again (different case): nothing changes, no new events.
    expect(updateLeadTags(db, [a, b], ["QUENTE"], [])).toEqual({ updated: 0 });
    expect(events(db, a, "tags_added")).toHaveLength(1);

    // Remove by slug-equivalent spelling; unknown tag ignored.
    expect(updateLeadTags(db, [a], [], ["quente", "inexistente"])).toEqual({ updated: 1 });
    expect(tagsOf(db, a)).toEqual(["academia"]);
    expect(tagsOf(db, b)).toEqual(["academia", "Quente"]);
    expect(events(db, a, "tags_removed")).toEqual([{ tags: ["Quente"] }]);

    expect(listTags(db).map((t) => [t.name, t.lead_count])).toEqual([
      ["academia", 2],
      ["Quente", 1],
    ]);
  });

  test("listLeads: tags per lead and any/all filter", () => {
    const db = tempDb();
    const search = findOrCreateSearch(db, "academias", "Recife-PE");
    const a = addLead(db, search.id);
    const b = addLead(db, search.id);
    const c = addLead(db, search.id);
    updateLeadTags(db, [a, b], ["Academia"], []);
    updateLeadTags(db, [b, c], ["Quente"], []);

    const all = listLeads(db, {});
    expect(all.leads.map((l) => [l.id, l.tags])).toEqual([
      [a, ["Academia"]],
      [b, ["Academia", "Quente"]],
      [c, ["Quente"]],
    ]);

    const ids = (tags: string[], mode?: "any" | "all") => listLeads(db, { tags, tags_mode: mode }).leads.map((l) => l.id);
    expect(ids(["ACADÊMIA"])).toEqual([a, b]); // accent/case-insensitive
    expect(ids(["academia", "quente"])).toEqual([a, b, c]);
    expect(ids(["academia", "quente"], "all")).toEqual([b]);
    expect(ids(["academia", "nao-existe"], "all")).toEqual([]);
    expect(ids(["nao-existe"])).toEqual([]);
    expect(listLeads(db, { tags: ["academia", "quente"], tags_mode: "all" }).total).toBe(1);
  });

  test("deleting leads removes their lead_tags (deleteLeads and raw DELETE via cascade)", () => {
    const db = tempDb();
    const search = findOrCreateSearch(db, "academias", "Recife-PE");
    const a = addLead(db, search.id);
    const b = addLead(db, search.id);
    updateLeadTags(db, [a, b], ["Academia"], []);

    expect(deleteLeads(db, [a])).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM lead_tags WHERE lead_id = ?").get(a)).toEqual({ n: 0 });

    db.query("DELETE FROM lead_events WHERE lead_id = ?").run(b);
    db.query("DELETE FROM leads WHERE id = ?").run(b);
    expect(db.query("SELECT COUNT(*) AS n FROM lead_tags").get()).toEqual({ n: 0 });
    expect(listTags(db)[0]!.lead_count).toBe(0);
  });
});

describe("search tags inheritance", () => {
  test("existing leads get newly added search tags; new leads inherit at insert; removal keeps lead tags", () => {
    const db = tempDb();
    const search = findOrCreateSearch(db, "academias", "Recife-PE");
    const other = findOrCreateSearch(db, "padarias", "Recife-PE");
    const old = addLead(db, search.id);
    const unrelated = addLead(db, other.id);

    expect(setSearchTags(db, search.id, ["Academia", "Recife"])).toEqual(["Academia", "Recife"]);
    expect(tagsOf(db, old)).toEqual(["Academia", "Recife"]);
    expect(tagsOf(db, unrelated)).toEqual([]);
    expect(events(db, old, "tags_added")).toEqual([{ tags: ["Academia", "Recife"], via: "search", search_id: search.id }]);

    const fresh = addLead(db, search.id);
    expect(tagsOf(db, fresh)).toEqual(["Academia", "Recife"]);
    expect(events(db, fresh, "tags_added")).toEqual([{ tags: ["Academia", "Recife"], via: "search", search_id: search.id }]);

    // Replace: "Recife" leaves the search but stays on its leads; "Quente" is new → applied.
    expect(setSearchTags(db, search.id, ["academia", "Quente"])).toEqual(["Academia", "Quente"]);
    expect(tagsOf(db, old)).toEqual(["Academia", "Quente", "Recife"]);
    expect(events(db, old, "tags_added")).toHaveLength(2);
    expect(events(db, old, "tags_added")[1]).toEqual({ tags: ["Quente"], via: "search", search_id: search.id });

    const later = addLead(db, search.id);
    expect(tagsOf(db, later)).toEqual(["Academia", "Quente"]);
  });
});

describe("migration", () => {
  test("a v5 database (with data) migrates to v6 without losing rows", () => {
    const path = join(tempDir(), "old.db");
    const old = openDb(path);
    const search = findOrCreateSearch(old, "academias", "Recife-PE");
    addLead(old, search.id, "Academia Antiga");
    // Roll the schema back to v5 (before tags existed).
    old.exec("DROP TABLE lead_tags; DROP TABLE search_tags; DROP TABLE tags; PRAGMA user_version = 5;");
    old.close();

    const db = openDb(path);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
    const page = listLeads(db, {});
    expect(page.leads.map((l) => [l.name, l.tags])).toEqual([["Academia Antiga", []]]);
    updateLeadTags(db, [page.leads[0]!.id], ["Nova"], []);
    expect(listTags(db).map((t) => t.name)).toEqual(["Nova"]);
    db.close();
    // Re-opening is a no-op.
    const again = openDb(path);
    expect(listTags(again)).toHaveLength(1);
    again.close();
  });
});

describe("HTTP", () => {
  test("POST /api/leads/tags + GET /api/tags + GET /api/leads filters + GET /api/leads/:id", async () => {
    const { db, base } = start();
    const search = findOrCreateSearch(db, "academias", "Recife-PE");
    const a = addLead(db, search.id);
    const b = addLead(db, search.id);

    expect((await call(base, "POST", "/api/leads/tags", { lead_ids: [], add: ["x"] })).status).toBe(400);
    expect((await call(base, "POST", "/api/leads/tags", { lead_ids: [a] })).status).toBe(400);
    expect((await call(base, "POST", "/api/leads/tags", { lead_ids: [a], add: ["x".repeat(41)] })).status).toBe(400);
    expect((await call(base, "POST", "/api/leads/tags", { lead_ids: ["1"], add: ["x"] })).status).toBe(400);
    // No upper limit on how many leads can be tagged at once.
    expect((await call(base, "POST", "/api/leads/tags", { lead_ids: Array.from({ length: 5001 }, (_, i) => i + 1), remove: ["nao-existe"] })).status).toBe(200);

    const added = await call(base, "POST", "/api/leads/tags", { lead_ids: [a, b, a], add: ["Academia", "Quente"] });
    expect(added.status).toBe(200);
    expect(added.json.updated).toBe(2);
    expect(added.json.tags.map((t: any) => [t.name, t.lead_count])).toEqual([
      ["Academia", 2],
      ["Quente", 2],
    ]);

    const removed = await call(base, "POST", "/api/leads/tags", { lead_ids: [b], remove: ["quente"] });
    expect(removed.json.updated).toBe(1);

    const tags = await call(base, "GET", "/api/tags");
    expect(tags.json.tags.map((t: any) => [t.name, t.slug, t.lead_count])).toEqual([
      ["Academia", "academia", 2],
      ["Quente", "quente", 1],
    ]);

    const any = await call(base, "GET", "/api/leads?tags=quente,academia");
    expect(any.json.total).toBe(2);
    const all = await call(base, "GET", "/api/leads?tags=quente,academia&tags_mode=all");
    expect(all.json.leads.map((l: any) => [l.id, l.tags])).toEqual([[a, ["Academia", "Quente"]]]);
    expect((await call(base, "GET", "/api/leads?tags_mode=some")).status).toBe(400);

    const one = await call(base, "GET", `/api/leads/${b}`);
    expect(one.json.lead.tags).toEqual(["Academia"]);
  });

  test("search tags via POST /api/searches, PUT /api/searches/:id/tags and /more", async () => {
    const { db, base } = start(fakeFetcher(30));

    expect((await call(base, "POST", "/api/searches", { niche: "academias", city: "Recife-PE", count: 5, tags: "x" })).status).toBe(400);

    const started = await call(base, "POST", "/api/searches", { niche: "academias", city: "Recife-PE", count: 10, tags: ["Academia"] });
    expect(started.status).toBe(202);
    await waitForJob(base, started.json.job_id);
    const id = started.json.search_id;
    let leads = (await call(base, "GET", `/api/leads?search_id=${id}`)).json.leads as any[];
    expect(leads).toHaveLength(10);
    expect(leads.every((l) => l.tags.join() === "Academia")).toBe(true);

    // Editing applies new tags to the 10 existing leads.
    const put = await call(base, "PUT", `/api/searches/${id}/tags`, { tags: ["Academia", "Recife"] });
    expect(put.status).toBe(200);
    expect(put.json.search).toMatchObject({ id, tags: ["Academia", "Recife"], lead_count: 10 });
    expect((await call(base, "PUT", "/api/searches/9999/tags", { tags: [] })).status).toBe(404);
    expect((await call(base, "PUT", `/api/searches/${id}/tags`, { tags: [1] })).status).toBe(400);

    // "Buscar mais" with an extra tag: new leads get all three; old ones get "Lote 2" too.
    const more = await call(base, "POST", `/api/searches/${id}/more`, { count: 10, tags: ["Lote 2"] });
    expect(more.status).toBe(202);
    await waitForJob(base, more.json.job_id);
    leads = (await call(base, "GET", `/api/leads?search_id=${id}`)).json.leads as any[];
    expect(leads).toHaveLength(20);
    expect(new Set(leads.map((l) => l.tags.join("|")))).toEqual(new Set(["Academia|Lote 2|Recife"]));

    const searches = (await call(base, "GET", "/api/searches")).json.searches as any[];
    expect(searches.find((s) => s.id === id).tags).toEqual(["Academia", "Lote 2", "Recife"]);

    // Removing a tag from the search keeps it on the leads.
    await call(base, "PUT", `/api/searches/${id}/tags`, { tags: ["Academia"] });
    leads = (await call(base, "GET", `/api/leads?search_id=${id}&tags=recife`)).json.leads as any[];
    expect(leads).toHaveLength(20);
    expect(db.query("SELECT COUNT(*) AS n FROM search_tags").get()).toEqual({ n: 1 });
  });

  test("POST /api/prospect accepts tags", async () => {
    const { base } = start(fakeFetcher(30));
    expect((await call(base, "POST", "/api/prospect", { text: "Busque os 3 principais dentistas de Recife-PE", tags: [""] })).status).toBe(400);
    const started = await call(base, "POST", "/api/prospect", { text: "Busque os 3 principais dentistas de Recife-PE", tags: ["Saúde"] });
    expect(started.status).toBe(202);
    await waitForJob(base, started.json.job_id);
    const leads = (await call(base, "GET", "/api/leads?tags=saude")).json.leads as any[];
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.length).toBe((await call(base, "GET", "/api/leads")).json.total);
    expect(leads[0].tags).toEqual(["Saúde"]);
  });
});

describe("AI tools", () => {
  const options = { toolCallId: "c", messages: [], abortSignal: new AbortController().signal } as never;
  const deps = (db: Database) => ({
    db,
    providerKind: "openai",
    getSerperKey: async () => "k-123456",
    sendToLead: async () => ({ ok: false as const, code: "no_instance" as const, reason: "x" }),
    addCredits: () => {},
    prospectFetcher: fakeFetcher(10),
    skipEnrichment: true,
  });

  test("query_leads filters by tags (any) and returns tags per lead", async () => {
    const db = tempDb();
    const search = findOrCreateSearch(db, "academias", "Recife-PE");
    const a = addLead(db, search.id);
    const b = addLead(db, search.id);
    addLead(db, search.id);
    updateLeadTags(db, [a], ["Academia"], []);
    updateLeadTags(db, [b], ["Quente"], []);
    const tools = createTools(deps(db));
    const result = (await tools.query_leads.execute!({ tags: ["ACADEMIA", "quente"], limit: 20 }, options)) as any;
    expect(result.total).toBe(2);
    expect(result.leads.map((l: any) => [l.id, l.tags])).toEqual([
      [a, ["Academia"]],
      [b, ["Quente"]],
    ]);
    const lead = (await tools.get_lead.execute!({ lead_id: a }, options)) as any;
    expect(lead.lead.tags).toEqual(["Academia"]);
  });

  test("start_prospect_search applies tags; approval shows them", async () => {
    const db = tempDb();
    const tools = createTools(deps(db));
    const result = (await tools.start_prospect_search.execute!({ niche: "padarias", city: "Recife-PE", count: 3, tags: ["Padaria"] }, options)) as any;
    expect(result.collected_new).toBeGreaterThan(0);
    expect(listLeads(db, { tags: ["padaria"] }).total).toBe(result.collected_new);
    const approval = describeApproval(db, "start_prospect_search", { niche: "padarias", city: "Recife-PE", count: 3, tags: ["Padaria", "Quente"] });
    expect(approval.params).toContainEqual({ label: "Tags", value: "Padaria, Quente" });
    const plain = describeApproval(db, "start_prospect_search", { niche: "padarias", city: "Recife-PE", count: 3 });
    expect(plain.params.some((p) => p.label === "Tags")).toBe(false);
  });
});
