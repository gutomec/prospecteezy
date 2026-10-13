// Media inside a chat bubble: lazy images/stickers (+ lightbox), video with
// poster, compact audio/voice player, document card, unavailable placeholder
// and inline errors with retry. URLs point at GET /api/wa/messages/media
// (lazy download + cache, Range) and /thumbnail (stored jpegThumbnail).
// Nothing downloads by default: media not cached on this computer shows type,
// size and a "Baixar" button (plus the stored thumbnail); only cached media
// renders the file itself.
import {
  AlertCircleIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  ImageOffIcon,
  Loader2Icon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  PresentationIcon,
  RefreshCwIcon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { waMediaUrl, type MediaKey } from "@/lib/api/endpoints";
import type { WaMedia } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { docCategory, fileExtension, formatBytes, formatDuration, mediaDisplay, mediaErrorMessage, type DocCategory } from "./wa-utils";

/* ---------------- shared hooks ---------------- */

/** true once the element came near the viewport (then stays true). */
function useNearViewport<T extends Element>(): [(node: T | null) => void, boolean] {
  const [visible, setVisible] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    if (!node || typeof IntersectionObserver === "undefined") {
      if (node) setVisible(true);
      return;
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.current?.disconnect();
        }
      },
      { rootMargin: "300px 0px" },
    );
    observer.current.observe(node);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, visible];
}

/** Asks the media endpoint why it failed (1-byte Range request) → PT-BR message, or null when it now answers fine. */
async function diagnose(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (response.ok) return null;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return mediaErrorMessage(response.status, body);
  } catch {
    return mediaErrorMessage(0, null);
  }
}

/** Media URL + error/retry state (retry adds a cache-busting param the backend ignores). */
function useMediaSource(key: MediaKey) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const base = waMediaUrl("media", key);
  const url = attempt ? `${base}&r=${attempt}` : base;
  const fail = useCallback(() => {
    void diagnose(url).then((message) => {
      // Transient failure that already recovered: retry once by itself.
      if (message === null && attempt === 0) setAttempt(1);
      else setError(message ?? "Não consegui exibir esta mídia neste navegador.");
    });
  }, [url, attempt]);
  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  return { url, downloadUrl: base, error, fail, retry };
}

function MediaError({ message, onRetry, className }: { message: string; onRetry: () => void; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2 rounded-md bg-destructive/8 p-2.5 text-xs text-destructive", className)} role="alert">
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="leading-snug">{message}</p>
        <Button size="xs" variant="outline" onClick={onRetry} className="text-foreground">
          <RefreshCwIcon /> Tentar de novo
        </Button>
      </div>
    </div>
  );
}

function kindIcon(kind: WaMedia["kind"]): LucideIcon {
  return kind === "video" ? VideoIcon : kind === "audio" || kind === "voice" ? MicIcon : kind === "document" ? FileIcon : ImageOffIcon;
}

export function MediaUnavailable({ kind }: { kind: WaMedia["kind"] }) {
  const Icon = kindIcon(kind);
  return (
    <div className="flex max-w-72 items-start gap-2 rounded-md border border-dashed border-current/15 bg-black/[0.03] px-3 py-2.5 text-xs text-muted-foreground dark:bg-white/[0.04]">
      <Icon className="mt-px size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p>Mídia indisponível (recebida antes da atualização)</p>
        <p className="text-[11px] leading-snug opacity-85">Use “Carregar arquivos”, no topo da conversa, para tentar recuperar.</p>
      </div>
    </div>
  );
}

const PROMPT_LABELS: Record<WaMedia["kind"], string> = {
  image: "Foto",
  video: "Vídeo",
  audio: "Áudio",
  voice: "Mensagem de voz",
  document: "Documento",
  sticker: "Figurinha",
};

/** Not on this computer yet: thumbnail (when stored) or type icon, size and "Baixar". */
export function MediaDownloadPrompt({ media, mediaKey, onReady }: { media: WaMedia; mediaKey: MediaKey; onReady: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = PROMPT_LABELS[media.kind];
  const size = media.file_size ? formatBytes(media.file_size) : null;
  const meta = [media.duration_s ? formatDuration(media.duration_s) : null, size].filter(Boolean).join(" · ");
  const visual = media.kind === "image" || media.kind === "video" || media.kind === "sticker";
  const Icon = media.kind === "image" || media.kind === "sticker" ? FileImageIcon : kindIcon(media.kind);

  const download = async () => {
    setBusy(true);
    setError(null);
    // 1-byte Range request: the backend downloads and caches the whole file first.
    const message = await diagnose(waMediaUrl("media", mediaKey));
    setBusy(false);
    if (message) setError(message);
    else onReady();
  };

  const button = (
    <Button
      type="button"
      size="sm"
      variant={visual && media.has_thumbnail ? "secondary" : "outline"}
      onClick={() => void download()}
      disabled={busy}
      aria-busy={busy}
      aria-label={busy ? `Baixando ${label.toLowerCase()}` : `Baixar ${label.toLowerCase()}${size ? ` (${size})` : ""}`}
      className={cn("shrink-0", visual && media.has_thumbnail && "shadow-md")}
    >
      {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
      {busy ? "Baixando…" : "Baixar"}
    </Button>
  );

  if (visual && media.has_thumbnail) {
    const box = media.kind === "sticker" ? { width: 144, height: 144 } : boxSize(media, 300, 340);
    return (
      <div className="max-w-full space-y-1.5" style={{ width: box.width }}>
        <div className="relative max-w-full overflow-hidden rounded-md bg-black/5 dark:bg-white/5" style={{ aspectRatio: `${box.width} / ${box.height}` }}>
          <img src={waMediaUrl("thumbnail", mediaKey)} alt="" aria-hidden="true" loading="lazy" className="absolute inset-0 size-full scale-105 object-cover blur-[2px]" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/25">
            {button}
            <span className="rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white tabular">{[label, meta].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        {error && <MediaError message={error} onRetry={() => void download()} />}
      </div>
    );
  }

  return (
    <div className="w-72 max-w-full space-y-1.5">
      <div className="flex items-center gap-3 rounded-md bg-black/[0.04] p-2.5 dark:bg-white/[0.06]">
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md" aria-hidden="true">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          <p className="text-muted-foreground text-xs tabular">{meta || "Tamanho desconhecido"}</p>
        </div>
        {button}
      </div>
      {error && <MediaError message={error} onRetry={() => void download()} />}
    </div>
  );
}

/** Display box for a visual media: keeps the aspect ratio inside max bounds. */
function boxSize(media: WaMedia, maxW: number, maxH: number): { width: number; height: number } {
  const w = media.width ?? 0;
  const h = media.height ?? 0;
  if (w <= 0 || h <= 0) return { width: maxW, height: Math.round(maxW * 0.75) };
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { width: Math.max(120, Math.round(w * scale)), height: Math.max(80, Math.round(h * scale)) };
}

/* ---------------- image / sticker ---------------- */

export function MediaImage({ media, mediaKey, caption }: { media: WaMedia; mediaKey: MediaKey; caption: string | null }) {
  const sticker = media.kind === "sticker";
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const { url, downloadUrl, error, fail, retry } = useMediaSource(mediaKey);
  const thumbUrl = media.has_thumbnail ? waMediaUrl("thumbnail", mediaKey) : null;
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const size = sticker ? { width: 144, height: 144 } : boxSize(media, 300, 340);

  if (error) {
    return (
      <div style={{ width: Math.min(size.width, 300) }} className="max-w-full">
        <MediaError message={error} onRetry={retry} />
      </div>
    );
  }

  const image = (
    <div
      ref={ref}
      className={cn("relative max-w-full overflow-hidden", sticker ? "" : "rounded-md bg-black/5 dark:bg-white/5")}
      style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }}
    >
      {near && thumbUrl && !loaded && (
        <img src={thumbUrl} alt="" aria-hidden="true" className="absolute inset-0 size-full scale-105 object-cover blur-sm" />
      )}
      {near && (
        <img
          src={url}
          alt={caption ? `Foto: ${caption.slice(0, 80)}` : sticker ? "Figurinha" : "Foto"}
          decoding="async"
          ref={(img) => {
            // The load event is sometimes missed (cache, SVG); decode() settles either way.
            img?.decode().then(
              () => setLoaded(true),
              () => undefined,
            );
          }}
          onLoad={() => setLoaded(true)}
          onError={fail}
          className={cn("absolute inset-0 size-full transition-opacity", sticker ? "object-contain" : "object-cover", loaded ? "opacity-100" : "opacity-0")}
        />
      )}
      {!loaded && (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <Loader2Icon className="size-5 animate-spin text-muted-foreground/70" />
        </span>
      )}
    </div>
  );

  if (sticker) return image;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block max-w-full rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        aria-label="Abrir foto em tela cheia"
      >
        {image}
      </button>
      <Lightbox open={open} onOpenChange={setOpen} src={url} downloadUrl={downloadUrl} caption={caption} />
    </>
  );
}

function Lightbox({
  open,
  onOpenChange,
  src,
  downloadUrl,
  caption,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  src: string;
  downloadUrl: string;
  caption: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[95dvh] w-auto max-w-[95vw] flex-col gap-3 p-3 sm:max-w-[95vw]">
        <DialogTitle className="sr-only">Foto</DialogTitle>
        <DialogDescription className="sr-only">{caption || "Foto recebida no WhatsApp"}</DialogDescription>
        <img src={src} alt={caption || "Foto"} className="mx-auto max-h-[78dvh] max-w-full rounded-md object-contain" />
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap">{caption}</p>
          <Button asChild size="sm" variant="outline" className="mr-6">
            <a href={downloadUrl} download>
              <DownloadIcon /> Baixar
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- video ---------------- */

export function MediaVideo({ media, mediaKey, autoPlay = false }: { media: WaMedia; mediaKey: MediaKey; autoPlay?: boolean }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const { url, error, fail, retry } = useMediaSource(mediaKey);
  const size = boxSize(media, 300, 340);
  const poster = media.has_thumbnail && near ? waMediaUrl("thumbnail", mediaKey) : undefined;

  if (error) {
    return (
      <div style={{ width: size.width }} className="max-w-full">
        <MediaError message={error} onRetry={retry} />
      </div>
    );
  }
  return (
    <div ref={ref} className="relative max-w-full overflow-hidden rounded-md bg-black" style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }}>
      <video
        key={url}
        src={url}
        poster={poster}
        controls
        autoPlay={autoPlay}
        preload="none"
        playsInline
        onError={fail}
        className="size-full object-contain"
        aria-label={`Vídeo${media.duration_s ? ` de ${formatDuration(media.duration_s)}` : ""}`}
      />
      {media.duration_s ? (
        <span className="pointer-events-none absolute top-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white tabular">
          {formatDuration(media.duration_s)}
        </span>
      ) : null}
    </div>
  );
}

/* ---------------- audio / voice ---------------- */

let playingAudio: HTMLAudioElement | null = null;
const RATES = [1, 1.5, 2] as const;

export function AudioPlayer({ media, mediaKey, fromMe, autoPlay = false }: { media: WaMedia; mediaKey: MediaKey; fromMe: boolean; autoPlay?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const { url, error, fail, retry } = useMediaSource(mediaKey);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(media.duration_s ?? 0);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const voice = media.kind === "voice";

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (playingAudio && playingAudio !== audio) playingAudio.pause();
    playingAudio = audio;
    setLoading(true);
    try {
      await audio.play();
    } catch {
      // onError (network/codec) diagnoses; NotAllowedError etc. just stop the spinner.
    } finally {
      setLoading(false);
    }
  };

  // Just downloaded by the user's click: start playing right away (once).
  const autoPlayed = useRef(false);
  useEffect(() => {
    if (!autoPlay || autoPlayed.current) return;
    autoPlayed.current = true;
    void toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [autoPlay]);

  if (error) return <MediaError message={error} onRetry={retry} className="w-64 max-w-full" />;

  const max = duration > 0 ? duration : 1;
  return (
    <div className="flex w-72 max-w-full items-center gap-2.5 py-0.5">
      {voice && (
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            fromMe ? "bg-success/20 text-success" : "bg-brand/12 text-brand",
          )}
          aria-hidden="true"
        >
          <MicIcon className="size-4" />
        </span>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="shrink-0 rounded-full"
        onClick={toggle}
        aria-label={playing ? "Pausar áudio" : voice ? "Reproduzir mensagem de voz" : "Reproduzir áudio"}
      >
        {loading ? <Loader2Icon className="animate-spin" /> : playing ? <PauseIcon className="fill-current" /> : <PlayIcon className="fill-current" />}
      </Button>
      <div className="min-w-0 flex-1 space-y-1">
        <Slider
          value={[Math.min(current, max)]}
          max={max}
          step={0.1}
          onValueChange={([value]) => {
            if (audioRef.current && value != null) {
              audioRef.current.currentTime = value;
              setCurrent(value);
            }
          }}
          thumbLabels={["Posição do áudio"]}
          aria-valuetext={`${formatDuration(current)} de ${formatDuration(duration)}`}
          className="py-1"
        />
        <span className="text-muted-foreground block text-[11px] tabular">{formatDuration(playing || current > 0 ? current : duration)}</span>
      </div>
      <Button
        type="button"
        size="xs"
        variant="secondary"
        className="w-10 shrink-0 rounded-full tabular"
        onClick={() => setRate((r) => RATES[(RATES.indexOf(r) + 1) % RATES.length]!)}
        aria-label={`Velocidade ${rate}x. Alterar velocidade`}
      >
        {rate.toLocaleString("pt-BR")}x
      </Button>
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
          e.currentTarget.playbackRate = rate;
        }}
        onError={() => {
          setPlaying(false);
          setLoading(false);
          fail();
        }}
      />
    </div>
  );
}

/* ---------------- document ---------------- */

const DOC_ICONS: Record<DocCategory, LucideIcon> = {
  pdf: FileTextIcon,
  sheet: FileSpreadsheetIcon,
  slides: PresentationIcon,
  text: FileTextIcon,
  archive: FileArchiveIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  image: FileImageIcon,
  file: FileIcon,
};

const DOC_TONES: Partial<Record<DocCategory, string>> = {
  pdf: "bg-destructive/12 text-destructive",
  sheet: "bg-success/15 text-success",
  slides: "bg-warning/20 text-warning-foreground dark:text-warning",
  text: "bg-brand/12 text-brand",
};

export function DocumentCard({
  media,
  mediaKey,
  cached = true,
  onDownloaded,
}: {
  media: WaMedia;
  mediaKey: MediaKey;
  /** false: not on this computer yet; the button reads "Baixar". */
  cached?: boolean;
  onDownloaded?: () => void;
}) {
  const downloadUrl = waMediaUrl("media", mediaKey);
  const [checking, setChecking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const category = docCategory(media.mimetype, media.file_name);
  const Icon = DOC_ICONS[category];
  const name = media.file_name || "Documento";
  const ext = fileExtension(media.file_name, media.mimetype);
  const meta = [ext, media.file_size ? formatBytes(media.file_size) : null].filter(Boolean).join(" · ");

  // Preflight (1-byte Range) so failures show inline instead of a broken download.
  const download = async () => {
    setChecking(true);
    setLocalError(null);
    try {
      const response = await fetch(downloadUrl, { headers: { Range: "bytes=0-0" } });
      if (!response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        setLocalError(mediaErrorMessage(response.status, body));
        return;
      }
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = name;
      a.rel = "noopener";
      document.body.append(a);
      a.click();
      a.remove();
      onDownloaded?.();
    } catch {
      setLocalError(mediaErrorMessage(0, null));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="w-72 max-w-full space-y-1.5">
      {media.has_thumbnail && category === "pdf" && (
        <img src={waMediaUrl("thumbnail", mediaKey)} alt="" loading="lazy" className="max-h-40 w-full rounded-md bg-white object-cover object-top" />
      )}
      <div className="flex items-center gap-3 rounded-md bg-black/[0.04] p-2.5 dark:bg-white/[0.06]">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-md", DOC_TONES[category] ?? "bg-muted text-muted-foreground")} aria-hidden="true">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={name}>
            {name}
          </p>
          {meta && <p className="text-muted-foreground text-xs tabular">{meta}</p>}
        </div>
        {cached ? (
          <Button type="button" size="icon-sm" variant="ghost" className="shrink-0 rounded-full" onClick={download} disabled={checking} aria-label={`Baixar ${name}`}>
            {checking ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
          </Button>
        ) : (
          <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={download} disabled={checking} aria-busy={checking} aria-label={`Baixar ${name}`}>
            {checking ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
            {checking ? "Baixando…" : "Baixar"}
          </Button>
        )}
      </div>
      {localError && <MediaError message={localError} onRetry={() => void download()} />}
    </div>
  );
}

/* ---------------- dispatcher ---------------- */

export function MessageMedia({ media, mediaKey, caption, fromMe }: { media: WaMedia; mediaKey: MediaKey; caption: string | null; fromMe: boolean }): ReactNode {
  // Downloaded from this bubble (the list still says cached:false until reloaded).
  const [downloaded, setDownloaded] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const display = mediaDisplay(media, downloaded);
  if (display === "unavailable") return <MediaUnavailable kind={media.kind} />;
  if (media.kind === "document") {
    return <DocumentCard media={media} mediaKey={mediaKey} cached={display === "cached"} onDownloaded={() => setDownloaded(true)} />;
  }
  if (display === "download") {
    return (
      <MediaDownloadPrompt
        media={media}
        mediaKey={mediaKey}
        onReady={() => {
          setAutoPlay(true);
          setDownloaded(true);
        }}
      />
    );
  }
  switch (media.kind) {
    case "image":
    case "sticker":
      return <MediaImage media={media} mediaKey={mediaKey} caption={caption} />;
    case "video":
      return <MediaVideo media={media} mediaKey={mediaKey} autoPlay={autoPlay} />;
    default:
      return <AudioPlayer media={media} mediaKey={mediaKey} fromMe={fromMe} autoPlay={autoPlay} />;
  }
}
