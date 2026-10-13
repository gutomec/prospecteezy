import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import {
  findOrCreateSearch,
  getMostRecentSearch,
  insertLeadIfNew,
  listLeads,
  touchSearch,
  type LeadInput,
} from "../src/db/repository.ts";

function lead(searchId: number, ids: { place_id: string | null; cid: string | null }): LeadInput {
  return {
    search_id: searchId,
    ...ids,
    position: 1,
    name: "Lugar",
    category: null,
    address: null,
    latitude: null,
    longitude: null,
    phone: null,
    website: null,
    rating: null,
    rating_count: null,
    source: "serper:places",
  };
}

describe("dedup by place_id OR cid", () => {
  test("same place first seen with only cid, later with place_id + cid → no duplicate, place_id backfilled", () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "padarias", "Recife");
    expect(insertLeadIfNew(db, lead(search.id, { place_id: null, cid: "cid-1" }))).toBe(true);
    expect(insertLeadIfNew(db, lead(search.id, { place_id: "place-1", cid: "cid-1" }))).toBe(false);
    const rows = db.query("SELECT place_id, cid FROM leads").all();
    expect(rows).toEqual([{ place_id: "place-1", cid: "cid-1" }]);
    // and now the place_id alone also dedups
    expect(insertLeadIfNew(db, lead(search.id, { place_id: "place-1", cid: null }))).toBe(false);
  });

  test("lead without any identity is refused", () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "padarias", "Recife");
    expect(insertLeadIfNew(db, lead(search.id, { place_id: null, cid: null }))).toBe(false);
  });
});

describe("most recent search = last used", () => {
  test("ordering follows last_used_at, falling back to id", () => {
    const db = openDb(":memory:");
    const a = findOrCreateSearch(db, "padarias", "Recife");
    const b = findOrCreateSearch(db, "clínicas", "Natal");
    expect(getMostRecentSearch(db)!.id).toBe(b.id); // nothing used yet → newest id
    touchSearch(db, a.id);
    expect(getMostRecentSearch(db)!.id).toBe(a.id);
  });
});

describe("migration v2 (searches.last_used_at)", () => {
  test("additive on an existing v1 database, idempotent on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "prospecteezy-mig-"));
    const path = join(dir, "v1.db");
    try {
      // Build a v1 database (current schema minus the new column) with data.
      const legacy = openDb(path);
      legacy.exec("PRAGMA user_version = 1");
      legacy.exec("ALTER TABLE searches DROP COLUMN last_used_at");
      findOrCreateSearch(legacy, "padarias", "Recife");
      legacy.close();

      const migrated = openDb(path);
      const cols = (migrated.query("PRAGMA table_info(searches)").all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).toContain("last_used_at");
      expect(migrated.query("SELECT niche FROM searches").all()).toEqual([{ niche: "padarias" }]);
      migrated.close();

      // Column already present but version behind (e.g. interrupted run): no
      // error. Re-runs v2 and the additive v3+ (AI layer, exhausted_at) up to the latest version.
      const raw = new Database(path);
      raw.exec("PRAGMA user_version = 1");
      raw.close();
      const again = openDb(path);
      expect((again.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listLeads robustness", () => {
  test("unknown sort column (e.g. city) is ignored instead of failing", () => {
    const db = openDb(":memory:");
    expect(() => listLeads(db, { sort: "city" })).not.toThrow();
    expect(() => listLeads(db, { sort: "city:desc" })).not.toThrow();
  });
});
