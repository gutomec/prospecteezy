import { describe, expect, test } from "bun:test";
import {
  brazilianVariants,
  phoneToUser,
  resolveRecipient,
  type OnWhatsAppSocket,
} from "../resolver.ts";

describe("brazilianVariants", () => {
  test("13-digit mobile also tests the 12-digit form", () => {
    expect(brazilianVariants("5511987654321")).toEqual(["5511987654321", "551187654321"]);
  });

  test("12-digit mobile (subscriber starts 6-9) also tests the 13-digit form", () => {
    expect(brazilianVariants("551187654321")).toEqual(["551187654321", "5511987654321"]);
  });

  test("landline never gains a ninth digit", () => {
    expect(brazilianVariants("551133334444")).toEqual(["551133334444"]);
  });

  test("non-BR number stays as-is", () => {
    expect(brazilianVariants("14155552671")).toEqual(["14155552671"]);
  });
});

describe("phoneToUser", () => {
  test("formatted BR E.164 becomes digits", () => {
    expect(phoneToUser("+55 11 98765-4321")).toBe("5511987654321");
  });

  test("local BR number gains country code", () => {
    expect(phoneToUser("(11) 3333-4444")).toBe("551133334444");
  });

  test("trunk zero before the DDD is dropped", () => {
    expect(phoneToUser("011 98765-4321")).toBe("5511987654321");
  });

  test("garbage is rejected", () => {
    expect(phoneToUser("---")).toBeNull();
    expect(phoneToUser("123")).toBeNull();
  });
});

describe("resolveRecipient — onWhatsApp semantics", () => {
  test("PARTIAL array maps by jid, never by index", async () => {
    // Candidates are [13-digit, 12-digit]; the server answers with a single
    // element that corresponds to the SECOND candidate. Index-matching would
    // wrongly bind it to the first.
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async (...numbers) => {
        expect(numbers).toEqual(["5511987654321", "551187654321"]);
        return [{ jid: "551187654321@s.whatsapp.net", exists: true }];
      },
    };
    const result = await resolveRecipient(sock, "5511987654321@s.whatsapp.net");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jid).toBe("551187654321@s.whatsapp.net");
      expect(result.corrected_from).toBe("5511987654321@s.whatsapp.net");
    }
  });

  test("exists:false entries are ignored (only exists:true counts)", async () => {
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => [
        { jid: "5511987654321@s.whatsapp.net", exists: false },
        { jid: "551187654321@s.whatsapp.net", exists: true },
      ],
    };
    const result = await resolveRecipient(sock, "5511987654321@s.whatsapp.net");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.jid).toBe("551187654321@s.whatsapp.net");
  });

  test("absent from the array means NOT_REGISTERED (empty response)", async () => {
    const sock: OnWhatsAppSocket = { onWhatsApp: async () => [] };
    const result = await resolveRecipient(sock, "551133334444@s.whatsapp.net");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_REGISTERED");
  });

  test("both variants existing is AMBIGUOUS — human decision, no auto-pick", async () => {
    const sock: OnWhatsAppSocket = {
      onWhatsApp: async () => [
        { jid: "5521998765432@s.whatsapp.net", exists: true },
        { jid: "552198765432@s.whatsapp.net", exists: true },
      ],
    };
    const result = await resolveRecipient(sock, "5521998765432@s.whatsapp.net");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AMBIGUOUS");
      expect(result.candidates).toEqual([
        "5521998765432@s.whatsapp.net",
        "552198765432@s.whatsapp.net",
      ]);
    }
  });

  test("undefined response is LOOKUP_FAILED, never a guess", async () => {
    const sock: OnWhatsAppSocket = { onWhatsApp: async () => undefined };
    const result = await resolveRecipient(sock, "5511987654321@s.whatsapp.net");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("LOOKUP_FAILED");
  });
});
