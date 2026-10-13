// Recipient resolver — port of the agentic-whatsapp-nirvana squad's
// template/lib/recipient-resolver.ts (incident destinatario-nao-verificado,
// 2026-07-26): Brazilian numbers have two JID forms because of the NINTH
// DIGIT — 13 digits (55 + DDD + 9XXXXXXXX, what people type/save) and 12
// (accounts registered before the change). Using the raw number as JID can
// deliver to the WRONG person, silently. Only the server knows the canonical
// form.
//
// Safe rule (the naive "try with 9, else without" FAILS): query ALL variants
// in one round-trip and treat "two accounts exist" as AMBIGUOUS — an error
// that requires a human decision, never an automatic pick (the two forms can
// belong to different people; that was the incident).

export type ResolveResult =
  | { ok: true; jid: string; corrected_from?: string }
  | {
      ok: false;
      code: "NOT_REGISTERED" | "AMBIGUOUS" | "LOOKUP_FAILED";
      candidates?: string[];
      message: string;
    };

/** BR mobile: 55 + DDD(2) + subscriber(8 or 9). Landlines (not starting 6-9) never gain a 9. */
const BR_MOBILE = /^55(\d{2})(\d{8,9})$/;

/**
 * Brazilian ninth-digit variants for a `user` (the part before the @, no
 * device). 13 digits → also test 12; 12-digit MOBILE → also test 13.
 * Anything else (landline, non-BR, malformed) → only the number itself.
 */
export function brazilianVariants(user: string): string[] {
  const m = BR_MOBILE.exec(user);
  if (!m) return [user];
  const [, ddd, subscriber] = m;
  if (subscriber!.length === 9 && subscriber!.startsWith("9")) {
    return [user, `55${ddd}${subscriber!.slice(1)}`]; // 13 → also 12
  }
  if (subscriber!.length === 8 && /^[6-9]/.test(subscriber!)) {
    return [user, `55${ddd}9${subscriber}`]; // 12 mobile → also 13
  }
  return [user]; // landline: no variant
}

/**
 * Normalizes a lead phone (Serper gives "+55 11 91234-5678", "(11) 3456-7890",
 * ...) into the digits-only `user` used for onWhatsApp. Returns null when the
 * number cannot be a WhatsApp account (too short/long, or a Brazilian
 * non-mobile service number: 0300/0500/0800/0900, 3003/4003/4004-style).
 * Explicitly international numbers ("+1 ...", "0044 ...") are kept as-is;
 * otherwise BR-first: local numbers (10-11 digits) gain the 55 country code.
 */
export function phoneToUser(phone: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  let international = phone.trim().startsWith("+");
  // "00" international dialing prefix ("0044 20 ...") — same as "+".
  if (!international && digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }
  if (international && !digits.startsWith("55")) {
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  }
  if (!international) {
    // Toll-free / premium service numbers (0800 123 4567) and the 8-digit
    // "número único" lines (4003-1234, 3003-1234) never have WhatsApp.
    if (/^0[3589]00/.test(digits)) return null;
    if (digits.length === 8 && /^[34]00\d/.test(digits)) return null;
    // Trunk prefix: "011 91234-5678" → drop the leading 0 before the DDD.
    if (digits.startsWith("0") && (digits.length === 11 || digits.length === 12)) {
      digits = digits.slice(1);
    }
  }
  let br: string | null = null;
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    br = digits; // already E.164 BR without the +
  } else if (!international && (digits.length === 10 || digits.length === 11)) {
    br = `55${digits}`; // BR local: DDD + subscriber
  }
  if (br) {
    // Brazilian DDDs are 11-99 with no zero digit: "55 40 03..." is a
    // service number written with a country code, not a mobile.
    return /^55[1-9][1-9]/.test(br) ? br : null;
  }
  if (international) return null; // +55 with an impossible length
  if (digits.length >= 8 && digits.length <= 15) {
    return digits; // other formats: pass through as-is
  }
  return null;
}

/** Minimal socket surface used here (fake in tests, no network). */
export interface OnWhatsAppSocket {
  onWhatsApp: (...numbers: string[]) => Promise<{ jid: string; exists: boolean }[] | undefined>;
}

/**
 * Server-side resolution (one round-trip — `onWhatsApp` is variadic).
 * Returns the canonical JID, or an error that must NEVER turn into a blind
 * write of a guessed JID.
 */
export async function resolveRecipient(
  sock: OnWhatsAppSocket,
  requestedJid: string,
): Promise<ResolveResult> {
  const user = requestedJid.split("@")[0]!.split(":")[0]!;
  const candidates = brazilianVariants(user);

  const res = await sock.onWhatsApp(...candidates);
  if (!res) {
    return {
      ok: false,
      code: "LOOKUP_FAILED",
      candidates,
      message: "onWhatsApp não respondeu; resultado não é confiável sem confirmação",
    };
  }

  // TRAP (baileys socket filters by !!contact): numbers that do not exist come
  // ABSENT from the array, not with exists:false. NEVER match by index — match
  // by the returned `jid`.
  // Dedupe: the server may answer BOTH ninth-digit variants with the SAME
  // canonical jid — that is one account, not two (not ambiguous).
  const existing = [...new Set(res.filter((r) => r.exists).map((r) => r.jid))];

  if (existing.length === 0) {
    return {
      ok: false,
      code: "NOT_REGISTERED",
      candidates,
      message: `nenhuma variante de ${user} está registrada no WhatsApp`,
    };
  }
  if (existing.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS",
      candidates: existing,
      message:
        `duas contas distintas existem para esse número (${existing.join(", ")}). ` +
        `Decisão humana obrigatória; gravar a errada aponta para um estranho.`,
    };
  }

  const canonical = existing[0]!;
  return {
    ok: true,
    jid: canonical,
    corrected_from: canonical.split("@")[0] !== user ? requestedJid : undefined,
  };
}
