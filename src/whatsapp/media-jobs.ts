// Per-conversation media (media-on-demand phase): nothing downloads by default,
// so a chat can report what it holds (cached / downloadable / unavailable) and,
// when the user accepts, download every downloadable file in one background job
// through the same cache path as the single-file endpoint (ensureMediaCached:
// reupload on 403/404/410, DNS fallback, size cap, shared in-flight downloads).
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import {
  ensureMediaCached,
  isCached,
  isMediaType,
  MAX_DOWNLOAD_BYTES,
  MediaError,
  resolveStoredPath,
  type MediaDownloader,
  type MediaKey,
  type MediaSocket,
} from "./media.ts";

export interface MediaSummary {
  /** Media messages in the chat (every bubble that shows a media). */
  total: number;
  /** Already on disk. */
  cached: number;
  /** Keys stored, not cached yet: can be downloaded now. */
  downloadable: number;
  /** No keys stored (received before the media update): only a history re-sync can help. */
  unavailable: number;
  /** Sum of the known file sizes of the downloadable ones. */
  downloadable_bytes: number;
  /** Downloadable ones whose size is unknown. */
  unknown_size_count: number;
  /** Bytes on disk of the cached ones. */
  cached_bytes: number;
}

type MediaState = "cached" | "downloadable" | "unavailable";

interface ChatMediaRow {
  message_id: string;
  from_me: number;
  message_type: string | null;
  timestamp: number;
  has_row: number;
  raw_json_set: number;
  cache_path: string | null;
  file_size: number | null;
}

export interface ChatMediaItem {
  id: string;
  fromMe: boolean;
  ts: number;
  fileSize: number | null;
  cachePath: string | null;
  state: MediaState;
}

/** Every media message of a chat with its state (same rules as mediaView). */
export function listChatMedia(db: Database, instance: string, chat: string): ChatMediaItem[] {
  const rows = db
    .query(
      `SELECT m.message_id, m.from_me, m.message_type, m.timestamp,
              mm.message_id IS NOT NULL AS has_row,
              mm.raw_json IS NOT NULL AS raw_json_set,
              mm.cache_path, mm.file_size
       FROM messages m
       LEFT JOIN message_media mm
         ON mm.instance_id = m.instance_id AND mm.chat_jid = m.chat_jid
        AND mm.message_id = m.message_id AND mm.from_me = m.from_me
       WHERE m.instance_id = ? AND m.chat_jid = ?
       ORDER BY m.timestamp ASC, m.rowid ASC`,
    )
    .all(instance, chat) as ChatMediaRow[];
  const out: ChatMediaItem[] = [];
  for (const r of rows) {
    if (!r.has_row && !isMediaType(r.message_type)) continue;
    const cached = r.has_row === 1 && isCached({ cache_path: r.cache_path });
    const state: MediaState = cached ? "cached" : r.raw_json_set ? "downloadable" : "unavailable";
    out.push({ id: r.message_id, fromMe: r.from_me === 1, ts: r.timestamp, fileSize: r.file_size, cachePath: r.cache_path, state });
  }
  return out;
}

function fileBytes(stored: string | null): number {
  if (!stored) return 0;
  try {
    return statSync(resolveStoredPath(stored)).size;
  } catch {
    return 0;
  }
}

export function mediaSummary(db: Database, instance: string, chat: string): MediaSummary {
  const summary: MediaSummary = {
    total: 0,
    cached: 0,
    downloadable: 0,
    unavailable: 0,
    downloadable_bytes: 0,
    unknown_size_count: 0,
    cached_bytes: 0,
  };
  for (const item of listChatMedia(db, instance, chat)) {
    summary.total++;
    summary[item.state]++;
    if (item.state === "cached") summary.cached_bytes += fileBytes(item.cachePath);
    if (item.state === "downloadable") {
      if (item.fileSize === null) summary.unknown_size_count++;
      else summary.downloadable_bytes += item.fileSize;
    }
  }
  return summary;
}

/* ---------------- bulk download job ---------------- */

export type MediaJobStatus = "running" | "done" | "failed";

export interface MediaJob {
  id: string;
  instance: string;
  chat: string;
  status: MediaJobStatus;
  total: number;
  /** Downloaded successfully. */
  done: number;
  failed: number;
  /** Bytes written to disk by this job. */
  bytes: number;
  errors: Array<{ message_id: string; code: string }>;
}

export interface MediaJobDeps {
  db: Database;
  /** Current socket of the instance (re-read per file: it may drop mid-job). */
  socket: () => MediaSocket | null;
  downloader: MediaDownloader;
  mediaDir?: string;
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 2;
/** Finished jobs kept in memory for polling. */
const KEEP_FINISHED = 50;

/** In-process registry: one running job per chat; ids never reused. */
export class MediaJobRegistry {
  private readonly jobs = new Map<string, MediaJob>();
  private readonly runningByChat = new Map<string, string>();

  get(id: string): MediaJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** The running job of a chat, if any. */
  running(instance: string, chat: string): MediaJob | null {
    const id = this.runningByChat.get(`${instance}|${chat}`);
    return id ? this.get(id) : null;
  }

  /** Starts downloading every downloadable media of the chat (returns at once). */
  start(instance: string, chat: string, deps: MediaJobDeps): MediaJob {
    const items = listChatMedia(deps.db, instance, chat).filter((m) => m.state === "downloadable");
    const job: MediaJob = {
      id: `mj_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      instance,
      chat,
      status: "running",
      total: items.length,
      done: 0,
      failed: 0,
      bytes: 0,
      errors: [],
    };
    this.jobs.set(job.id, job);
    const chatKey = `${instance}|${chat}`;
    this.runningByChat.set(chatKey, job.id);
    void runMediaJob(job, items, deps)
      .catch((error) => {
        job.status = "failed";
        console.error(`[wa:media] job ${job.id} falhou: ${String(error)}`);
      })
      .finally(() => {
        if (this.runningByChat.get(chatKey) === job.id) this.runningByChat.delete(chatKey);
        this.prune();
      });
    return job;
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.status !== "running");
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(j.id);
  }
}

async function runMediaJob(job: MediaJob, items: ChatMediaItem[], deps: MediaJobDeps): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      if (item.fileSize !== null && item.fileSize > MAX_DOWNLOAD_BYTES) {
        job.failed++;
        job.errors.push({ message_id: item.id, code: "too_large" });
        continue;
      }
      const key: MediaKey = { instance: job.instance, chat: job.chat, id: item.id, fromMe: item.fromMe };
      try {
        const { path } = await ensureMediaCached(deps.db, key, {
          socket: deps.socket(),
          downloader: deps.downloader,
          mediaDir: deps.mediaDir,
        });
        job.bytes += fileBytes(path);
        job.done++;
      } catch (error) {
        job.failed++;
        job.errors.push({ message_id: item.id, code: error instanceof MediaError ? error.code : "download_failed" });
      }
    }
  };
  const workers = Math.max(1, Math.min(deps.concurrency ?? DEFAULT_CONCURRENCY, items.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));
  job.status = "done";
}
