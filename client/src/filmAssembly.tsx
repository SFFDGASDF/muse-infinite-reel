import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { FilmAssemblyRef } from "./types";

// Playback/download of chunked films, two paths:
// 1. PRIMARY — the direct whole-file URL from getFilmFile: the server
//    keeps one blob holding the complete MP4 (written at import time,
//    or materialized once from the sealed chunks / delivery file and
//    verified against the sealed manifest then). The browser fetches
//    that single file — downloads start on click, the player streams
//    it directly. No chunk fetches, no reassembly, no repeat
//    verification: sealing already verified every chunk's hash and
//    the whole-file total before the film was marked done, so
//    re-verifying on every click was pure waiting.
// 2. FALLBACK — client-side reassembly (below), used only when no
//    whole-file copy exists or the direct file fails to load. The
//    assembled bytes are verified three ways: exact total length,
//    whole-file SHA-256 against the manifest registered at save time,
//    and the MP4 box structure — the checks whose absence once handed
//    the user truncated "error files" from every download surface.

/** MP4 box-structure walk (client port of the old server gate): walk
 *  the top-level boxes, require ftyp first plus a complete moov and
 *  mdat, and require the walk to land exactly on EOF. Returns a
 *  plain-language problem, or null when the file is structurally whole. */
export function mp4StructureProblem(bytes: Uint8Array): string | null {
  if (bytes.length < 16) {
    return `文件只有 ${bytes.length} 字节，装不下一个完整的 MP4`;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const typeAt = (off: number) =>
    String.fromCharCode(
      bytes[off] ?? 0,
      bytes[off + 1] ?? 0,
      bytes[off + 2] ?? 0,
      bytes[off + 3] ?? 0,
    );
  let offset = 0;
  let boxes = 0;
  let sawMoov = false;
  let sawMdat = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      return `文件在第 ${offset} 字节处被截断（连一个完整的 box 头都不到）`;
    }
    let size = view.getUint32(offset);
    const type = typeAt(offset + 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > bytes.length) {
        return `文件在第 ${offset} 字节处被截断（${type} 的 64 位长度没传完）`;
      }
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (size < header) {
      return `第 ${offset} 字节处的 ${type || "未知"} box 长度 ${size} 不合法，文件已损坏`;
    }
    if (offset + size > bytes.length) {
      return `${type} box 声明长度 ${size} 字节，但文件在第 ${offset} 字节处就结束了——文件被截断`;
    }
    if (boxes === 0 && type !== "ftyp") {
      return `文件第一个 box 是 ${type || "未知"} 而不是 ftyp，不是有效的 MP4`;
    }
    if (type === "moov") sawMoov = true;
    if (type === "mdat") sawMdat = true;
    offset += size;
    boxes++;
  }
  if (offset !== bytes.length) return "文件 box 结构对不齐，末尾有多余或缺失的字节";
  if (!sawMoov) return "文件里没有完整的 moov box（影片信息缺失），无法播放";
  if (!sawMdat) return "文件里没有 mdat box（没有画面数据），无法播放";
  return null;
}

async function sha256HexSubtle(bytes: Uint8Array): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") return null;
  try {
    const digest = await subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // WebCrypto exists but refused (odd contexts, detached buffers):
    // fall through to the pure-JS implementation below.
    return null;
  }
}

// Pure-JS SHA-256 (FIPS 180-4). Fallback for runtimes where WebCrypto's
// SubtleCrypto is unavailable — notably non-secure contexts, where
// `crypto.subtle` is undefined and reading `.digest` off it throws
// "Cannot read properties of undefined (reading 'digest')". That exact
// crash once made every chunked film in the user's client report itself
// "damaged" even though its bytes were intact: the verification step
// died before it could verify anything. The fallback keeps the
// whole-file hash check at full strength in every context.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256HexPure(bytes: Uint8Array): string {
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const len = bytes.length;
  const paddedLen = (((len + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  // Bit length as a 64-bit big-endian integer (high word is 0 for any
  // film this tool handles, but write both halves correctly anyway).
  view.setUint32(paddedLen - 4, (len << 3) >>> 0);
  view.setUint32(paddedLen - 8, Math.floor(len / 0x20000000) >>> 0);
  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLen; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15] ?? 0, 7) ^ rotr(w[t - 15] ?? 0, 18) ^ ((w[t - 15] ?? 0) >>> 3);
      const s1 = rotr(w[t - 2] ?? 0, 17) ^ rotr(w[t - 2] ?? 0, 19) ^ ((w[t - 2] ?? 0) >>> 10);
      w[t] = ((w[t - 16] ?? 0) + s0 + (w[t - 7] ?? 0) + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (SHA256_K[t] ?? 0) + (w[t] ?? 0)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return (await sha256HexSubtle(bytes)) ?? sha256HexPure(bytes);
}

/** An assembly problem with user-facing copy. Raw engine exceptions
 *  (TypeErrors from fetch/WebCrypto, DOMExceptions, …) must never be
 *  interpolated into the UI — callers render only FilmAssemblyError
 *  messages verbatim and map everything else through
 *  filmAssemblyErrorText. */
export class FilmAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilmAssemblyError";
  }
}

/** The server has no (sealed) assembly record for this request at all —
 *  e.g. a film saved by the old single-blob mechanism whose node still
 *  carries a stale manifest. Callers with a plain blob URL to fall back
 *  to should use it instead of declaring the film damaged. */
export class AssemblyUnavailableError extends FilmAssemblyError {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyUnavailableError";
  }
}

/** Clean, user-facing text for any assembly failure: our own errors
 *  carry plain-language copy already; anything else becomes a generic
 *  sentence with no raw exception text in it. */
export function filmAssemblyErrorText(e: unknown): string {
  if (e instanceof FilmAssemblyError) return e.message;
  return "拼装时出现未知错误，暂时无法确认这份成片的完整性";
}

export interface AssembledFilm {
  blob: Blob;
  objectUrl: string;
  totalBytes: number;
}

// One assembly per film request, shared by the node player, the banner
// download, and the history entry so the chunks are fetched only once.
const assemblyCache = new Map<number, Promise<AssembledFilm>>();

export function assembleFilm(requestId: number): Promise<AssembledFilm> {
  const cached = assemblyCache.get(requestId);
  if (cached) return cached;
  const promise = (async (): Promise<AssembledFilm> => {
    const manifest = await api.getFilmAssembly({ requestId });
    if (!manifest.found) {
      throw new AssemblyUnavailableError("这份成片没有分片保存记录");
    }
    if (!manifest.sealed) {
      throw new AssemblyUnavailableError("这份成片的分片还没有全部保存完成，暂时无法拼装");
    }
    if (manifest.chunk_urls.length !== manifest.chunk_count) {
      throw new FilmAssemblyError(
        `成片分片不齐：应有 ${manifest.chunk_count} 片，只拿到 ${manifest.chunk_urls.length} 片的地址`,
      );
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const url of manifest.chunk_urls) {
      let res: Response;
      try {
        res = await fetch(url);
      } catch {
        throw new FilmAssemblyError("有一片成片分片读取失败，请稍后重试");
      }
      if (!res.ok) throw new FilmAssemblyError("有一片成片分片读取失败，请稍后重试");
      const buf = new Uint8Array(await res.arrayBuffer());
      parts.push(buf);
      total += buf.length;
    }
    if (total !== manifest.total_bytes) {
      throw new FilmAssemblyError(
        `拼装出的成片长度不对：应为 ${manifest.total_bytes} 字节，实际 ${total} 字节，文件不完整`,
      );
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const part of parts) {
      bytes.set(part, off);
      off += part.length;
    }
    const digest = await sha256Hex(bytes);
    if (digest !== manifest.sha256.toLowerCase()) {
      throw new FilmAssemblyError("拼装出的成片校验和对不上，文件已损坏，不会提供播放或下载");
    }
    const mime = manifest.mime || "video/mp4";
    if (mime.includes("mp4") || mime.includes("quicktime")) {
      const problem = mp4StructureProblem(bytes);
      if (problem) throw new FilmAssemblyError(`拼装出的成片结构不完整：${problem}`);
    }
    const blob = new Blob([bytes as BlobPart], { type: mime });
    return { blob, objectUrl: URL.createObjectURL(blob), totalBytes: total };
  })();
  // A failed assembly must not poison the cache — a retry refetches.
  promise.catch(() => assemblyCache.delete(requestId));
  assemblyCache.set(requestId, promise);
  return promise;
}

/** Assemble (with full verification) and save the film as a download. */
export async function downloadAssembledFilm(
  requestId: number,
  filename: string,
): Promise<void> {
  const film = await assembleFilm(requestId);
  const a = document.createElement("a");
  a.href = film.objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type AssemblyState =
  | { phase: "loading" }
  | { phase: "ready"; film: AssembledFilm }
  | { phase: "error"; message: string }
  | { phase: "unavailable"; message: string };

/** Player for a chunked film: with autoLoad it assembles + verifies on
 *  mount and only then shows a <video>; otherwise it waits for a click
 *  (history rail, where several films may be listed). Verification
 *  failure shows a plain error and NO download — never a broken file.
 *  When the server has no assembly record for the request at all and
 *  the caller still holds a plain blob URL for the film (old-format
 *  saves), onUnavailable fires so the caller can fall back to the
 *  ordinary player/download path instead of an error state. */
export function AssembledFilmPlayer(props: {
  assembly: FilmAssemblyRef;
  title: string;
  autoLoad: boolean;
  onBroken?: () => void;
  onUnavailable?: () => void;
}) {
  const { assembly } = props;
  const [started, setStarted] = useState(props.autoLoad);
  const [state, setState] = useState<AssemblyState>({ phase: "loading" });

  useEffect(() => {
    if (!started) return;
    let alive = true;
    setState({ phase: "loading" });
    assembleFilm(assembly.requestId)
      .then((film) => {
        if (alive) setState({ phase: "ready", film });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof AssemblyUnavailableError && props.onUnavailable) {
          props.onUnavailable();
          return;
        }
        if (e instanceof AssemblyUnavailableError) {
          setState({ phase: "unavailable", message: e.message });
          return;
        }
        setState({ phase: "error", message: filmAssemblyErrorText(e) });
        props.onBroken?.();
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, assembly.requestId]);

  if (!started) {
    return (
      <button
        type="button"
        className="w-full rounded-md border border-[var(--cyan)] px-2 py-2 text-xs font-medium text-[var(--cyan)]"
        aria-label={`拼装并播放成片 ${props.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setStarted(true);
        }}
      >
        ▶ 播放成片（{assembly.chunkCount > 0 ? `${assembly.chunkCount} 片拼装，` : "分片拼装，"}播放前先校验完整性）
      </button>
    );
  }
  if (state.phase === "loading") {
    return (
      <p role="status" className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-center text-[11px] text-[var(--dim)]">
        正在拼装成片{assembly.chunkCount > 0 ? `（${assembly.chunkCount} 片）` : ""}并校验完整性…
      </p>
    );
  }
  if (state.phase === "unavailable") {
    return (
      <p role="alert" className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-[11px] leading-snug text-[#ff7a5c]">
        {state.message}，这份成片无法在此播放。点「生成并合成成片」重新生成一份即可。
      </p>
    );
  }
  if (state.phase === "error") {
    return (
      <p role="alert" className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-[11px] leading-snug text-[#ff7a5c]">
        这份成片拼装校验没通过：{state.message}。点「生成并合成成片」重新生成一份即可。
      </p>
    );
  }
  return (
    <div className="relative w-full overflow-hidden rounded-md bg-black" style={{ aspectRatio: "16/10" }}>
      <video
        src={state.film.objectUrl}
        controls
        playsInline
        draggable={false}
        className="h-full w-full object-contain"
      />
    </div>
  );
}

/** Shared query for a film's direct whole-file URL. The player and
 *  the download link for the same film share one cache entry, and the
 *  query starts resolving as soon as either mounts — by the time the
 *  user clicks 下载， the plain <a href download> is already in place
 *  and the browser download starts immediately. */
function useFilmFile(requestId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["filmFile", requestId],
    queryFn: () => api.getFilmFile({ requestId }),
    enabled,
    staleTime: 60_000,
  });
}

/** Player for a chunked film, direct-file first: as soon as the
 *  whole-file URL resolves, a plain <video> streams it — no assembly
 *  or verification state ever shows. The fall back to the verified
 *  chunk-reassembly player is gated on POSITIVE evidence, because
 *  two transient states used to be misread as "no direct file" and
 *  dumped the user into a minutes-long 1190-chunk reassembly even
 *  though the whole file existed and its download link right beside
 *  the player already pointed at it:
 *  - a FAILED getFilmFile query (network/gateway error) — that is
 *    "unknown", not "no file": the player now shows a retry control
 *    for the query itself and never assembles on a query error;
 *  - a <video> element error while streaming a large file during
 *    the page-load burst (observed as ERR_FAILED on a 39MB film
 *    while a 5.9MB film on the same page streamed fine, and while
 *    the same bytes later loaded without trouble) — the player now
 *    retries the SAME direct URL several times with growing delays
 *    before believing the file is unloadable.
 *  Only a definitive server answer (found, but no whole-file URL —
 *  no copy exists and none could be materialized) or a direct
 *  stream that still fails after every retry drops back to chunk
 *  reassembly. When the server has no assembly record at all,
 *  onUnavailable fires (same contract as AssembledFilmPlayer) so
 *  callers with a legacy plain blob URL can fall back to it. */
const DIRECT_LOAD_RETRIES = 4;

export function DirectFilmPlayer(props: {
  assembly: FilmAssemblyRef;
  title: string;
  autoLoad: boolean;
  onBroken?: () => void;
  onUnavailable?: () => void;
}) {
  const { assembly } = props;
  const [started, setStarted] = useState(props.autoLoad);
  // Direct-stream attempt counter: bumping it remounts the <video>
  // against the same URL for a fresh load. `gaveUp` is set only
  // after DIRECT_LOAD_RETRIES consecutive media errors.
  const [attempt, setAttempt] = useState(0);
  const [retryWait, setRetryWait] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const retryTimer = useRef<number | null>(null);
  const query = useFilmFile(assembly.requestId, started);
  const data = query.data;

  useEffect(() => {
    if (data && !data.found && props.onUnavailable) props.onUnavailable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.found]);

  // A different film (or a fresh mount) starts the direct-load
  // attempt sequence from scratch.
  useEffect(() => {
    setAttempt(0);
    setRetryWait(false);
    setGaveUp(false);
    if (retryTimer.current != null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, [assembly.requestId]);

  useEffect(
    () => () => {
      if (retryTimer.current != null) window.clearTimeout(retryTimer.current);
    },
    [],
  );

  if (!started) {
    return (
      <button
        type="button"
        className="w-full rounded-md border border-[var(--cyan)] px-2 py-2 text-xs font-medium text-[var(--cyan)]"
        aria-label={`播放成片 ${props.title}`}
        onClick={(e) => {
          e.stopPropagation();
          setStarted(true);
        }}
      >
        ▶ 播放成片
      </button>
    );
  }
  if (data?.url && !gaveUp) {
    if (retryWait) {
      return (
        <p role="status" className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-center text-[11px] text-[var(--dim)]">
          正在加载成片…
        </p>
      );
    }
    return (
      <div className="relative w-full overflow-hidden rounded-md bg-black" style={{ aspectRatio: "16/10" }}>
        <video
          key={attempt}
          src={data.url}
          controls
          playsInline
          draggable={false}
          className="h-full w-full object-contain"
          onError={() => {
            if (attempt + 1 >= DIRECT_LOAD_RETRIES) {
              setGaveUp(true);
              return;
            }
            // Transient stream abort (large file, busy page): wait
            // briefly, then load the SAME direct URL again. The
            // assembly fallback is not entered on a single error.
            setRetryWait(true);
            retryTimer.current = window.setTimeout(
              () => {
                setAttempt((a) => a + 1);
                setRetryWait(false);
              },
              1200 * (attempt + 1),
            );
          }}
        />
      </div>
    );
  }
  if (query.isPending || (query.isFetching && !data)) {
    return (
      <p role="status" className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-center text-[11px] text-[var(--dim)]">
        正在加载成片…
      </p>
    );
  }
  if (query.isError && !data) {
    // The lookup itself failed — nothing is known about the file,
    // so this must NOT be treated as "no direct file": offer a
    // retry of the lookup instead of silently reassembling chunks.
    return (
      <div className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-center">
        <p role="alert" className="text-[11px] leading-snug text-[#ff7a5c]">
          成片地址加载失败，网络可能不稳定。
        </p>
        <button
          type="button"
          className="mt-1.5 rounded-md border border-[var(--cyan)] px-2 py-1 text-[11px] font-medium text-[var(--cyan)]"
          aria-label={`重新加载成片 ${props.title}`}
          onClick={(e) => {
            e.stopPropagation();
            void query.refetch();
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
  // Definitive answers only: the server has the film but no
  // whole-file copy (found, empty url), or the direct stream failed
  // every retry — verified chunk reassembly is the fallback.
  return (
    <AssembledFilmPlayer
      assembly={assembly}
      title={props.title}
      autoLoad
      onBroken={props.onBroken}
      onUnavailable={props.onUnavailable}
    />
  );
}

/** Download control for a chunked film. Once the whole-file URL is
 *  known this is a plain <a href download> — clicking starts the
 *  browser download of the complete MP4 in one request, with no
 *  assembly or verification step in between. While the URL is still
 *  resolving it renders the same label inert; if the server has no
 *  whole-file copy it falls back to the verified assembly download. */
export function DirectFilmDownload(props: {
  requestId: number;
  filename: string;
  className?: string;
  ariaLabel: string;
  children: ReactNode;
  onError?: (message: string) => void;
  onUnavailable?: () => void;
}) {
  const query = useFilmFile(props.requestId, true);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const url = query.data?.url ?? "";
  if (url) {
    return (
      <a
        href={url}
        download={props.filename}
        draggable={false}
        className={props.className}
        aria-label={props.ariaLabel}
      >
        {props.children}
      </a>
    );
  }
  const resolving = query.isPending;
  return (
    <button
      type="button"
      className={`${props.className ?? ""} disabled:opacity-50`}
      aria-label={props.ariaLabel}
      disabled={resolving || fallbackBusy}
      onClick={(e) => {
        e.stopPropagation();
        // A failed lookup is "unknown", not "no direct file": retry
        // the lookup first; only a definitive answer without a URL
        // may use the verified assembly download.
        if (query.isError && !query.data) {
          void query.refetch();
          return;
        }
        setFallbackBusy(true);
        downloadAssembledFilm(props.requestId, props.filename)
          .catch((err: unknown) => {
            if (err instanceof AssemblyUnavailableError && props.onUnavailable) {
              props.onUnavailable();
              return;
            }
            props.onError?.(filmAssemblyErrorText(err));
          })
          .finally(() => setFallbackBusy(false));
      }}
    >
      {props.children}
    </button>
  );
}
