import { describe, expect, test } from "bun:test";
import { openDb } from "../src/db/index.ts";
import { findOrCreateSearch, getLead, insertLeadIfNew } from "../src/db/repository.ts";
import {
  crawlWebsite,
  enrichLead,
  extractEmails,
  extractSocialLinks,
  isCrawlForbidden,
} from "../src/ingest/email-crawler.ts";

const CONTACT_HTML = `
<html><body>
  <a href="mailto:contato@escritorio.com.br?subject=Oi">Fale conosco</a>
  <p>Ou escreva para comercial@escritorio.com.br.</p>
  <img src="logo@2x.png">
  <a href="https://www.instagram.com/escritorio.adv">Instagram</a>
  <a href="https://br.linkedin.com/company/escritorio-adv">LinkedIn</a>
</body></html>`;

describe("e-mail extraction", () => {
  test("extracts mailto and text-pattern e-mails, ignoring image junk", () => {
    const emails = extractEmails(CONTACT_HTML);
    expect(emails).toContain("contato@escritorio.com.br");
    expect(emails).toContain("comercial@escritorio.com.br");
    expect(emails.some((e) => e.includes("logo@2x"))).toBe(false);
  });

  test("extracts instagram and linkedin links", () => {
    const socials = extractSocialLinks(CONTACT_HTML);
    expect(socials.instagram).toBe("https://www.instagram.com/escritorio.adv");
    expect(socials.linkedin).toBe("https://br.linkedin.com/company/escritorio-adv");
  });
});

describe("robots.txt", () => {
  test("Disallow: / for all agents forbids crawling", () => {
    expect(isCrawlForbidden("User-agent: *\nDisallow: /")).toBe(true);
  });

  test("path-specific disallow does not forbid the site", () => {
    expect(isCrawlForbidden("User-agent: *\nDisallow: /admin")).toBe(false);
  });

  test("disallow scoped to another agent does not apply", () => {
    expect(isCrawlForbidden("User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow:")).toBe(
      false,
    );
  });
});

/** Every hostname resolves to a public address (no real DNS in tests). */
const publicDns = async () => ["93.184.216.34"];

function mockSite(routes: Record<string, string>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const html = routes[path];
    if (html === undefined) return new Response("não encontrado", { status: 404 });
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
}

describe("crawlWebsite", () => {
  test("finds the e-mail on a contact page when the home has none", async () => {
    const site = mockSite({
      "/": "<html><body>Bem-vindo ao escritório</body></html>",
      "/contato": CONTACT_HTML,
    });
    const result = await crawlWebsite("https://escritorio.com.br/", { fetchImpl: site, resolveHost: publicDns });
    expect(result.email).toBe("contato@escritorio.com.br");
    expect(result.socials.instagram).toBeDefined();
  });

  test("respects robots.txt Disallow: /", async () => {
    const site = mockSite({
      "/robots.txt": "User-agent: *\nDisallow: /",
      "/": CONTACT_HTML,
    });
    const result = await crawlWebsite("https://escritorio.com.br/", { fetchImpl: site, resolveHost: publicDns });
    expect(result.skippedByRobots).toBe(true);
    expect(result.email).toBeNull();
    expect(result.pagesVisited).toBe(0);
  });

  test("enrichLead persists e-mail, socials and enriched_at", async () => {
    const db = openDb(":memory:");
    const search = findOrCreateSearch(db, "escritórios de advocacia", "São Paulo-SP");
    insertLeadIfNew(db, {
      search_id: search.id,
      place_id: "place-x",
      cid: "cid-x",
      position: 1,
      name: "Escritório X",
      category: "Advogado",
      address: null,
      latitude: null,
      longitude: null,
      phone: null,
      website: "https://escritorio.com.br/",
      rating: null,
      rating_count: null,
      source: "serper:places",
    });
    const lead = getLead(db, 1)!;

    const site = mockSite({ "/": CONTACT_HTML });
    await enrichLead(db, lead, { fetchImpl: site, resolveHost: publicDns });

    const updated = getLead(db, lead.id)!;
    expect(updated.email).toBe("contato@escritorio.com.br");
    expect(updated.enriched_at).not.toBeNull();
    expect(JSON.parse(updated.socials_json!)).toMatchObject({
      instagram: "https://www.instagram.com/escritorio.adv",
    });

    const events = db
      .query("SELECT event FROM lead_events WHERE lead_id = ? ORDER BY id")
      .all(lead.id) as { event: string }[];
    expect(events.map((e) => e.event)).toEqual(["collected", "enriched"]);
  });
});
