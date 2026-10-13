import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db/index.ts";
import { createServer } from "../src/server.ts";
import {
  addLeadEvent,
  deleteLeads,
  findOrCreateSearch,
  insertLeadIfNew,
} from "../src/db/repository.ts";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

/** Inserts a lead (creates a "collected" event too) and returns its id. */
function seedLead(db: Database, searchId: number, placeId: string): number {
  insertLeadIfNew(db, {
    search_id: searchId,
    place_id: placeId,
    cid: null,
    position: null,
    name: `Lead ${placeId}`,
    category: null,
    address: null,
    latitude: null,
    longitude: null,
    phone: null,
    website: null,
    rating: null,
    rating_count: null,
    source: "serper:places",
  });
  const row = db.query("SELECT id FROM leads WHERE place_id = ?").get(placeId) as {
    id: number;
  };
  return row.id;
}

function countEvents(db: Database, leadId: number): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM lead_events WHERE lead_id = ?").get(leadId) as {
      n: number;
    }
  ).n;
}

function leadExists(db: Database, id: number): boolean {
  return db.query("SELECT 1 FROM leads WHERE id = ?").get(id) !== null;
}

describe("deleteLeads (repository)", () => {
  test("deletes N leads with their events, leaving the rest intact", () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "advogados", "Recife");
    const a = seedLead(db, search.id, "place-a");
    const b = seedLead(db, search.id, "place-b");
    const c = seedLead(db, search.id, "place-c");
    addLeadEvent(db, a, "enriched", { email: "a@x.com" }); // a now has 2 events

    expect(countEvents(db, a)).toBe(2);
    expect(countEvents(db, b)).toBe(1);

    const deleted = deleteLeads(db, [a, b]);
    expect(deleted).toBe(2);

    expect(leadExists(db, a)).toBe(false);
    expect(leadExists(db, b)).toBe(false);
    expect(leadExists(db, c)).toBe(true); // untouched lead remains

    expect(countEvents(db, a)).toBe(0); // events removed, no orphans
    expect(countEvents(db, b)).toBe(0);
    expect(countEvents(db, c)).toBe(1); // untouched lead keeps its events
  });

  test("empty ids is a no-op returning 0", () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "padarias", "Curitiba");
    seedLead(db, search.id, "place-1");
    expect(deleteLeads(db, [])).toBe(0);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n,
    ).toBe(1);
  });

  test("non-existent ids do not break and are not counted", () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "clínicas", "Fortaleza");
    const existing = seedLead(db, search.id, "place-x");

    expect(deleteLeads(db, [999999])).toBe(0); // pure miss
    expect(deleteLeads(db, [existing, 999999])).toBe(1); // counts only the real one
    expect(leadExists(db, existing)).toBe(false);
  });
});

function startTestServer() {
  const { server, db } = createServer({
    db: openDb(":memory:"),
    port: 0,
    skipEnrichment: true,
  });
  stop = () => server.stop(true);
  return { db, base: `http://localhost:${server.port}` };
}

describe("DELETE /api/leads", () => {
  test("removes the selected leads and returns {deleted}", async () => {
    const { db, base } = startTestServer();
    const search = findOrCreateSearch(db, "restaurantes", "Santos");
    const a = seedLead(db, search.id, "place-a");
    const b = seedLead(db, search.id, "place-b");
    const c = seedLead(db, search.id, "place-c");

    const res = await fetch(`${base}/api/leads`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [a, b] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { deleted: number }).toEqual({ deleted: 2 });

    expect(leadExists(db, a)).toBe(false);
    expect(leadExists(db, c)).toBe(true);
  });

  test("invalid body (not an array) returns 400 in PT-BR", async () => {
    const { base } = startTestServer();
    const res = await fetch(`${base}/api/leads`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: "nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("ids");
  });

  test("non-JSON body returns 400", async () => {
    const { base } = startTestServer();
    const res = await fetch(`${base}/api/leads`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
