import { useEffect, useState } from "react";
import { api } from "./api";
import type { FilmAssemblyRef } from "./types";

// Client-side reassembly of chunked films. A finished film is stored
// server-side as ordered ≤256KB chunk blobs (the server cannot read
// blob bytes back, so reassembly can only happen here). Before the
// user is offered a player or a download, the assembled bytes are
// verified three ways: exact total length, whole-file SHA-256 against
// the manifest registered at save time, and the MP4 box structure —
// the checks whose absence once handed the user truncated "error
// files" from every download surface.

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    if (!manifest.found || !manifest.sealed) {
      throw new Error("这份成片的分片还没有全部保存完成，暂时无法拼装");
    }
    if (manifest.chunk_urls.length !== manifest.chunk_count) {
      throw new Error(
        `成片分片不齐：应有 ${manifest.chunk_count} 片，只拿到 ${manifest.chunk_urls.length} 片的地址`,
      );
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const url of manifest.chunk_urls) {
      const res = await fetch(url);
      if (!res.ok) throw new Error("有一片成片分片读取失败，请稍后重试");
      const buf = new Uint8Array(await res.arrayBuffer());
      parts.push(buf);
      total += buf.length;
    }
    if (total !== manifest.total_bytes) {
      throw new Error(
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
      throw new Error("拼装出的成片校验和对不上，文件已损坏，不会提供播放或下载");
    }
    const mime = manifest.mime || "video/mp4";
    if (mime.includes("mp4") || mime.includes("quicktime")) {
      const problem = mp4StructureProblem(bytes);
      if (problem) throw new Error(`拼装出的成片结构不完整：${problem}`);
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
  | { phase: "error"; message: string };

/** Player for a chunked film: with autoLoad it assembles + verifies on
 *  mount and only then shows a <video>; otherwise it waits for a click
 *  (history rail, where several films may be listed). Verification
 *  failure shows a plain error and NO download — never a broken file. */
export function AssembledFilmPlayer(props: {
  assembly: FilmAssemblyRef;
  title: string;
  autoLoad: boolean;
  onBroken?: () => void;
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
        setState({
          phase: "error",
          message: e instanceof Error ? e.message : "成片拼装失败",
        });
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
        className="h-full w-full object-contain"
      />
    </div>
  );
}
