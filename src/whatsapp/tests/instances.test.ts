import { describe, expect, test } from "bun:test";
import { openWaDb } from "../db.ts";
import {
  createInstance,
  deleteInstance,
  generateInstanceId,
  getActiveInstance,
  getInstance,
  instanceExists,
  isValidInstanceId,
  listInstances,
  setActiveInstance,
} from "../instances.ts";

describe("instance registry", () => {
  test("generateInstanceId is a valid letter-first slug", () => {
    for (let i = 0; i < 20; i++) expect(isValidInstanceId(generateInstanceId())).toBe(true);
  });

  test("createInstance persists and lists", () => {
    const db = openWaDb(":memory:");
    const a = createInstance(db, { name: "Vendas" });
    expect(a.id).toMatch(/^wa[0-9a-f]{10}$/);
    expect(a.name).toBe("Vendas");
    expect(instanceExists(db, a.id)).toBe(true);
    expect(getInstance(db, a.id)?.name).toBe("Vendas");
    expect(listInstances(db)).toHaveLength(1);
  });

  test("two instances coexist and first is active by default", () => {
    const db = openWaDb(":memory:");
    const a = createInstance(db);
    const b = createInstance(db);
    expect(listInstances(db).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(getActiveInstance(db)).toBe(a.id);
  });

  test("active instance persists across a fresh read (select survives reload)", () => {
    const db = openWaDb(":memory:");
    const a = createInstance(db);
    const b = createInstance(db);
    setActiveInstance(db, b.id);
    // Simulate a reload by reading the persisted key only.
    expect(getActiveInstance(db)).toBe(b.id);
  });

  test("deleteInstance removes the row, its mirror rows and reassigns active", () => {
    const db = openWaDb(":memory:");
    const a = createInstance(db);
    const b = createInstance(db);
    setActiveInstance(db, a.id);
    db.query(
      "INSERT INTO chats (instance_id, jid, is_group, created_at, updated_at) VALUES (?, 'x@s.whatsapp.net', 0, 'now', 'now')",
    ).run(a.id);
    deleteInstance(db, a.id);
    expect(instanceExists(db, a.id)).toBe(false);
    expect((db.query("SELECT count(*) c FROM chats WHERE instance_id = ?").get(a.id) as { c: number }).c).toBe(0);
    expect(getActiveInstance(db)).toBe(b.id); // active reassigned to the survivor
  });

  test("invalid explicit id is rejected", () => {
    const db = openWaDb(":memory:");
    expect(() => createInstance(db, { id: "1nope" })).toThrow();
  });
});
