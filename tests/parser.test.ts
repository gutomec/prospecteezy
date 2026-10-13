import { describe, expect, test } from "bun:test";
import { parseProspectRequest } from "../src/agent/parser.ts";

describe("PT-BR prospect request parser", () => {
  test("canonical request: niche, city (with UF) and count", () => {
    const parsed = parseProspectRequest(
      "Busque os 100 principais escritórios de advocacia de São Paulo-SP",
    );
    expect(parsed).toEqual({
      kind: "new",
      niche: "escritórios de advocacia",
      city: "São Paulo-SP",
      count: 100,
    });
  });

  test('"top N X em Y" variant', () => {
    const parsed = parseProspectRequest("top 50 clínicas de estética em Fortaleza");
    expect(parsed).toEqual({
      kind: "new",
      niche: "clínicas de estética",
      city: "Fortaleza",
      count: 50,
    });
  });

  test("other verbs and qualifiers", () => {
    const parsed = parseProspectRequest(
      "Traga os 20 melhores restaurantes japoneses em Curitiba-PR",
    );
    expect(parsed).toEqual({
      kind: "new",
      niche: "restaurantes japoneses",
      city: "Curitiba-PR",
      count: 20,
    });
  });

  test('continuation: "mais 100"', () => {
    expect(parseProspectRequest("mais 100")).toEqual({ kind: "more", count: 100 });
  });

  test('continuation: "+30 da mesma pesquisa"', () => {
    expect(parseProspectRequest("+30 da mesma pesquisa")).toEqual({
      kind: "more",
      count: 30,
    });
  });

  test('"mais N <niche> de <city>" is a full request (cursor makes it additive)', () => {
    const parsed = parseProspectRequest(
      "mais 100 escritórios de advocacia de São Paulo-SP",
    );
    expect(parsed).toEqual({
      kind: "new",
      niche: "escritórios de advocacia",
      city: "São Paulo-SP",
      count: 100,
    });
  });

  test("missing count falls back to the default", () => {
    const parsed = parseProspectRequest("Busque escritórios de advocacia em Recife");
    expect(parsed).toMatchObject({ kind: "new", count: 20, city: "Recife" });
  });

  test("accents are preserved in niche and city", () => {
    const parsed = parseProspectRequest("Busque 10 farmácias de manipulação em São Luís-MA");
    expect(parsed).toMatchObject({
      niche: "farmácias de manipulação",
      city: "São Luís-MA",
    });
  });

  test("unintelligible request returns a clear PT-BR message", () => {
    const parsed = parseProspectRequest("olá, tudo bem?");
    expect(parsed.kind).toBe("unknown");
    if (parsed.kind === "unknown") {
      expect(parsed.message).toContain("Não entendi");
    }
  });

  test("empty request", () => {
    expect(parseProspectRequest("   ").kind).toBe("unknown");
  });

  test("a number inside the niche is not the count", () => {
    expect(parseProspectRequest("Busque academias 24 horas em Recife")).toEqual({
      kind: "new",
      niche: "academias 24 horas",
      city: "Recife",
      count: 20,
    });
    expect(parseProspectRequest("Busque os 30 melhores academias 24 horas em Recife")).toEqual({
      kind: "new",
      niche: "academias 24 horas",
      city: "Recife",
      count: 30,
    });
  });

  test('" no " / " na " / " nos " / " nas " are city separators', () => {
    expect(parseProspectRequest("top 10 restaurantes no Rio de Janeiro")).toMatchObject({
      niche: "restaurantes",
      city: "Rio de Janeiro",
      count: 10,
    });
    expect(parseProspectRequest("Busque 15 padarias na Bahia")).toMatchObject({
      niche: "padarias",
      city: "Bahia",
    });
    expect(parseProspectRequest("Busque clínicas nos Jardins")).toMatchObject({ city: "Jardins" });
    expect(parseProspectRequest("Busque lojas nas Perdizes")).toMatchObject({ city: "Perdizes" });
  });

  test('a trailing " com ..." clause is stripped from the city', () => {
    expect(
      parseProspectRequest("Traga os 20 melhores restaurantes japoneses em Curitiba-PR com e-mail"),
    ).toEqual({
      kind: "new",
      niche: "restaurantes japoneses",
      city: "Curitiba-PR",
      count: 20,
    });
  });

  test("qualifier words only match whole words", () => {
    expect(parseProspectRequest("Busque assessorias contábeis em Natal")).toMatchObject({
      niche: "assessorias contábeis",
    });
    expect(parseProspectRequest("Busque ostras em Florianópolis")).toMatchObject({
      niche: "ostras",
    });
  });

  test('"mais N" needs at least 1 and has no upper limit', () => {
    expect(parseProspectRequest("mais 0").kind).toBe("unknown");
    expect(parseProspectRequest("+9999")).toEqual({ kind: "more", count: 9999 });
    expect(parseProspectRequest("Busque 20000 dentistas em Curitiba-PR")).toMatchObject({ kind: "new", count: 20000 });
  });
});
