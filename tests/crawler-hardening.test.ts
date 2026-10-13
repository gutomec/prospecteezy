import { describe, expect, test } from "bun:test";
import {
  crawlWebsite,
  extractEmails,
  isBlockedAddress,
  isCrawlForbidden,
  isPathDisallowed,
  isUrlAllowed,
  parseRobotsDisallow,
  pickPrimaryEmail,
} from "../src/ingest/email-crawler.ts";

const publicDns = async () => ["93.184.216.34"];

type Route = string | Response | (() => Response);

/** Records every requested URL; unknown paths return 404. */
function mockSite(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const parsed = new URL(url);
    const route = routes[parsed.host + parsed.pathname] ?? routes[parsed.pathname];
    if (route === undefined) return new Response("não encontrado", { status: 404 });
    if (typeof route === "function") return route();
    if (route instanceof Response) return route;
    return new Response(route, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

describe("e-mail extraction hardening", () => {
  test("malformed mailto escape does not throw and yields no junk", () => {
    const html = `<a href="mailto:contato%@x.com">x</a> <a href="mailto:ok@x.com.br">y</a>`;
    expect(() => extractEmails(html)).not.toThrow();
    expect(extractEmails(html)).toEqual(["ok@x.com.br"]);
  });

  test("ignores addresses inside <script> and <style>", () => {
    const html = `<script>var a = "dev@tracker-lib.com";</script><style>/* x@cssjunk.com */</style><p>oi@loja.com.br</p>`;
    expect(extractEmails(html)).toEqual(["oi@loja.com.br"]);
  });

  test("decodes HTML entities and obfuscations", () => {
    const html = `<p>vendas&#64;loja.com.br</p><p>sac&commat;loja.com.br</p><p>financeiro [at] loja [dot] com [dot] br</p><p>rh arroba loja.com.br</p><p>ti (at) loja.com.br</p>`;
    expect(extractEmails(html).sort()).toEqual(
      [
        "financeiro@loja.com.br",
        "rh@loja.com.br",
        "sac@loja.com.br",
        "ti@loja.com.br",
        "vendas@loja.com.br",
      ].sort(),
    );
  });

  test("splits multi-address mailto, lowercases and dedups", () => {
    const html = `<a href="mailto:A@Loja.com.br,b@loja.com.br;%20c@loja.com.br?subject=x">x</a> a@loja.com.br`;
    expect(extractEmails(html)).toEqual(["a@loja.com.br", "b@loja.com.br", "c@loja.com.br"]);
  });

  test("drops junk domains and image-like suffixes", () => {
    const html = [
      "abc123@sentry.io",
      "abc@o123.ingest.sentry.io",
      "x@sentry-next.wixpress.com",
      "user@example.com",
      "nome@domain.com",
      "seu@email.com",
      "voce@seudominio.com.br",
      "logo@2x.png",
      "hero@3x.webp",
      "real@empresa.com.br",
    ].join(" ");
    expect(extractEmails(html)).toEqual(["real@empresa.com.br"]);
  });

  test("prefers an address on the lead's own domain", () => {
    const emails = ["parceiro@gmail.com", "contato@escritorio.com.br"];
    expect(pickPrimaryEmail(emails, "https://www.escritorio.com.br/")).toBe(
      "contato@escritorio.com.br",
    );
    expect(pickPrimaryEmail(["a@gmail.com"], "https://escritorio.com.br")).toBe("a@gmail.com");
    expect(pickPrimaryEmail([], "https://escritorio.com.br")).toBeNull();
  });

  test("crawl picks the own-domain e-mail even when found on a later page", async () => {
    const { fetchImpl } = mockSite({
      "/": `<a href="mailto:dev@agencia-web.com">feito por</a>`,
      "/contato": `<p>contato@escritorio.com.br</p>`,
    });
    const result = await crawlWebsite("https://escritorio.com.br/", {
      fetchImpl,
      resolveHost: publicDns,
    });
    expect(result.email).toBe("contato@escritorio.com.br");
  });
});

describe("robots.txt parsing", () => {
  test('"Disallow:/" without space forbids the site', () => {
    expect(isCrawlForbidden("User-agent: *\nDisallow:/")).toBe(true);
  });

  test("consecutive User-agent lines form one group", () => {
    expect(isCrawlForbidden("User-agent: googlebot\nUser-agent: *\nDisallow: /")).toBe(true);
  });

  test("agent tokens match exactly, not by substring", () => {
    // "p" and "prospect" are substrings of "prospecteezy" but are other bots.
    expect(isCrawlForbidden("User-agent: p\nDisallow: /")).toBe(false);
    expect(isCrawlForbidden("User-agent: prospect\nDisallow: /")).toBe(false);
    expect(isCrawlForbidden("User-agent: Prospecteezy\nDisallow: /")).toBe(true);
  });

  test("our own group overrides the * group", () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: prospecteezy\nDisallow: /admin";
    expect(isCrawlForbidden(robots)).toBe(false);
    expect(parseRobotsDisallow(robots)).toEqual(["/admin"]);
  });

  test("path-prefix rules and wildcards", () => {
    const rules = parseRobotsDisallow("User-agent: *\nDisallow: /contato\nDisallow: /*.pdf$");
    expect(isPathDisallowed(rules, "/contato")).toBe(true);
    expect(isPathDisallowed(rules, "/contato/form")).toBe(true);
    expect(isPathDisallowed(rules, "/contact")).toBe(false);
    expect(isPathDisallowed(rules, "/files/a.pdf")).toBe(true);
    expect(isPathDisallowed(rules, "/files/a.pdf?x")).toBe(false);
  });

  test("crawl skips disallowed pages before fetching them", async () => {
    const { fetchImpl, requested } = mockSite({
      "/robots.txt": "User-agent: *\nDisallow: /contato",
      "/": "<p>nada aqui</p>",
      "/contato": "<p>escondido@escritorio.com.br</p>",
      "/contact": "<p>contact@escritorio.com.br</p>",
    });
    const result = await crawlWebsite("https://escritorio.com.br/", {
      fetchImpl,
      resolveHost: publicDns,
    });
    expect(requested.some((u) => u.endsWith("/contato"))).toBe(false);
    expect(result.email).toBe("contact@escritorio.com.br");
  });
});

describe("SSRF guard", () => {
  test("blocks private, loopback, link-local, CGNAT and special addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.10",
      "169.254.169.254",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    for (const ip of ["93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("only http/https, and hostnames resolving to private IPs are rejected", async () => {
    const privateDns = async () => ["10.0.0.5"];
    const mixedDns = async () => ["93.184.216.34", "127.0.0.1"];
    const failingDns = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await isUrlAllowed(new URL("file:///etc/passwd"), publicDns)).toBe(false);
    expect(await isUrlAllowed(new URL("ftp://x.com/"), publicDns)).toBe(false);
    expect(await isUrlAllowed(new URL("http://127.0.0.1:3000/"), publicDns)).toBe(false);
    expect(await isUrlAllowed(new URL("http://[::1]/"), publicDns)).toBe(false);
    expect(await isUrlAllowed(new URL("http://2130706433/"), publicDns)).toBe(false);
    expect(await isUrlAllowed(new URL("http://intranet.corp/"), privateDns)).toBe(false);
    expect(await isUrlAllowed(new URL("http://rebind.example/"), mixedDns)).toBe(false);
    expect(await isUrlAllowed(new URL("http://nao-existe.invalid/"), failingDns)).toBe(false);
    expect(await isUrlAllowed(new URL("https://escritorio.com.br/"), publicDns)).toBe(true);
  });

  test("a lead website pointing at a private address is never fetched", async () => {
    const { fetchImpl, requested } = mockSite({ "/": "<p>a@b.com.br</p>" });
    const result = await crawlWebsite("http://192.168.0.1/", { fetchImpl, resolveHost: publicDns });
    expect(requested).toEqual([]);
    expect(result.email).toBeNull();
  });

  test("redirects are followed manually and each Location is re-checked", async () => {
    const redirect = (location: string) => () =>
      new Response(null, { status: 302, headers: { Location: location } });
    const { fetchImpl, requested } = mockSite({
      "escritorio.com.br/": redirect("https://www.escritorio.com.br/home"),
      "www.escritorio.com.br/home": "<p>contato@escritorio.com.br</p>",
      "escritorio.com.br/contato": redirect("http://169.254.169.254/latest/meta-data/"),
    });
    const result = await crawlWebsite("https://escritorio.com.br/", {
      fetchImpl,
      resolveHost: publicDns,
    });
    expect(result.email).toBe("contato@escritorio.com.br");
    expect(requested.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  test("stops after 3 redirect hops", async () => {
    let hops = 0;
    const loop = () => {
      hops += 1;
      return new Response(null, { status: 301, headers: { Location: `/r${hops}` } });
    };
    const fetchImpl = (async () => loop()) as unknown as typeof fetch;
    const result = await crawlWebsite("https://escritorio.com.br/", {
      fetchImpl,
      resolveHost: publicDns,
    });
    expect(result.pagesVisited).toBe(0);
    // robots.txt + 4 candidate pages, each: 1 request + 3 redirect hops = 4 requests
    expect(hops).toBe(5 * 4);
  });
});

describe("body size cap", () => {
  test("rejects responses declaring more than 2 MB", async () => {
    const { fetchImpl } = mockSite({
      "/": () =>
        new Response("<p>grande@escritorio.com.br</p>", {
          headers: { "Content-Type": "text/html", "Content-Length": String(3 * 1024 * 1024) },
        }),
    });
    const result = await crawlWebsite("https://escritorio.com.br/", {
      fetchImpl,
      resolveHost: publicDns,
    });
    expect(result.pagesVisited).toBe(0);
  });

  test("reads at most 2 MB of an undeclared-length body", async () => {
    const filler = "x".repeat(2 * 1024 * 1024);
    const { fetchImpl } = mockSite({
      "/": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`<p>cedo@escritorio.com.br</p>${filler}`));
              controller.enqueue(encoder.encode("<p>tarde@escritorio.com.br</p>"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/html" } },
        ),
    });
    const result = await crawlWebsite("https://escritorio.com.br/", {
      fetchImpl,
      resolveHost: publicDns,
    });
    expect(result.pagesVisited).toBe(1);
    expect(result.email).toBe("cedo@escritorio.com.br");
  });
});
