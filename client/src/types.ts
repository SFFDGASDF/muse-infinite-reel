export type NodeType = "text" | "image" | "video" | "config" | "group";
export type Aspect = "16:9" | "9:16" | "1:1";
export type Motion = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "static";
export type NodeStatus = "idle" | "generating" | "error";
export type BackgroundMode = "dots" | "lines" | "blank";
export type Quality = "standard" | "hd";

/** Snapshot of the exact parameters a generation ran with (prompt after
 *  upstream/config merging, aspect, duration, camera motion, quality and
 *  the reference-image blob keys that fed it). Stored on the node at
 *  generation time so a failed or unsatisfying result can be retried
 *  one-click with the identical parameters. */
export interface GenSnapshot {
  prompt: string;
  aspect: Aspect;
  duration: number;
  motion: Motion;
  quality: Quality;
  refBlobKeys: string[];
  at: number;
}

/** Reference to a film saved back as verified chunks (beginFilmSave →
 *  saveFilmChunk ×N → finalizeFilmSave). The bytes live in per-chunk
 *  blobs server-side; the client reassembles them in the browser and
 *  verifies length + whole-file SHA-256 + MP4 structure before playing
 *  or downloading. Present on a video node instead of url/blobKey. */
export interface FilmAssemblyRef {
  requestId: number;
  chunkCount: number;
  totalBytes: number;
  sha256: string;
  mime: string;
}

export interface CanvasNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  title: string;
  text: string;
  aspect: Aspect;
  duration: number;
  motion: Motion;
  blobKey: string;
  url: string;
  /** Chunked-film manifest when this video node's film was saved in
   *  verified chunks; null for legacy single-blob films and uploads. */
  filmAssembly?: FilmAssemblyRef | null;
  /** This shot's on-screen caption / subtitle line, burned into the
   *  finished film during this shot when the film is generated. */
  caption: string;
  /** This shot's video motion prompt: what should move in the shot and
   *  how — the per-shot direction used when its true-motion clip is
   *  generated for the film. */
  motionPrompt: string;
  /** Legacy field from the retired in-tool frame-sequence synthesis. Kept
   *  only so old saved graphs still parse; no longer read or written. */
  frames: string[];
  status: NodeStatus;
  error: string;
  /** Locked nodes keep their position (LibTV-style node lock). */
  locked: boolean;
  /** Id of the group node this node belongs to, or null. */
  groupId: string | null;
  /** Group nodes only: frame size in world units (the wrap rect around
   *  the members, padding 24 / top 52) and the collapsed flag that
   *  hides the members while keeping the group frame on the canvas. */
  w: number;
  h: number;
  collapsed: boolean;
  /** Image quality tier chosen on the node (or inherited from a wired
   *  生成配置 node): standard | hd. Recorded in the generation snapshot;
   *  "hd" also appends a high-detail suffix to the effective prompt. */
  quality: Quality;
  /** Parameters of the last generation that ran on this node. */
  snapshot: GenSnapshot | null;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface Viewport {
  x: number;
  y: number;
  k: number;
}

export interface Graph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: Viewport;
  backgroundMode: BackgroundMode;
}

export const NODE_W = 300;

export function nodeWidth(node: CanvasNode): number {
  return node.type === "group" ? Math.max(120, node.w || NODE_W) : NODE_W;
}

export function nodeHeight(node: CanvasNode): number {
  if (node.type === "group") return Math.max(80, node.h || 200);
  if (node.type === "text") return 218;
  if (node.type === "config") return 218;
  // Estimated rendered heights (header + preview + controls + refine
  // row + motion/caption fields for images; shot list for video nodes).
  // Used for fit-view, minimap, marquee hits and group wrapping — a
  // slight overestimate is safe, an underestimate clips real content.
  if (node.type === "video") return 540;
  return 460;
}

/** Column count for laying N same-kind nodes out as a wrapped grid
 *  instead of one long vertical strip: roughly √N in cell count,
 *  biased wider (node cells are taller than they are wide, so a
 *  square cell grid already reads portrait), capped at 6 across.
 *  Shared by 整理 auto-layout, storyboard split and (mirrored in)
 *  the server-side Agent canvas skeleton. */
export function gridColumnCount(count: number): number {
  if (count <= 1) return 1;
  return Math.min(6, Math.max(2, Math.round(Math.sqrt(count * 1.9))));
}

export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
}

export function makeNode(type: NodeType, x: number, y: number): CanvasNode {
  return {
    id: uid("n"),
    type,
    x,
    y,
    title:
      type === "text"
        ? "提示词"
        : type === "image"
          ? "分镜图"
          : type === "config"
            ? "生成配置"
            : type === "group"
              ? "分组"
              : "成片",
    text: "",
    aspect: "16:9",
    duration: 3,
    motion: "zoom-in",
    blobKey: "",
    url: "",
    filmAssembly: null,
    caption: "",
    motionPrompt: "",
    frames: [],
    status: "idle",
    error: "",
    locked: false,
    groupId: null,
    w: 0,
    h: 0,
    collapsed: false,
    quality: "standard",
    snapshot: null,
  };
}

/** Fill defaults for nodes saved by older versions and reset any
 *  in-flight generation state (a reload mid-generation is not running). */
export function normalizeNode(raw: Partial<CanvasNode> & { id: string; type: NodeType }): CanvasNode {
  const base = makeNode(raw.type, raw.x ?? 60, raw.y ?? 60);
  const merged: CanvasNode = { ...base, ...raw, id: raw.id, type: raw.type };
  if (!Array.isArray(merged.frames)) merged.frames = [];
  if (typeof merged.caption !== "string") merged.caption = "";
  if (typeof merged.motionPrompt !== "string") merged.motionPrompt = "";
  const fa = merged.filmAssembly as Partial<FilmAssemblyRef> | null | undefined;
  if (
    !fa ||
    typeof fa.requestId !== "number" ||
    typeof fa.chunkCount !== "number" ||
    typeof fa.totalBytes !== "number" ||
    typeof fa.sha256 !== "string"
  ) {
    merged.filmAssembly = null;
  } else {
    merged.filmAssembly = {
      requestId: fa.requestId,
      chunkCount: fa.chunkCount,
      totalBytes: fa.totalBytes,
      sha256: fa.sha256,
      mime: typeof fa.mime === "string" && fa.mime ? fa.mime : "video/mp4",
    };
  }
  if (typeof merged.groupId !== "string") merged.groupId = null;
  if (typeof merged.w !== "number" || !Number.isFinite(merged.w)) merged.w = 0;
  if (typeof merged.h !== "number" || !Number.isFinite(merged.h)) merged.h = 0;
  if (typeof merged.collapsed !== "boolean") merged.collapsed = false;
  if (merged.quality !== "hd") merged.quality = "standard";
  const snap = merged.snapshot as Partial<GenSnapshot> | null | undefined;
  if (!snap || typeof snap.prompt !== "string") {
    merged.snapshot = null;
  } else {
    merged.snapshot = {
      prompt: snap.prompt,
      aspect: snap.aspect === "9:16" || snap.aspect === "1:1" ? snap.aspect : "16:9",
      duration: typeof snap.duration === "number" ? snap.duration : 3,
      motion: snap.motion ?? "zoom-in",
      quality: snap.quality === "hd" ? "hd" : "standard",
      refBlobKeys: Array.isArray(snap.refBlobKeys)
        ? snap.refBlobKeys.filter((k): k is string => typeof k === "string")
        : [],
      at: typeof snap.at === "number" ? snap.at : 0,
    };
  }
  // Open-time reset (front-end layer, on top of the server-side stall
  // self-checks): a node left in "generating" by a closed page or a
  // dead task is not running anymore — reset it so the canvas never
  // opens with phantom in-flight states.
  if (merged.status === "generating") {
    merged.status = "idle";
  }
  return merged;
}

export function parseGraph(raw: string): Graph {
  const fallback: Graph = {
    nodes: [],
    edges: [],
    viewport: { x: 40, y: 60, k: 0.85 },
    backgroundMode: "dots",
  };
  try {
    const parsed = JSON.parse(raw) as Partial<Graph>;
    return {
      nodes: Array.isArray(parsed.nodes)
        ? (parsed.nodes as CanvasNode[]).map((n) => normalizeNode(n))
        : [],
      edges: Array.isArray(parsed.edges) ? (parsed.edges as CanvasEdge[]) : [],
      viewport: parsed.viewport ?? { x: 40, y: 60, k: 0.85 },
      backgroundMode:
        parsed.backgroundMode === "lines" || parsed.backgroundMode === "blank"
          ? parsed.backgroundMode
          : "dots",
    };
  } catch {
    return fallback;
  }
}

/** Upstream nodes feeding `nodeId`, in edge order. */
export function upstream(graph: Graph, nodeId: string): CanvasNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.to === nodeId)
    .map((e) => byId.get(e.from))
    .filter((n): n is CanvasNode => n != null);
}

/** The 生成配置 node wired into this node, if any. A config node feeds
 *  every downstream generation node: aspect, quality and a style text
 *  that all inheriting nodes share — change it once, the whole wired
 *  group follows. */
export function configOf(graph: Graph, nodeId: string): CanvasNode | null {
  return upstream(graph, nodeId).find((u) => u.type === "config") ?? null;
}

/** Aspect a generation on this node should use: a wired config node's
 *  aspect wins over the node's own setting. */
export function effectiveAspect(graph: Graph, node: CanvasNode): Aspect {
  return configOf(graph, node.id)?.aspect ?? node.aspect;
}

export function effectiveQuality(graph: Graph, node: CanvasNode): Quality {
  return configOf(graph, node.id)?.quality ?? node.quality;
}

/** Reference images collected along the wires into this node: upstream
 *  image nodes that already hold a picture. Their blob keys are recorded
 *  in the generation snapshot and their descriptions join the prompt
 *  context (the image channel itself takes a single prompt; true
 *  pixel-level reference editing goes through 图生图）. */
export function upstreamImages(graph: Graph, nodeId: string): CanvasNode[] {
  return upstream(graph, nodeId).filter((u) => u.type === "image" && u.url);
}

/** Effective generation prompt for an image node, collected along the
 *  wires: connected text nodes first, then the style of a wired config
 *  node, then descriptions of wired reference images, then the node's
 *  own text — with a cinematic style suffix. */
export function effectivePrompt(graph: Graph, node: CanvasNode): string {
  const parts: string[] = [];
  for (const up of upstream(graph, node.id)) {
    if (up.type === "text" && up.text.trim()) parts.push(up.text.trim());
  }
  const cfg = configOf(graph, node.id);
  if (cfg && cfg.text.trim()) parts.push(cfg.text.trim());
  for (const ref of upstreamImages(graph, node.id)) {
    const desc = (ref.text || ref.caption || ref.title).trim();
    if (desc) parts.push(`参考图（${ref.title}）：${desc}`);
  }
  if (node.text.trim()) parts.push(node.text.trim());
  const base = parts.join("。");
  if (!base) return "";
  const detail =
    effectiveQuality(graph, node) === "hd"
      ? "超高清细节，纹理锐利"
      : "高清细节";
  return `${base}。电影级画面质感，构图讲究，光影细腻，${detail}`;
}

/** Members of a group node, in canvas order. */
export function groupMembers(graph: Graph, groupId: string): CanvasNode[] {
  return graph.nodes.filter((n) => n.groupId === groupId);
}

/** Wrap rect for a set of member nodes: bounding box with padding 24 on
 *  the sides/bottom and 52 on top (room for the group title bar). */
export function groupWrapRect(members: CanvasNode[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} | null {
  if (members.length === 0) return null;
  const minX = Math.min(...members.map((n) => n.x));
  const minY = Math.min(...members.map((n) => n.y));
  const maxX = Math.max(...members.map((n) => n.x + nodeWidth(n)));
  const maxY = Math.max(...members.map((n) => n.y + nodeHeight(n)));
  return { x: minX - 24, y: minY - 52, w: maxX - minX + 48, h: maxY - minY + 52 + 24 };
}

export function orientationOf(aspect: Aspect): "landscape" | "portrait" | "square" {
  if (aspect === "16:9") return "landscape";
  if (aspect === "9:16") return "portrait";
  return "square";
}

export interface StoryShot {
  prompt: string;
  caption: string;
  duration: number;
  motion: Motion;
}

const MOTION_BY_LABEL: Record<string, Motion> = {
  推近: "zoom-in",
  拉远: "zoom-out",
  左移: "pan-left",
  右移: "pan-right",
  固定: "static",
};

export const MOTION_LABELS: Record<Motion, string> = {
  "zoom-in": "推近",
  "zoom-out": "拉远",
  "pan-left": "左移",
  "pan-right": "右移",
  static: "固定",
};

export function motionLabel(motion: Motion): string {
  return MOTION_LABELS[motion] ?? "推近";
}

/** Parse the 分镜脚本 lines produced by the generateText storyboard mode
 *  (镜头N｜时长X秒｜运镜：…｜画面：…｜字幕：…) back into structured shots.
 *  Lenient: any non-empty line that mentions 画面 or starts with 镜头 counts. */
export function parseStoryboard(text: string): StoryShot[] {
  const shots: StoryShot[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || (!line.includes("镜头") && !line.includes("画面"))) continue;
    const segments = line.split(/[｜|]/).map((s) => s.trim());
    let prompt = "";
    let caption = "";
    let duration = 3;
    let motion: Motion = "zoom-in";
    for (const seg of segments) {
      const durMatch = seg.match(/(\d+(?:\.\d+)?)\s*秒/);
      if (seg.startsWith("时长") && durMatch) {
        duration = Math.min(10, Math.max(1, Number(durMatch[1]) || 3));
      } else if (seg.startsWith("运镜")) {
        const label = seg.replace(/^运镜[:：]?/, "").trim();
        motion = MOTION_BY_LABEL[label] ?? motion;
      } else if (seg.startsWith("画面")) {
        prompt = seg.replace(/^画面[:：]?/, "").trim();
      } else if (seg.startsWith("字幕")) {
        const c = seg.replace(/^字幕[:：]?/, "").trim();
        caption = c === "无" ? "" : c;
      }
    }
    if (!prompt) {
      // Fall back to the whole line minus the 镜头N prefix.
      prompt = line.replace(/^镜头\s*\d+\s*[｜|：:]?\s*/, "").trim();
    }
    if (prompt) shots.push({ prompt, caption, duration, motion });
  }
  return shots.slice(0, 8);
}
