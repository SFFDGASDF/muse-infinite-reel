// Actions for the infinite-canvas video studio.
//
// Projects hold their whole node/edge graph as one JSON document; media
// (generated keyframes, uploaded assets, composed videos) lives in
// ctx.blobs with only the blob key persisted on nodes / history rows.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import { contracts } from "@space/privileged";

const projectSummary = z.object({
  id: z.number(),
  name: z.string(),
  updated_at: z.string(),
  created_at: z.string(),
});

const generationRow = z.object({
  id: z.number(),
  kind: z.enum(["image", "video"]),
  prompt: z.string(),
  node_id: z.string(),
  url: z.string(),
  created_at: z.string(),
  /** True when this video is a chunked film assembly. `url` carries
   *  the whole-file copy's URL when one exists; otherwise it is empty
   *  and the client resolves the film via `film_request_id`
   *  (getFilmFile first, chunked assembly as fallback). */
  chunked: z.boolean(),
  film_request_id: z.number().nullable(),
});

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- film generation via a background Muse task ------------------------
// The page itself has no video model. When the user clicks
// 「生成并合成成片」, requestFilm stores the ordered shot list on a
// film_requests row and spawns a background Muse task; that task reads
// the shots back through getFilmRequest, generates one true-motion clip
// per shot chat-side (Muse's own video generation, max 6 clips per
// round), edits them into one film with ffmpeg, and saves the MP4 back
// via importFilmFromWorkspace: the task drops the delivery encode at
// ~/workspace/film-delivery/<requestId>/delivery.mp4 and the tool reads
// it host-side into small hash-verified chunks, then seals the save.
// No export step exists anywhere in this flow.

interface GraphNodeLike {
  id: string;
  type: string;
  x?: number;
  y?: number;
  title?: string;
  text?: string;
  aspect?: string;
  duration?: number;
  motion?: string;
  blobKey?: string;
  url?: string;
  caption?: string;
  motionPrompt?: string;
  [key: string]: unknown;
}

interface GraphLike {
  nodes: GraphNodeLike[];
  edges: { id?: string; from: string; to: string }[];
  viewport?: unknown;
}

const MOTION_LABELS_SERVER: Record<string, string> = {
  "zoom-in": "推近",
  "zoom-out": "拉远",
  "pan-left": "左移",
  "pan-right": "右移",
  static: "固定",
};

function parseGraphLike(raw: string): GraphLike {
  try {
    const parsed = JSON.parse(raw) as Partial<GraphLike>;
    return {
      nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as GraphNodeLike[]) : [],
      edges: Array.isArray(parsed.edges) ? (parsed.edges as GraphLike["edges"]) : [],
      viewport: parsed.viewport,
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Media-preservation merge: generated media must never be erased by a
 *  graph save that simply doesn't know about it yet. The canvas holds a
 *  local copy of the graph; while the server (agent build, background
 *  film task) writes fresh url/blobKey values onto nodes, a page holding
 *  an older copy can autosave and silently wipe them — the generated
 *  images then "disappear" from the nodes even though the blobs and the
 *  history rows are all still there. Rule: for a node present in BOTH
 *  graphs, if the stored node has media and the incoming node has none,
 *  the stored media wins. A node the incoming graph dropped entirely
 *  stays dropped, and an incoming node WITH media always wins, so
 *  regenerate / replace / upload flows are unaffected. */
function preserveStoredMedia(incoming: GraphLike, stored: GraphLike): GraphLike {
  const storedById = new Map(stored.nodes.map((n) => [n.id, n]));
  return {
    ...incoming,
    nodes: incoming.nodes.map((n) => {
      const s = storedById.get(n.id);
      if (!s) return n;
      const incomingKey = typeof n.blobKey === "string" ? n.blobKey : "";
      const storedKey = typeof s.blobKey === "string" ? s.blobKey : "";
      const incomingAssembly = n.filmAssembly != null && typeof n.filmAssembly === "object";
      const storedAssembly = s.filmAssembly != null && typeof s.filmAssembly === "object";
      if ((incomingKey || incomingAssembly) || (!storedKey && !storedAssembly)) return n;
      return {
        ...n,
        blobKey: s.blobKey,
        url: typeof s.url === "string" ? s.url : n.url,
        filmAssembly: storedAssembly ? s.filmAssembly : n.filmAssembly,
        status: n.status === "error" ? "idle" : n.status,
        error: n.status === "error" ? "" : n.error,
      };
    }),
  };
}

/** Response-level self-heal for graphs saved before the preservation
 *  merge existed: an image/video node with no media whose generation
 *  history rows DO exist gets its latest recorded media back (blob key
 *  + a freshly resolved URL). Only fills empty nodes; a node that never
 *  generated anything stays empty. This does not rewrite the stored
 *  graph — the next client save persists the healed copy through the
 *  normal save path (which now preserves it). */
async function backfillNodeMediaFromHistory(
  ctx: Ctx,
  db: AgentDb,
  projectId: number,
  graph: GraphLike,
): Promise<GraphLike> {
  const emptyMedia = graph.nodes.filter(
    (n) =>
      (n.type === "image" || n.type === "video") &&
      !(typeof n.blobKey === "string" && n.blobKey) &&
      !(n.filmAssembly != null && typeof n.filmAssembly === "object"),
  );
  if (emptyMedia.length === 0) return graph;
  const gens = await db
    .select()
    .from(schema.generations)
    .where(eq(schema.generations.projectId, projectId))
    .orderBy(desc(schema.generations.id));
  if (gens.length === 0) return graph;
  const wanted = new Set(emptyMedia.map((n) => n.id));
  const latestByNode = new Map<string, string>();
  for (const g of gens) {
    // Chunked films store an assembly marker as their blob_key, not a
    // playable blob — their nodes heal via the filmAssembly field the
    // finalize patch wrote, never through this URL backfill.
    if (isFilmAssemblyMarker(g.blobKey)) continue;
    if (g.nodeId && wanted.has(g.nodeId) && !latestByNode.has(g.nodeId)) {
      latestByNode.set(g.nodeId, g.blobKey);
    }
  }
  if (latestByNode.size === 0) return graph;
  const nodes: GraphNodeLike[] = [];
  for (const n of graph.nodes) {
    const key = latestByNode.get(n.id);
    if (!key) {
      nodes.push(n);
      continue;
    }
    nodes.push({
      ...n,
      blobKey: key,
      url: await ctx.blobs.getUrl(key),
      status: n.status === "error" ? "idle" : n.status,
      error: n.status === "error" ? "" : n.error,
    });
  }
  return { ...graph, nodes };
}

function upstreamOf(graph: GraphLike, nodeId: string): GraphNodeLike[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.to === nodeId)
    .map((e) => byId.get(e.from))
    .filter((n): n is GraphNodeLike => n != null);
}

/** Same effective prompt the canvas uses for image generation: connected
 *  text nodes + the node's own text + the cinematic suffix. */
function effectivePromptServer(graph: GraphLike, node: GraphNodeLike): string {
  const parts: string[] = [];
  for (const up of upstreamOf(graph, node.id)) {
    if (up.type === "text" && (up.text ?? "").trim()) parts.push((up.text as string).trim());
  }
  if ((node.text ?? "").trim()) parts.push((node.text as string).trim());
  const base = parts.join("。");
  if (!base) return "";
  return `${base}。电影级画面质感，构图讲究，光影细腻，高清细节`;
}

interface FilmShot {
  index: number;
  nodeId: string;
  title: string;
  blobKey: string;
  imagePrompt: string;
  motionPrompt: string;
  caption: string;
  duration: number;
  cameraMotion: string;
  aspect: string;
}

/** Ordered shots for a film: the given package node's wired image nodes
 *  in edge order; otherwise the (first) package node that has images
 *  wired in; otherwise every image node on the canvas in reading order
 *  (top-to-bottom, then left-to-right). Shots whose image was never
 *  generated/uploaded are reported by title in `missing`. */
function collectFilmShots(
  graph: GraphLike,
  packageNodeId?: string,
): { packageNodeId: string; orderedCount: number; missing: string[]; shots: FilmShot[] } {
  let pkg: GraphNodeLike | undefined;
  if (packageNodeId) {
    pkg = graph.nodes.find((n) => n.id === packageNodeId && n.type === "video");
  }
  if (!pkg) {
    pkg = graph.nodes.find(
      (n) => n.type === "video" && upstreamOf(graph, n.id).some((u) => u.type === "image"),
    );
  }
  let ordered: GraphNodeLike[] = [];
  if (pkg) ordered = upstreamOf(graph, pkg.id).filter((u) => u.type === "image");
  if (ordered.length === 0) {
    ordered = [...graph.nodes]
      .filter((n) => n.type === "image")
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
  }
  const missing: string[] = [];
  const shots: FilmShot[] = [];
  for (const n of ordered) {
    const blobKey = (n.blobKey ?? "").trim();
    if (!blobKey) {
      missing.push(n.title ?? "未命名镜头");
      continue;
    }
    shots.push({
      index: shots.length + 1,
      nodeId: n.id,
      title: n.title ?? `镜头 ${shots.length + 1}`,
      blobKey,
      imagePrompt: effectivePromptServer(graph, n) || (n.text ?? "").trim() || n.title || "",
      motionPrompt: (n.motionPrompt ?? "").trim(),
      caption: (n.caption ?? "").trim(),
      duration: typeof n.duration === "number" && n.duration > 0 ? n.duration : 3,
      cameraMotion: MOTION_LABELS_SERVER[n.motion ?? "zoom-in"] ?? "推近",
      aspect: n.aspect ?? "16:9",
    });
  }
  return { packageNodeId: pkg?.id ?? "", orderedCount: ordered.length, missing, shots };
}

const filmRequestResponse = z.object({
  ok: z.boolean(),
  request_id: z.number().nullable(),
  shot_count: z.number(),
  status: z.string(),
  error: z.string(),
  already: z.boolean(),
});

const filmStatusResponse = z.object({
  status: z.enum(["none", "queued", "running", "done", "failed"]),
  request_id: z.number().nullable(),
  shot_count: z.number(),
  progress_done: z.number(),
  progress_stage: z.string(),
  film_url: z.string(),
  /** True when the finished film was saved as chunks: film_url is
   *  empty and the client reassembles via getFilmAssembly(request_id). */
  film_chunked: z.boolean(),
  error: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  is_stalled: z.boolean(),
});

const filmAssemblyResponse = z.object({
  found: z.boolean(),
  sealed: z.boolean(),
  chunk_count: z.number(),
  received_count: z.number(),
  total_bytes: z.number(),
  sha256: z.string(),
  mime: z.string(),
  chunk_urls: z.array(z.string()),
});

/** Direct whole-file access for a sealed chunked film: `url` points at
 *  ONE blob holding the complete MP4, so the browser downloads/plays
 *  it in a single request — no per-chunk fetches, no client-side
 *  reassembly, no repeat verification (the seal already verified every
 *  chunk's hash and the whole-file total before marking the film
 *  done). `url` is empty when no whole-file copy could be produced;
 *  the client then falls back to the chunked assembly path. */
const filmFileResponse = z.object({
  found: z.boolean(),
  sealed: z.boolean(),
  url: z.string(),
  total_bytes: z.number(),
  sha256: z.string(),
  mime: z.string(),
  chunk_count: z.number(),
});

const filmProgressResponse = z.object({ ok: z.literal(true) });
const cancelFilmResponse = z.object({
  ok: z.boolean(),
  cancelled: z.boolean(),
  error: z.string(),
});

// Stall detection for background film generation.
// The background task reports progress via reportFilmProgress after each
// finished clip (and at stage changes); every report bumps updatedAt.
// If nothing has been reported for a long while the task is almost
// certainly gone (crashed, timed out, or never really started) — the
// old code waited 3 hours before giving up, which left the user staring
// at "0/13" with no way out.
// - WARN after 5 min without an update: UI shows "可能卡住了".
// - AUTO-FAIL after 15 min without an update: the request is marked
//   failed so the user can immediately retry, no manual cleanup needed.
// - HARD CAP 45 min total even if reports keep trickling in.
// - The saving stage used to get lenient thresholds (10/30 min) because
//   one whole-file save call could legitimately hang for minutes. With
//   chunked saving every stored chunk bumps updatedAt and chunks take
//   seconds each, so the saving stage now uses the SAME 5/15 thresholds:
//   a healthy save can never go 5 minutes silent, and a task that dies
//   mid-save is failed within 15 minutes of silence instead of hanging
//   until the 45-minute hard cap (which is exactly how request 7 died:
//   it reported "正在保存成片（第 1 次尝试）" and was never heard from
//   again — nothing landed until someone queried it 3.5 hours later).
const FILM_STALL_WARN_MS = 5 * 60 * 1000;
const FILM_STALL_FAIL_MS = 15 * 60 * 1000;
const FILM_HARD_TIMEOUT_MS = 45 * 60 * 1000;
const FILM_SAVE_STALL_WARN_MS = FILM_STALL_WARN_MS;
const FILM_SAVE_STALL_FAIL_MS = FILM_STALL_FAIL_MS;

/** True when the row's current stage label is the film-saving stage. */
function isSavingStage(stage: string | null | undefined): boolean {
  return (stage ?? "").includes("保存");
}

// ---- Chunked film save (the structural fix) ------------------------------
// Saving a finished film back into the tool used to take the whole MP4
// as ONE base64 action argument. The evidence chain from five real runs
// in a single day proved that channel itself is the single point of
// failure — every earlier stage (script, asset lock, storyboard images,
// clips, editing, music) never failed once:
// - request 1: the stored 47s film was byte-mangled yet marked done;
// - request 2: the film rendered, then hung in "正在保存成片" forever;
// - project 3: the task re-encoded 6+ shrinking versions over 8+ silent
//   minutes, retrying the same all-or-nothing call;
// - project 5: even a SMALL transfer arrived as a 4,290-byte truncated
//   prefix (moov cut in half) and was stored unchecked — so it was never
//   a size problem, it is the single-shot channel that is unreliable;
// - request 7 (after the integrity gate shipped): the task reported
//   "正在保存成片（第 1 次尝试）" and vanished — no second attempt, no
//   failFilmSave, nothing. One giant call hanging or dying with the
//   agent's turn takes every downstream remedy with it.
// The replacement is chunked, resumable, and verified at every step:
// 1. beginFilmSave registers the manifest (chunk count, total bytes,
//    whole-file SHA-256) and returns the indices already received, so a
//    restarted task resumes instead of starting over;
// 2. saveFilmChunk carries ONE chunk of at most FILM_CHUNK_BYTES raw
//    bytes; the server decodes it, computes its SHA-256 over the bytes
//    it ACTUALLY received and compares with the declared hash — a
//    mangled chunk is rejected immediately and only that chunk is
//    resent. Each stored chunk also bumps the film request's progress
//    ("正在保存成片 · 已传 X/N 片") and updatedAt, so saving produces
//    its own heartbeat and the stall model above applies unchanged;
// 3. finalizeFilmSave seals the assembly only when every chunk 0..N-1
//    is present and each stored blob's size (ctx.blobs.head — the one
//    byte-level fact the server can check without a read API) matches
//    its declared length and the lengths sum to the declared total.
//    Only then is the film attached to the 成片 node + history and the
//    request marked done.
// Playback/download reassemble the chunks in the BROWSER (the server
// cannot read blob bytes back — BlobClient has no get), where the
// assembled file's length, whole-file SHA-256, and MP4 box structure
// are all verified before the user is offered a player or a download.
// Chunk size is 32KB. The first chunked design still routed every
// chunk through the background task's own action-call output (base64
// text the agent must emit), and live runs killed that too — at 256KB
// AND at 32KB chunk sizes alike, three independent tasks registered
// their save (beginFilmSave landed, stage "已传 0/N 片") and then never
// landed a single chunk payload: one failed honestly after minutes of
// trying, the others went silent and had to be auto-failed. Emitting
// bulk base64 is simply not a channel an agent turn can push bytes
// through, at any chunk size. So the bytes no longer travel through
// the agent at all: the task writes the delivery encode to a fixed
// drop path on this host (~/workspace/film-delivery/<requestId>/
// delivery.mp4 — the tasks run on the same machine), and
// importFilmFromWorkspace reads it back host-side via the privileged
// filmFileInfo/readFilmChunk contracts, then feeds the slices through
// the SAME verified ingest (storeFilmChunk: per-chunk SHA-256 checked
// before storing, chunk-0 MP4 head gate, idempotent resume) and the
// SAME seal (sealAssembly) as the manual chunk actions, which remain
// available as the underlying mechanism. The agent emits exactly one
// small call; the delivery encode is quality-first (native resolution,
// CRF 18–20 — see the saving contract in the spawn briefs), typically
// a few MB up to the 64MB mechanism cap below, and each stored chunk
// is a fresh progress heartbeat.
const FILM_CHUNK_BYTES = 32 * 1024;
const FILM_CHUNK_BASE64_MAX = 60_000;
const FILM_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const FILM_MAX_CHUNKS = 2048;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Marker stored in film_requests.film_blob_key / generations.blob_key
 *  for a film saved as chunks: the real bytes live in per-chunk blobs
 *  under the assembly, resolved via getFilmAssembly. */
function filmAssemblyMarker(requestId: number): string {
  return `film-assembly:${requestId}`;
}
function isFilmAssemblyMarker(key: string): boolean {
  return key.startsWith("film-assembly:");
}
function filmChunkBlobKey(projectId: number, requestId: number, index: number): string {
  return `p${projectId}/film-${requestId}/chunk-${String(index).padStart(4, "0")}`;
}

/** Blob key of the whole-file copy of a sealed film (see
 *  filmAssemblies.fullBlobKey). `versionTag` distinguishes a staged
 *  replacement's copy from the currently-live one so a replace can
 *  write the new file before the atomic swap. */
function filmFullBlobKey(projectId: number, requestId: number, versionTag?: string): string {
  return `p${projectId}/film-${requestId}/full${versionTag ? `-v${versionTag}` : ""}.mp4`;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Attach a film reference to the project's 成片 (package) node: the
 *  given node when it exists, else the first video node, else a newly
 *  created node wired from every image node. `patch` carries either the
 *  legacy {url, blobKey} pair or a chunked {filmAssembly} manifest.
 *  Returns the target node's id. Pure graph transform — the caller
 *  persists it. */
function attachFilmToGraph(
  graph: GraphLike,
  packageNodeId: string | undefined,
  patch: Partial<GraphNodeLike>,
): string {
  let targetId = "";
  if (packageNodeId) {
    const n = graph.nodes.find((x) => x.id === packageNodeId && x.type === "video");
    if (n) targetId = n.id;
  }
  if (!targetId) {
    const first = graph.nodes.find((x) => x.type === "video");
    if (first) targetId = first.id;
  }
  if (targetId) {
    graph.nodes = graph.nodes.map((n) =>
      n.id === targetId ? { ...n, ...patch, status: "idle", error: "" } : n,
    );
    return targetId;
  }
  const images = graph.nodes.filter((n) => n.type === "image");
  const maxX = images.length ? Math.max(...images.map((n) => (n.x ?? 0) + 300)) : 60;
  const minY = images.length ? Math.min(...images.map((n) => n.y ?? 120)) : 120;
  targetId = `n-film-${Date.now().toString(36)}`;
  const filmNode: GraphNodeLike = {
    id: targetId,
    type: "video",
    x: maxX + 60,
    y: minY,
    title: "成片",
    text: "",
    aspect: images[0]?.aspect ?? "16:9",
    duration: 3,
    motion: "zoom-in",
    blobKey: "",
    url: "",
    caption: "",
    motionPrompt: "",
    frames: [],
    status: "idle",
    error: "",
    locked: false,
    ...patch,
  };
  graph.nodes = [...graph.nodes, filmNode];
  graph.edges = [
    ...graph.edges,
    ...images.map((n) => ({
      id: `e-film-${n.id}-${Date.now().toString(36)}`,
      from: n.id,
      to: targetId,
    })),
  ];
  return targetId;
}

/** Flip a film request to done with the given film reference and close
 *  out any linked Agent 一句话成片 run. Shared by the chunked finalize
 *  path. Supersede guard: if the request was already cancelled /
 *  auto-failed as stalled AND a newer request has replaced it, the late
 *  film still lands in history (the caller's job) but neither row is
 *  touched — the dead request is not resurrected and the new request's
 *  status is not confused. */
async function completeFilmRequest(
  db: AgentDb,
  args: { projectId: number; requestId: number; filmRef: string },
): Promise<void> {
  const reqRows = await db
    .select()
    .from(schema.filmRequests)
    .where(eq(schema.filmRequests.id, args.requestId))
    .limit(1);
  const reqRow = reqRows[0];
  if (!reqRow) return;
  const superseded =
    reqRow.status === "failed" &&
    (await db
      .select()
      .from(schema.filmRequests)
      .where(eq(schema.filmRequests.projectId, args.projectId))
      .orderBy(desc(schema.filmRequests.id))
      .limit(1))[0]?.id !== reqRow.id;
  if (superseded) return;
  await db
    .update(schema.filmRequests)
    .set({
      status: "done",
      filmBlobKey: args.filmRef,
      error: "",
      progressDone: reqRow.shotCount,
      progressStage: "已完成",
      updatedAt: new Date(),
    })
    .where(eq(schema.filmRequests.id, reqRow.id));
  const agentRows = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.filmRequestId, reqRow.id));
  for (const run of agentRows) {
    if (run.status !== "cancelled" && run.status !== "failed") {
      await db
        .update(schema.agentRuns)
        .set({
          status: "done",
          progressDone: run.progressTotal,
          progressStage: "已完成",
          error: "",
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, run.id));
    }
  }
}

/** Load the assembly registered for a film request, if any. */
async function loadAssembly(db: AgentDb, requestId: number) {
  const rows = await db
    .select()
    .from(schema.filmAssemblies)
    .where(eq(schema.filmAssemblies.requestId, requestId))
    .limit(1);
  return rows[0] ?? null;
}

/** Indices of chunks already stored for an assembly, ascending. */
async function receivedChunkIndices(db: AgentDb, assemblyId: number): Promise<number[]> {
  const rows = await db
    .select({ idx: schema.filmChunks.idx })
    .from(schema.filmChunks)
    .where(eq(schema.filmChunks.assemblyId, assemblyId));
  return rows.map((r) => r.idx).sort((a, b) => a - b);
}

/** Saving progress is a heartbeat: every stored chunk moves the film
 *  request's stage to "正在保存成片 · 已传 X/N 片" and bumps updatedAt
 *  (and mirrors onto a linked agent run), so the existing stall model
 *  sees a live save and a dead one goes silent immediately. */
async function reportChunkProgress(
  db: AgentDb,
  args: { requestId: number; received: number; total: number },
): Promise<void> {
  const stage = `正在保存成片 · 已传 ${args.received}/${args.total} 片`;
  const now = new Date();
  await db
    .update(schema.filmRequests)
    .set({ progressStage: stage, updatedAt: now })
    .where(eq(schema.filmRequests.id, args.requestId));
  const agentRows = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.filmRequestId, args.requestId));
  for (const run of agentRows) {
    if (
      run.status === "filming" ||
      run.status === "scoring" ||
      run.status === "editing" ||
      run.status === "saving"
    ) {
      await db
        .update(schema.agentRuns)
        .set({ status: "saving", progressStage: stage, updatedAt: now })
        .where(eq(schema.agentRuns.id, run.id));
    }
  }
}

/** Structural head gate for chunk 0 of an MP4 film: the file must
 *  OPEN as an MP4 — a valid ftyp box with a sane size and a printable
 *  major brand. Hashes alone cannot provide this check (a non-MP4
 *  file hashes perfectly self-consistently). Shared by storeFilmChunk
 *  and the staged ingest of replaceFilmFromWorkspace. */
function assertMp4ChunkHead(bytes: Uint8Array, mimeRaw: string): void {
  const mime = (mimeRaw || "video/mp4").toLowerCase();
  if (!(mime.includes("mp4") || mime.includes("quicktime"))) return;
  const headView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxType =
    bytes.length >= 8
      ? String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0)
      : "";
  const boxSize = bytes.length >= 4 ? headView.getUint32(0) : 0;
  const brandOk =
    bytes.length >= 12 &&
    [8, 9, 10, 11].every((i) => {
      const c = bytes[i] ?? 0;
      return c >= 0x20 && c <= 0x7e;
    });
  if (boxType !== "ftyp" || !(boxSize >= 8 || boxSize === 1) || !brandOk) {
    throw new Error(
      "第 1 片的开头不是有效的 MP4 文件头（第一个 box 应为 ftyp）——这不是一个完整的 MP4 文件，没有保存。请先在本地用 ffprobe 确认交付版能完整解码，再从第 1 片开始重新传",
    );
  }
}

/** Store ONE chunk of a film assembly — the single verified ingest
 *  path shared by saveFilmChunk (base64 emitted by the background
 *  task) and importFilmFromWorkspace (slices read host-side from the
 *  delivery file). Verifies the chunk's SHA-256 over the bytes that
 *  ACTUALLY arrived before storing anything, enforces the MP4
 *  structural head gate on chunk 0, treats a byte-identical re-store
 *  as a no-op (resume), refuses to modify a sealed assembly, and
 *  reports save progress. Returns how many chunks are stored. */
async function storeFilmChunk(
  ctx: Ctx,
  db: AgentDb,
  assembly: NonNullable<Awaited<ReturnType<typeof loadAssembly>>>,
  index: number,
  bytes: Uint8Array,
  declaredSha256: string,
): Promise<number> {
  if (index >= assembly.chunkCount) {
    throw new Error(
      `分片序号 ${index} 超出范围：这部成片共登记了 ${assembly.chunkCount} 片（序号 0–${assembly.chunkCount - 1}）`,
    );
  }
  if (bytes.length === 0) throw new Error("分片数据为空");
  if (bytes.length > FILM_CHUNK_BYTES) {
    throw new Error(
      `第 ${index + 1} 片有 ${bytes.length} 字节，超过单片上限 ${FILM_CHUNK_BYTES} 字节（32KB）。按每片不超过 32KB 原始字节重新切分后再传`,
    );
  }
  // Verify BEFORE storing: the hash is computed over the bytes that
  // actually arrived, so a transfer mangled on the way (the failure
  // that corrupted two real films) is caught here, per chunk, and
  // only this chunk needs re-sending.
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== declaredSha256.toLowerCase()) {
    throw new Error(
      `第 ${index + 1} 片在传输中被打烂了（收到的字节哈希对不上），没有保存。请从磁盘重新读取这一片的字节、重新算它的 SHA-256 再单独重传这一片；其他片不受影响`,
    );
  }
  // Structural head gate (chunk 0 only): the file must OPEN as an
  // MP4 — a valid ftyp box with a sane size and a printable major
  // brand. Hashes alone cannot provide this check (a non-MP4 file
  // hashes perfectly self-consistently), and the old whole-file
  // gate caught exactly this class of garbage before storing; the
  // chunk-0 check restores that guarantee at the one place the
  // server still sees the file's head. The full box walk runs
  // client-side after reassembly (the server cannot read chunks
  // back to walk them — BlobClient has no read API).
  if (index === 0) {
    assertMp4ChunkHead(bytes, assembly.mime || "video/mp4");
  }
  const existingRows = await db
    .select()
    .from(schema.filmChunks)
    .where(eq(schema.filmChunks.assemblyId, assembly.id))
    .orderBy(schema.filmChunks.idx);
  const existing = existingRows.find((r) => r.idx === index);
  if (assembly.status === "sealed") {
    // A sealed film is immutable: a byte-identical re-send is a
    // no-op, anything else is a different film trying to overwrite
    // a finished one.
    if (existing && existing.sha256 === actualSha && existing.byteLength === bytes.length) {
      return existingRows.length;
    }
    throw new Error(
      "这部成片已经保存完成并封存，分片不能再改。如果这是另一部成片，请让用户重新点一次「生成并合成成片」开一个新请求来保存",
    );
  }
  if (existing && existing.sha256 === actualSha && existing.byteLength === bytes.length) {
    // Idempotent re-send (resume after an interruption): already
    // stored byte-identical, counts as received.
    return existingRows.length;
  }
  const key = filmChunkBlobKey(assembly.projectId, assembly.requestId, index);
  await ctx.blobs.put(key, bytes, { contentType: assembly.mime || "video/mp4" });
  if (existing) {
    await db
      .update(schema.filmChunks)
      .set({ blobKey: key, byteLength: bytes.length, sha256: actualSha })
      .where(eq(schema.filmChunks.id, existing.id));
  } else {
    await db.insert(schema.filmChunks).values({
      assemblyId: assembly.id,
      idx: index,
      blobKey: key,
      byteLength: bytes.length,
      sha256: actualSha,
    });
  }
  const received = await receivedChunkIndices(db, assembly.id);
  await reportChunkProgress(db, {
    requestId: assembly.requestId,
    received: received.length,
    total: assembly.chunkCount,
  });
  return received.length;
}

/** Seal an assembly whose chunks should all be stored: verify every
 *  chunk 0..N-1 is present, each stored blob's real size matches the
 *  length recorded when its hash-verified bytes arrived, and the
 *  lengths sum to the registered whole-file total. Only then attach
 *  the film to the 成片 node, record it in generation history, seal
 *  the assembly, and mark the request (plus any linked Agent run)
 *  done. Shared by finalizeFilmSave and importFilmFromWorkspace. */
async function sealAssembly(
  ctx: Ctx,
  db: AgentDb,
  assembly: NonNullable<Awaited<ReturnType<typeof loadAssembly>>>,
): Promise<{ chunk_count: number; total_bytes: number }> {
  const chunkRows = await db
    .select()
    .from(schema.filmChunks)
    .where(eq(schema.filmChunks.assemblyId, assembly.id))
    .orderBy(schema.filmChunks.idx);
  const byIdx = new Map(chunkRows.map((r) => [r.idx, r]));
  const missing: number[] = [];
  for (let i = 0; i < assembly.chunkCount; i++) {
    if (!byIdx.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    throw new Error(
      `成片还差 ${missing.length} 片没有传：序号 ${missing.join("、")}。用 saveFilmChunk 把这些片补齐（只需补缺的），再调用 finalizeFilmSave`,
    );
  }
  // Byte-level verification with the one check the blob store
  // supports server-side: each stored blob's real size must equal
  // the length recorded when its (hash-verified) bytes arrived, and
  // the lengths must sum to the registered whole-file total.
  let sum = 0;
  for (let i = 0; i < assembly.chunkCount; i++) {
    const row = byIdx.get(i);
    if (!row) continue;
    const head = await ctx.blobs.head(row.blobKey);
    if (!head || head.sizeBytes !== row.byteLength) {
      throw new Error(
        `第 ${i + 1} 片存储异常（应有 ${row.byteLength} 字节，实际 ${head ? `${head.sizeBytes} 字节` : "不存在"}）。请用 saveFilmChunk 重新传这一片，再调用 finalizeFilmSave`,
      );
    }
    sum += row.byteLength;
  }
  if (sum !== assembly.totalBytes) {
    throw new Error(
      `分片总长度 ${sum} 字节与登记的整文件长度 ${assembly.totalBytes} 字节对不上，成片不完整，没有标记完成。请核对切分方式（每片 32KB、按顺序、无重叠无遗漏）后重传受影响的片`,
    );
  }
  const projRows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, assembly.projectId))
    .limit(1);
  const proj = projRows[0];
  if (!proj) throw new Error("项目不存在");
  const marker = filmAssemblyMarker(assembly.requestId);
  const manifest = {
    requestId: assembly.requestId,
    chunkCount: assembly.chunkCount,
    totalBytes: assembly.totalBytes,
    sha256: assembly.sha256,
    mime: assembly.mime || "video/mp4",
  };
  const graph = parseGraphLike(proj.graph);
  const targetId = attachFilmToGraph(graph, assembly.packageNodeId || undefined, {
    url: "",
    blobKey: "",
    filmAssembly: manifest,
  });
  await db
    .update(schema.projects)
    .set({ graph: JSON.stringify(graph), updatedAt: new Date() })
    .where(eq(schema.projects.id, assembly.projectId));
  await db.insert(schema.generations).values({
    projectId: assembly.projectId,
    kind: "video",
    prompt: `成片：${proj.name}`,
    blobKey: marker,
    nodeId: targetId,
  });
  await db
    .update(schema.filmAssemblies)
    .set({ status: "sealed", updatedAt: new Date() })
    .where(eq(schema.filmAssemblies.id, assembly.id));
  await completeFilmRequest(db, {
    projectId: assembly.projectId,
    requestId: assembly.requestId,
    filmRef: marker,
  });
  return { chunk_count: assembly.chunkCount, total_bytes: assembly.totalBytes };
}

/** Materialize the whole-file copy of a SEALED assembly that does not
 *  have one yet (films sealed before the direct-file path existed).
 *  Two sources, tried in order, both fully verified against the
 *  sealed manifest before anything is stored:
 *  1. the delivery file the background task left on this host
 *     (~/workspace/film-delivery/<requestId>/delivery.mp4) — only when
 *     its size AND whole-file SHA-256 match the sealed manifest
 *     exactly, read back through the same privileged contracts the
 *     import used;
 *  2. the stored chunk blobs themselves, fetched back over their blob
 *     URLs and concatenated in order.
 *  On success the assembly's fullBlobKey is recorded and the blob key
 *  returned; on any failure returns "" and the caller falls back to
 *  the chunked assembly path — a failed materialization never touches
 *  the sealed chunks. */
async function materializeFullFilmBlob(
  ctx: Ctx,
  db: AgentDb,
  assembly: NonNullable<Awaited<ReturnType<typeof loadAssembly>>>,
): Promise<string> {
  if (assembly.status !== "sealed") return "";
  const mime = assembly.mime || "video/mp4";
  const key = filmFullBlobKey(assembly.projectId, assembly.requestId);
  const record = async (bytes: Uint8Array): Promise<string> => {
    if (bytes.length !== assembly.totalBytes) return "";
    if ((await sha256Hex(bytes)) !== assembly.sha256.toLowerCase()) return "";
    await ctx.blobs.put(key, bytes, { contentType: mime });
    const head = await ctx.blobs.head(key);
    if (!head || head.sizeBytes !== assembly.totalBytes) return "";
    await db
      .update(schema.filmAssemblies)
      .set({ fullBlobKey: key, updatedAt: new Date() })
      .where(eq(schema.filmAssemblies.id, assembly.id));
    return key;
  };
  // Source 1: the host-side delivery file, if it is still there and
  // is byte-identical to the sealed film.
  try {
    const info = await ctx.executePrivileged(contracts.filmFileInfo, {
      requestId: assembly.requestId,
    });
    if (
      info.found &&
      info.totalBytes === assembly.totalBytes &&
      info.sha256.toLowerCase() === assembly.sha256.toLowerCase()
    ) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < assembly.chunkCount; i++) {
        const part = await ctx.executePrivileged(contracts.readFilmChunk, {
          requestId: assembly.requestId,
          index: i,
          chunkBytes: FILM_CHUNK_BYTES,
        });
        const bytes = decodeBase64(part.dataBase64);
        if (bytes.length !== part.byteLength) throw new Error("chunk read length mismatch");
        parts.push(bytes);
      }
      const done = await record(concatBytes(parts));
      if (done) return done;
    }
  } catch {
    // Delivery file gone or unreadable — try the chunk blobs.
  }
  // Source 2: fetch the stored chunk blobs back and concatenate.
  try {
    const chunkRows = await db
      .select()
      .from(schema.filmChunks)
      .where(eq(schema.filmChunks.assemblyId, assembly.id))
      .orderBy(schema.filmChunks.idx);
    if (chunkRows.length === assembly.chunkCount) {
      const parts: Uint8Array[] = [];
      for (const row of chunkRows) {
        const url = await ctx.blobs.getUrl(row.blobKey);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`chunk fetch ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length !== row.byteLength) throw new Error("chunk length mismatch");
        parts.push(buf);
      }
      const done = await record(concatBytes(parts));
      if (done) return done;
    }
  } catch {
    // No readable source — the chunked path remains the fallback.
  }
  return "";
}

function filmStallState(row: {
  status: string;
  createdAt: Date;
  updatedAt: Date;
  progressStage?: string;
}): { isStalled: boolean; shouldAutoFail: boolean; reason: string } {
  if (row.status !== "queued" && row.status !== "running") {
    return { isStalled: false, shouldAutoFail: false, reason: "" };
  }
  const now = Date.now();
  const sinceUpdate = now - row.updatedAt.getTime();
  const totalAge = now - row.createdAt.getTime();
  if (totalAge >= FILM_HARD_TIMEOUT_MS) {
    return {
      isStalled: true,
      shouldAutoFail: true,
      reason: "成片生成超过 45 分钟仍未完成，已自动结束。后台任务可能已中断，请重新生成",
    };
  }
  const saving = isSavingStage(row.progressStage);
  const failMs = saving ? FILM_SAVE_STALL_FAIL_MS : FILM_STALL_FAIL_MS;
  const warnMs = saving ? FILM_SAVE_STALL_WARN_MS : FILM_STALL_WARN_MS;
  if (sinceUpdate >= failMs) {
    return {
      isStalled: true,
      shouldAutoFail: true,
      reason: saving
        ? `成片保存已 ${Math.floor(sinceUpdate / 60000)} 分钟没有任何新进度，后台任务可能已中断，已自动结束。成片文件已在后台生成，可让 Muse 直接在对话里发给你`
        : `成片生成已 ${Math.floor(sinceUpdate / 60000)} 分钟没有任何新进度，后台任务可能已中断，已自动结束。请重新生成`,
    };
  }
  if (sinceUpdate >= warnMs) {
    return { isStalled: true, shouldAutoFail: false, reason: "" };
  }
  return { isStalled: false, shouldAutoFail: false, reason: "" };
}

// ---- Agent 一句话成片 (one-sentence automatic production) -----------------
// Dual mode with the manual canvas: the user types one sentence and the
// server itself builds the whole workflow on a NEW project (existing
// projects are never touched): input text node → script node (full
// storyboard table) → asset-lock node (one character/scene reference
// image + a unified anchor description injected as TEXT into every
// shot's image prompt — text anchoring, not a face/identity model) →
// one image node per shot (prompt / motion prompt / caption / duration
// / camera all filled, images generated one by one with per-shot
// progress) → 成片 node wired in story order. Then either the film
// pipeline starts immediately (auto mode) or the run parks in
// awaiting_confirm (step mode, or when some shot images failed and are
// marked on their nodes for individual retry).

const MOTION_BY_LABEL_SERVER: Record<string, string> = {
  推近: "zoom-in",
  拉远: "zoom-out",
  左移: "pan-left",
  右移: "pan-right",
  固定: "static",
};

const agentShotPlan = z.object({
  shotSize: z.string(),
  visual: z.string(),
  action: z.string(),
  caption: z.string(),
  duration: z.number(),
  camera: z.enum(["推近", "拉远", "左移", "右移", "固定"]),
  imagePrompt: z.string(),
  motionPrompt: z.string(),
});

const agentPlanSchema = z.object({
  title: z.string(),
  anchor: z.string(),
  musicMood: z.string(),
  shots: z.array(agentShotPlan).min(1).max(12),
});

type AgentPlan = z.infer<typeof agentPlanSchema>;
function agentDbOf(ctx: Ctx) {
  return ctx.db<typeof schema>();
}
type AgentDb = ReturnType<typeof agentDbOf>;

const AGENT_ACTIVE_STATUSES = [
  "queued",
  "scripting",
  "assets",
  "storyboarding",
  "filming",
  "scoring",
  "editing",
  "saving",
] as const;

function orientationOfAspect(aspect: string): "landscape" | "portrait" | "square" {
  if (aspect === "9:16") return "portrait";
  if (aspect === "1:1") return "square";
  return "landscape";
}

function agentNode(partial: Partial<GraphNodeLike> & { id: string; type: string }): GraphNodeLike {
  return {
    text: "",
    aspect: "16:9",
    duration: 3,
    motion: "zoom-in",
    blobKey: "",
    url: "",
    caption: "",
    motionPrompt: "",
    frames: [],
    status: "idle",
    error: "",
    locked: false,
    title: "",
    x: 60,
    y: 60,
    ...partial,
  };
}

/** Build the zoned canvas for an agent run: input / script / asset
 *  zones on the left, the storyboard shots as a wrapped grid, and the
 *  成片 node to the right of the grid, vertically centered on it. */
function agentGraphSkeleton(args: {
  instruction: string;
  aspect: string;
  style: string;
  plan: AgentPlan;
  scriptText: string;
  anchorNodeId: string;
  shotNodeIds: string[];
  filmNodeId: string;
}): GraphLike {
  const shotX = 1240;
  const configNodeId = "n-agent-config";
  const nodes: GraphNodeLike[] = [
    agentNode({
      id: "n-agent-input",
      type: "text",
      x: 60,
      y: 140,
      title: "一句话创意",
      text: args.instruction,
      aspect: args.aspect,
    }),
    agentNode({
      id: "n-agent-script",
      type: "text",
      x: 440,
      y: 140,
      title: "分镜脚本",
      text: args.scriptText,
      aspect: args.aspect,
    }),
    agentNode({
      id: args.anchorNodeId,
      type: "image",
      x: 820,
      y: 140,
      title: "资产定版 · 角色/场景参考",
      text: args.plan.anchor,
      aspect: args.aspect,
    }),
    // Global generation config for the whole workflow: carries the
    // run's aspect + style tone and is wired into every shot node, so
    // the user can restyle the whole storyboard from one node. It
    // coexists with the asset-lock node (which anchors the character /
    // scene, not the parameters).
    agentNode({
      id: configNodeId,
      type: "config",
      x: 820,
      y: 540,
      title: "生成配置 · 全局",
      text: args.style,
      aspect: args.aspect,
    }),
  ];
  // Storyboard shots are laid out as a WRAPPED GRID (row-major, story
  // order) — never one long vertical strip. The column count mirrors
  // the client's gridColumnCount (client/src/types.ts): roughly √N
  // biased wider, capped at 6 across.
  const shotCount = args.plan.shots.length;
  const shotCols =
    shotCount <= 1
      ? 1
      : Math.min(6, Math.max(2, Math.round(Math.sqrt(shotCount * 1.9))));
  const shotRows = Math.max(1, Math.ceil(shotCount / shotCols));
  args.plan.shots.forEach((shot, i) => {
    nodes.push(
      agentNode({
        id: args.shotNodeIds[i] ?? `n-agent-shot-${i + 1}`,
        type: "image",
        x: shotX + (i % shotCols) * 380,
        y: 60 + Math.floor(i / shotCols) * 372,
        title: `镜头 ${i + 1}`,
        // The unified anchor text is baked into every shot's prompt —
        // this text anchoring is what keeps character/style consistent.
        text: `${shot.imagePrompt}。统一角色与风格锚定：${args.plan.anchor}`,
        aspect: args.aspect,
        duration: Math.min(10, Math.max(1, shot.duration || 3)),
        motion: MOTION_BY_LABEL_SERVER[shot.camera] ?? "zoom-in",
        caption: shot.caption === "无" ? "" : shot.caption,
        motionPrompt: shot.motionPrompt,
      }),
    );
  });
  const filmY = shotRows > 1 ? 60 + ((shotRows - 1) * 372) / 2 : 140;
  nodes.push(
    agentNode({
      id: args.filmNodeId,
      type: "video",
      x: shotX + shotCols * 380,
      y: filmY,
      title: "成片",
      aspect: args.aspect,
    }),
  );
  const edges: GraphLike["edges"] = [
    { id: "e-agent-1", from: "n-agent-input", to: "n-agent-script" },
    { id: "e-agent-2", from: "n-agent-script", to: args.anchorNodeId },
    ...args.shotNodeIds.map((id, i) => ({
      id: `e-agent-a${i + 1}`,
      from: args.anchorNodeId,
      to: id,
    })),
    ...args.shotNodeIds.map((id, i) => ({
      id: `e-agent-c${i + 1}`,
      from: configNodeId,
      to: id,
    })),
    ...args.shotNodeIds.map((id, i) => ({
      id: `e-agent-f${i + 1}`,
      from: id,
      to: args.filmNodeId,
    })),
  ];
  return { nodes, edges, viewport: { x: 20, y: 40, k: 0.6 } };
}

function formatScriptText(plan: AgentPlan): string {
  const lines = plan.shots.map(
    (s, i) =>
      `镜头${i + 1}｜景别：${s.shotSize}｜时长${s.duration}秒｜运镜：${s.camera}｜画面：${s.visual}｜动作：${s.action}｜字幕：${s.caption || "无"}｜画面提示词：${s.imagePrompt}｜运动提示词：${s.motionPrompt}`,
  );
  return [`《${plan.title}》分镜表`, `配乐情绪：${plan.musicMood}`, "", ...lines].join("\n");
}

/** Insert a film_requests row for an agent run and spawn the background
 *  Muse task with the expanded brief: true-motion clips per shot,
 *  story-order editing with burned captions, AND a background-music
 *  track matched to the story's mood mixed into the final film. */
async function spawnAgentFilm(
  ctx: Ctx,
  db: AgentDb,
  args: {
    projectId: number;
    projectName: string;
    runId: number;
    packageNodeId: string;
    shots: FilmShot[];
    musicMood: string;
  },
): Promise<{ ok: boolean; requestId: number; error: string }> {
  const insertedRows = await db
    .insert(schema.filmRequests)
    .values({
      projectId: args.projectId,
      packageNodeId: args.packageNodeId,
      status: "queued",
      shotsJson: JSON.stringify(args.shots),
      shotCount: args.shots.length,
    })
    .returning({ id: schema.filmRequests.id });
  const inserted = insertedRows[0];
  if (!inserted) return { ok: false, requestId: 0, error: "成片请求创建失败，请重试" };
  const requestId = inserted.id;
  const totalSeconds = args.shots.reduce((sum, s) => sum + s.duration, 0);
  const assignment = [
    `The user started an "Agent 一句话成片" automatic production in the web artifact "无限画布视频生成工具" (slug: wu-xian-hua-bu-shi-pin-sheng-cheng-gong-ju). Agent run id: ${args.runId}. Film request id: ${requestId}. Project id: ${args.projectId}. Project name: ${args.projectName}. The film has ${args.shots.length} shots, about ${totalSeconds} seconds total. Package (成片) node id: ${args.packageNodeId || "(none — omit packageNodeId when saving)"}. Background music mood for this story: ${args.musicMood || "与剧情情绪匹配"}.`,
    "",
    "Do the whole job yourself, end to end. The user must NOT be asked to export, download, or send anything — everything you need is reachable through the artifact's own actions, and the finished film goes back into the tool the same way.",
    "",
    "Progress reporting (BOTH channels, so the tool's progress bars move for real and nothing is mistaken for stalled): reportFilmProgress(requestId, doneShots, stage) for the film request, and reportAgentProgress(runId, status, doneShots, stage) for the agent run. Agent statuses: filming while generating shot clips, scoring while making/mixing the music, editing while cutting, saving right before the save call. Report immediately when you start, after EACH finished shot clip, and as a heartbeat about every 3 minutes during any long single step. Going 15 minutes without any report auto-fails the run as stalled (during saving, every stored chunk reports automatically — see step 5).",
    "",
    "Steps:",
    `1. Call the artifact action getFilmRequest with { "requestId": ${requestId} } to get the ordered shot list. Per shot you get: index, title, blob_key, image_prompt, motion_prompt, caption, duration_seconds, camera_motion, aspect. Note: the storyboard image bytes themselves are not readable from chat (the artifact's blob storage exposes no read path to you), so for each shot first regenerate its keyframe image from image_prompt with your own image generation, matching the prompt's subject, composition, colors and the shot's aspect. Immediately report: reportAgentProgress { "runId": ${args.runId}, "status": "filming", "doneShots": 0, "stage": "正在生成镜头视频" } and reportFilmProgress { "requestId": ${requestId}, "doneShots": 0, "stage": "正在生成镜头视频" }.`,
    `2. For each shot, generate ONE true-motion video clip from that keyframe, driven by the shot's motion_prompt and camera_motion, about duration_seconds long. The subject itself must really move (image-to-video) — never a slideshow of stills, never pan/zoom over a static image, never frame interpolation presented as motion. Generate at most 6 clips per round; if there are more than 6 shots, continue in consecutive rounds until every shot has a clip. After EACH finished clip, report both channels with doneShots = clips finished so far and stage "正在生成镜头视频".`,
    `3. Music: report both channels with stage "正在配乐" (agent status "scoring"). Create or select ONE original background-music track whose mood matches: ${args.musicMood || "the story's emotional tone"}. It must fit the film's total length (loop/trim as needed) and sit under the picture at a modest level. There is no dialogue in this production, so add NO narration/voiceover. If you genuinely cannot produce any music track after a real attempt, say so plainly in your final chat report — but still finish and save the film; never fake a music credit.`,
    `4. Editing: report both channels with stage "正在按剧情剪辑合成" (agent status "editing"). Edit the clips into ONE coherent film in index order with ffmpeg: conform each clip to its duration_seconds, unify resolution and frame rate according to the shots' aspect, burn each shot's caption as a bottom subtitle shown during that shot (skip empty captions), mix the background music across the whole film (fade out at the end), and cut like a director following the story — straight cuts, at most a very short dissolve where it genuinely helps continuity. The result is a single MP4 (H.264, yuv420p, faststart) WITH the music track muxed in.`,
    `5. Saving — HOST-SIDE IMPORT, follow this contract exactly; it exists because saving is where every past production died. NEVER send the whole film as one action argument: the old whole-file save no longer exists — five real productions were lost to that single all-or-nothing call (bytes mangled in transit and stored unchecked, tasks vanishing mid-call with the request hanging for hours). (a) FIRST produce a "delivery encode" of the finished film BEFORE any save call — QUALITY FIRST, because this encode is exactly what the tool stores, plays, and offers for download. Keep the finished film's NATIVE resolution (whatever the edited master is — 1280x720, 720x1280, 1080p, …): NEVER downscale it, and never target a fixed file size. Encode H.264 at constant quality, CRF 18–20 (for 720p material that lands around 6 Mbps or higher; use -preset slow if time permits). An old rule capped this encode at ~1.5MB / a few hundred kbps — it was a workaround for a dead save channel, it made longer films unwatchably blurry, and it is ABOLISHED: do not resurrect it. The ONLY size limit is the tool's import cap of 64MB (67,108,864 bytes); if a CRF 18–20 encode would exceed 64MB, raise the CRF only as far as needed to fit under the cap and keep the native resolution. Keep the full-resolution master as a separate local file as well. (b) FILE DISCIPLINE + INTEGRITY, before any upload: do ALL of this save's file work in a directory named after this request — ~/workspace/film-delivery/${requestId}/ — and never use a shared temp filename: other productions may be running concurrently and a shared path gets overwritten (this exact accident already killed one save: the registered file was replaced before upload and no longer matched its hash). Verify the delivery file on your side (ffprobe must open it and report its full expected duration, and a full decode pass must not error), then compute its total byte size and its whole-file SHA-256 (e.g. sha256sum). The delivery encode MUST end up at the exact path ~/workspace/film-delivery/${requestId}/delivery.mp4 (folder named by the request id, file named exactly delivery.mp4) — that fixed location is how the tool finds it. Once you call importFilmFromWorkspace, the delivery file is FROZEN: never re-encode, move, or overwrite it until that call returns; keep any re-encode as a NEW file under a new name and, if its size/hash differ, that is a different film — do not mix the two. (c) Report reportAgentProgress { "runId": ${args.runId}, "status": "saving", "doneShots": ${args.shots.length}, "stage": "正在保存成片" } once. (d) Save with ONE call: importFilmFromWorkspace { "requestId": ${requestId} }. The tool reads ~/workspace/film-delivery/${requestId}/delivery.mp4 itself on the server host, slices it into ≤32KB chunks, verifies every chunk's SHA-256 before storing it, then seals the save — film attached to the 成片 node, history recorded, everything marked done. NEVER emit film bytes (base64 or otherwise) in an action call yourself: that channel is what killed every earlier save, at every size tried. Progress (正在保存成片 · 已传 X/N 片) is reported automatically per stored chunk and resets the no-progress clock on both channels. A save only counts when importFilmFromWorkspace returns ok. If it returns ok with "imported_chunks": 0, this request already has a sealed film and NOTHING was overwritten; only when you are deliberately re-delivering a corrected or higher-quality encode of the SAME film for this SAME request, call replaceFilmFromWorkspace { "requestId": ${requestId} } instead — it stages and fully verifies the new file first, then swaps atomically, and a failed replace leaves the sealed film untouched. Never use it for a different film. (e) If importFilmFromWorkspace returns an error, read it and fix exactly what it names — file missing or at the wrong path: put the delivery encode at the exact path above; file not a valid MP4: re-encode the delivery encode and replace delivery.mp4 — then call importFilmFromWorkspace again, at most 3 tries total; chunks already stored are skipped, so a retry resumes instead of starting over. (f) If it still fails after 3 tries, IMMEDIATELY call failFilmSave with { "requestId": ${requestId}, "reason": "<the actual error, in one short plain sentence>" } so the tool marks this production failed right away (it also records that the finished film exists on your side) — never leave the request hanging in "saving" — and then deliver the finished film file to the user directly in chat yourself. Do not invent a video or save anything else under the film's name.`,
    "6. Afterwards, tell the user briefly in chat that the film is done and saved into the tool (it shows on the 成片 node and in the 生成历史）, with the shot count, total duration, and whether the background music was included. If one shot's clip fails after a genuine retry, still finish the film with the remaining shots in order and say plainly which shot is missing. If you cannot produce any real clip at all, say so plainly in chat and do NOT save anything.",
  ].join("\n");

  const spawned = await ctx.agent.spawnTask(assignment, {
    expectsAction: "importFilmFromWorkspace",
    dedupeKey: `film-${args.projectId}-${requestId}`,
  });
  if (!spawned.ok) {
    await db
      .update(schema.filmRequests)
      .set({ status: "failed", error: `成片任务未能启动：${spawned.error}`, updatedAt: new Date() })
      .where(eq(schema.filmRequests.id, requestId));
    return { ok: false, requestId, error: `成片任务未能启动：${spawned.error}` };
  }
  await db
    .update(schema.filmRequests)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(schema.filmRequests.id, requestId));
  return { ok: true, requestId, error: "" };
}

/** Generate (or regenerate) storyboard images for the given image nodes
 *  of an agent run, one by one, saving the graph and the run's progress
 *  after each shot so the page shows real per-shot progress and a single
 *  failure is marked on its node without losing the rest. Returns the
 *  titles of shots whose image could not be generated. */
async function generateAgentShotImages(
  ctx: Ctx,
  db: AgentDb,
  args: {
    runId: number;
    projectId: number;
    nodeIds: string[];
    orientation: "landscape" | "portrait" | "square";
  },
): Promise<{ failedTitles: string[] }> {
  const failedTitles: string[] = [];
  let done = 0;
  for (const nodeId of args.nodeIds) {
    // Re-read the project row at the TOP of every iteration: the stored
    // graph is the single source of truth, and each shot's save must be
    // based on the latest stored state, never on a snapshot taken before
    // the loop (an older write would silently drop shots saved since).
    const projRows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, args.projectId))
      .limit(1);
    const proj = projRows[0];
    if (!proj) {
      failedTitles.push(...args.nodeIds.slice(done));
      break;
    }
    const graphBefore = parseGraphLike(proj.graph);
    const nodeBefore = graphBefore.nodes.find((n) => n.id === nodeId && n.type === "image");
    if (!nodeBefore) {
      failedTitles.push(nodeId);
      done++;
      continue;
    }
    const prompt = effectivePromptServer(graphBefore, nodeBefore) || (nodeBefore.text ?? "").trim();
    // Compute this shot's outcome first; the graph is only touched when
    // the result is written back below.
    let patch: Partial<GraphNodeLike>;
    if (!prompt) {
      patch = {
        status: "error",
        error: "这一镜还没有提示词，补上后可单独重试生成图片",
      };
      failedTitles.push(nodeBefore.title ?? nodeId);
    } else {
      try {
        const media = await ctx.tool.generate_media(prompt, {
          orientation: args.orientation,
          key: `p${args.projectId}/img-${nodeId}-${Date.now()}`,
        });
        patch = { blobKey: media.blobKey, url: media.url, status: "idle", error: "", frames: [] };
        await db.insert(schema.generations).values({
          projectId: args.projectId,
          kind: "image",
          prompt,
          blobKey: media.blobKey,
          nodeId,
        });
      } catch (e) {
        patch = {
          status: "error",
          error: `分镜图生成失败：${e instanceof Error ? e.message : String(e)}。可在画布上单独点「重新生成」重试这一张`,
        };
        failedTitles.push(nodeBefore.title ?? nodeId);
      }
    }
    done++;
    // Re-read once more and patch ONLY this shot's node into the latest
    // stored graph, so this save can never drop anything written since
    // the iteration started (other shots, the asset node, a film node).
    const freshRows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, args.projectId))
      .limit(1);
    const fresh = freshRows[0];
    if (!fresh) break;
    const graph = parseGraphLike(fresh.graph);
    const node = graph.nodes.find((n) => n.id === nodeId && n.type === "image");
    if (node) Object.assign(node, patch);
    await db
      .update(schema.projects)
      .set({ graph: JSON.stringify(graph), updatedAt: new Date() })
      .where(eq(schema.projects.id, args.projectId));
    await db
      .update(schema.agentRuns)
      .set({
        progressDone: done,
        progressTotal: args.nodeIds.length,
        progressStage: "正在生成分镜图",
        updatedAt: new Date(),
      })
      .where(eq(schema.agentRuns.id, args.runId));
  }
  return { failedTitles };
}

const agentStartResponse = z.object({
  ok: z.boolean(),
  project_id: z.number().nullable(),
  run_id: z.number().nullable(),
  status: z.string(),
  error: z.string(),
});

const agentStatusResponse = z.object({
  status: z.enum([
    "none",
    "queued",
    "scripting",
    "assets",
    "storyboarding",
    "awaiting_confirm",
    "filming",
    "scoring",
    "editing",
    "saving",
    "done",
    "failed",
    "cancelled",
  ]),
  run_id: z.number().nullable(),
  mode: z.string(),
  instruction: z.string(),
  progress_done: z.number(),
  progress_total: z.number(),
  progress_stage: z.string(),
  error: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  is_stalled: z.boolean(),
});

// The starter workflow a brand-new project opens with: a prompt wired
// into a keyframe image node wired into a video node, ready to run.
function starterGraph(): string {
  const graph = {
    nodes: [
      {
        id: "n-prompt",
        type: "text",
        x: 60,
        y: 140,
        title: "创意提示词",
        text: "雨夜的未来都市，霓虹灯倒映在湿漉漉的街道上，一辆悬浮列车缓缓驶过，电影感镜头",
        aspect: "16:9",
        duration: 3,
        motion: "zoom-in",
        blobKey: "",
        url: "",
        status: "idle",
        error: "",
      },
      {
        id: "n-keyframe",
        type: "image",
        x: 420,
        y: 120,
        title: "分镜关键帧",
        text: "",
        aspect: "16:9",
        duration: 3,
        motion: "zoom-in",
        blobKey: "",
        url: "",
        status: "idle",
        error: "",
      },
      {
        id: "n-video",
        type: "video",
        x: 790,
        y: 120,
        title: "成片",
        text: "",
        aspect: "16:9",
        duration: 3,
        motion: "zoom-in",
        blobKey: "",
        url: "",
        status: "idle",
        error: "",
      },
    ],
    edges: [
      { id: "e-1", from: "n-prompt", to: "n-keyframe" },
      { id: "e-2", from: "n-keyframe", to: "n-video" },
    ],
    viewport: { x: 40, y: 60, k: 0.85 },
  };
  return JSON.stringify(graph);
}

export const Actions = {
  listProjects: defineAction({
    description: "Lists all canvas projects, most recently edited first.",
    request: z.object({}),
    response: z.object({ projects: z.array(projectSummary) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projects)
        .orderBy(desc(schema.projects.updatedAt));
      return {
        projects: rows.map((row) => ({
          id: row.id,
          name: row.name,
          updated_at: row.updatedAt.toISOString(),
          created_at: row.createdAt.toISOString(),
        })),
      };
    },
  }),

  createProject: defineAction({
    description:
      "Creates a project; with no graph it seeds the starter prompt → keyframe → video workflow.",
    request: z.object({
      name: z.string().min(1).max(80),
      graph: z.string().max(2_000_000).optional(),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.projects)
        .values({ name: args.name, graph: args.graph ?? starterGraph() })
        .returning({ id: schema.projects.id });
      const inserted = result[0];
      if (!inserted) throw new Error("createProject: insert returned no rows");
      ctx.invalidateQueries();
      return { id: inserted.id };
    },
  }),

  getProject: defineAction({
    description: "Returns one project's saved canvas graph JSON.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      id: z.number(),
      name: z.string(),
      graph: z.string(),
      updated_at: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.id))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("项目不存在");
      // Heal node media that an older stale save wiped from the stored
      // graph: the generation history still knows each node's latest
      // media, so an empty node gets it back in the response instead of
      // showing a permanent blank. The stored row is left untouched;
      // the client's next save persists the healed graph (and the save
      // path now preserves media, so it cannot regress).
      const healed = await backfillNodeMediaFromHistory(
        ctx,
        db,
        row.id,
        parseGraphLike(row.graph),
      );
      return {
        id: row.id,
        name: row.name,
        graph: JSON.stringify(healed),
        updated_at: row.updatedAt.toISOString(),
      };
    },
  }),

  saveProject: defineAction({
    description: "Saves a project's name and full canvas graph JSON.",
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(80),
      graph: z.string().max(2_000_000),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      // Never let a save erase generated media it doesn't know about:
      // if the stored graph has a node's image/film and the incoming
      // graph has that same node without it (a page holding an older
      // copy while the server was generating), the stored media wins.
      const rows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.id))
        .limit(1);
      const stored = rows[0];
      // Backstop for the build window: while an agent run is actively
      // building this canvas server-side (scripting / assets /
      // storyboarding), the server is the graph's only writer. A
      // page-side graph save in that window is a stale local snapshot
      // (it can even predate the workflow skeleton) — accept the rename
      // but keep the server's graph untouched. The client pauses its
      // autosave in the same window; this covers the race before its
      // first status poll lands and any direct flush call.
      let serverOwnsGraph = false;
      if (stored) {
        const runRows = await db
          .select()
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.projectId, args.id))
          .orderBy(desc(schema.agentRuns.id))
          .limit(1);
        const latestRun = runRows[0];
        serverOwnsGraph =
          latestRun != null &&
          (latestRun.status === "scripting" ||
            latestRun.status === "assets" ||
            latestRun.status === "storyboarding");
      }
      const graphToSave = stored
        ? serverOwnsGraph
          ? stored.graph
          : JSON.stringify(
              preserveStoredMedia(parseGraphLike(args.graph), parseGraphLike(stored.graph)),
            )
        : args.graph;
      await db
        .update(schema.projects)
        .set({ name: args.name, graph: graphToSave, updatedAt: new Date() })
        .where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteProject: defineAction({
    description: "Deletes a project, its generation history, and its media blobs.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const gens = await db
        .select()
        .from(schema.generations)
        .where(eq(schema.generations.projectId, args.id));
      const blobs = await ctx.blobs.list(`p${args.id}/`);
      await Promise.all([
        ...gens.map((g) => ctx.blobs.delete(g.blobKey).catch(() => undefined)),
        ...blobs.map((b) => ctx.blobs.delete(b.key).catch(() => undefined)),
      ]);
      await db
        .delete(schema.generations)
        .where(eq(schema.generations.projectId, args.id));
      const assemblyRows = await db
        .select()
        .from(schema.filmAssemblies)
        .where(eq(schema.filmAssemblies.projectId, args.id));
      for (const assembly of assemblyRows) {
        await db
          .delete(schema.filmChunks)
          .where(eq(schema.filmChunks.assemblyId, assembly.id));
      }
      await db
        .delete(schema.filmAssemblies)
        .where(eq(schema.filmAssemblies.projectId, args.id));
      await db
        .delete(schema.filmRequests)
        .where(eq(schema.filmRequests.projectId, args.id));
      await db
        .delete(schema.agentRuns)
        .where(eq(schema.agentRuns.projectId, args.id));
      await db.delete(schema.projects).where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  generateImage: defineAction({
    description:
      "Generates one AI image from a prompt, stores it as a blob, records it in the project history, and returns its durable URL.",
    request: z.object({
      projectId: z.number().int().positive(),
      nodeId: z.string().min(1).max(80),
      prompt: z.string().min(1).max(2000),
      orientation: z.enum(["square", "landscape", "portrait"]),
    }),
    response: z.object({
      blob_key: z.string(),
      url: z.string(),
    }),
    async handler(ctx, args) {
      const media = await ctx.tool.generate_media(args.prompt, {
        orientation: args.orientation,
        key: `p${args.projectId}/img-${args.nodeId}-${Date.now()}`,
      });
      const db = ctx.db<typeof schema>();
      await db.insert(schema.generations).values({
        projectId: args.projectId,
        kind: "image",
        prompt: args.prompt,
        blobKey: media.blobKey,
        nodeId: args.nodeId,
      });
      ctx.invalidateQueries();
      return { blob_key: media.blobKey, url: media.url };
    },
  }),

  uploadAsset: defineAction({
    description:
      "Stores a user-uploaded image or video (base64) as a project blob and returns its durable URL.",
    request: z.object({
      projectId: z.number().int().positive(),
      nodeId: z.string().min(1).max(80),
      kind: z.enum(["image", "video"]),
      mime: z.string().min(3).max(80),
      dataBase64: z.string().min(1).max(90_000_000),
    }),
    response: z.object({ blob_key: z.string(), url: z.string() }),
    async handler(ctx, args) {
      const ext = args.kind === "video" ? "webm" : "img";
      const key = `p${args.projectId}/up-${args.nodeId}-${Date.now()}.${ext}`;
      const bytes = decodeBase64(args.dataBase64);
      await ctx.blobs.put(key, bytes, { contentType: args.mime });
      const url = await ctx.blobs.getUrl(key);
      return { blob_key: key, url };
    },
  }),

  listGenerations: defineAction({
    description: "Lists a project's generation history with playable/viewable URLs, newest first.",
    request: z.object({
      projectId: z.number().int().positive(),
      limit: z.number().int().positive().max(100).default(40),
    }),
    response: z.object({ generations: z.array(generationRow) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.generations)
        .where(eq(schema.generations.projectId, args.projectId))
        .orderBy(desc(schema.generations.id))
        .limit(args.limit);
      const generations = await Promise.all(
        rows.map(async (row) => {
          const chunked = isFilmAssemblyMarker(row.blobKey);
          const markerId = chunked ? Number(row.blobKey.slice("film-assembly:".length)) : NaN;
          let url = "";
          if (!chunked) {
            url = await ctx.blobs.getUrl(row.blobKey);
          } else if (Number.isFinite(markerId)) {
            // A chunked film WITH a whole-file copy plays/downloads
            // straight from that one blob; without one the URL stays
            // empty and the client uses the direct-file action (which
            // materializes the copy) or the chunked assembly fallback.
            const assembly = await loadAssembly(db, markerId);
            if (assembly?.fullBlobKey) {
              url = await ctx.blobs.getUrl(assembly.fullBlobKey);
            }
          }
          return {
            id: row.id,
            kind: row.kind,
            prompt: row.prompt,
            node_id: row.nodeId,
            url,
            created_at: row.createdAt.toISOString(),
            chunked,
            film_request_id: Number.isFinite(markerId) ? markerId : null,
          };
        }),
      );
      return { generations };
    },
  }),

  enhancePrompt: defineAction({
    description:
      "Rewrites a short shot idea into a richer cinematic image/video prompt the user can accept or ignore.",
    request: z.object({ text: z.string().min(1).max(1000) }),
    response: z.object({ prompt: z.string() }),
    async handler(ctx, args) {
      const result = await ctx.inference.complete(
        `把下面这句简短的画面想法扩写成一段适合 AI 生成分镜图与短视频的中文提示词：保留原意，补充主体细节、场景、光线、镜头运动和氛围，不超过 120 字，只输出提示词本身。\n\n想法：${args.text}`,
        { schema: z.string() },
      );
      return { prompt: result.trim() };
    },
  }),

  generateText: defineAction({
    description:
      "Generates text with the platform model: expands a prompt, writes a short-video script, splits an idea into a shot-by-shot storyboard script, or writes title/caption copy.",
    request: z.object({
      text: z.string().min(1).max(2000),
      mode: z.enum(["expand", "script", "storyboard", "captions"]),
    }),
    response: z.object({ text: z.string() }),
    async handler(ctx, args) {
      const instructions: Record<typeof args.mode, string> = {
        expand:
          "把下面这句简短的画面想法扩写成一段适合 AI 生成分镜图与短视频的中文提示词：保留原意，补充主体细节、场景、光线、镜头运动和氛围，不超过 120 字，只输出提示词本身。",
        script:
          "把下面的创意写成一个 30–60 秒短视频脚本：包含片名、整体风格说明，然后按时间顺序写出每个段落的画面内容、镜头运动、旁白/字幕文案。语言生动具体，可直接用于拍摄或 AI 生成。用中文输出，只输出脚本本身。",
        storyboard:
          "把下面的创意拆成 4–6 个镜头的分镜脚本。每个镜头单独一行，严格使用这个格式：镜头N｜时长X秒｜运镜：推近/拉远/左移/右移/固定 选一｜画面：这一镜具体画面的详细描述｜字幕：这一镜的字幕文案（没有就写 无）。只输出分镜行，不要标题和解释。",
        captions:
          "为下面的短视频创意写一组可直接使用的中文文案：第一行是主标题（15 字内，有吸引力），随后 3 行是备选标题，再空一行写一段 60 字内的发布文案，最后给出 5 个话题标签（以 # 开头）。只输出文案本身。",
      };
      const result = await ctx.inference.complete(
        `${instructions[args.mode]}\n\n创意：${args.text}`,
        { schema: z.string() },
      );
      return { text: result.trim() };
    },
  }),

  assistantChat: defineAction({
    description:
      "Canvas side-assistant chat: answers with the platform model using the current canvas selection and its upstream nodes as context (supplied by the client from the live graph). Returns plain reply text the user can insert back onto the canvas as a new node.",
    request: z.object({
      message: z.string().min(1).max(2000),
      context: z.string().max(4000).default(""),
    }),
    response: z.object({ text: z.string() }),
    async handler(ctx, args) {
      const contextBlock = args.context.trim()
        ? `\n\n当前画布选区及其上游节点（作为背景上下文）：\n${args.context.trim()}`
        : "\n\n（用户当前没有选中任何节点。）";
      const result = await ctx.inference.complete(
        `你是无限画布视频创作工具里的画布助手。用户正在用节点工作流做短视频：提示词节点写创意，生成配置节点统一画幅/画质/风格，分镜图节点逐镜生成画面，最后连到成片节点生成成片。结合下面的画布上下文回答用户的问题：需要给文本时直接给可用的文本（提示词、字幕、运动提示词等），简洁具体，用中文。${contextBlock}\n\n用户：${args.message.trim()}`,
        { schema: z.string() },
      );
      return { text: result.trim() };
    },
  }),

  varyImage: defineAction({
    description:
      "Image-to-image: reads a reference image with the platform vision model, rewrites it per the user's instruction, generates a variation image, stores it, and records it in history.",
    request: z.object({
      projectId: z.number().int().positive(),
      nodeId: z.string().min(1).max(80),
      instruction: z.string().min(1).max(1000),
      imageBase64: z.string().min(1).max(12_000_000),
      orientation: z.enum(["square", "landscape", "portrait"]),
    }),
    response: z.object({ blob_key: z.string(), url: z.string() }),
    async handler(ctx, args) {
      const prompt = await ctx.inference.complete(
        `仔细看这张参考图。用一段中文提示词描述如何基于它生成一张新图：先准确概括原图的主体、场景、构图和色调，再按用户的要求做修改。只输出最终用于 AI 生图的提示词本身，不超过 150 字。\n\n用户的要求：${args.instruction}`,
        {
          schema: z.string(),
          images: [
            {
              dataBase64: args.imageBase64,
              mimeType: "image/jpeg",
              caption: "用户要改的参考图",
            },
          ],
        },
      );
      const media = await ctx.tool.generate_media(prompt.trim(), {
        orientation: args.orientation,
        key: `p${args.projectId}/img-${args.nodeId}-${Date.now()}`,
      });
      const db = ctx.db<typeof schema>();
      await db.insert(schema.generations).values({
        projectId: args.projectId,
        kind: "image",
        prompt: `图生图：${args.instruction}`,
        blobKey: media.blobKey,
        nodeId: args.nodeId,
      });
      ctx.invalidateQueries();
      return { blob_key: media.blobKey, url: media.url };
    },
  }),

  requestFilm: defineAction({
    description:
      "Queues a 'generate & compose film' request for a project: stores the ordered storyboard shots on a film request row and spawns a background Muse task that generates one true-motion clip per shot and saves the finished film back via importFilmFromWorkspace (host-side read of the delivery file, hash-verified chunked store, sealed finalize).",
    request: z.object({
      projectId: z.number().int().positive(),
      packageNodeId: z.string().max(80).optional(),
    }),
    response: filmRequestResponse,
    async handler(ctx, args): Promise<z.infer<typeof filmRequestResponse>> {
      const db = ctx.db<typeof schema>();
      const fail = (
        error: string,
        extra?: Partial<z.infer<typeof filmRequestResponse>>,
      ): z.infer<typeof filmRequestResponse> => ({
        ok: false,
        request_id: null,
        shot_count: 0,
        status: "failed",
        error,
        already: false,
        ...extra,
      });

      // One active film per project: return the in-flight request instead
      // of spawning a duplicate — UNLESS it has stalled (no progress
      // report for 15+ min, or 45+ min total). A stalled request is
      // auto-failed here so the user is never locked out for hours
      // staring at 0/N (the old limit was 3 hours).
      const latestRows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.projectId, args.projectId))
        .orderBy(desc(schema.filmRequests.id))
        .limit(1);
      const latest = latestRows[0];
      if (latest && (latest.status === "queued" || latest.status === "running")) {
        const stall = filmStallState(latest);
        if (!stall.shouldAutoFail) {
          return {
            ok: true,
            request_id: latest.id,
            shot_count: latest.shotCount,
            status: latest.status,
            error: "",
            already: true,
          };
        }
        await db
          .update(schema.filmRequests)
          .set({ status: "failed", error: stall.reason, updatedAt: new Date() })
          .where(eq(schema.filmRequests.id, latest.id));
      }

      const projRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.projectId))
        .limit(1);
      const proj = projRows[0];
      if (!proj) return fail("项目不存在");

      const graph = parseGraphLike(proj.graph);
      const { packageNodeId, orderedCount, missing, shots } = collectFilmShots(
        graph,
        args.packageNodeId,
      );
      if (orderedCount === 0) {
        return fail("画布上还没有分镜图节点：先写分镜、生成分镜图，再点「生成并合成成片」");
      }
      if (missing.length > 0) {
        return fail(
          `这些镜头还没有图：${missing.join("、")}。先给它们生成图片，再点「生成并合成成片」`,
        );
      }
      if (shots.length > 24) {
        return fail(
          `一次最多合成 24 个镜头（现在 ${shots.length} 个），镜头太多了，请拆成两个成片节点分别生成`,
          { shot_count: shots.length },
        );
      }

      const insertedRows = await db
        .insert(schema.filmRequests)
        .values({
          projectId: args.projectId,
          packageNodeId,
          status: "queued",
          shotsJson: JSON.stringify(shots),
          shotCount: shots.length,
        })
        .returning({ id: schema.filmRequests.id });
      const inserted = insertedRows[0];
      if (!inserted) return fail("成片请求创建失败，请重试");
      const requestId = inserted.id;

      const totalSeconds = shots.reduce((sum, s) => sum + s.duration, 0);
      const assignment = [
        `The user clicked 「生成并合成成片」 in the web artifact "无限画布视频生成工具" (slug: wu-xian-hua-bu-shi-pin-sheng-cheng-gong-ju). Film request id: ${requestId}. Project id: ${args.projectId}. Project name: ${proj.name}. The film has ${shots.length} shots, about ${totalSeconds} seconds total. Package (成片) node id: ${packageNodeId || "(none — omit packageNodeId when saving)"}.`,
        "",
        "Do the whole job yourself, end to end. The user must NOT be asked to export, download, or send anything — everything you need is reachable through the artifact's own actions, and the finished film goes back into the tool the same way.",
        "",
        "Steps:",
        `1. Call the artifact action getFilmRequest with { "requestId": ${requestId} } to get the ordered shot list. Per shot you get: index, title, blob_key (the storyboard image's blob key in the artifact's storage), image_prompt, motion_prompt (what moves in the shot and how — may be empty), caption (subtitle line, may be empty), duration_seconds, camera_motion, aspect. Note: the storyboard image bytes themselves are not readable from chat (the artifact's blob storage exposes no read path to you), so for each shot first regenerate its keyframe image from image_prompt with your own image generation, matching the prompt's subject, composition, colors and the shot's aspect.`,
        `2. For each shot, generate ONE true-motion video clip from that keyframe, driven by the shot's motion_prompt and camera_motion, about duration_seconds long. The subject itself must really move (image-to-video) — never a slideshow of stills, never pan/zoom over a static image, never frame interpolation presented as motion. Generate at most 6 clips per round; if there are more than 6 shots, continue in consecutive rounds until every shot has a clip. IMPORTANT — report progress so the tool's progress bar moves for real AND the request is not mistaken for stalled: (a) immediately when you start, call reportFilmProgress with { "requestId": ${requestId}, "doneShots": 0, "stage": "正在生成镜头片段" }; (b) after EACH shot's clip is finished, call reportFilmProgress with { "requestId": ${requestId}, "doneShots": <number of clips finished so far>, "stage": "正在生成镜头片段" }; (c) if any single clip takes more than about 3 minutes, call reportFilmProgress again with the same doneShots and a stage like "正在生成镜头片段（第 N 镜生成中）" as a heartbeat. If you go 15 minutes without any reportFilmProgress call the tool will auto-fail the request as stalled.`,
        `3. Before editing, call reportFilmProgress with { "requestId": ${requestId}, "doneShots": ${shots.length}, "stage": "正在按剧情剪辑合成" }. Then edit the clips into ONE coherent film in index order with ffmpeg: conform each clip to its duration_seconds, unify resolution and frame rate according to the shots' aspect (they share one aspect in practice), burn each shot's caption as a bottom subtitle shown during that shot (skip empty captions), and cut like a director following the story — straight cuts, at most a very short dissolve where it genuinely helps continuity. The result is a single MP4 (H.264, yuv420p, faststart).`,
        `4. Saving — HOST-SIDE IMPORT, follow this contract exactly; it exists because saving is where every past film request died. NEVER send the whole film as one action argument: the old whole-file save no longer exists — five real productions were lost to that single all-or-nothing call (bytes mangled in transit and stored unchecked, tasks vanishing mid-call with the request hanging for hours). (a) FIRST produce a "delivery encode" of the finished film BEFORE any save call — QUALITY FIRST, because this encode is exactly what the tool stores, plays, and offers for download. Keep the finished film's NATIVE resolution (whatever the edited master is — 1280x720, 720x1280, 1080p, …): NEVER downscale it, and never target a fixed file size. Encode H.264 at constant quality, CRF 18–20 (for 720p material that lands around 6 Mbps or higher; use -preset slow if time permits). An old rule capped this encode at ~1.5MB / a few hundred kbps — it was a workaround for a dead save channel, it made longer films unwatchably blurry, and it is ABOLISHED: do not resurrect it. The ONLY size limit is the tool's import cap of 64MB (67,108,864 bytes); if a CRF 18–20 encode would exceed 64MB, raise the CRF only as far as needed to fit under the cap and keep the native resolution. Keep the full-resolution master as a separate local file as well. (b) FILE DISCIPLINE + INTEGRITY, before any upload: do ALL of this save's file work in a directory named after this request — ~/workspace/film-delivery/${requestId}/ — and never use a shared temp filename: other productions may be running concurrently and a shared path gets overwritten (this exact accident already killed one save: the registered file was replaced before upload and no longer matched its hash). Verify the delivery file on your side (ffprobe must open it and report its full expected duration, and a full decode pass must not error), then compute its total byte size and its whole-file SHA-256 (e.g. sha256sum). The delivery encode MUST end up at the exact path ~/workspace/film-delivery/${requestId}/delivery.mp4 (folder named by the request id, file named exactly delivery.mp4) — that fixed location is how the tool finds it. Once you call importFilmFromWorkspace, the delivery file is FROZEN: never re-encode, move, or overwrite it until that call returns; keep any re-encode as a NEW file under a new name and, if its size/hash differ, that is a different film — do not mix the two. (c) Save with ONE call: importFilmFromWorkspace { "requestId": ${requestId} }. The tool reads ~/workspace/film-delivery/${requestId}/delivery.mp4 itself on the server host, slices it into ≤32KB chunks, verifies every chunk's SHA-256 before storing it, then seals the save — film attached to the 成片 node, history recorded, the request marked done. NEVER emit film bytes (base64 or otherwise) in an action call yourself: that channel is what killed every earlier save, at every size tried. Progress (正在保存成片 · 已传 X/N 片) is reported automatically per stored chunk and resets the tool's no-progress clock. A save only counts when importFilmFromWorkspace returns ok. If it returns ok with "imported_chunks": 0, this request already has a sealed film and NOTHING was overwritten; only when you are deliberately re-delivering a corrected or higher-quality encode of the SAME film for this SAME request, call replaceFilmFromWorkspace { "requestId": ${requestId} } instead — it stages and fully verifies the new file first, then swaps atomically, and a failed replace leaves the sealed film untouched. Never use it for a different film. (d) If importFilmFromWorkspace returns an error, read it and fix exactly what it names — file missing or at the wrong path: put the delivery encode at the exact path above; file not a valid MP4: re-encode the delivery encode and replace delivery.mp4 — then call importFilmFromWorkspace again, at most 3 tries total; chunks already stored are skipped, so a retry resumes instead of starting over. (e) If it still fails after 3 tries, IMMEDIATELY call the artifact action failFilmSave with { "requestId": ${requestId}, "reason": "<the actual error, in one short plain sentence>" } so the tool marks this request failed right away (it also records that the finished film exists on your side) — never leave the request hanging in "saving" until a timeout kills it — and then deliver the finished film file to the user directly in chat yourself. Do not invent a video or save anything else under the film's name.`,
        "5. Afterwards, tell the user briefly in chat that the film is done and saved into the tool (it shows on the 成片 node and in the 生成历史）, with the shot count and total duration. If one shot's clip fails after a genuine retry, still finish the film with the remaining shots in order and say plainly which shot is missing. If you cannot produce any real clip at all, say so plainly in chat and do NOT save anything.",
      ].join("\n");

      const spawned = await ctx.agent.spawnTask(assignment, {
        expectsAction: "importFilmFromWorkspace",
        dedupeKey: `film-${args.projectId}-${requestId}`,
      });
      if (!spawned.ok) {
        await db
          .update(schema.filmRequests)
          .set({ status: "failed", error: `成片任务未能启动：${spawned.error}`, updatedAt: new Date() })
          .where(eq(schema.filmRequests.id, requestId));
        ctx.invalidateQueries();
        return fail(`成片任务未能启动：${spawned.error}`, {
          request_id: requestId,
          shot_count: shots.length,
        });
      }
      await db
        .update(schema.filmRequests)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(schema.filmRequests.id, requestId));

      // Best-effort heads-up to the owning chat when the runtime exposes
      // it; the spawned task itself also reports back in chat when done.
      try {
        const notifyParent = (
          ctx as unknown as {
            notifyParent?: (message: string) => Promise<void> | void;
          }
        ).notifyParent;
        if (typeof notifyParent === "function") {
          await notifyParent(
            `工具里已排队生成成片：项目《${proj.name}》，${shots.length} 个镜头，正在逐镜头生成真运动视频并剪辑，完成后会自动存回工具。`,
          );
        }
      } catch {
        /* notification is best-effort only */
      }

      ctx.invalidateQueries();
      return {
        ok: true,
        request_id: requestId,
        shot_count: shots.length,
        status: "running",
        error: "",
        already: false,
      };
    },
  }),

  getFilmStatus: defineAction({
    description:
      "Returns the latest film-generation status for a project (none/queued/running/done/failed) plus the finished film's URL when done (empty with film_chunked=true when the film was saved as chunks — reassemble via getFilmAssembly), so the page can show progress and play the film inline. A queued/running request with no progress report for 15+ minutes — the saving stage included, since every stored chunk reports — or 45+ minutes total is auto-failed here as stalled so the user is never stuck watching 0/N forever.",
    request: z.object({ projectId: z.number().int().positive() }),
    response: filmStatusResponse,
    async handler(ctx, args): Promise<z.infer<typeof filmStatusResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.projectId, args.projectId))
        .orderBy(desc(schema.filmRequests.id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return {
          status: "none",
          request_id: null,
          shot_count: 0,
          progress_done: 0,
          progress_stage: "",
          film_url: "",
          film_chunked: false,
          error: "",
          created_at: "",
          updated_at: "",
          is_stalled: false,
        };
      }
      // Self-heal a stuck request on read: if it has stalled past the
      // fail threshold, flip it to failed right away so the page shows
      // the retry state instead of an eternal spinner.
      let effective = row;
      const stall = filmStallState(row);
      if (stall.shouldAutoFail) {
        const now = new Date();
        await db
          .update(schema.filmRequests)
          .set({ status: "failed", error: stall.reason, updatedAt: now })
          .where(eq(schema.filmRequests.id, row.id));
        effective = { ...row, status: "failed" as const, error: stall.reason, updatedAt: now };
        ctx.invalidateQueries();
      }
      const effStall = filmStallState(effective);
      const chunked = isFilmAssemblyMarker(effective.filmBlobKey);
      return {
        status: effective.status,
        request_id: effective.id,
        shot_count: effective.shotCount,
        progress_done:
          effective.status === "done" ? effective.shotCount : effective.progressDone,
        progress_stage: effective.progressStage,
        film_url:
          effective.filmBlobKey && !chunked
            ? await ctx.blobs.getUrl(effective.filmBlobKey)
            : "",
        film_chunked: chunked,
        error: effective.error,
        created_at: effective.createdAt.toISOString(),
        updated_at: effective.updatedAt.toISOString(),
        is_stalled: effStall.isStalled,
      };
    },
  }),

  cancelFilm: defineAction({
    description:
      "Cancels the project's in-flight (queued/running) film generation request, marking it failed so the user can immediately start a new one. Used when generation looks stuck; late progress/save calls from the old background task for that request are then ignored or treated as orphaned.",
    request: z.object({ projectId: z.number().int().positive() }),
    response: cancelFilmResponse,
    async handler(ctx, args): Promise<z.infer<typeof cancelFilmResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.projectId, args.projectId))
        .orderBy(desc(schema.filmRequests.id))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true, cancelled: false, error: "" };
      if (row.status !== "queued" && row.status !== "running") {
        return { ok: true, cancelled: false, error: "" };
      }
      await db
        .update(schema.filmRequests)
        .set({
          status: "failed",
          error: "你已结束这次生成（进度长时间没有变化）。可以点「重新生成」再试一次",
          progressStage: "",
          updatedAt: new Date(),
        })
        .where(eq(schema.filmRequests.id, row.id));
      ctx.invalidateQueries();
      return { ok: true, cancelled: true, error: "" };
    },
  }),

  reportFilmProgress: defineAction({
    description:
      "Reports live progress for an in-flight film request (shot clips finished so far + a short stage label) so the tool page can show a real, moving progress bar while the film is being generated.",
    request: z.object({
      requestId: z.number().int().positive(),
      doneShots: z.number().int().min(0).max(1000).optional(),
      stage: z.string().max(80).optional(),
    }),
    response: filmProgressResponse,
    async handler(ctx, args): Promise<z.infer<typeof filmProgressResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.id, args.requestId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("成片请求不存在");
      // Late or duplicate reports for a finished request change nothing.
      if (row.status === "done" || row.status === "failed") {
        return { ok: true };
      }
      const patch: {
        progressDone?: number;
        progressStage?: string;
        updatedAt: Date;
      } = { updatedAt: new Date() };
      if (args.doneShots != null) {
        // Progress only moves forward, and never past the shot total.
        patch.progressDone = Math.min(
          row.shotCount,
          Math.max(row.progressDone, args.doneShots),
        );
      }
      if (args.stage != null && args.stage.trim()) {
        patch.progressStage = args.stage.trim();
      }
      await db
        .update(schema.filmRequests)
        .set(patch)
        .where(eq(schema.filmRequests.id, row.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getFilmRequest: defineAction({
    description:
      "Returns one film request's ordered shot list (blob keys, prompts, motion prompts, captions, durations) for the background Muse task that generates the clips and edits the film.",
    request: z.object({ requestId: z.number().int().positive() }),
    response: z.object({
      request_id: z.number(),
      project_id: z.number(),
      project_name: z.string(),
      package_node_id: z.string(),
      status: z.string(),
      shots: z.array(
        z.object({
          index: z.number(),
          node_id: z.string(),
          title: z.string(),
          blob_key: z.string(),
          image_prompt: z.string(),
          motion_prompt: z.string(),
          caption: z.string(),
          duration_seconds: z.number(),
          camera_motion: z.string(),
          aspect: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.id, args.requestId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("成片请求不存在");
      if (row.status === "queued") {
        await db
          .update(schema.filmRequests)
          .set({
            status: "running",
            progressStage: row.progressStage || "正在生成镜头片段",
            updatedAt: new Date(),
          })
          .where(eq(schema.filmRequests.id, row.id));
      }
      const projRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, row.projectId))
        .limit(1);
      let shots: FilmShot[] = [];
      try {
        const parsed = JSON.parse(row.shotsJson) as FilmShot[];
        if (Array.isArray(parsed)) shots = parsed;
      } catch {
        shots = [];
      }
      return {
        request_id: row.id,
        project_id: row.projectId,
        project_name: projRows[0]?.name ?? "",
        package_node_id: row.packageNodeId,
        status: row.status === "queued" ? "running" : row.status,
        shots: shots.map((s) => ({
          index: s.index,
          node_id: s.nodeId,
          title: s.title,
          blob_key: s.blobKey,
          image_prompt: s.imagePrompt,
          motion_prompt: s.motionPrompt,
          caption: s.caption,
          duration_seconds: s.duration,
          camera_motion: s.cameraMotion,
          aspect: s.aspect,
        })),
      };
    },
  }),

  beginFilmSave: defineAction({
    description:
      "Starts (or resumes) the CHUNKED save of a finished film for a film request: registers the assembly manifest — chunk count (each chunk ≤32KB raw bytes), total byte size, and the whole file's SHA-256 hex — and returns the chunk indices already received, so a restarted task resumes where it left off instead of re-sending everything. Then call saveFilmChunk once per missing chunk and finalizeFilmSave at the end. The old whole-file saveFilmToProject action no longer exists: never send a whole film as one action argument.",
    request: z.object({
      requestId: z.number().int().positive(),
      chunkCount: z.number().int().min(1).max(FILM_MAX_CHUNKS),
      totalBytes: z.number().int().min(1).max(FILM_MAX_TOTAL_BYTES),
      sha256: z.string().regex(SHA256_HEX_RE),
      mime: z.string().min(3).max(80).default("video/mp4"),
    }),
    response: z.object({
      ok: z.literal(true),
      received: z.array(z.number()),
      sealed: z.boolean(),
      chunk_count: z.number(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; received: number[]; sealed: boolean; chunk_count: number }> {
      const db = ctx.db<typeof schema>();
      const reqRows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.id, args.requestId))
        .limit(1);
      const req = reqRows[0];
      if (!req) throw new Error("成片请求不存在");
      const existing = await loadAssembly(db, args.requestId);
      if (existing) {
        if (
          existing.chunkCount !== args.chunkCount ||
          existing.totalBytes !== args.totalBytes ||
          existing.sha256 !== args.sha256.toLowerCase()
        ) {
          throw new Error(
            `这个请求已经登记过一份不同的成片（${existing.chunkCount} 片、共 ${existing.totalBytes} 字节），和这次报的（${args.chunkCount} 片、共 ${args.totalBytes} 字节）对不上。不要换文件保存：用原来那份交付版继续传完，或先结束这次请求再重新生成`,
          );
        }
        const received = await receivedChunkIndices(db, existing.id);
        return {
          ok: true,
          received,
          sealed: existing.status === "sealed",
          chunk_count: existing.chunkCount,
        };
      }
      if (req.status === "done" || req.status === "failed") {
        throw new Error(
          "这个成片请求已经结束（完成或失败），不能再开始保存。如果成片还没存进工具，请让用户重新点一次「生成并合成成片」开一个新请求",
        );
      }
      const insertedRows = await db
        .insert(schema.filmAssemblies)
        .values({
          requestId: req.id,
          projectId: req.projectId,
          packageNodeId: req.packageNodeId,
          chunkCount: args.chunkCount,
          totalBytes: args.totalBytes,
          sha256: args.sha256.toLowerCase(),
          mime: args.mime || "video/mp4",
          status: "open",
        })
        .returning({ id: schema.filmAssemblies.id });
      if (!insertedRows[0]) throw new Error("成片保存登记失败，请重试");
      await reportChunkProgress(db, { requestId: req.id, received: 0, total: args.chunkCount });
      ctx.invalidateQueries();
      return { ok: true, received: [], sealed: false, chunk_count: args.chunkCount };
    },
  }),

  saveFilmChunk: defineAction({
    description:
      "Uploads ONE chunk of a film being saved via beginFilmSave: index is 0-based, dataBase64 is at most 32KB of raw bytes, and sha256 is that chunk's SHA-256 hex. The server hashes the bytes it actually receives and rejects a mismatch immediately (nothing is stored) — re-read just that chunk from disk and send it again; other chunks are unaffected. Re-sending an already-stored chunk with the same hash is a no-op success, so the sequence is resumable. Each stored chunk reports the save progress (已传 X/N 片) automatically. NOTE: the background film task should normally save via importFilmFromWorkspace instead (it reads the delivery file host-side); this per-chunk upload remains as the underlying mechanism and a fallback.",
    request: z.object({
      requestId: z.number().int().positive(),
      index: z.number().int().min(0).max(FILM_MAX_CHUNKS - 1),
      dataBase64: z.string().min(1).max(FILM_CHUNK_BASE64_MAX),
      sha256: z.string().regex(SHA256_HEX_RE),
    }),
    response: z.object({
      ok: z.literal(true),
      received_count: z.number(),
      chunk_count: z.number(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; received_count: number; chunk_count: number }> {
      const db = ctx.db<typeof schema>();
      const assembly = await loadAssembly(db, args.requestId);
      if (!assembly) {
        throw new Error("还没有登记成片保存：先调用 beginFilmSave 报总片数、总字节数和整文件 SHA-256");
      }
      const bytes = decodeBase64(args.dataBase64);
      const receivedCount = await storeFilmChunk(ctx, db, assembly, args.index, bytes, args.sha256);
      ctx.invalidateQueries();
      return { ok: true, received_count: receivedCount, chunk_count: assembly.chunkCount };
    },
  }),

  finalizeFilmSave: defineAction({
    description:
      "Seals a chunked film save started with beginFilmSave: verifies every chunk 0..N-1 is present, each stored blob's size matches its declared length, and the lengths sum to the registered total. Only then attaches the film to the 成片 node, records it in generation history, and marks the film request (and any linked Agent run) done. If any chunk is missing or the wrong size, it fails with exactly which chunks are wrong and nothing is marked done — send the missing chunks via saveFilmChunk and call again.",
    request: z.object({ requestId: z.number().int().positive() }),
    response: z.object({
      ok: z.literal(true),
      chunk_count: z.number(),
      total_bytes: z.number(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; chunk_count: number; total_bytes: number }> {
      const db = ctx.db<typeof schema>();
      const assembly = await loadAssembly(db, args.requestId);
      if (!assembly) {
        throw new Error("还没有登记成片保存：先调用 beginFilmSave，再逐片 saveFilmChunk，最后 finalizeFilmSave");
      }
      if (assembly.status === "sealed") {
        return { ok: true, chunk_count: assembly.chunkCount, total_bytes: assembly.totalBytes };
      }
      const sealed = await sealAssembly(ctx, db, assembly);
      ctx.invalidateQueries();
      return { ok: true, chunk_count: sealed.chunk_count, total_bytes: sealed.total_bytes };
    },
  }),

  importFilmFromWorkspace: defineAction({
    description:
      "Imports the finished film for a film request from the delivery file the background task wrote to ~/workspace/film-delivery/<requestId>/delivery.mp4: the file is read host-side (no film bytes ever pass through an action argument — the channel that killed every earlier save), sliced into ≤32KB chunks, each chunk's SHA-256 verified before it is stored, and the save is then sealed exactly like finalizeFilmSave — film attached to the 成片 node, history recorded, request (and any linked Agent run) marked done. Chunks already stored are skipped, so calling it again after an error resumes where it stopped. This is THE way for the background task to save a finished film.",
    request: z.object({ requestId: z.number().int().positive() }),
    response: z.object({
      ok: z.literal(true),
      chunk_count: z.number(),
      total_bytes: z.number(),
      imported_chunks: z.number(),
    }),
    privileged: [contracts.filmFileInfo, contracts.readFilmChunk],
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; chunk_count: number; total_bytes: number; imported_chunks: number }> {
      const db = ctx.db<typeof schema>();
      const reqRows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.id, args.requestId))
        .limit(1);
      const req = reqRows[0];
      if (!req) throw new Error("成片请求不存在");
      let assembly = await loadAssembly(db, req.id);
      if (assembly?.status === "sealed") {
        return {
          ok: true,
          chunk_count: assembly.chunkCount,
          total_bytes: assembly.totalBytes,
          imported_chunks: 0,
        };
      }
      const info = await ctx.executePrivileged(contracts.filmFileInfo, {
        requestId: args.requestId,
      });
      if (!info.found || info.totalBytes <= 0) {
        throw new Error(
          `没有在 ~/workspace/film-delivery/${args.requestId}/delivery.mp4 找到交付版成片文件。请把最终交付版 MP4 存到这个确切路径（文件夹名就是请求号 ${args.requestId}，文件名必须是 delivery.mp4），用 ffprobe 确认它能完整解码，再调用 importFilmFromWorkspace`,
        );
      }
      if (info.totalBytes > FILM_MAX_TOTAL_BYTES) {
        throw new Error(
          `高清交付版文件有 ${info.totalBytes} 字节，超过工具能保存的上限（64MB）。请保持原分辨率不变、适当调高 CRF 把文件压到 64MB 以内（不要降分辨率、不要按固定小体积目标压），覆盖 delivery.mp4 后再调用 importFilmFromWorkspace`,
        );
      }
      const chunkCount = Math.ceil(info.totalBytes / FILM_CHUNK_BYTES);
      if (chunkCount > FILM_MAX_CHUNKS) {
        throw new Error("高清交付版文件的分片数超过上限（等同超过 64MB）。请保持原分辨率不变、适当调高 CRF 把文件压到 64MB 以内后再导入");
      }
      if (!assembly) {
        const insertedRows = await db
          .insert(schema.filmAssemblies)
          .values({
            requestId: req.id,
            projectId: req.projectId,
            packageNodeId: req.packageNodeId,
            chunkCount,
            totalBytes: info.totalBytes,
            sha256: info.sha256.toLowerCase(),
            mime: "video/mp4",
            status: "open",
          })
          .returning({ id: schema.filmAssemblies.id });
        if (!insertedRows[0]) throw new Error("成片保存登记失败，请重试 importFilmFromWorkspace");
        await reportChunkProgress(db, { requestId: req.id, received: 0, total: chunkCount });
        assembly = await loadAssembly(db, req.id);
        if (!assembly) throw new Error("成片保存登记失败，请重试 importFilmFromWorkspace");
      } else if (
        assembly.chunkCount !== chunkCount ||
        assembly.totalBytes !== info.totalBytes ||
        assembly.sha256 !== info.sha256.toLowerCase()
      ) {
        // A manifest was registered earlier (e.g. beginFilmSave from a
        // first attempt) but the file on disk differs. If chunks are
        // already stored under the old manifest the two are different
        // films — refuse rather than mix them. With zero chunks
        // stored, the file on disk is the ground truth: re-register.
        const receivedSoFar = await receivedChunkIndices(db, assembly.id);
        if (receivedSoFar.length > 0) {
          throw new Error(
            "工具里已经存了这部成片的一部分分片，但和 delivery.mp4 对不上（大小或哈希不同），两边不是同一个文件。请不要混存：确认 delivery.mp4 是本次请求最终的交付版；如果工具里存的是旧版本，让用户重新点一次「生成并合成成片」开新请求再保存",
          );
        }
        await db
          .update(schema.filmAssemblies)
          .set({
            chunkCount,
            totalBytes: info.totalBytes,
            sha256: info.sha256.toLowerCase(),
            mime: "video/mp4",
            updatedAt: new Date(),
          })
          .where(eq(schema.filmAssemblies.id, assembly.id));
        assembly = {
          ...assembly,
          chunkCount,
          totalBytes: info.totalBytes,
          sha256: info.sha256.toLowerCase(),
          mime: "video/mp4",
        };
      }
      const received = new Set(await receivedChunkIndices(db, assembly.id));
      let imported = 0;
      // Every slice is read from the delivery file even when its chunk
      // is already stored: the slices are also concatenated into the
      // whole-file copy below, so playback/download never reassemble
      // chunks in the browser.
      const fullParts: Uint8Array[] = [];
      for (let i = 0; i < assembly.chunkCount; i++) {
        const part = await ctx.executePrivileged(contracts.readFilmChunk, {
          requestId: args.requestId,
          index: i,
          chunkBytes: FILM_CHUNK_BYTES,
        });
        const bytes = decodeBase64(part.dataBase64);
        if (bytes.length !== part.byteLength) {
          throw new Error(
            `第 ${i + 1} 片读取长度异常。已存好的分片不会丢失，请直接重试 importFilmFromWorkspace 续传`,
          );
        }
        fullParts.push(bytes);
        if (received.has(i)) continue;
        await storeFilmChunk(ctx, db, assembly, i, bytes, part.sha256);
        imported++;
      }
      const sealed = await sealAssembly(ctx, db, assembly);
      // Whole-file copy for direct playback/download. Best-effort: the
      // sealed chunks are the record of truth, and getFilmFile can
      // materialize this copy later if writing it here fails.
      try {
        const full = concatBytes(fullParts);
        if (
          full.length === info.totalBytes &&
          (await sha256Hex(full)) === info.sha256.toLowerCase()
        ) {
          const fullKey = filmFullBlobKey(req.projectId, req.id);
          await ctx.blobs.put(fullKey, full, { contentType: "video/mp4" });
          const head = await ctx.blobs.head(fullKey);
          if (head && head.sizeBytes === info.totalBytes) {
            await db
              .update(schema.filmAssemblies)
              .set({ fullBlobKey: fullKey, updatedAt: new Date() })
              .where(eq(schema.filmAssemblies.id, assembly.id));
          }
        }
      } catch {
        // Direct-file copy is an optimization; the sealed film stands.
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        chunk_count: sealed.chunk_count,
        total_bytes: sealed.total_bytes,
        imported_chunks: imported,
      };
    },
  }),

  replaceFilmFromWorkspace: defineAction({
    description:
      "Explicitly REPLACES the already-sealed film of a film request with the file now at ~/workspace/film-delivery/<requestId>/delivery.mp4 (e.g. a higher-quality re-encode of the same film). The new file is staged chunk by chunk under versioned blob keys with the same verification as a first save (per-chunk SHA-256 over the received bytes, MP4 ftyp head gate, per-blob size check); only when every chunk is staged and verified does ONE atomic batch swap the chunk rows, the assembly manifest, the 成片 node's manifest and the history entry to the new version, after which the old chunks are deleted. Any failure before the swap leaves the sealed film completely untouched. If the delivery file is byte-identical to the sealed film, this is a no-op. For a first save (nothing sealed yet) use importFilmFromWorkspace instead.",
    request: z.object({ requestId: z.number().int().positive() }),
    response: z.object({
      ok: z.literal(true),
      replaced: z.boolean(),
      chunk_count: z.number(),
      total_bytes: z.number(),
      sha256: z.string(),
      previous_total_bytes: z.number(),
    }),
    privileged: [contracts.filmFileInfo, contracts.readFilmChunk],
    async handler(
      ctx,
      args,
    ): Promise<{
      ok: true;
      replaced: boolean;
      chunk_count: number;
      total_bytes: number;
      sha256: string;
      previous_total_bytes: number;
    }> {
      const db = ctx.db<typeof schema>();
      const reqRows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.id, args.requestId))
        .limit(1);
      const req = reqRows[0];
      if (!req) throw new Error("成片请求不存在");
      const assembly = await loadAssembly(db, req.id);
      if (!assembly || assembly.status !== "sealed") {
        throw new Error(
          "这个请求还没有已封存的成片，没有可替换的版本。首次保存请用 importFilmFromWorkspace",
        );
      }
      const previousTotalBytes = assembly.totalBytes;
      const info = await ctx.executePrivileged(contracts.filmFileInfo, {
        requestId: args.requestId,
      });
      if (!info.found || info.totalBytes <= 0) {
        throw new Error(
          `没有在 ~/workspace/film-delivery/${args.requestId}/delivery.mp4 找到要替换上的成片文件。原已封存的成片没有动。请把新版 MP4 存到这个确切路径（文件夹名就是请求号 ${args.requestId}，文件名必须是 delivery.mp4），用 ffprobe 确认它能完整解码，再调用 replaceFilmFromWorkspace`,
        );
      }
      if (info.totalBytes > FILM_MAX_TOTAL_BYTES) {
        throw new Error(
          `新版文件有 ${info.totalBytes} 字节，超过工具能保存的上限（64MB）。原已封存的成片没有动。请保持原分辨率不变、适当调高 CRF 把文件压到 64MB 以内，覆盖 delivery.mp4 后再调用 replaceFilmFromWorkspace`,
        );
      }
      const chunkCount = Math.ceil(info.totalBytes / FILM_CHUNK_BYTES);
      if (chunkCount > FILM_MAX_CHUNKS) {
        throw new Error(
          "新版文件的分片数超过上限（等同超过 64MB）。原已封存的成片没有动。请保持原分辨率不变、适当调高 CRF 把文件压到 64MB 以内后再替换",
        );
      }
      const newSha = info.sha256.toLowerCase();
      if (
        newSha === assembly.sha256.toLowerCase() &&
        info.totalBytes === assembly.totalBytes &&
        chunkCount === assembly.chunkCount
      ) {
        // Byte-identical to the sealed film: nothing to replace.
        return {
          ok: true,
          replaced: false,
          chunk_count: assembly.chunkCount,
          total_bytes: assembly.totalBytes,
          sha256: assembly.sha256,
          previous_total_bytes: previousTotalBytes,
        };
      }
      // STAGE the new film under versioned blob keys. The sealed
      // assembly's rows, manifest and blobs are NOT touched in this
      // phase, so the current film stays playable throughout; any
      // failure here just discards the staged blobs.
      const versionTag = newSha.slice(0, 12);
      const stagedKey = (index: number) =>
        `${filmChunkBlobKey(assembly.projectId, assembly.requestId, index)}-v${versionTag}`;
      const staged: { idx: number; blobKey: string; byteLength: number; sha256: string }[] = [];
      const stagedBytes: Uint8Array[] = [];
      let stagedFullKey = "";
      try {
        for (let i = 0; i < chunkCount; i++) {
          const part = await ctx.executePrivileged(contracts.readFilmChunk, {
            requestId: args.requestId,
            index: i,
            chunkBytes: FILM_CHUNK_BYTES,
          });
          const bytes = decodeBase64(part.dataBase64);
          if (bytes.length !== part.byteLength || bytes.length === 0) {
            throw new Error(`第 ${i + 1} 片读取长度异常，原成片没有动。请直接重试 replaceFilmFromWorkspace`);
          }
          const actualSha = await sha256Hex(bytes);
          if (actualSha !== part.sha256.toLowerCase()) {
            throw new Error(
              `第 ${i + 1} 片在读取时被打烂了（字节哈希对不上），没有替换，原成片完好。请直接重试 replaceFilmFromWorkspace`,
            );
          }
          if (i === 0) assertMp4ChunkHead(bytes, assembly.mime || "video/mp4");
          const key = stagedKey(i);
          await ctx.blobs.put(key, bytes, { contentType: assembly.mime || "video/mp4" });
          staged.push({ idx: i, blobKey: key, byteLength: bytes.length, sha256: actualSha });
          stagedBytes.push(bytes);
        }
        // Seal-grade verification of the staged set BEFORE the swap:
        // every staged blob really stored, with exactly the length
        // its hash-verified bytes had, summing to the file's total.
        let stagedSum = 0;
        for (const s of staged) {
          const head = await ctx.blobs.head(s.blobKey);
          if (!head || head.sizeBytes !== s.byteLength) {
            throw new Error(
              `第 ${s.idx + 1} 片暂存异常（应有 ${s.byteLength} 字节，实际 ${head ? `${head.sizeBytes} 字节` : "不存在"}），没有替换，原成片完好。请直接重试 replaceFilmFromWorkspace`,
            );
          }
          stagedSum += s.byteLength;
        }
        if (stagedSum !== info.totalBytes) {
          throw new Error("暂存分片总长度与新版文件对不上，没有替换，原成片完好。请直接重试 replaceFilmFromWorkspace");
        }
        // Stage the whole-file copy too (versioned key): verified
        // against the new file's whole-file hash before it is stored,
        // and only pointed at by the atomic swap below.
        const fullBytes = concatBytes(stagedBytes);
        if ((await sha256Hex(fullBytes)) !== newSha) {
          throw new Error("新版成片整文件校验对不上，没有替换，原成片完好。请直接重试 replaceFilmFromWorkspace");
        }
        stagedFullKey = filmFullBlobKey(assembly.projectId, assembly.requestId, versionTag);
        await ctx.blobs.put(stagedFullKey, fullBytes, {
          contentType: assembly.mime || "video/mp4",
        });
        const fullHead = await ctx.blobs.head(stagedFullKey);
        if (!fullHead || fullHead.sizeBytes !== info.totalBytes) {
          throw new Error("新版成片整文件暂存异常，没有替换，原成片完好。请直接重试 replaceFilmFromWorkspace");
        }
      } catch (e) {
        for (const s of staged) {
          try {
            await ctx.blobs.delete(s.blobKey);
          } catch {
            // best-effort cleanup of staged blobs; the sealed film is untouched either way
          }
        }
        if (stagedFullKey) {
          try {
            await ctx.blobs.delete(stagedFullKey);
          } catch {
            // best-effort cleanup, as above
          }
        }
        throw e;
      }
      // Prepare the graph patch (new manifest on the 成片 node) from
      // the current stored graph, exactly like sealAssembly does.
      const projRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, assembly.projectId))
        .limit(1);
      const proj = projRows[0];
      if (!proj) throw new Error("项目不存在，原成片没有动");
      const marker = filmAssemblyMarker(assembly.requestId);
      const manifest = {
        requestId: assembly.requestId,
        chunkCount,
        totalBytes: info.totalBytes,
        sha256: newSha,
        mime: assembly.mime || "video/mp4",
      };
      const graph = parseGraphLike(proj.graph);
      const targetId = attachFilmToGraph(graph, assembly.packageNodeId || undefined, {
        url: "",
        blobKey: "",
        filmAssembly: manifest,
      });
      const oldChunkRows = await db
        .select()
        .from(schema.filmChunks)
        .where(eq(schema.filmChunks.assemblyId, assembly.id));
      // ATOMIC SWAP: one batch repoints the chunk rows, the assembly
      // manifest, the project graph and the history at the new
      // version. Before this batch commits, every reader still sees
      // the old sealed film; after it, everyone sees the new one.
      // There is no intermediate state.
      const statements: BatchItem<"sqlite">[] = [
        db.delete(schema.filmChunks).where(eq(schema.filmChunks.assemblyId, assembly.id)),
        ...staged.map((s) =>
          db.insert(schema.filmChunks).values({
            assemblyId: assembly.id,
            idx: s.idx,
            blobKey: s.blobKey,
            byteLength: s.byteLength,
            sha256: s.sha256,
          }),
        ),
        db
          .update(schema.filmAssemblies)
          .set({
            chunkCount,
            totalBytes: info.totalBytes,
            sha256: newSha,
            mime: "video/mp4",
            fullBlobKey: stagedFullKey || assembly.fullBlobKey,
            updatedAt: new Date(),
          })
          .where(eq(schema.filmAssemblies.id, assembly.id)),
        db
          .update(schema.projects)
          .set({ graph: JSON.stringify(graph), updatedAt: new Date() })
          .where(eq(schema.projects.id, assembly.projectId)),
        db.insert(schema.generations).values({
          projectId: assembly.projectId,
          kind: "video",
          prompt: `成片：${proj.name}`,
          blobKey: marker,
          nodeId: targetId,
        }),
      ];
      const [firstStmt, ...restStmts] = statements;
      if (firstStmt) await db.batch([firstStmt, ...restStmts]);
      await completeFilmRequest(db, {
        projectId: assembly.projectId,
        requestId: assembly.requestId,
        filmRef: marker,
      });
      // Cleanup: the old version's blobs are unreferenced now.
      const newKeys = new Set(staged.map((s) => s.blobKey));
      for (const row of oldChunkRows) {
        if (!row.blobKey || newKeys.has(row.blobKey)) continue;
        try {
          await ctx.blobs.delete(row.blobKey);
        } catch {
          // best-effort: an orphaned old chunk blob is harmless
        }
      }
      if (assembly.fullBlobKey && assembly.fullBlobKey !== stagedFullKey) {
        try {
          await ctx.blobs.delete(assembly.fullBlobKey);
        } catch {
          // best-effort: an orphaned old whole-file copy is harmless
        }
      }
      ctx.invalidateQueries();
      return {
        ok: true,
        replaced: true,
        chunk_count: chunkCount,
        total_bytes: info.totalBytes,
        sha256: newSha,
        previous_total_bytes: previousTotalBytes,
      };
    },
  }),

  getFilmAssembly: defineAction({
    description:
      "Returns a chunked film's assembly manifest (chunk count, total bytes, whole-file SHA-256, mime) plus the ordered per-chunk URLs once the save is sealed, so the page can reassemble the MP4 in the browser and verify its length + SHA-256 + MP4 structure before playing or downloading it.",
    request: z.object({ requestId: z.number().int().positive() }),
    response: filmAssemblyResponse,
    async handler(ctx, args): Promise<z.infer<typeof filmAssemblyResponse>> {
      const db = ctx.db<typeof schema>();
      const assembly = await loadAssembly(db, args.requestId);
      if (!assembly) {
        return {
          found: false,
          sealed: false,
          chunk_count: 0,
          received_count: 0,
          total_bytes: 0,
          sha256: "",
          mime: "video/mp4",
          chunk_urls: [],
        };
      }
      const received = await receivedChunkIndices(db, assembly.id);
      const sealed = assembly.status === "sealed";
      const chunkUrls: string[] = [];
      if (sealed) {
        const chunkRows = await db
          .select()
          .from(schema.filmChunks)
          .where(eq(schema.filmChunks.assemblyId, assembly.id))
          .orderBy(schema.filmChunks.idx);
        for (const row of chunkRows) {
          chunkUrls.push(await ctx.blobs.getUrl(row.blobKey));
        }
      }
      return {
        found: true,
        sealed,
        chunk_count: assembly.chunkCount,
        received_count: received.length,
        total_bytes: assembly.totalBytes,
        sha256: assembly.sha256,
        mime: assembly.mime || "video/mp4",
        chunk_urls: chunkUrls,
      };
    },
  }),

  getFilmFile: defineAction({
    description:
      "Returns a direct whole-file URL for a sealed chunked film: one blob holding the complete MP4, so the page downloads or plays it in a single request with no chunk fetches, no browser-side reassembly and no repeat verification (sealing already verified every chunk hash and the whole-file total). If the film was sealed before whole-file copies existed, the copy is materialized once here — verified against the sealed manifest's size + SHA-256 — and reused afterwards. url is empty when no whole-file copy exists or could be produced; the client then falls back to getFilmAssembly's chunked path.",
    request: z.object({ requestId: z.number().int().positive() }),
    response: filmFileResponse,
    privileged: [contracts.filmFileInfo, contracts.readFilmChunk],
    async handler(ctx, args): Promise<z.infer<typeof filmFileResponse>> {
      const db = ctx.db<typeof schema>();
      const assembly = await loadAssembly(db, args.requestId);
      if (!assembly) {
        return {
          found: false,
          sealed: false,
          url: "",
          total_bytes: 0,
          sha256: "",
          mime: "video/mp4",
          chunk_count: 0,
        };
      }
      const base = {
        found: true,
        sealed: assembly.status === "sealed",
        total_bytes: assembly.totalBytes,
        sha256: assembly.sha256,
        mime: assembly.mime || "video/mp4",
        chunk_count: assembly.chunkCount,
      };
      if (assembly.status !== "sealed") return { ...base, url: "" };
      let key = assembly.fullBlobKey;
      if (key) {
        const head = await ctx.blobs.head(key);
        if (!head || head.sizeBytes !== assembly.totalBytes) key = "";
      }
      if (!key) {
        key = await materializeFullFilmBlob(ctx, db, assembly);
      }
      if (!key) return { ...base, url: "" };
      return { ...base, url: await ctx.blobs.getUrl(key) };
    },
  }),

  failFilmSave: defineAction({
    description:
      "Called by the background film task when saving the finished film back into the tool has definitively failed (after its bounded save attempts). Immediately marks the film request failed — and any linked Agent 一句话成片 run too — with a plain-language reason that records the finished film file still exists on the task side and can be delivered to the user directly in chat, instead of leaving the request hanging in running until a stall timeout kills it.",
    request: z.object({
      requestId: z.number().int().positive(),
      reason: z.string().min(1).max(300),
    }),
    response: filmProgressResponse,
    async handler(ctx, args): Promise<z.infer<typeof filmProgressResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.filmRequests)
        .where(eq(schema.filmRequests.id, args.requestId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("成片请求不存在");
      if (row.status === "done" || row.status === "failed") {
        return { ok: true };
      }
      const error = `成片保存回工具失败：${args.reason.trim()}。成片文件已在后台生成完毕，可由 Muse 直接在对话里发给你，不用重新生成`;
      await db
        .update(schema.filmRequests)
        .set({ status: "failed", error, progressStage: "", updatedAt: new Date() })
        .where(eq(schema.filmRequests.id, row.id));
      // The Agent 一句话成片 run linked to this request fails with it —
      // same save path, same honest ending.
      const agentRows = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.filmRequestId, row.id));
      for (const run of agentRows) {
        if (run.status !== "cancelled" && run.status !== "done" && run.status !== "failed") {
          await db
            .update(schema.agentRuns)
            .set({ status: "failed", error, progressStage: "", updatedAt: new Date() })
            .where(eq(schema.agentRuns.id, run.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  startAgentProduction: defineAction({
    description:
      "Starts an 'Agent 一句话成片' production: creates a NEW project (existing projects untouched) plus an agent run in queued state. The client then calls buildAgentProduction, which builds the workflow on that project's canvas.",
    request: z.object({
      instruction: z.string().min(1).max(500),
      targetDuration: z.number().int().min(0).max(300).default(0),
      aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
      style: z.string().max(120).default(""),
      mode: z.enum(["auto", "step"]).default("auto"),
    }),
    response: agentStartResponse,
    async handler(ctx, args): Promise<z.infer<typeof agentStartResponse>> {
      const db = ctx.db<typeof schema>();
      const name = `Agent成片：${args.instruction.trim().slice(0, 20)}`;
      const projRows = await db
        .insert(schema.projects)
        .values({ name, graph: JSON.stringify({ nodes: [], edges: [], viewport: { x: 20, y: 40, k: 0.6 } }) })
        .returning({ id: schema.projects.id });
      const proj = projRows[0];
      if (!proj) {
        return { ok: false, project_id: null, run_id: null, status: "failed", error: "新项目创建失败，请重试" };
      }
      const runRows = await db
        .insert(schema.agentRuns)
        .values({
          projectId: proj.id,
          instruction: args.instruction.trim(),
          targetDuration: args.targetDuration,
          aspect: args.aspect,
          style: args.style.trim(),
          mode: args.mode,
          status: "queued",
          progressStage: "已排队，等待开始",
        })
        .returning({ id: schema.agentRuns.id });
      const run = runRows[0];
      if (!run) {
        return { ok: false, project_id: proj.id, run_id: null, status: "failed", error: "自动制作任务创建失败，请重试" };
      }
      ctx.invalidateQueries();
      return { ok: true, project_id: proj.id, run_id: run.id, status: "queued", error: "" };
    },
  }),

  buildAgentProduction: defineAction({
    description:
      "Runs the server-side build for a queued agent run: writes the storyboard script (platform inference), locks the character/scene asset (one reference image + a unified anchor text injected into every shot prompt), generates each shot's storyboard image one by one with per-shot progress, lays out the zoned canvas, then either starts the background film pipeline (auto mode) or parks in awaiting_confirm (step mode / failed shots).",
    request: z.object({ runId: z.number().int().positive() }),
    response: agentStartResponse,
    async handler(ctx, args): Promise<z.infer<typeof agentStartResponse>> {
      const db = ctx.db<typeof schema>();
      const fail = async (
        runId: number,
        projectId: number | null,
        error: string,
      ): Promise<z.infer<typeof agentStartResponse>> => {
        await db
          .update(schema.agentRuns)
          .set({ status: "failed", error, updatedAt: new Date() })
          .where(eq(schema.agentRuns.id, runId));
        ctx.invalidateQueries();
        return { ok: false, project_id: projectId, run_id: runId, status: "failed", error };
      };
      const runRows = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, args.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) {
        return { ok: false, project_id: null, run_id: null, status: "failed", error: "自动制作任务不存在" };
      }
      if (run.status !== "queued") {
        return {
          ok: true,
          project_id: run.projectId,
          run_id: run.id,
          status: run.status,
          error: run.error,
        };
      }
      const setRun = async (patch: Partial<typeof schema.agentRuns.$inferInsert>) => {
        await db
          .update(schema.agentRuns)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(schema.agentRuns.id, run.id));
      };

      // -- scripting ------------------------------------------------------
      await setRun({ status: "scripting", progressStage: "正在写剧本" });
      const targetShots =
        run.targetDuration > 0
          ? Math.min(12, Math.max(3, Math.round(run.targetDuration / 4)))
          : 7;
      let plan: AgentPlan;
      try {
        plan = await ctx.inference.complete(
          [
            `你是一位短视频导演。根据下面这一句话创意，写出可以直接生产的完整分镜方案。`,
            `创意：${run.instruction}`,
            `画幅：${run.aspect}。风格基调：${run.style || "电影感、画面精致"}。目标总时长：${run.targetDuration > 0 ? `约 ${run.targetDuration} 秒` : "约 30 秒"}，镜头数控制在 ${targetShots} 个左右，最多 12 个，每个镜头 2–5 秒，所有镜头时长合计接近目标总时长。`,
            `anchor（定版锚定描述）：用一段话统一描述全片的主角外观（年龄段、发型、服装、标志性特征）、主要场景和整体视觉风格，每个镜头生成时都会原样注入这段文字来保持一致性，必须具体到可以直接照着画。`,
            `musicMood：一句话描述与剧情情绪匹配的背景音乐（风格、乐器、节奏、情绪曲线），不要提任何具体歌曲名或艺人。`,
            `每个镜头给出：shotSize 景别（远景/全景/中景/近景/特写 之一）、visual 画面内容、action 主体动作、caption 字幕文案（一句，确实不需要就留空）、duration 时长秒数、camera 运镜（推近/拉远/左移/右移/固定 之一）、imagePrompt 这一镜的生图提示词（具体的主体、场景、光线、构图）、motionPrompt 视频运动提示词（什么在动、怎么动、镜头如何运动）。`,
            `title 是这部短片的片名。剧情要有起承转合，镜头之间连贯。`,
          ].join("\n"),
          { schema: agentPlanSchema },
        );
      } catch (e) {
        return fail(run.id, run.projectId, `剧本生成失败：${e instanceof Error ? e.message : String(e)}`);
      }
      plan = { ...plan, shots: plan.shots.slice(0, 12) };
      if (run.targetDuration > 0 && plan.shots.length > 0) {
        const sum = plan.shots.reduce((s, x) => s + (x.duration || 3), 0);
        if (sum > 0) {
          const scale = run.targetDuration / sum;
          plan = {
            ...plan,
            shots: plan.shots.map((s) => ({
              ...s,
              duration: Math.min(10, Math.max(1, Math.round((s.duration || 3) * scale * 2) / 2)),
            })),
          };
        }
      }
      const shotNodeIds = plan.shots.map((_, i) => `n-agent-shot-${i + 1}`);
      const anchorNodeId = "n-agent-asset";
      const filmNodeId = "n-agent-film";
      const scriptText = formatScriptText(plan);
      const graph = agentGraphSkeleton({
        instruction: run.instruction,
        aspect: run.aspect,
        style: run.style,
        plan,
        scriptText,
        anchorNodeId,
        shotNodeIds,
        filmNodeId,
      });
      await db
        .update(schema.projects)
        .set({ name: plan.title.slice(0, 80) || undefined, graph: JSON.stringify(graph), updatedAt: new Date() })
        .where(eq(schema.projects.id, run.projectId));
      await setRun({
        progressTotal: plan.shots.length,
        progressDone: 0,
        musicMood: plan.musicMood,
        packageNodeId: filmNodeId,
      });

      // -- asset lock ------------------------------------------------------
      await setRun({ status: "assets", progressStage: "正在定版资产" });
      const orientation = orientationOfAspect(run.aspect);
      try {
        const media = await ctx.tool.generate_media(
          `${plan.anchor}。定版参考图，主体完整清晰，构图讲究，光影细腻，电影级画面质感${run.style ? `，${run.style}` : ""}`,
          { orientation, key: `p${run.projectId}/img-${anchorNodeId}-${Date.now()}` },
        );
        const g2 = parseGraphLike(
          (await db.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).limit(1))[0]?.graph ?? "{}",
        );
        g2.nodes = g2.nodes.map((n) =>
          n.id === anchorNodeId ? { ...n, blobKey: media.blobKey, url: media.url, status: "idle", error: "" } : n,
        );
        await db
          .update(schema.projects)
          .set({ graph: JSON.stringify(g2), updatedAt: new Date() })
          .where(eq(schema.projects.id, run.projectId));
        await db.insert(schema.generations).values({
          projectId: run.projectId,
          kind: "image",
          prompt: `资产定版：${plan.anchor}`,
          blobKey: media.blobKey,
          nodeId: anchorNodeId,
        });
      } catch (e) {
        // The reference image is a nice-to-have; the anchor TEXT injected
        // into every shot prompt still carries consistency. Mark the node
        // honestly and carry on.
        const g2 = parseGraphLike(
          (await db.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).limit(1))[0]?.graph ?? "{}",
        );
        g2.nodes = g2.nodes.map((n) =>
          n.id === anchorNodeId
            ? { ...n, status: "error", error: `定版参考图生成失败：${e instanceof Error ? e.message : String(e)}。锚定文字仍会注入每个镜头，可在画布上单独重试这张图` }
            : n,
        );
        await db
          .update(schema.projects)
          .set({ graph: JSON.stringify(g2), updatedAt: new Date() })
          .where(eq(schema.projects.id, run.projectId));
      }

      // -- storyboard images, one by one -----------------------------------
      await setRun({ status: "storyboarding", progressStage: "正在生成分镜图", progressDone: 0 });
      const { failedTitles } = await generateAgentShotImages(ctx, db, {
        runId: run.id,
        projectId: run.projectId,
        nodeIds: shotNodeIds,
        orientation,
      });

      if (failedTitles.length > 0) {
        const error = `这些分镜图生成失败：${failedTitles.join("、")}。已在对应节点上标出，可在画布上单独点「重新生成」补好，再点「继续生成成片」`;
        await setRun({ status: "awaiting_confirm", progressStage: "分镜有待补齐，等待确认", error });
        ctx.invalidateQueries();
        return { ok: true, project_id: run.projectId, run_id: run.id, status: "awaiting_confirm", error };
      }
      if (run.mode === "step") {
        await setRun({ status: "awaiting_confirm", progressStage: "分镜已就绪，等待确认", error: "" });
        ctx.invalidateQueries();
        return { ok: true, project_id: run.projectId, run_id: run.id, status: "awaiting_confirm", error: "" };
      }

      // -- auto mode: straight into the film pipeline -----------------------
      const projRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, run.projectId))
        .limit(1);
      const proj = projRows[0];
      if (!proj) return fail(run.id, run.projectId, "项目不存在");
      const collected = collectFilmShots(parseGraphLike(proj.graph), filmNodeId);
      if (collected.shots.length === 0) {
        return fail(run.id, run.projectId, "分镜图没有生成成功，无法进入成片阶段");
      }
      await setRun({ status: "filming", progressStage: "正在生成镜头视频", progressDone: 0, progressTotal: collected.shots.length });
      const spawned = await spawnAgentFilm(ctx, db, {
        projectId: run.projectId,
        projectName: proj.name,
        runId: run.id,
        packageNodeId: filmNodeId,
        shots: collected.shots,
        musicMood: plan.musicMood,
      });
      if (!spawned.ok) {
        return fail(run.id, run.projectId, spawned.error);
      }
      await setRun({ filmRequestId: spawned.requestId });
      ctx.invalidateQueries();
      return { ok: true, project_id: run.projectId, run_id: run.id, status: "filming", error: "" };
    },
  }),

  getAgentRunStatus: defineAction({
    description:
      "Returns the latest Agent 一句话成片 run status for a project (full state machine: queued/scripting/assets/storyboarding/awaiting_confirm/filming/scoring/editing/saving/done/failed/cancelled) with real progress counts. Active runs with no progress update for 15+ minutes (the saving stage included — every stored film chunk reports) or 45+ minutes total are auto-failed as stalled; awaiting_confirm never stalls because it is waiting on the user. While filming, status is synced from the linked film request.",
    request: z.object({ projectId: z.number().int().positive() }),
    response: agentStatusResponse,
    async handler(ctx, args): Promise<z.infer<typeof agentStatusResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.projectId, args.projectId))
        .orderBy(desc(schema.agentRuns.id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        return {
          status: "none",
          run_id: null,
          mode: "",
          instruction: "",
          progress_done: 0,
          progress_total: 0,
          progress_stage: "",
          error: "",
          created_at: "",
          updated_at: "",
          is_stalled: false,
        };
      }
      let effective = row;
      // Sync the filming phase from the linked film request: its stage
      // text decides filming/scoring/editing/saving, its completion or
      // failure ends the run, and its updates count as run activity.
      if (
        (row.status === "filming" || row.status === "scoring" || row.status === "editing" || row.status === "saving") &&
        row.filmRequestId > 0
      ) {
        const filmRows = await db
          .select()
          .from(schema.filmRequests)
          .where(eq(schema.filmRequests.id, row.filmRequestId))
          .limit(1);
        const film = filmRows[0];
        if (film) {
          if (film.status === "done") {
            const now = new Date();
            await db
              .update(schema.agentRuns)
              .set({ status: "done", progressDone: row.progressTotal, progressStage: "已完成", error: "", updatedAt: now })
              .where(eq(schema.agentRuns.id, row.id));
            effective = { ...row, status: "done" as const, progressDone: row.progressTotal, progressStage: "已完成", error: "", updatedAt: now };
          } else if (film.status === "failed") {
            const now = new Date();
            await db
              .update(schema.agentRuns)
              .set({ status: "failed", error: film.error || "成片生成没有完成", updatedAt: now })
              .where(eq(schema.agentRuns.id, row.id));
            effective = { ...row, status: "failed" as const, error: film.error || "成片生成没有完成", updatedAt: now };
          } else {
            const stage = film.progressStage;
            const mapped = stage.includes("配乐")
              ? ("scoring" as const)
              : stage.includes("剪辑")
                ? ("editing" as const)
                : stage.includes("保存")
                  ? ("saving" as const)
                  : ("filming" as const);
            const patch = {
              status: mapped,
              progressDone: film.progressDone,
              progressTotal: film.shotCount,
              progressStage: stage || "正在生成镜头视频",
              updatedAt: film.updatedAt > row.updatedAt ? film.updatedAt : row.updatedAt,
            };
            await db.update(schema.agentRuns).set(patch).where(eq(schema.agentRuns.id, row.id));
            effective = { ...row, ...patch };
          }
        }
      }
      // Stall self-heal (same thresholds as film requests), but never for
      // awaiting_confirm — that state is waiting on the user, not a task.
      const stallEligible =
        effective.status !== "awaiting_confirm" &&
        (AGENT_ACTIVE_STATUSES as readonly string[]).includes(effective.status);
      let isStalled = false;
      if (stallEligible) {
        const stall = filmStallState(effective);
        if (stall.shouldAutoFail) {
          const now = new Date();
          const reason = stall.reason.replace("成片生成", "自动制作");
          await db
            .update(schema.agentRuns)
            .set({ status: "failed", error: reason, updatedAt: now })
            .where(eq(schema.agentRuns.id, effective.id));
          effective = { ...effective, status: "failed" as const, error: reason, updatedAt: now };
          ctx.invalidateQueries();
        } else {
          isStalled = stall.isStalled;
        }
      }
      return {
        status: effective.status,
        run_id: effective.id,
        mode: effective.mode,
        instruction: effective.instruction,
        progress_done: effective.progressDone,
        progress_total: effective.progressTotal,
        progress_stage: effective.progressStage,
        error: effective.error,
        created_at: effective.createdAt.toISOString(),
        updated_at: effective.updatedAt.toISOString(),
        is_stalled: isStalled,
      };
    },
  }),

  continueAgentProduction: defineAction({
    description:
      "Continues a parked (awaiting_confirm) or failed agent run from the canvas's CURRENT state: next='film' re-collects the shots from the saved graph (including any user edits) and starts the background film pipeline with music; next='storyboard' regenerates every shot image from the current node prompts, then re-parks or proceeds according to the run's mode.",
    request: z.object({
      projectId: z.number().int().positive(),
      next: z.enum(["film", "storyboard"]).default("film"),
    }),
    response: agentStartResponse,
    async handler(ctx, args): Promise<z.infer<typeof agentStartResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.projectId, args.projectId))
        .orderBy(desc(schema.agentRuns.id))
        .limit(1);
      const run = rows[0];
      if (!run) {
        return { ok: false, project_id: args.projectId, run_id: null, status: "failed", error: "这个项目没有自动制作任务" };
      }
      if (run.status !== "awaiting_confirm" && run.status !== "failed" && run.status !== "cancelled") {
        return { ok: true, project_id: args.projectId, run_id: run.id, status: run.status, error: run.error };
      }
      const projRows = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.projectId))
        .limit(1);
      const proj = projRows[0];
      if (!proj) {
        return { ok: false, project_id: args.projectId, run_id: run.id, status: "failed", error: "项目不存在" };
      }
      const setRun = async (patch: Partial<typeof schema.agentRuns.$inferInsert>) => {
        await db
          .update(schema.agentRuns)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(schema.agentRuns.id, run.id));
      };
      const graph = parseGraphLike(proj.graph);
      const packageNodeId = run.packageNodeId || graph.nodes.find((n) => n.type === "video")?.id || "";

      if (args.next === "storyboard") {
        const shotNodes = packageNodeId
          ? upstreamOf(graph, packageNodeId).filter((u) => u.type === "image")
          : graph.nodes.filter((n) => n.type === "image" && n.id !== "n-agent-asset");
        if (shotNodes.length === 0) {
          return { ok: false, project_id: args.projectId, run_id: run.id, status: run.status, error: "画布上还没有分镜图节点，无法重新生成分镜" };
        }
        await setRun({
          status: "storyboarding",
          progressStage: "正在生成分镜图",
          progressDone: 0,
          progressTotal: shotNodes.length,
          error: "",
        });
        const { failedTitles } = await generateAgentShotImages(ctx, db, {
          runId: run.id,
          projectId: args.projectId,
          nodeIds: shotNodes.map((n) => n.id),
          orientation: orientationOfAspect(run.aspect),
        });
        if (failedTitles.length > 0) {
          const error = `这些分镜图生成失败：${failedTitles.join("、")}。已在对应节点上标出，可单独重试后继续`;
          await setRun({ status: "awaiting_confirm", progressStage: "分镜有待补齐，等待确认", error });
          ctx.invalidateQueries();
          return { ok: true, project_id: args.projectId, run_id: run.id, status: "awaiting_confirm", error };
        }
        if (run.mode === "step") {
          await setRun({ status: "awaiting_confirm", progressStage: "分镜已就绪，等待确认", error: "" });
          ctx.invalidateQueries();
          return { ok: true, project_id: args.projectId, run_id: run.id, status: "awaiting_confirm", error: "" };
        }
        // auto mode falls through to the film pipeline below.
      }

      const freshProj = (await db.select().from(schema.projects).where(eq(schema.projects.id, args.projectId)).limit(1))[0];
      const collected = collectFilmShots(
        parseGraphLike(freshProj?.graph ?? proj.graph),
        packageNodeId || undefined,
      );
      if (collected.orderedCount === 0) {
        return { ok: false, project_id: args.projectId, run_id: run.id, status: run.status, error: "画布上还没有分镜图节点：先补齐分镜，再继续生成成片" };
      }
      if (collected.missing.length > 0) {
        const error = `这些镜头还没有图：${collected.missing.join("、")}。先给它们生成图片，再点「继续生成成片」`;
        await setRun({ status: "awaiting_confirm", progressStage: "分镜有待补齐，等待确认", error });
        return { ok: false, project_id: args.projectId, run_id: run.id, status: "awaiting_confirm", error };
      }
      if (collected.shots.length > 24) {
        return { ok: false, project_id: args.projectId, run_id: run.id, status: run.status, error: `一次最多合成 24 个镜头（现在 ${collected.shots.length} 个）` };
      }
      await setRun({
        status: "filming",
        progressStage: "正在生成镜头视频",
        progressDone: 0,
        progressTotal: collected.shots.length,
        error: "",
      });
      const spawned = await spawnAgentFilm(ctx, db, {
        projectId: args.projectId,
        projectName: freshProj?.name ?? proj.name,
        runId: run.id,
        packageNodeId: collected.packageNodeId || packageNodeId,
        shots: collected.shots,
        musicMood: run.musicMood,
      });
      if (!spawned.ok) {
        await setRun({ status: "failed", error: spawned.error });
        return { ok: false, project_id: args.projectId, run_id: run.id, status: "failed", error: spawned.error };
      }
      await setRun({ filmRequestId: spawned.requestId });
      ctx.invalidateQueries();
      return { ok: true, project_id: args.projectId, run_id: run.id, status: "filming", error: "" };
    },
  }),

  cancelAgentRun: defineAction({
    description:
      "Cancels the project's active Agent 一句话成片 run (marks it cancelled) and, if it is already in the film stage, also ends the linked film request so the project is immediately free.",
    request: z.object({ projectId: z.number().int().positive() }),
    response: cancelFilmResponse,
    async handler(ctx, args): Promise<z.infer<typeof cancelFilmResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.projectId, args.projectId))
        .orderBy(desc(schema.agentRuns.id))
        .limit(1);
      const run = rows[0];
      if (!run) return { ok: true, cancelled: false, error: "" };
      if (!(AGENT_ACTIVE_STATUSES as readonly string[]).includes(run.status) && run.status !== "awaiting_confirm") {
        return { ok: true, cancelled: false, error: "" };
      }
      await db
        .update(schema.agentRuns)
        .set({
          status: "cancelled",
          error: "你已结束这次自动制作。画布上的工作流和已生成分镜都保留着，可以随时手动继续，或重新点「继续生成成片」",
          progressStage: "",
          updatedAt: new Date(),
        })
        .where(eq(schema.agentRuns.id, run.id));
      if (run.filmRequestId > 0) {
        const filmRows = await db
          .select()
          .from(schema.filmRequests)
          .where(eq(schema.filmRequests.id, run.filmRequestId))
          .limit(1);
        const film = filmRows[0];
        if (film && (film.status === "queued" || film.status === "running")) {
          await db
            .update(schema.filmRequests)
            .set({
              status: "failed",
              error: "你已结束这次自动制作（成片阶段随之结束）",
              progressStage: "",
              updatedAt: new Date(),
            })
            .where(eq(schema.filmRequests.id, film.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true, cancelled: true, error: "" };
    },
  }),

  reportAgentProgress: defineAction({
    description:
      "Reports live progress for an in-flight Agent 一句话成片 run from the background film task (stage-machine status + shot clips finished + stage label), driving the tool's progress display and stall heartbeat.",
    request: z.object({
      runId: z.number().int().positive(),
      status: z
        .enum(["filming", "scoring", "editing", "saving"])
        .optional(),
      doneShots: z.number().int().min(0).max(1000).optional(),
      stage: z.string().max(80).optional(),
    }),
    response: filmProgressResponse,
    async handler(ctx, args): Promise<z.infer<typeof filmProgressResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, args.runId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("自动制作任务不存在");
      if (row.status === "done" || row.status === "failed" || row.status === "cancelled") {
        return { ok: true };
      }
      const patch: {
        status?: "filming" | "scoring" | "editing" | "saving";
        progressDone?: number;
        progressStage?: string;
        updatedAt: Date;
      } = { updatedAt: new Date() };
      if (args.status) patch.status = args.status;
      if (args.doneShots != null) {
        patch.progressDone = Math.min(
          row.progressTotal || args.doneShots,
          Math.max(row.progressDone, args.doneShots),
        );
      }
      if (args.stage != null && args.stage.trim()) {
        patch.progressStage = args.stage.trim();
      }
      await db.update(schema.agentRuns).set(patch).where(eq(schema.agentRuns.id, row.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
