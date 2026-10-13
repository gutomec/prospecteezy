// In-memory fake of /api/wa/* for the UI preview (PREVIEW_MOCK=1). Drives every
// WhatsApp write flow without touching a real account: instances + QR pairing,
// chats with every media kind (generated SVG/WAV/PDF bytes, Range support,
// unavailable and failing media), pagination incl. a "fetching history" phase,
// sending (quiet hours 409, rate limit 429, upload limits 413/415), SSE
// (message, reaction, status, qr, campaign) and campaigns with a pause/resume.
// Never imported by the app bundle.
import QRCode from "qrcode";
import type {
  Lead,
  WaCampaign,
  WaChat,
  WaInstance,
  WaMedia,
  WaMessage,
  WaUploadedMedia,
} from "../lib/api/types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const fail = (message: string, status: number, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);
const nowS = () => Math.floor(Date.now() / 1000);
const MB = 1024 * 1024;
type Bytes = Uint8Array<ArrayBuffer>;
const PLACEHOLDERS = ["name", "category", "address", "phone", "website", "rating", "email"];

/* ---------------- generated media bytes ---------------- */

function svgImage(label: string, hue: number, w = 800, h = 600): Bytes {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},70%,40%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${w * 0.78}" cy="${h * 0.28}" r="${Math.min(w, h) * 0.12}" fill="rgba(255,255,255,.35)"/>
<path d="M0 ${h * 0.8} L${w * 0.3} ${h * 0.5} L${w * 0.55} ${h * 0.72} L${w * 0.75} ${h * 0.55} L${w} ${h * 0.85} V${h} H0Z" fill="rgba(0,0,0,.25)"/>
<text x="50%" y="52%" font-family="sans-serif" font-size="${Math.round(Math.min(w, h) / 9)}" fill="white" text-anchor="middle" font-weight="700">${label}</text></svg>`;
  return new TextEncoder().encode(svg);
}

function stickerSvg(): Bytes {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><circle cx="256" cy="256" r="220" fill="#ffcc4d"/><circle cx="186" cy="210" r="28" fill="#664500"/><circle cx="326" cy="210" r="28" fill="#664500"/><path d="M150 310 Q256 420 362 310" stroke="#664500" stroke-width="26" fill="none" stroke-linecap="round"/></svg>`,
  );
}

/** 16-bit PCM WAV with a soft two-tone melody. */
function wavTone(seconds: number, base = 440): Bytes {
  const rate = 8000;
  const samples = Math.floor(seconds * rate);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const freq = Math.floor(t * 2) % 2 ? base * 1.25 : base;
    const env = Math.min(1, t * 8, (seconds - t) * 8);
    view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * freq * t) * 9000 * env, true);
  }
  return new Uint8Array(buffer) as Bytes;
}

function pdfBytes(title: string): Bytes {
  const content = `BT /F1 24 Tf 72 720 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

/* ---------------- model ---------------- */

interface StoredMedia {
  bytes: Bytes | null;
  mime: string;
  name: string | null;
  thumb: Bytes | null;
  /** Simulated failure: status + code (one-shot when `once`). */
  failure?: { status: number; code: string; error: string; /** Fails this many requests, then serves. */ times?: number };
}

interface MockChat extends Omit<WaChat, "last_message" | "last_type" | "last_ts"> {
  instance: string;
  messages: WaMessage[];
  /** Older history "fetched from WhatsApp" after the mirror is exhausted. */
  history?: WaMessage[];
  historyPolls?: number;
}

interface MockCampaign extends WaCampaign {
  template: string;
  pausedOnce: boolean;
}

function media(kind: WaMedia["kind"], extra: Partial<WaMedia> = {}): WaMedia {
  return { kind, mimetype: null, file_name: null, file_size: null, duration_s: null, width: null, height: null, has_thumbnail: false, available: true, cached: false, ...extra };
}

export function createWaMock(getLeads: () => Lead[]) {
  const instances: WaInstance[] = [
    { id: "wa1", name: "Comercial", phone: "5511999990000", status: "connected", status_reason: null, is_active: true },
    {
      id: "wa2",
      name: "Suporte",
      phone: "5511988887777",
      status: "disconnected",
      status_reason: "Sessão substituída (440): o número foi aberto em outro computador. Clique em reconectar.",
      is_active: false,
    },
  ];
  const mediaStore = new Map<string, StoredMedia>(); // key `${chat}|${id}` or media_id
  const uploads = new Map<string, WaUploadedMedia & { bytes: Bytes }>();
  const chats: MockChat[] = [];
  const campaigns = new Map<string, MockCampaign>();
  const qrTimers = new Map<string, ReturnType<typeof setInterval>>();
  let sendCount = 0;

  /* ---- SSE ---- */
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  function emit(event: string, instance: string, data: Record<string, unknown>) {
    const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ instance, ...data })}\n\n`);
    for (const c of clients) {
      try {
        c.enqueue(frame);
      } catch {
        clients.delete(c);
      }
    }
  }
  function stream(): Response {
    let ping: ReturnType<typeof setInterval> | null = null;
    let self: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
        ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            if (ping) clearInterval(ping);
          }
        }, 15_000);
      },
      cancel() {
        if (ping) clearInterval(ping);
        if (self) clients.delete(self);
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" } });
  }

  /* ---- seed ---- */
  const base = nowS() - 3 * 86_400;
  let seq = 0;
  const mid = () => `3EB0MOCK${String(++seq).padStart(6, "0")}`;
  function msg(chat: MockChat, partial: Partial<WaMessage> & { ts: number }): WaMessage {
    const m: WaMessage = { id: mid(), from_me: false, text: null, type: "conversation", status: null, media: null, quoted: null, reactions: [], ...partial };
    if (m.from_me && !m.status) m.status = "read";
    chat.messages.push(m);
    return m;
  }
  function putMedia(chat: MockChat, m: WaMessage, stored: StoredMedia) {
    mediaStore.set(`${chat.jid}|${m.id}`, stored);
  }

  // 1) rich thread: every media kind, replies, reactions, formatting, 120+ messages.
  const rich: MockChat = { instance: "wa1", jid: "5511912345678@s.whatsapp.net", name: "Clínica Sorriso Almeida", phone: "5511912345678", unread: 0, saved: true, messages: [] };
  chats.push(rich);
  const filler = [
    "Bom dia! Tudo certo?",
    "Tudo ótimo, e por aí?",
    "Conseguiu ver a proposta?",
    "Ainda não, vejo hoje à tarde.",
    "Perfeito, fico no aguardo.",
    "Pode me ligar amanhã às 10h?",
    "Combinado 👍",
  ];
  for (let i = 0; i < 100; i++) {
    msg(rich, { ts: base - 86_400 * 2 + i * 600, from_me: i % 3 === 1, text: `${filler[i % filler.length]} (#${i + 1})` });
  }
  const t0 = base + 3600;
  const greet = msg(rich, { ts: t0, text: "Oi! Vi o anúncio de vocês. Vocês fazem *site* e _tráfego pago_? Nosso site atual: https://www.sorrisoalmeida.com.br/inicio." });
  msg(rich, {
    ts: t0 + 60,
    from_me: true,
    text: "Olá! Fazemos sim. Segue um resumo:\n• *Site novo* em 15 dias\n• ~Mensalidade~ sem fidelidade\n```Plano Essencial: R$ 990/mês```",
    quoted: { id: greet.id, text: greet.text, type: "conversation" },
    reactions: [{ emoji: "❤️", from_me: false }],
  });
  const img = msg(rich, { ts: t0 + 300, type: "imageMessage", text: "Essa é a nossa recepção nova", media: media("image", { mimetype: "image/svg+xml", width: 800, height: 600, has_thumbnail: true, file_size: 182_311 }) });
  putMedia(rich, img, { bytes: svgImage("Recepção", 200), mime: "image/svg+xml", name: null, thumb: svgImage("", 200, 80, 60) });
  const tall = msg(rich, { ts: t0 + 320, type: "imageMessage", media: media("image", { mimetype: "image/svg+xml", width: 600, height: 1000, has_thumbnail: false }) });
  putMedia(rich, tall, { bytes: svgImage("Fachada", 20, 600, 1000), mime: "image/svg+xml", name: null, thumb: null });
  const flaky = msg(rich, { ts: t0 + 340, type: "imageMessage", text: "Foto que falha na 1ª tentativa (409)", media: media("image", { mimetype: "image/svg+xml", width: 800, height: 500 }) });
  putMedia(rich, flaky, {
    bytes: svgImage("Recuperada", 140, 800, 500),
    mime: "image/svg+xml",
    name: null,
    thumb: null,
    failure: { status: 409, code: "not_connected", error: "WhatsApp desconectado e mídia fora do cache.", times: 2 },
  });
  const voice = msg(rich, { ts: t0 + 600, type: "pttMessage", media: media("voice", { mimetype: "audio/wav", duration_s: 6, file_size: 96_044 }), reactions: [{ emoji: "👍", from_me: true }] });
  putMedia(rich, voice, { bytes: wavTone(6, 392), mime: "audio/wav", name: null, thumb: null });
  const audio = msg(rich, { ts: t0 + 660, from_me: true, type: "audioMessage", media: media("audio", { mimetype: "audio/wav", duration_s: 12, file_size: 192_044 }) });
  putMedia(rich, audio, { bytes: wavTone(12, 523), mime: "audio/wav", name: null, thumb: null });
  const video = msg(rich, { ts: t0 + 900, type: "videoMessage", text: "Vídeo do consultório (download falha: 502)", media: media("video", { mimetype: "video/mp4", width: 1280, height: 720, duration_s: 34, has_thumbnail: true }) });
  putMedia(rich, video, { bytes: null, mime: "video/mp4", name: null, thumb: svgImage("▶", 280, 160, 90), failure: { status: 502, code: "download_failed", error: "Falha ao baixar a mídia do WhatsApp." } });
  const doc = msg(rich, {
    ts: t0 + 1200,
    from_me: true,
    type: "documentMessage",
    text: "Proposta atualizada",
    media: media("document", { mimetype: "application/pdf", file_name: "Proposta Comercial - Sorriso.pdf", file_size: 182_311, has_thumbnail: true }),
  });
  putMedia(rich, doc, { bytes: pdfBytes("Proposta Comercial"), mime: "application/pdf", name: "Proposta Comercial - Sorriso.pdf", thumb: svgImage("PDF", 0, 300, 400) });
  const sheet = msg(rich, { ts: t0 + 1300, type: "documentMessage", media: media("document", { mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", file_name: "orçamento-2026.xlsx", file_size: 48_200 }) });
  putMedia(rich, sheet, { bytes: pdfBytes("planilha"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "orçamento-2026.xlsx", thumb: null });
  msg(rich, { ts: t0 + 1500, type: "imageMessage", text: "Foto antiga", media: media("image", { available: false }) });
  msg(rich, { ts: t0 + 1510, type: "audioMessage", media: media("voice", { available: false }) });
  const st = msg(rich, { ts: t0 + 1600, type: "stickerMessage", media: media("sticker", { mimetype: "image/svg+xml", width: 512, height: 512 }) });
  putMedia(rich, st, { bytes: stickerSvg(), mime: "image/svg+xml", name: null, thumb: null });
  msg(rich, { ts: t0 + 1700, type: "locationMessage" });
  msg(rich, { ts: nowS() - 7200, text: "Pode mandar o contrato? `urgente`", quoted: { id: doc.id, text: "Proposta atualizada", type: "documentMessage" } });
  msg(rich, { ts: nowS() - 3600, from_me: true, text: "Mando ainda hoje!", status: "delivered" });
  rich.history = Array.from({ length: 12 }, (_, i) => ({
    id: `3EB0HIST${String(i).padStart(4, "0")}`,
    from_me: i % 2 === 0,
    text: `Mensagem antiga do histórico do WhatsApp (${i + 1})`,
    type: "conversation",
    ts: base - 86_400 * 10 + i * 900,
    status: i % 2 === 0 ? "read" : null,
    media: null,
    quoted: null,
    reactions: [],
  }));

  // 2) unread voice note
  const bakery: MockChat = { instance: "wa1", jid: "5511923456789@s.whatsapp.net", name: "Padaria Pão Bom", phone: "5511923456789", unread: 2, saved: false, messages: [] };
  chats.push(bakery);
  msg(bakery, { ts: nowS() - 900, from_me: true, text: "Olá! Somos da Norte Digital." });
  msg(bakery, { ts: nowS() - 600, text: "Oi, pode falar" });
  const bv = msg(bakery, { ts: nowS() - 300, type: "pttMessage", media: media("voice", { mimetype: "audio/wav", duration_s: 4 }) });
  putMedia(bakery, bv, { bytes: wavTone(4, 330), mime: "audio/wav", name: null, thumb: null });

  // 3) LID chats (no number in the jid)
  const lid: MockChat = { instance: "wa1", jid: "184467440737095@lid", name: null, phone: "5511987654321", unread: 1, saved: false, messages: [] };
  chats.push(lid);
  const lp = msg(lid, { ts: nowS() - 86_400 - 500, type: "imageMessage", media: media("image", { mimetype: "image/svg+xml", width: 900, height: 600, has_thumbnail: true }) });
  putMedia(lid, lp, { bytes: svgImage("Cardápio", 100, 900, 600), mime: "image/svg+xml", name: null, thumb: svgImage("", 100, 90, 60) });
  const hidden: MockChat = { instance: "wa1", jid: "99112233445566@lid", name: null, phone: null, unread: 0, saved: false, messages: [] };
  chats.push(hidden);
  msg(hidden, { ts: nowS() - 86_400 * 4, text: "Olá, quem fala?" });

  // 4) cold lead: no inbound message → first send hits quiet hours (409)
  const cold: MockChat = { instance: "wa1", jid: "5511934567890@s.whatsapp.net", name: "Academia Costa (sem resposta)", phone: "5511934567890", unread: 0, saved: false, messages: [] };
  chats.push(cold);

  // 5) more conversations for a realistic list
  const NAMES = ["Imobiliária Ribeiro", "Contabilidade Lima", "Restaurante Araújo", "Escritório Martins", "Clínica Barbosa", "Academia Cardoso", "Dra. Fernanda Souza", "João (indicação)"];
  NAMES.forEach((name, i) => {
    const c: MockChat = { instance: "wa1", jid: `55119500000${String(i).padStart(2, "0")}@s.whatsapp.net`, name, phone: `55119500000${String(i).padStart(2, "0")}`, unread: i === 2 ? 5 : 0, saved: i % 3 === 0, messages: [] };
    chats.push(c);
    msg(c, { ts: nowS() - 86_400 * (i + 1) - i * 1000, text: "Obrigado pelo contato!" });
    if (i === 4) {
      const d = msg(c, { ts: nowS() - 86_400 * (i + 1), from_me: true, type: "documentMessage", media: media("document", { mimetype: "application/zip", file_name: "materiais.zip", file_size: 3_400_000 }) });
      putMedia(c, d, { bytes: pdfBytes("zip"), mime: "application/zip", name: "materiais.zip", thumb: null });
    }
    if (i === 5) msg(c, { ts: nowS() - 86_400 * (i + 1), type: "videoMessage", text: null, media: media("video", { available: false }) });
  });

  // 6) the second (disconnected) account keeps its mirrored chats
  const sup: MockChat = { instance: "wa2", jid: "5511977776666@s.whatsapp.net", name: "Cliente Suporte", phone: "5511977776666", unread: 0, saved: true, messages: [] };
  chats.push(sup);
  msg(sup, { ts: nowS() - 86_400 * 2, text: "O sistema voltou, obrigado!" });

  /* ---- helpers ---- */
  const chatOf = (instance: string, jid: string) => chats.find((c) => c.instance === instance && c.jid === jid);
  function chatView(c: MockChat): WaChat {
    const last = [...c.messages].reverse()[0];
    return {
      jid: c.jid,
      name: c.name ?? c.phone ?? null,
      phone: c.phone,
      last_message: last?.text ?? null,
      last_type: last?.type ?? null,
      last_ts: last?.ts ?? null,
      unread: c.unread,
      saved: c.saved,
    };
  }
  function mirrored(c: MockChat, m: WaMessage) {
    return { chat_jid: c.jid, message_id: m.id, from_me: m.from_me, text: m.text, type: m.type, ts: m.ts, status: m.status, media: m.media, quoted: m.quoted };
  }
  function inbound(c: MockChat, text: string, delay: number) {
    setTimeout(() => {
      const m = msg(c, { ts: nowS(), text });
      c.unread++;
      emit("message", c.instance, mirrored(c, m));
    }, delay);
  }

  function setStatus(inst: WaInstance, status: WaInstance["status"], reason: string | null = null) {
    inst.status = status;
    inst.status_reason = reason;
    emit("status", inst.id, { status, reason, me_jid: status === "connected" && inst.phone ? `${inst.phone}@s.whatsapp.net` : null });
  }

  async function qrDataUrl(id: string) {
    return QRCode.toDataURL(`mock-pairing:${id}:${Date.now()}`, { margin: 1, width: 512 });
  }
  const qrState = new Map<string, { qr: string | null; expires_at: number | null }>();

  function startPairing(inst: WaInstance) {
    clearInterval(qrTimers.get(inst.id));
    setStatus(inst, "connecting");
    setTimeout(async () => {
      if (!instances.includes(inst)) return;
      const qr = await qrDataUrl(inst.id);
      qrState.set(inst.id, { qr, expires_at: Date.now() + 20_000 });
      setStatus(inst, "qr");
      emit("qr", inst.id, { qr, expires_at: Date.now() + 20_000 });
      let rotations = 0;
      const timer = setInterval(async () => {
        if (!instances.includes(inst) || inst.status !== "qr") return clearInterval(timer);
        rotations++;
        if (rotations >= 3) {
          // "scanned" on the 3rd rotation (~18 s)
          clearInterval(timer);
          qrState.delete(inst.id);
          inst.phone ??= `55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
          setStatus(inst, "connected");
          return;
        }
        const next = await qrDataUrl(inst.id);
        qrState.set(inst.id, { qr: next, expires_at: Date.now() + 20_000 });
        emit("qr", inst.id, { qr: next, expires_at: Date.now() + 20_000 });
      }, 6000);
      qrTimers.set(inst.id, timer);
    }, 1000);
  }

  /** Serves stored bytes with Range support (206/416). */
  function serveBytes(req: Request, bytes: Bytes, mime: string, name: string | null, attachment: boolean): Response {
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
      "Content-Disposition": attachment && name ? `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}` : "inline",
    };
    const range = req.headers.get("range");
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m) {
      const size = bytes.length;
      let start = m[1] ? Number(m[1]) : size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      if (!m[1]) end = size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` } });
    }
    return new Response(bytes, { headers });
  }

  function sniff(file: File): { kind: WaUploadedMedia["kind"]; mime: string } | null {
    const type = file.type.toLowerCase();
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    if (type.startsWith("image/")) return { kind: "image", mime: type };
    if (type.startsWith("video/")) return { kind: "video", mime: type };
    if (type.startsWith("audio/") || ["ogg", "mp3", "m4a"].includes(ext)) return { kind: "audio", mime: type || "audio/ogg" };
    if (type === "application/pdf" || ext === "pdf") return { kind: "document", mime: "application/pdf" };
    if (["docx", "xlsx", "pptx", "zip"].includes(ext)) return { kind: "document", mime: type || "application/zip" };
    return null;
  }

  /* ---- campaigns ---- */
  function campaignEvent(job: MockCampaign, recipient?: WaCampaign["recipients"][number]) {
    emit("campaign", job.instance, { job_id: job.job_id, status: job.status, total: job.total, sent: job.sent, failed: job.failed, skipped: job.skipped, reason: job.reason, ...(recipient ? { recipient } : {}) });
  }
  function driveCampaign(job: MockCampaign) {
    const tick = () => {
      if (job.status !== "running") return;
      const r = job.recipients.find((x) => x.status === "queued");
      if (!r) {
        job.status = "done";
        campaignEvent(job);
        return;
      }
      const lead = getLeads().find((l) => l.id === r.lead_id);
      r.phone = lead?.phone ?? null;
      const empty = lead ? PLACEHOLDERS.filter((p) => new RegExp(`\\{\\{\\s*${p}\\s*\\}\\}`, "i").test(job.template) && !String(lead[p as keyof Lead] ?? "").trim()) : [];
      if (!lead) Object.assign(r, { status: "failed", reason: "lead_not_found" });
      else if (!lead.phone) Object.assign(r, { status: "skipped", reason: "sem telefone" });
      else if (lead.is_whatsapp === 0) Object.assign(r, { status: "skipped", reason: "not_whatsapp" });
      else if (empty.length) Object.assign(r, { status: "skipped", reason: `campo vazio para este lead: {{${empty[0]}}}` });
      else if (lead.id % 11 === 0) Object.assign(r, { status: "failed", reason: "erro do WhatsApp: número temporariamente indisponível" });
      else Object.assign(r, { status: "sent", reason: null, message_id: mid() });
      job.sent = job.recipients.filter((x) => x.status === "sent").length;
      job.failed = job.recipients.filter((x) => x.status === "failed").length;
      job.skipped = job.recipients.filter((x) => x.status === "skipped").length;
      const processed = job.sent + job.failed + job.skipped;
      if (!job.pausedOnce && processed === Math.min(3, job.total - 1)) {
        job.pausedOnce = true;
        job.status = "paused";
        job.reason = "horário de silêncio (21:00–08:00, America/Sao_Paulo)";
        const next = job.recipients.find((x) => x.status === "queued");
        if (next) next.reason = "quiet_hours";
      }
      campaignEvent(job, r);
      setTimeout(tick, 1400);
    };
    setTimeout(tick, 900);
  }

  /* ---- router ---- */
  async function handle(req: Request, url: URL, path: string): Promise<Response | null> {
    const m = req.method;
    const body = async <T>() => {
      try {
        return (await req.json()) as T;
      } catch {
        return undefined;
      }
    };

    if (path === "/api/wa/stream" && m === "GET") return stream();

    /* instances */
    if (path === "/api/wa/instances" && m === "GET") return json({ instances });
    if (path === "/api/wa/instances" && m === "POST") {
      const name = (await body<{ name?: string }>())?.name?.trim() || null;
      const inst: WaInstance = { id: `wa${crypto.randomUUID().slice(0, 8)}`, name, phone: null, status: "connecting", status_reason: null, is_active: false };
      instances.push(inst);
      startPairing(inst);
      return json({ id: inst.id }, 201);
    }
    const im = /^\/api\/wa\/instances\/([^/]+)(?:\/(qr|select|disconnect|reconnect|repair))?$/.exec(path);
    if (im) {
      const inst = instances.find((i) => i.id === im[1]);
      if (!inst) return fail("Instância não encontrada.", 404);
      const action = im[2];
      if (action === "qr" && m === "GET") {
        const q = qrState.get(inst.id);
        return json({ qr: inst.status === "qr" ? (q?.qr ?? null) : null, expires_at: q?.expires_at ?? null, status: inst.status, status_reason: inst.status_reason });
      }
      if (action === "select" && m === "POST") {
        if (inst.status !== "connected") return fail("Conecte a conta antes de usá-la para enviar.", 409);
        for (const i of instances) i.is_active = i === inst;
        return json({ ok: true, active_instance: inst.id });
      }
      if (action === "disconnect" && m === "POST") {
        setStatus(inst, "disconnected", "Desconectado manualmente.");
        return json({ ok: true, status: inst.status });
      }
      if (action === "reconnect" && m === "POST") {
        setStatus(inst, "connecting");
        setTimeout(() => setStatus(inst, "connected"), 1500);
        return json({ ok: true, status: inst.status });
      }
      if (action === "repair" && m === "POST") {
        startPairing(inst);
        return json({ ok: true, status: "connecting" });
      }
      if (!action && m === "DELETE") {
        clearInterval(qrTimers.get(inst.id));
        instances.splice(instances.indexOf(inst), 1);
        if (inst.is_active && instances[0]) instances[0].is_active = true;
        emit("status", inst.id, { status: "logged_out", reason: null });
        return json({ ok: true });
      }
    }

    /* chats & messages */
    if (path === "/api/wa/chats" && m === "GET") {
      const instance = url.searchParams.get("instance") ?? "";
      if (!instances.some((i) => i.id === instance)) return fail("Parâmetro 'instance' inválido.", 400);
      const list = chats.filter((c) => c.instance === instance).map(chatView);
      list.sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0));
      return json({ chats: list });
    }
    const mm = /^\/api\/wa\/chats\/([^/]+)\/messages$/.exec(path);
    if (mm && m === "GET") {
      const instance = url.searchParams.get("instance") ?? "";
      const jid = decodeURIComponent(mm[1]!);
      const c = chatOf(instance, jid);
      const limit = Math.min(500, Number(url.searchParams.get("limit")) || 200);
      if (!c) return json({ messages: [], has_more: false, fetching: false });
      c.unread = 0;
      const all = [...c.messages].sort((a, b) => a.ts - b.ts);
      const beforeId = url.searchParams.get("before_id");
      let end = all.length;
      if (beforeId) {
        const idx = all.findIndex((x) => x.id === beforeId);
        end = idx === -1 ? 0 : idx;
      }
      const page = all.slice(Math.max(0, end - limit), end);
      let hasMore = end - limit > 0;
      let fetching = false;
      if (!hasMore && c.history?.length) {
        // Mirror exhausted → pretend WhatsApp is sending older history (arrives on the 2nd poll).
        c.historyPolls = (c.historyPolls ?? 0) + 1;
        if (page.length > 0 || c.historyPolls < 2) {
          hasMore = true;
          fetching = true;
        } else {
          c.messages.unshift(...c.history);
          c.history = [];
          const fresh = [...c.messages].sort((a, b) => a.ts - b.ts);
          const idx = beforeId ? fresh.findIndex((x) => x.id === beforeId) : fresh.length;
          return json({ messages: fresh.slice(Math.max(0, idx - limit), idx), has_more: false, fetching: false });
        }
      }
      await Bun.sleep(250);
      return json({ messages: page, has_more: hasMore, fetching });
    }

    const md = /^\/api\/wa\/messages\/(media|thumbnail)$/.exec(path);
    if (md && (m === "GET" || m === "HEAD")) {
      const chat = url.searchParams.get("chat") ?? "";
      const id = url.searchParams.get("id") ?? "";
      const stored = mediaStore.get(`${chat}|${id}`);
      const message = chats.find((c) => c.jid === chat)?.messages.find((x) => x.id === id);
      if (!message) return fail("Mensagem não encontrada.", 404, { code: "message_not_found" });
      if (!message.media) return fail("Esta mensagem não tem mídia.", 404, { code: "not_media" });
      if (md[1] === "thumbnail") {
        return stored?.thumb ? new Response(stored.thumb, { headers: { "Content-Type": "image/svg+xml" } }) : fail("Miniatura indisponível.", 404, { code: "no_thumbnail" });
      }
      if (!message.media.available || !stored) return fail("Mídia indisponível (recebida antes da atualização).", 404, { code: "media_unavailable" });
      if (stored.failure) {
        const f = stored.failure;
        if (f.times !== undefined && --f.times <= 0) delete stored.failure;
        await Bun.sleep(400);
        return fail(f.error, f.status, { code: f.code });
      }
      message.media.cached = true;
      return serveBytes(req, stored.bytes!, stored.mime, stored.name, message.media.kind === "document");
    }

    /* media on demand: summary, bulk download (instant job), history recovery (recovers nothing) */
    const ms = /^\/api\/wa\/chats\/([^/]+)\/media-summary$/.exec(path);
    if (ms && m === "GET") {
      const c = chatOf(url.searchParams.get("instance") ?? "", decodeURIComponent(ms[1]!));
      const list = (c?.messages ?? []).flatMap((x) => (x.media ? [x.media] : []));
      const downloadable = list.filter((x) => x.available && !x.cached);
      return json({
        total: list.length,
        cached: list.filter((x) => x.cached).length,
        downloadable: downloadable.length,
        unavailable: list.filter((x) => !x.available && !x.cached).length,
        downloadable_bytes: downloadable.reduce((n, x) => n + (x.file_size ?? 0), 0),
        unknown_size_count: downloadable.filter((x) => x.file_size === null).length,
        cached_bytes: list.filter((x) => x.cached).reduce((n, x) => n + (x.file_size ?? 0), 0),
      });
    }
    const mo = /^\/api\/wa\/chats\/([^/]+)\/media\/(download|recover)$/.exec(path);
    if (mo && m === "POST") {
      const input = await body<{ instance?: string }>();
      const c = chatOf(input?.instance ?? "", decodeURIComponent(mo[1]!));
      if (mo[2] === "recover") {
        await Bun.sleep(1500);
        const missing = (c?.messages ?? []).filter((x) => x.media && !x.media.available).length;
        return json({ requested: missing ? 1 : 0, recovered: 0, still_unavailable: missing });
      }
      const targets = (c?.messages ?? []).filter((x) => x.media?.available && !x.media.cached);
      for (const x of targets) x.media!.cached = true;
      const bytes = targets.reduce((n, x) => n + (x.media!.file_size ?? 0), 0);
      return json({ job_id: `mj_${targets.length}_${bytes}` }, 202);
    }
    const mj = /^\/api\/wa\/media-jobs\/mj_(\d+)_(\d+)$/.exec(path);
    if (mj && m === "GET") {
      const total = Number(mj[1]);
      const bytes = Number(mj[2]);
      return json({ status: "done", total, done: total, failed: 0, bytes, errors: [] });
    }

    /* upload + send */
    if (path === "/api/wa/media" && m === "POST") {
      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return fail("Campo 'file' obrigatório (arquivo).", 400);
      if (file.size === 0) return fail("Arquivo vazio.", 400);
      if (file.size > 100 * MB) return fail("Arquivo excede o limite de 100 MB.", 413);
      const s = sniff(file);
      if (!s) return fail("Tipo de arquivo não suportado. Envie JPEG, PNG, WEBP, GIF, MP4, PDF, OGG, MP3, M4A, DOCX, XLSX, PPTX ou ZIP.", 415);
      const limit = { image: 16, video: 64, audio: 16, document: 100 }[s.kind] * MB;
      if (file.size > limit) return fail(`Arquivo excede o limite de ${limit / MB} MB.`, 413);
      const media_id = `med${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const record = { media_id, kind: s.kind, mime: s.mime, filename: file.name || null, size: file.size, bytes: new Uint8Array(await file.arrayBuffer()) as Bytes };
      uploads.set(media_id, record);
      const { bytes: _b, ...view } = record;
      return json(view, 201);
    }
    if (path === "/api/wa/send" && m === "POST") {
      const input = (await body<{ instance?: string; jid?: string; text?: string; media_id?: string; caption?: string; voice?: boolean }>()) ?? {};
      const inst = instances.find((i) => i.id === input.instance) ?? instances.find((i) => i.is_active);
      if (!inst) return fail("Instância inválida.", 400);
      const jid = (input.jid ?? "").trim();
      const text = (input.text ?? "").trim();
      if (!jid || (!text && !input.media_id)) return fail('Campos "jid" e "text" (ou "media_id") são obrigatórios.', 400);
      const up = input.media_id ? uploads.get(input.media_id) : null;
      if (input.media_id && !up) return fail("media_id não encontrado.", 400);
      const caption = (input.caption ?? text).trim();
      if (up?.kind === "audio" && caption) return fail("Áudio não aceita legenda: envie o texto em outra mensagem.", 400);
      if (input.voice && !(up?.kind === "audio" && up.mime.startsWith("audio/ogg"))) return fail("Mensagem de voz exige áudio OGG (Opus).", 400);
      if (inst.status !== "connected") return json({ ok: false, blocked_code: null, reason: "instância não conectada" }, 409);
      let c = chatOf(inst.id, jid);
      if (!c) {
        const lead = getLeads().find((l) => l.whatsapp_jid === jid);
        c = { instance: inst.id, jid, name: lead?.name ?? null, phone: jid.split("@")[0]!, unread: 0, saved: false, messages: [] };
        chats.push(c);
      }
      if (!c.messages.some((x) => !x.from_me)) {
        return json({ ok: false, blocked_code: "quiet_hours", reason: "horário de silêncio (21:00–08:00, America/Sao_Paulo)" }, 409);
      }
      sendCount++;
      if (sendCount % 6 === 0) return json({ ok: false, blocked_code: "rate_limit", reason: "limite de 2 envios por minuto atingido" }, 429);
      await Bun.sleep(500);
      const kindMap = { image: "imageMessage", video: "videoMessage", audio: input.voice ? "pttMessage" : "audioMessage", document: "documentMessage" } as const;
      const message = msg(c, {
        ts: nowS(),
        from_me: true,
        status: "sent",
        text: up ? caption || null : text,
        type: up ? kindMap[up.kind] : "conversation",
        media: up
          ? media(up.kind === "audio" && input.voice ? "voice" : up.kind, { mimetype: up.mime, file_name: up.filename, file_size: up.size, duration_s: up.kind === "audio" ? 5 : null })
          : null,
      });
      if (up) putMedia(c, message, { bytes: up.bytes, mime: up.mime, name: up.filename, thumb: null });
      const echo = mirrored(c, message);
      emit("message", inst.id, echo);
      // Simulated delivery ticks (message_status, like messages.update) + a
      // reply and a reaction from the contact.
      const tick = (status: "delivered" | "read", delay: number) =>
        setTimeout(() => {
          message.status = status;
          emit("message_status", inst.id, { chat_jid: c!.jid, message_id: message.id, from_me: true, status });
        }, delay);
      tick("delivered", 1500);
      tick("read", 3000);
      if (c === rich || c === bakery) {
        inbound(c, "Recebido, obrigado! 🙌", 3500);
        setTimeout(() => {
          message.reactions = [{ emoji: "👍", from_me: false }];
          emit("reaction", inst.id, { chat_jid: c!.jid, target_id: message.id, emoji: "👍", from_me: false, removed: false });
        }, 5000);
      }
      return json({ ok: true, message: echo });
    }

    /* leads & contacts */
    if (path === "/api/wa/leads" && m === "GET") {
      return json({
        leads: getLeads()
          .filter((l) => l.is_whatsapp === 1 && l.whatsapp_jid)
          .map((l) => ({ lead_id: l.id, name: l.name, phone: l.phone, jid: l.whatsapp_jid, category: l.category })),
      });
    }
    if (path === "/api/wa/contacts/save" && m === "POST") {
      const input = (await body<{ instance: string; jids: string[] }>()) ?? { instance: "", jids: [] };
      const results = (input.jids ?? []).map((jid) => {
        const c = chatOf(input.instance, jid);
        if (c?.saved) return { jid, status: "skipped_already_saved" as const };
        if (c) c.saved = true;
        return { jid, status: "saved" as const };
      });
      return json({
        results,
        saved: results.filter((r) => r.status === "saved").length,
        skipped: results.filter((r) => r.status === "skipped_already_saved").length,
        failed: 0,
      });
    }

    /* campaigns */
    if (path === "/api/wa/campaign" && m === "POST") {
      const input = (await body<{ instance?: string; lead_ids?: number[]; template?: string; media?: { media_id?: string } }>()) ?? {};
      const inst = instances.find((i) => i.id === input.instance) ?? instances.find((i) => i.is_active);
      if (!inst) return fail("Instância inválida.", 400);
      const ids = (input.lead_ids ?? []).filter((n) => Number.isInteger(n) && n > 0);
      if (!ids.length) return fail('Campo "lead_ids" deve ser uma lista não vazia.', 400);
      const template = input.template ?? "";
      if (!template.trim() && !input.media?.media_id) return fail("Mensagem vazia sem mídia: informe um template ou uma mídia.", 400);
      const unknown = [...template.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((x) => x[1]!).filter((k) => !PLACEHOLDERS.includes(k.toLowerCase()));
      if (unknown.length) {
        const fmt = (keys: string[]) => keys.map((k) => `{{${k}}}`).join(", ");
        return fail(`Campos desconhecidos no template: ${fmt(unknown)}. Campos válidos: ${fmt(PLACEHOLDERS)}.`, 400, { unknown_placeholders: unknown, valid_placeholders: PLACEHOLDERS });
      }
      if (inst.status !== "connected") return fail("Nenhum WhatsApp conectado. Conecte uma conta antes de enviar.", 409);
      const running = [...campaigns.values()].find((j) => j.instance === inst.id && (j.status === "running" || j.status === "queued"));
      if (running) return fail("Já existe uma campanha em andamento nesta conta. Aguarde terminar antes de iniciar outra.", 409, { job_id: running.job_id });
      const job: MockCampaign = {
        job_id: `cmp${crypto.randomUUID().slice(0, 10)}`,
        instance: inst.id,
        status: "running",
        total: ids.length,
        sent: 0,
        failed: 0,
        skipped: 0,
        reason: null,
        recipients: ids.map((lead_id) => ({ lead_id, phone: null, status: "queued", reason: null, message_id: null })),
        template,
        pausedOnce: false,
      };
      campaigns.set(job.job_id, job);
      driveCampaign(job);
      return json({ job_id: job.job_id }, 202);
    }
    const cm = /^\/api\/wa\/campaign\/([^/]+)(\/resume)?$/.exec(path);
    if (cm) {
      const job = campaigns.get(cm[1]!);
      if (!job) return fail("Campanha não encontrada.", 404);
      if (cm[2] && m === "POST") {
        if (job.status === "running") return fail("Esta campanha já está em andamento.", 409);
        if (job.status === "done") return fail("Esta campanha já terminou.", 409);
        const inst = instances.find((i) => i.id === job.instance);
        if (inst?.status !== "connected") return fail("Nenhum WhatsApp conectado. Conecte a conta desta campanha antes de retomar.", 409);
        job.status = "running";
        job.reason = null;
        campaignEvent(job);
        driveCampaign(job);
        return json({ ok: true, job_id: job.job_id });
      }
      if (!cm[2] && m === "GET") {
        const { template: _t, pausedOnce: _p, ...view } = job;
        return json(view);
      }
    }

    return null;
  }

  // Ambient life: an inbound message now and then (live list updates, unread, new-message counter).
  setInterval(() => {
    if (clients.size === 0) return;
    const c = [bakery, rich, lid][Math.floor(Math.random() * 3)]!;
    inbound(c, ["Alguma novidade?", "Pode me mandar o link de novo?", "Vi agora, obrigado!", "Combinado então ✅"][Math.floor(Math.random() * 4)]!, 0);
  }, 45_000);

  return { handle, instances };
}
