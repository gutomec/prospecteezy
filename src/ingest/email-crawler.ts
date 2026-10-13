import type { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { markEnriched, type LeadRow } from "../db/repository.ts";

export const SOURCE_CRAWLER = "crawler:website";
export const CRAWLER_USER_AGENT =
  "prospecteezy/0.1 (coletor de dados públicos de contato; operado localmente)";
const ROBOTS_AGENT_TOKEN = "prospecteezy";

const CONTACT_PATHS = ["/contato", "/contact", "/fale-conosco"];
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGES_PER_SITE = 3; // home + at most 2 contact pages
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// obvious junk that matches the e-mail pattern but is not an address
const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|tiff?|css|js|woff2?|ttf|eot)$/i;
const JUNK_EMAIL_DOMAINS = [
  "sentry.io",
  "wixpress.com",
  "sentry-next.wixpress.com",
  "example.com",
  "example.org",
  "example.net",
  "domain.com",
  "email.com",
  "seudominio.com.br",
];
const VALID_EMAIL =
  /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Resolves a hostname to its IP addresses. Injectable for tests. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export const defaultResolveHost: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // malformed escape (e.g. "contato%@x.com"): validated below
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  commat: "@",
  period: ".",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (m, hex: string) => codePoint(parseInt(hex, 16), m))
    .replace(/&#(\d{1,7});?/g, (m, dec: string) => codePoint(parseInt(dec, 10), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\\u0040|\\x40/gi, "@");
}

function codePoint(value: number, fallback: string): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

/** "contato [at] x [dot] com", "contato arroba x.com" → "contato@x.com". */
function normalizeObfuscation(text: string): string {
  return text
    .replace(/\s*[[(]\s*(?:at|arroba)\s*[\])]\s*/gi, "@")
    .replace(/\s+arroba\s+/gi, "@")
    .replace(/\s*[[(]\s*(?:dot|ponto)\s*[\])]\s*/gi, ".");
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

function isJunkDomain(domain: string): boolean {
  return JUNK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function acceptEmail(candidate: string, found: Set<string>): void {
  const email = candidate.trim().toLowerCase();
  if (!VALID_EMAIL.test(email)) return;
  if (JUNK_EMAIL.test(email) || isJunkDomain(emailDomain(email))) return;
  found.add(email);
}

export function extractEmails(html: string): string[] {
  const cleaned = decodeEntities(
    html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[\s\S]*?<\/style\s*>/gi, " "),
  );
  const found = new Set<string>();
  for (const match of cleaned.matchAll(/mailto:([^"'?\s<>]+)/gi)) {
    for (const part of safeDecodeURIComponent(match[1]!).split(/[,;]/)) {
      acceptEmail(part, found);
    }
  }
  const text = normalizeObfuscation(cleaned);
  // Starts at a token boundary (not mid "%20nome@"); bounded quantifiers
  // avoid quadratic backtracking on long character runs.
  const textPattern = /(?<![a-z0-9._+%-])[a-z0-9._+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
  for (const match of text.matchAll(textPattern)) {
    acceptEmail(match[0]!.replace(/^\.+/, ""), found);
  }
  return [...found];
}

/** True when the e-mail is on the website's domain (or a sub/parent domain). */
function isOwnDomainEmail(email: string, website: string): boolean {
  let host: string;
  try {
    host = new URL(website).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  const domain = emailDomain(email);
  return domain === host || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
}

/** First e-mail on the site's own domain, else the first one found. */
export function pickPrimaryEmail(emails: string[], website: string): string | null {
  return emails.find((email) => isOwnDomainEmail(email, website)) ?? emails[0] ?? null;
}

export function extractSocialLinks(html: string): Record<string, string> {
  const socials: Record<string, string> = {};
  const instagram = html.match(
    /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]{2,}/i,
  );
  if (instagram) socials.instagram = instagram[0];
  const linkedin = html.match(
    /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9\-_.%]+/i,
  );
  if (linkedin) socials.linkedin = linkedin[0];
  return socials;
}

/**
 * Disallow path rules that apply to us: groups naming our token exactly win
 * over "*" groups. Consecutive User-agent lines form one group.
 */
export function parseRobotsDisallow(robotsTxt: string): string[] {
  const ours: string[] = [];
  const wildcard: string[] = [];
  let hasOwnGroup = false;
  let groupAgents: string[] = [];
  let inRules = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (inRules) {
        groupAgents = [];
        inRules = false;
      }
      const agent = value.toLowerCase();
      groupAgents.push(agent);
      if (agent === ROBOTS_AGENT_TOKEN) hasOwnGroup = true;
    } else if (field === "disallow" || field === "allow") {
      inRules = true;
      if (field !== "disallow" || !value) continue;
      if (groupAgents.includes(ROBOTS_AGENT_TOKEN)) ours.push(value);
      if (groupAgents.includes("*")) wildcard.push(value);
    }
  }
  return hasOwnGroup ? ours : wildcard;
}

function ruleMatches(rule: string, path: string): boolean {
  if (!rule.includes("*") && !rule.endsWith("$")) return path.startsWith(rule);
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

export function isPathDisallowed(rules: string[], path: string): boolean {
  return rules.some((rule) => ruleMatches(rule, path));
}

/** True when robots.txt forbids the whole site (the root path) to us. */
export function isCrawlForbidden(robotsTxt: string): boolean {
  return isPathDisallowed(parseRobotsDisallow(robotsTxt), "/");
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

function inV4Range(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((ipv4ToInt(base)! & mask) >>> 0);
}

function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return (
    inV4Range(value, "0.0.0.0", 8) ||
    inV4Range(value, "10.0.0.0", 8) ||
    inV4Range(value, "100.64.0.0", 10) ||
    inV4Range(value, "127.0.0.0", 8) ||
    inV4Range(value, "169.254.0.0", 16) ||
    inV4Range(value, "172.16.0.0", 12) ||
    inV4Range(value, "192.168.0.0", 16) ||
    inV4Range(value, "224.0.0.0", 3) // multicast, reserved, broadcast
  );
}

/** Expands an IPv6 literal to 8 hextets (embedded IPv4 tail supported). */
function ipv6Hextets(ip: string): number[] | null {
  let address = ip.toLowerCase().split("%")[0]!;
  const v4Tail = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const v4 = ipv4ToInt(v4Tail[1]!);
    if (v4 === null) return null;
    address =
      address.slice(0, -v4Tail[1]!.length) +
      `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const hextets = all.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return hextets.some(Number.isNaN) ? null : hextets;
}

function isBlockedIpv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const allZeroPrefix = h.slice(0, 5).every((x) => x === 0);
  if (allZeroPrefix && h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
  if (allZeroPrefix && (h[5] === 0xffff || h[5] === 0)) {
    // IPv4-mapped / IPv4-compatible: judge the embedded IPv4
    return isBlockedIpv4(`${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`);
  }
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for loopback, private, link-local, CGNAT, unspecified and similar ranges. */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

/** Lead websites are untrusted: only public http(s) hosts may be fetched. */
export async function isUrlAllowed(url: URL, resolveHost: HostResolver): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return false;
  if (isIP(hostname)) return !isBlockedAddress(hostname);
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every((address) => !isBlockedAddress(address));
}

async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BODY_BYTES - total;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    total += Math.min(value.byteLength, room);
    if (total >= MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export interface CrawlerDeps {
  fetchImpl?: typeof fetch;
  resolveHost?: HostResolver;
}

async function fetchText(url: string, deps: Required<CrawlerDeps>): Promise<string | null> {
  try {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!(await isUrlAllowed(current, deps.resolveHost))) return null;
      const response = await deps.fetchImpl(current.href, {
        headers: { "User-Agent": CRAWLER_USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!location) return null;
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) return null;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !contentType.includes("text/")) return null;
      return await readCapped(response);
    }
    return null; // too many redirects
  } catch {
    return null;
  }
}

export interface EnrichmentResult {
  email: string | null;
  socials: Record<string, string>;
  pagesVisited: number;
  skippedByRobots: boolean;
}

function resolveDeps(deps: typeof fetch | CrawlerDeps | undefined): Required<CrawlerDeps> {
  const options = typeof deps === "function" ? { fetchImpl: deps } : (deps ?? {});
  return {
    fetchImpl: options.fetchImpl ?? fetch,
    resolveHost: options.resolveHost ?? defaultResolveHost,
  };
}

/**
 * Visits the lead's website (home + likely contact pages), extracting
 * e-mails (mailto + text patterns) and instagram/linkedin links.
 * Skips the site entirely when robots.txt forbids crawling, and skips any
 * single page whose path robots.txt disallows.
 */
export async function crawlWebsite(
  website: string,
  crawlerDeps?: typeof fetch | CrawlerDeps,
): Promise<EnrichmentResult> {
  const deps = resolveDeps(crawlerDeps);
  const result: EnrichmentResult = {
    email: null,
    socials: {},
    pagesVisited: 0,
    skippedByRobots: false,
  };

  let origin: string;
  try {
    const parsed = new URL(website);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return result;
    origin = parsed.origin;
  } catch {
    return result;
  }

  const robots = await fetchText(`${origin}/robots.txt`, deps);
  const disallow = robots ? parseRobotsDisallow(robots) : [];
  if (isPathDisallowed(disallow, "/")) {
    result.skippedByRobots = true;
    return result;
  }

  const emails: string[] = [];
  const urls = [website, ...CONTACT_PATHS.map((p) => origin + p)];
  for (const url of urls) {
    if (result.pagesVisited >= MAX_PAGES_PER_SITE) break;
    const target = new URL(url);
    if (isPathDisallowed(disallow, target.pathname + target.search)) continue;
    const html = await fetchText(url, deps);
    if (html === null) continue;
    result.pagesVisited += 1;

    for (const email of extractEmails(html)) {
      if (!emails.includes(email)) emails.push(email);
    }
    result.email = pickPrimaryEmail(emails, website);
    result.socials = { ...extractSocialLinks(html), ...result.socials };

    const ownDomain = result.email !== null && isOwnDomainEmail(result.email, website);
    if (ownDomain && Object.keys(result.socials).length >= 2) break;
  }
  return result;
}

/**
 * Enriches one lead in place: crawls its website and persists e-mail,
 * socials and enriched_at (always set after an attempt, even when empty,
 * so the lead is not re-crawled forever).
 */
export async function enrichLead(
  db: Database,
  lead: LeadRow,
  crawlerDeps?: typeof fetch | CrawlerDeps,
): Promise<EnrichmentResult> {
  if (!lead.website) {
    return { email: null, socials: {}, pagesVisited: 0, skippedByRobots: false };
  }
  const result = await crawlWebsite(lead.website, crawlerDeps);
  markEnriched(db, lead.id, result.email, result.socials);
  return result;
}
