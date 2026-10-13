// Media on demand: bubble display mode, size text, the "Carregar arquivos"
// summary text and the flow's state transitions (wa-utils.ts).
import { describe, expect, test } from "bun:test";
import type { WaMediaJob, WaMediaSummary } from "../lib/api/types";
import {
  approxSize,
  formatBytes,
  MEDIA_LOAD_INITIAL,
  mediaDisplay,
  mediaJobPercent,
  mediaLoadOutcome,
  mediaLoadReducer,
  mediaSummaryText,
  type MediaLoadState,
} from "../features/whatsapp/wa-utils";

const MB = 1024 * 1024;

function summary(extra: Partial<WaMediaSummary> = {}): WaMediaSummary {
  return {
    total: 10,
    cached: 0,
    downloadable: 7,
    unavailable: 3,
    downloadable_bytes: 12 * MB,
    unknown_size_count: 0,
    cached_bytes: 0,
    ...extra,
  };
}

function job(extra: Partial<WaMediaJob> = {}): WaMediaJob {
  return { status: "running", total: 4, done: 1, failed: 0, bytes: 20, errors: [], ...extra };
}

describe("mediaDisplay", () => {
  test("cached shows the file; available but not cached asks to download; no keys is unavailable", () => {
    expect(mediaDisplay({ available: true, cached: true })).toBe("cached");
    expect(mediaDisplay({ available: true, cached: false })).toBe("download");
    expect(mediaDisplay({ available: true, cached: false }, true)).toBe("cached");
    expect(mediaDisplay({ available: false, cached: false })).toBe("unavailable");
  });
});

describe("size formatting", () => {
  test("approximate sizes in PT-BR", () => {
    expect(approxSize(12 * MB)).toBe("~12 MB");
    expect(approxSize(1.5 * MB)).toBe("~1,5 MB");
    expect(approxSize(800 * 1024)).toBe("~800 KB");
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("mediaSummaryText", () => {
  test("full text with downloadable and old media", () => {
    expect(mediaSummaryText(summary())).toBe(
      "Esta conversa tem 10 arquivos de mídia. 7 podem ser baixados agora (~12 MB). " +
        "3 são antigos e só podem ser recuperados pedindo o histórico ao seu celular (ele precisa estar online). " +
        "Os arquivos ficam salvos neste computador, na pasta data/wa-media, e ocupam espaço em disco.",
    );
  });

  test("singulars, cached files and unknown sizes", () => {
    const text = mediaSummaryText(summary({ total: 3, cached: 1, downloadable: 1, unavailable: 1, downloadable_bytes: 0, unknown_size_count: 1 }));
    expect(text).toContain("Esta conversa tem 3 arquivos de mídia. 1 já está neste computador.");
    expect(text).toContain("1 pode ser baixado agora.");
    expect(text).toContain("1 é antigo e só pode ser recuperado pedindo o histórico");
    const mixed = mediaSummaryText(summary({ downloadable: 3, unknown_size_count: 1, downloadable_bytes: 2 * MB }));
    expect(mixed).toContain("3 podem ser baixados agora (~2 MB, mais 1 de tamanho desconhecido).");
  });

  test("nothing to download / no media", () => {
    expect(mediaSummaryText(summary({ total: 2, cached: 2, downloadable: 0, unavailable: 0, downloadable_bytes: 0 }))).toContain(
      "Nenhum arquivo para baixar agora.",
    );
    expect(mediaSummaryText(summary({ total: 0, downloadable: 0, unavailable: 0 }))).toBe("Esta conversa não tem arquivos de mídia.");
  });
});

describe("mediaLoadReducer", () => {
  const ready = mediaLoadReducer(MEDIA_LOAD_INITIAL, { type: "summary_loaded", summary: summary() });

  test("summary → recover → download → progress → finished", () => {
    expect(ready).toEqual({ phase: "ready", summary: summary() });
    const recovering = mediaLoadReducer(ready, { type: "start", recover: true });
    expect(recovering.phase).toBe("recovering");
    const result = { requested: 2, recovered: 1, still_unavailable: 2 };
    let state: MediaLoadState = mediaLoadReducer(recovering, { type: "recovered", result });
    expect(state).toMatchObject({ phase: "downloading", recover: result, jobId: null, job: null });
    state = mediaLoadReducer(state, { type: "job_started", jobId: "mj_1" });
    expect(state).toMatchObject({ phase: "downloading", jobId: "mj_1" });
    state = mediaLoadReducer(state, { type: "job_progress", job: job() });
    expect(state).toMatchObject({ phase: "downloading", job: job() });
    const final = job({ status: "done", done: 7, failed: 1, total: 8 });
    state = mediaLoadReducer(state, { type: "job_progress", job: final });
    expect(state.phase).toBe("finished");
    expect(mediaLoadOutcome(state as Extract<MediaLoadState, { phase: "finished" }>)).toEqual({
      downloaded: 7,
      failed: 1,
      recovered: 1,
      stillUnavailable: 2,
    });
  });

  test("without recovery (unchecked, or nothing old) goes straight to the download", () => {
    expect(mediaLoadReducer(ready, { type: "start", recover: false }).phase).toBe("downloading");
    const noOld = mediaLoadReducer(MEDIA_LOAD_INITIAL, { type: "summary_loaded", summary: summary({ unavailable: 0 }) });
    expect(mediaLoadReducer(noOld, { type: "start", recover: true }).phase).toBe("downloading");
    const finished = mediaLoadReducer(
      mediaLoadReducer(mediaLoadReducer(ready, { type: "start", recover: false }), { type: "job_started", jobId: "x" }),
      { type: "job_progress", job: job({ status: "done", done: 7, total: 7 }) },
    );
    expect(mediaLoadOutcome(finished as Extract<MediaLoadState, { phase: "finished" }>).stillUnavailable).toBe(3);
  });

  test("a failed recovery still downloads, keeping the reason", () => {
    const recovering = mediaLoadReducer(ready, { type: "start", recover: true });
    expect(mediaLoadReducer(recovering, { type: "recover_failed", message: "Celular offline." })).toMatchObject({
      phase: "downloading",
      recover: null,
      recoverError: "Celular offline.",
    });
  });

  test("errors keep the summary; reset starts over; out-of-phase actions are ignored", () => {
    expect(mediaLoadReducer(ready, { type: "failed", message: "x" })).toEqual({ phase: "error", message: "x", summary: summary() });
    expect(mediaLoadReducer(ready, { type: "reset" })).toEqual(MEDIA_LOAD_INITIAL);
    expect(mediaLoadReducer(ready, { type: "job_progress", job: job() })).toBe(ready);
    expect(mediaLoadReducer(ready, { type: "recovered", result: { requested: 1, recovered: 0, still_unavailable: 3 } })).toBe(ready);
    expect(mediaLoadReducer(MEDIA_LOAD_INITIAL, { type: "start", recover: true })).toBe(MEDIA_LOAD_INITIAL);
  });
});

describe("mediaJobPercent", () => {
  test("counts done and failed; empty job is complete; no job is 0", () => {
    expect(mediaJobPercent(job({ total: 4, done: 1, failed: 1 }))).toBe(50);
    expect(mediaJobPercent(job({ total: 0, done: 0 }))).toBe(100);
    expect(mediaJobPercent(null)).toBe(0);
  });
});
