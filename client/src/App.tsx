import {
useCallback,
useEffect,
useMemo,
useRef,
useState,
type PointerEvent as ReactPointerEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import {
NodeCard,
type ImageToolKind,
type PackageShotInfo,
type TextMode,
} from "./NodeCard";
import { AssembledFilmPlayer, downloadAssembledFilm } from "./filmAssembly";
import { ImageToolsDialog } from "./ImageTools";
import {
NODE_W,
configOf,
effectiveAspect,
effectivePrompt,
effectiveQuality,
groupMembers,
groupWrapRect,
makeNode,
nodeHeight,
nodeWidth,
orientationOf,
parseGraph,
parseStoryboard,
uid,
upstream,
upstreamImages,
type BackgroundMode,
type CanvasNode,
type Graph,
type NodeType,
type Viewport,
} from "./types";

type ProjectList = ApiResponse<typeof api, "listProjects">;
type GenerationList = ApiResponse<typeof api, "listGenerations">;

const EMPTY_GRAPH: Graph = {
  nodes: [],
  edges: [],
  viewport: { x: 40, y: 60, k: 0.85 },
  backgroundMode: "dots",
};
const WORLD_OFF = 2000;

type FilmStatusData = ApiResponse<typeof api, "getFilmStatus">;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Zoom range mirrors the reference canvas: 0.05–5. */
function clampK(k: number): number {
  return Math.min(5, Math.max(0.05, k));
}

/** Screen point (relative to the canvas container) → world coordinates. */
function screenToWorld(
  vp: Viewport,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.k, y: (sy - vp.y) / vp.k };
}

/** World point → screen point (relative to the canvas container). */
function worldToScreen(
  vp: Viewport,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return { x: wx * vp.k + vp.x, y: wy * vp.k + vp.y };
}

/** Viewport that fits all given nodes inside a w×h screen, centered,
 *  with 120 units of breathing room and zoom capped at 1.2. */
function fitViewportForNodes(
  nodes: CanvasNode[],
  w: number,
  h: number,
): Viewport {
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + nodeWidth(n)));
  const maxY = Math.max(...nodes.map((n) => n.y + nodeHeight(n)));
  const k = clampK(
    Math.min(w / (maxX - minX + 120), h / (maxY - minY + 120), 1.2),
  );
  return {
    k,
    x: (w - (maxX - minX) * k) / 2 - minX * k,
    y: (h - (maxY - minY) * k) / 2 - minY * k,
  };
}

/** Connection legality, normalized in one place (mirrors the reference
 *  canvas's normalizeConnection): no self-links, no duplicates in either
 *  direction, and nothing links INTO a group frame. */
function canConnect(
  graph: Graph,
  from: string,
  to: string,
): boolean {
  if (from === to) return false;
  const target = graph.nodes.find((n) => n.id === to);
  if (!target || target.type === "group") return false;
  if (graph.edges.some((e) => e.from === from && e.to === to)) return false;
  if (graph.edges.some((e) => e.from === to && e.to === from)) return false;
  return true;
}

export function App() {
  const queryClient = useQueryClient();
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [projectName, setProjectName] = useState("");
  const [graph, setGraph] = useState<Graph>(EMPTY_GRAPH);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedId = selectedIds[0] ?? null;
  const setSelectedId = useCallback((id: string | null) => {
    setSelectedIds(id ? [id] : []);
  }, []);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [toast, setToast] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [enhancingId, setEnhancingId] = useState<string | null>(null);
  const [filmRequesting, setFilmRequesting] = useState(false);
  // URL of a stored film whose bytes are damaged (reported by the 成片
  // node's <video> onError). Films saved before the server-side
  // integrity gate include truncated transfers; when the current film
  // is one of them, the banner and history stop offering its download.
  const [brokenFilmUrl, setBrokenFilmUrl] = useState("");
  // URLs of history-rail videos that failed to load (same damaged-file
  // class as above); their download links are withdrawn, not dead-ends.
  const [brokenGenUrls, setBrokenGenUrls] = useState<ReadonlySet<string>>(new Set());
  // History entries (chunked films) whose reassembly verification
  // failed, and the one currently being assembled for download.
  const [brokenGenIds, setBrokenGenIds] = useState<ReadonlySet<number>>(new Set());
  const [historyDlId, setHistoryDlId] = useState<number | null>(null);
  // Agent 一句话成片 panel + run state
  const [showAgentPanel, setShowAgentPanel] = useState(false);
  const [agentInstruction, setAgentInstruction] = useState("");
  const [agentDuration, setAgentDuration] = useState(0);
  const [agentAspect, setAgentAspect] = useState<"16:9" | "9:16" | "1:1">("16:9");
  const [agentStyle, setAgentStyle] = useState("");
  const [agentMode, setAgentMode] = useState<"auto" | "step">("auto");
  const [agentStarting, setAgentStarting] = useState(false);
  const [agentContinuing, setAgentContinuing] = useState(false);
  const [agentCancelling, setAgentCancelling] = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 900, h: 600 });
  const [hintVisible, setHintVisible] = useState(true);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [menu, setMenu] = useState<
    | { kind: "canvas"; x: number; y: number; worldX: number; worldY: number }
    | { kind: "node"; x: number; y: number; nodeId: string }
    | { kind: "linkcreate"; x: number; y: number; worldX: number; worldY: number }
    | null
  >(null);
  const [showHelp, setShowHelp] = useState(false);
  const [histState, setHistState] = useState({ canUndo: false, canRedo: false });
  const [runningAll, setRunningAll] = useState(false);
  // Canvas tool (select / pan), mirroring the reference canvas's dock:
  // in select mode a mouse drag on empty canvas box-selects; in pan mode
  // (or while Space is held, or with the middle button) it pans. Touch
  // drags always pan.
  const [canvasTool, setCanvasTool] = useState<"select" | "pan">("select");
  const spacePanRef = useRef(false);
  const [, setSpacePanTick] = useState(0);
  // Single-image refine dialog currently open.
  const [imageTool, setImageTool] = useState<{ node: CanvasNode; tool: ImageToolKind } | null>(null);
  const [toolBusy, setToolBusy] = useState(false);
  // Selection-aware assistant side panel.
  const [showAssistant, setShowAssistant] = useState(false);
  const [assistantLog, setAssistantLog] = useState<
    { role: "user" | "assistant"; text: string }[]
  >([]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  // Two-step clear-canvas confirm (no native confirm() in the shell).
  const [clearArmed, setClearArmed] = useState(false);
  // Dock appearance popover (background mode), like the reference dock.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const [transferBusy, setTransferBusy] = useState(false);

  const graphRef = useRef(graph);
  graphRef.current = graph;
  const nameRef = useRef(projectName);
  nameRef.current = projectName;
  const savedGraphRef = useRef("");
  const loadedProjectRef = useRef<number | null>(null);
  // Reactive mirror of loadedProjectRef for rendering: a ref mutation
  // alone never re-renders, so the "正在打开画布…" overlay must key off
  // state, not the ref. loadedId is set together with the ref wherever
  // a project is (un)loaded.
  const [loadedId, setLoadedId] = useState<number | null>(null);
  // The exact projectQuery.data object last applied to the canvas.
  // Background refreshes (agent progress, finished film) apply through
  // this identity check instead of the loaded flag: React Query's
  // structural sharing returns the SAME object when a refetch changes
  // nothing, so any flow that clears the loaded flag and waits for the
  // load effect to restore it can wait forever — that was the stuck
  // "正在打开画布…" overlay.
  const appliedDataRef = useRef<unknown>(null);
  const markProjectUnloaded = useCallback(() => {
    loadedProjectRef.current = null;
    appliedDataRef.current = null;
    setLoadedId(null);
  }, []);
  const createdInitialRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const globalUploadRef = useRef<HTMLInputElement>(null);

  const dragRef = useRef<{
    kind: "pan" | "node" | "marquee";
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    nodeId?: string;
    /** Original positions of every node moved by a group drag. */
    origins?: Map<string, { x: number; y: number }>;
    /** Marquee started with a modifier: union with the old selection. */
    additive?: boolean;
  } | null>(null);
  const historyRef = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const settledRef = useRef("");
  const clipboardRef = useRef<{ nodes: CanvasNode[]; edges: { from: string; to: string }[] } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{
    dist: number;
    midX: number;
    midY: number;
    k: number;
    vpX: number;
    vpY: number;
    worldX: number;
    worldY: number;
  } | null>(null);
  // requestAnimationFrame coalescing for pan / node-drag moves: pointer
  // events can fire far faster than the frame rate; only the latest
  // pending move is applied, once per frame.
  const moveRafRef = useRef(0);
  const pendingMoveRef = useRef<(() => void) | null>(null);
  const queueMove = useCallback((fn: () => void) => {
    pendingMoveRef.current = fn;
    if (moveRafRef.current) return;
    moveRafRef.current = requestAnimationFrame(() => {
      moveRafRef.current = 0;
      const f = pendingMoveRef.current;
      pendingMoveRef.current = null;
      f?.();
    });
  }, []);

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects({}),
  });
  const projects: ProjectList["projects"] = projectsQuery.data?.projects ?? [];

  const projectQuery = useQuery({
    queryKey: ["project", currentId],
    queryFn: () => api.getProject({ id: currentId as number }),
    enabled: currentId != null,
  });

  const generationsQuery = useQuery({
    queryKey: ["generations", currentId],
    queryFn: () => api.listGenerations({ projectId: currentId as number, limit: 40 }),
    enabled: currentId != null && showHistory,
  });
  const generations: GenerationList["generations"] =
    generationsQuery.data?.generations ?? [];

  // Film generation status: polled while Muse is shooting/editing in the
  // background, so the finished film appears here on its own — no refresh,
  // no export, no sending files anywhere.
  const filmQuery = useQuery({
    queryKey: ["filmStatus", currentId],
    queryFn: () => api.getFilmStatus({ projectId: currentId as number }),
    enabled: currentId != null,
    refetchInterval: (query) => {
      const s = (query.state.data as FilmStatusData | undefined)?.status;
      return s === "queued" || s === "running" ? 4000 : false;
    },
  });
  const filmStatus: FilmStatusData["status"] = filmQuery.data?.status ?? "none";
  const filmBusy = filmStatus === "queued" || filmStatus === "running";

  // 1s tick shared by the film and agent progress displays.
  const [filmNow, setFilmNow] = useState(() => Date.now());

  // Agent 一句话成片 run status for the current project: polled while the
  // server builds the workflow or the background task films/scores/edits.
  type AgentStatusData = ApiResponse<typeof api, "getAgentRunStatus">;
  const agentQuery = useQuery({
    queryKey: ["agentStatus", currentId],
    queryFn: () => api.getAgentRunStatus({ projectId: currentId as number }),
    enabled: currentId != null,
    refetchInterval: (query) => {
      const s = (query.state.data as AgentStatusData | undefined)?.status;
      return s === "queued" ||
        s === "scripting" ||
        s === "assets" ||
        s === "storyboarding" ||
        s === "filming" ||
        s === "scoring" ||
        s === "editing" ||
        s === "saving"
        ? 4000
        : false;
    },
  });
  const agentStatus: AgentStatusData["status"] = agentQuery.data?.status ?? "none";
  const agentActive =
    agentStatus === "queued" ||
    agentStatus === "scripting" ||
    agentStatus === "assets" ||
    agentStatus === "storyboarding" ||
    agentStatus === "filming" ||
    agentStatus === "scoring" ||
    agentStatus === "editing" ||
    agentStatus === "saving";
  const agentBuilding =
    agentStatus === "scripting" || agentStatus === "assets" || agentStatus === "storyboarding";
  const agentStageLabel =
    agentQuery.data?.progress_stage ||
    (agentStatus === "scripting"
      ? "正在写剧本"
      : agentStatus === "assets"
        ? "正在定版资产"
        : agentStatus === "storyboarding"
          ? "正在生成分镜图"
          : agentStatus === "filming"
            ? "正在生成镜头视频"
            : agentStatus === "scoring"
              ? "正在配乐"
              : agentStatus === "editing"
                ? "正在按剧情剪辑合成"
                : agentStatus === "saving"
                  ? "正在保存成片"
                  : "");
  const agentTotal = agentQuery.data?.progress_total ?? 0;
  const agentDone = agentQuery.data?.progress_done ?? 0;
  const agentPct =
    agentTotal > 0 ? Math.min(100, Math.round((agentDone / agentTotal) * 100)) : 0;
  const agentCreatedMs = agentQuery.data?.created_at
    ? Date.parse(agentQuery.data.created_at)
    : NaN;
  const agentUpdatedMs = agentQuery.data?.updated_at
    ? Date.parse(agentQuery.data.updated_at)
    : NaN;
  const agentElapsedSec =
    agentActive && Number.isFinite(agentCreatedMs)
      ? Math.max(0, Math.floor((filmNow - agentCreatedMs) / 1000))
      : 0;
  const agentElapsedLabel =
    agentElapsedSec >= 60
      ? `${Math.floor(agentElapsedSec / 60)} 分 ${agentElapsedSec % 60} 秒`
      : `${agentElapsedSec} 秒`;
  const agentSinceUpdateSec =
    agentActive && Number.isFinite(agentUpdatedMs)
      ? Math.max(0, Math.floor((filmNow - agentUpdatedMs) / 1000))
      : 0;
  const agentSinceUpdateLabel =
    agentSinceUpdateSec >= 60
      ? `${Math.floor(agentSinceUpdateSec / 60)} 分 ${agentSinceUpdateSec % 60} 秒`
      : `${agentSinceUpdateSec} 秒`;
  // Saving is chunked now (mirrors the server): every stored chunk
  // reports progress and moves updated_at, and a chunk takes seconds —
  // so the saving stage gets the same 5 quiet minutes before the
  // "可能卡住了" warning as every other stage. (The old whole-file
  // save needed a lenient 10 minutes because one call could hang.)
  const agentStallWarnMs = 5 * 60 * 1000;
  const agentIsStalled =
    agentActive &&
    agentStatus !== "queued" &&
    ((agentQuery.data?.is_stalled ?? false) ||
      (Number.isFinite(agentUpdatedMs) && filmNow - agentUpdatedMs >= agentStallWarnMs));

  // While an agent run is live, the canvas graph changes SERVER-side:
  // script/asset nodes appear, each storyboard image lands on its node
  // as it is generated, and the finished film is patched onto the 成片
  // node at the end. Reload the project whenever the polled run status
  // reports ANY change — status, finished-shot count, total, stage, or
  // the row's updated_at (which moves on every server-side write) — in
  // EVERY phase, filming/scoring/editing/saving and the terminal "done"
  // included. The earlier version reloaded only while building and
  // keyed on done+stage alone, so the last shots of a run never reached
  // the canvas and the nodes stayed blank at whatever an earlier reload
  // happened to catch. A second, delayed invalidation covers the race
  // where the first refetch joins a request that started before the
  // server's latest write and returns pre-write data.
  const agentProgressKey = `${currentId ?? 0}|${agentStatus}|${agentDone}|${agentTotal}|${agentQuery.data?.progress_stage ?? ""}|${agentQuery.data?.updated_at ?? ""}`;
  const agentProgressKeyRef = useRef("");
  useEffect(() => {
    if (currentId == null) return;
    if (
      agentStatus === "none" ||
      agentStatus === "failed" ||
      agentStatus === "cancelled"
    )
      return;
    if (agentProgressKeyRef.current === agentProgressKey) return;
    agentProgressKeyRef.current = agentProgressKey;
    // Only invalidate — do NOT mark the project unloaded here. During
    // the filming/scoring/editing phases the graph often does not
    // change between polls, and React Query structural sharing then
    // hands back the identical data object, so the load effect would
    // never re-run to restore a cleared loaded flag and the canvas
    // stayed behind the "正在打开画布…" overlay forever. The load
    // effect now applies any genuinely new data object on its own.
    queryClient.invalidateQueries({ queryKey: ["project", currentId] });
    const t = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["project", currentId] });
    }, 1500);
    return () => clearTimeout(t);
  }, [agentProgressKey, agentStatus, currentId, queryClient]);
  const filmDoneNotifiedRef = useRef<number | null>(null);

  // Live film progress: the background task reports each finished shot
  // clip via reportFilmProgress, and getFilmStatus (polled every 4s while
  // busy) carries the count + stage here. A 1s local tick keeps the
  // elapsed timer moving between polls, so the progress display is
  // genuinely dynamic instead of a static "生成中" note.
  useEffect(() => {
    if (!filmBusy && !agentActive) return;
    setFilmNow(Date.now());
    const t = setInterval(() => setFilmNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [filmBusy, agentActive]);
  const filmTotal = filmQuery.data?.shot_count ?? 0;
  const filmDoneShots = filmQuery.data?.progress_done ?? 0;
  const filmStage = filmQuery.data?.progress_stage ?? "";
  const filmPct =
    filmTotal > 0
      ? Math.min(100, Math.round((filmDoneShots / filmTotal) * 100))
      : 0;
  const filmCreatedMs = filmQuery.data?.created_at
    ? Date.parse(filmQuery.data.created_at)
    : NaN;
  const filmElapsedSec =
    filmBusy && Number.isFinite(filmCreatedMs)
      ? Math.max(0, Math.floor((filmNow - filmCreatedMs) / 1000))
      : 0;
  const filmElapsedLabel =
    filmElapsedSec >= 60
      ? `${Math.floor(filmElapsedSec / 60)} 分 ${filmElapsedSec % 60} 秒`
      : `${filmElapsedSec} 秒`;
  const filmStageLabel =
    filmStatus === "queued"
      ? "已排队，等待开始"
      : filmStage
        ? filmStage
        : filmDoneShots > 0
          ? "正在生成镜头片段"
          : "正在逐镜头生成真运动视频并按剧情剪辑";
  // Stall detection (mirrors the server): updated_at only moves when the
  // background task reports progress. No update for 5+ minutes while busy
  // means it is very likely stuck — say so plainly and offer an exit
  // instead of an eternal "生成中". At 15+ minutes without an update the
  // server auto-fails the request on the next poll, so this warning state
  // is also the user's chance to end it early.
  const filmUpdatedMs = filmQuery.data?.updated_at
    ? Date.parse(filmQuery.data.updated_at)
    : NaN;
  const filmSinceUpdateSec =
    filmBusy && Number.isFinite(filmUpdatedMs)
      ? Math.max(0, Math.floor((filmNow - filmUpdatedMs) / 1000))
      : 0;
  const filmSinceUpdateLabel =
    filmSinceUpdateSec >= 60
      ? `${Math.floor(filmSinceUpdateSec / 60)} 分 ${filmSinceUpdateSec % 60} 秒`
      : `${filmSinceUpdateSec} 秒`;
  // Same 5-minute warning for the saving stage as everywhere else:
  // chunked saving reports on every stored chunk (see agentStallWarnMs).
  const filmStallWarnMs = 5 * 60 * 1000;
  const filmIsStalled =
    filmBusy &&
    ((filmQuery.data?.is_stalled ?? false) ||
      (Number.isFinite(filmUpdatedMs) && filmNow - filmUpdatedMs >= filmStallWarnMs));
  const [filmCancelling, setFilmCancelling] = useState(false);
  const [bannerDownloading, setBannerDownloading] = useState(false);

  useEffect(() => {
    const data = filmQuery.data;
    if (!data || currentId == null) return;
    if (data.status === "done" && data.request_id != null) {
      // The film was saved back onto the 成片 node + history by the
      // background task: refetch the project so it just shows up.
      queryClient.invalidateQueries({ queryKey: ["project", currentId] });
      queryClient.invalidateQueries({ queryKey: ["generations", currentId] });
      if (filmDoneNotifiedRef.current !== data.request_id) {
        filmDoneNotifiedRef.current = data.request_id;
        // Invalidate only: the load effect applies the new data object
        // (with the film patched onto the 成片 node) by identity. Clearing
        // the loaded flag here could strand the "正在打开画布…" overlay
        // if the refetch comes back structurally unchanged.
        queryClient.invalidateQueries({ queryKey: ["project", currentId] });
        setToast("成片已经生成好并存回工具里了，在成片节点和生成历史里都能播放");
      }
    }
  }, [filmQuery.data, currentId, queryClient]);

  const createProjectMut = useMutation({
    mutationFn: (name: string) => api.createProject({ name }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setCurrentId(res.id);
      setNewProjectName("");
    },
    onError: (e) => setToast(`创建项目失败：${errMsg(e)}`),
  });

  const deleteProjectMut = useMutation({
    mutationFn: (id: number) => api.deleteProject({ id }),
    onSuccess: (_res, id) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (id === currentId) {
        setCurrentId(null);
        markProjectUnloaded();
      }
      setToast("项目已删除");
    },
    onError: (e) => setToast(`删除失败：${errMsg(e)}`),
  });

  const saveMut = useMutation({
    mutationFn: (args: { id: number; name: string; graph: string }) =>
      api.saveProject(args),
    onSuccess: (_res, args) => {
      savedGraphRef.current = args.graph;
      setSaveState("saved");
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e) => {
      setSaveState("dirty");
      setToast(`保存失败：${errMsg(e)}`);
    },
  });
  const saveMutRef = useRef(saveMut);
  saveMutRef.current = saveMut;

  // ---- project lifecycle -------------------------------------------------

  useEffect(() => {
    if (!projectsQuery.data) return;
    if (currentId != null) return;
    const list = projectsQuery.data.projects;
    if (list.length > 0) {
      const first = list[0];
      if (first) setCurrentId(first.id);
    } else if (!createdInitialRef.current) {
      createdInitialRef.current = true;
      createProjectMut.mutate("我的第一个短片");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsQuery.data, currentId]);

  useEffect(() => {
    const data = projectQuery.data;
    if (!data || currentId == null || data.id !== currentId) return;
    // Apply each distinct data object exactly once. Keying on object
    // identity (not on the loaded flag) is what lets background
    // refreshes land — a new storyboard image, the finished film —
    // without ever marking the canvas unloaded: when a refetch changes
    // nothing, React Query returns this same object and there is
    // simply nothing to apply, while the canvas stays open.
    if (appliedDataRef.current === data) return;
    const isFirstLoad = loadedProjectRef.current !== currentId;
    appliedDataRef.current = data;
    loadedProjectRef.current = currentId;
    setLoadedId(currentId);
    const parsed = parseGraph(data.graph);
    const serialized = JSON.stringify(parsed);
    if (!isFirstLoad && serialized === JSON.stringify(graphRef.current)) {
      // Server copy matches what is already on the canvas (e.g. the
      // refetch raced our own save): refresh bookkeeping only, never
      // reset the user's selection, history, or in-progress edits.
      savedGraphRef.current = serialized;
      setProjectName(data.name);
      return;
    }
    if (isFirstLoad && parsed.nodes.length > 0) {
      // Phone first-open: a viewport saved on a wide screen can leave
      // most nodes (and their controls) off the small screen entirely.
      // Fit the whole workflow into view once, locally — the stored
      // graph keeps its own viewport until the user actually edits.
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.width < 640) {
        parsed.viewport = fitViewportForNodes(parsed.nodes, rect.width, rect.height);
      }
    }
    // Recompute after the possible local viewport override so the
    // autosave baseline matches what is on the canvas and the phone-fit
    // alone never triggers a save over the stored graph.
    savedGraphRef.current = JSON.stringify(parsed);
    setGraph(parsed);
    setProjectName(data.name);
    setSaveState("saved");
    if (isFirstLoad) {
      setSelectedId(null);
      setLinkFrom(null);
      historyRef.current = { past: [], future: [] };
      settledRef.current = JSON.stringify({ nodes: parsed.nodes, edges: parsed.edges, viewport: parsed.viewport });
      setHistState({ canUndo: false, canRedo: false });
    } else {
      // A server-side update landed mid-session (agent build, finished
      // film): adopt it as the settled snapshot so the history debounce
      // does not record the server's update as a user edit, and drop
      // selections that no longer exist.
      settledRef.current = JSON.stringify({ nodes: parsed.nodes, edges: parsed.edges, viewport: parsed.viewport });
      setSelectedIds((prev) => prev.filter((id) => parsed.nodes.some((n) => n.id === id)));
    }
  }, [projectQuery.data, currentId, setSelectedId]);

  // ---- autosave ----------------------------------------------------------

  const doSave = useCallback(() => {
    if (currentId == null || loadedProjectRef.current !== currentId) return;
    // While the agent build owns the canvas (scripting / assets /
    // storyboarding), the local graph is a snapshot that falls behind
    // the server with every generated shot. Saving it would write the
    // older copy back over the server's graph and wipe the images the
    // build just put on the nodes — exactly the "node images never
    // update" failure. Autosave resumes by itself when the build parks
    // (awaiting_confirm) or hands off to the film phase; the server
    // also preserves generated media and ignores graph replacement
    // during the build as a backstop.
    if (agentBuilding) return;
    const serialized = JSON.stringify(graphRef.current);
    if (serialized === savedGraphRef.current && nameRef.current.trim()) {
      setSaveState("saved");
      return;
    }
    setSaveState("saving");
    saveMutRef.current.mutate({
      id: currentId,
      name: nameRef.current.trim() || "未命名项目",
      graph: serialized,
    });
  }, [currentId, agentBuilding]);

  useEffect(() => {
    if (currentId == null || loadedProjectRef.current !== currentId) return;
    if (agentBuilding) return;
    if (JSON.stringify(graph) === savedGraphRef.current) return;
    setSaveState("dirty");
    const t = setTimeout(doSave, 900);
    return () => clearTimeout(t);
  }, [graph, currentId, doSave, agentBuilding]);

  // ---- undo / redo ---------------------------------------------------------
  // History mirrors the reference canvas: past/future double stacks,
  // capped at 50 entries; commits are debounced so a continuous drag or
  // a burst of typing settles into ONE entry; entries cover nodes +
  // connections + viewport; applying a snapshot sets the settled marker
  // first so the programmatic replay is never re-recorded as a new edit
  // (the paused flag below makes that guard explicit). Snapshots carry
  // node media references (blob keys / urls / film manifests) verbatim,
  // so undo/redo never loses or corrupts an image or a finished film.

  const historyPausedRef = useRef(false);

  useEffect(() => {
    if (currentId == null || loadedProjectRef.current !== currentId) return;
    const t = setTimeout(() => {
      if (historyPausedRef.current) return;
      const g = graphRef.current;
      const snap = JSON.stringify({
        nodes: g.nodes,
        edges: g.edges,
        viewport: g.viewport,
      });
      if (snap === settledRef.current) return;
      const h = historyRef.current;
      h.past.push(settledRef.current);
      if (h.past.length > 50) h.past.shift();
      h.future = [];
      settledRef.current = snap;
      setHistState({ canUndo: true, canRedo: false });
    }, 500);
    return () => clearTimeout(t);
  }, [graph.nodes, graph.edges, graph.viewport, currentId]);

  const applySnapshot = useCallback((snap: string) => {
    try {
      const parsed = JSON.parse(snap) as {
        nodes: CanvasNode[];
        edges: Graph["edges"];
        viewport?: Viewport;
      };
      historyPausedRef.current = true;
      settledRef.current = snap;
      setGraph((g) => ({
        ...g,
        nodes: parsed.nodes,
        edges: parsed.edges,
        viewport: parsed.viewport ?? g.viewport,
      }));
      setSelectedIds((prev) =>
        prev.filter((id) => parsed.nodes.some((n) => n.id === id)),
      );
      // Release the pause after the replay has settled, so the NEXT
      // genuine user edit records normally.
      setTimeout(() => {
        historyPausedRef.current = false;
      }, 600);
    } catch {
      historyPausedRef.current = false;
    }
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    const prev = h.past.pop();
    if (prev == null) return;
    h.future.push(settledRef.current);
    applySnapshot(prev);
    setHistState({ canUndo: h.past.length > 0, canRedo: true });
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    const next = h.future.pop();
    if (next == null) return;
    h.past.push(settledRef.current);
    applySnapshot(next);
    setHistState({ canUndo: true, canRedo: h.future.length > 0 });
  }, [applySnapshot]);

  // ---- toast --------------------------------------------------------------

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- container size / wheel zoom ---------------------------------------

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setContainerSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Event-routing markers: wheels over panels/popovers/drawers that
      // carry data-canvas-no-zoom scroll THEM, not the canvas.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("[data-canvas-no-zoom]")) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setGraph((g) => {
        const vp = g.viewport;
        // Exponential factor: smooth, speed-proportional zoom anchored
        // at the cursor — the world point under the cursor stays put.
        const factor = Math.exp(-e.deltaY * 0.0016);
        const k = clampK(vp.k * factor);
        const w = screenToWorld(vp, mx, my);
        return {
          ...g,
          viewport: { k, x: mx - w.x * k, y: my - w.y * k },
        };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- graph mutation helpers ---------------------------------------------

  const patchNode = useCallback((id: string, patch: Partial<CanvasNode>) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
  }, []);

  const setViewport = useCallback((vp: Viewport) => {
    setGraph((g) => ({ ...g, viewport: vp }));
  }, []);

  const centerWorld = useCallback((): { x: number; y: number } => {
    const vp = graphRef.current.viewport;
    return {
      x: (containerSize.w / 2 - vp.x) / vp.k - NODE_W / 2,
      y: (containerSize.h / 2 - vp.y) / vp.k - 120,
    };
  }, [containerSize]);

  const addNode = useCallback(
    (type: NodeType, at?: { x: number; y: number }) => {
      const c = at ?? centerWorld();
      const jitter = at ? 0 : (graphRef.current.nodes.length % 5) * 26;
      const node = makeNode(type, c.x + jitter, c.y + jitter);
      if (type === "text") node.title = "提示词";
      if (type === "group") {
        node.w = 380;
        node.h = 260;
      }
      setGraph((g) => ({ ...g, nodes: [...g.nodes, node] }));
      setSelectedId(node.id);
      return node;
    },
    [centerWorld],
  );

  const deleteNode = useCallback((id: string) => {
    setGraph((g) => {
      const target = g.nodes.find((n) => n.id === id);
      // Deleting a group frame keeps its members (they just ungroup).
      const nodes =
        target?.type === "group"
          ? g.nodes
              .filter((n) => n.id !== id)
              .map((n) => (n.groupId === id ? { ...n, groupId: null } : n))
          : g.nodes.filter((n) => n.id !== id);
      return {
        ...g,
        nodes,
        edges: g.edges.filter((e) => e.from !== id && e.to !== id),
      };
    });
    setSelectedIds((s) => s.filter((x) => x !== id));
    setLinkFrom((s) => (s === id ? null : s));
  }, []);

  const deleteSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    const ids = new Set(selectedIds);
    setGraph((g) => {
      // A deleted group frame ungroups its members instead of deleting
      // them (members die only when they are selected themselves).
      const deadGroups = new Set(
        g.nodes.filter((n) => ids.has(n.id) && n.type === "group").map((n) => n.id),
      );
      return {
        ...g,
        nodes: g.nodes
          .filter((n) => !ids.has(n.id))
          .map((n) =>
            n.groupId && deadGroups.has(n.groupId) ? { ...n, groupId: null } : n,
          ),
        edges: g.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to)),
      };
    });
    setSelectedIds([]);
    setLinkFrom(null);
  }, [selectedIds]);

  // ---- grouping ------------------------------------------------------------

  /** Wrap the current selection in a group frame node (Ctrl/Cmd+G):
   *  the frame's rect is the members' bounding box with padding 24 and
   *  52 on top, and the members' groupId points at the new node. */
  const groupSelection = useCallback(() => {
    const g = graphRef.current;
    const members = g.nodes.filter(
      (n) => selectedIds.includes(n.id) && n.type !== "group",
    );
    if (members.length < 2) {
      setToast("先选中至少 2 个节点再成组");
      return;
    }
    const rect = groupWrapRect(members);
    if (!rect) return;
    const group = makeNode("group", rect.x, rect.y);
    group.title = "分组";
    group.w = rect.w;
    group.h = rect.h;
    setGraph((prev) => ({
      ...prev,
      nodes: [
        group,
        ...prev.nodes.map((n) =>
          members.some((m) => m.id === n.id) ? { ...n, groupId: group.id } : n,
        ),
      ],
    }));
    setSelectedIds([group.id]);
    setToast(`已把 ${members.length} 个节点收进分组，拖动分组标题栏可整体移动`);
  }, [selectedIds]);

  /** Dissolve a group frame: members stay on the canvas, ungrouped. */
  const ungroupNode = useCallback((groupNode: CanvasNode) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes
        .filter((n) => n.id !== groupNode.id)
        .map((n) => (n.groupId === groupNode.id ? { ...n, groupId: null } : n)),
      edges: g.edges.filter((e) => e.from !== groupNode.id && e.to !== groupNode.id),
    }));
    setSelectedIds((s) => s.filter((x) => x !== groupNode.id));
  }, []);

  /** Ungroup the group(s) the current selection belongs to (Ctrl/Cmd+Shift+G). */
  const ungroupSelection = useCallback(() => {
    const g = graphRef.current;
    const groupIds = new Set<string>();
    for (const n of g.nodes) {
      if (n.type === "group" && selectedIds.includes(n.id)) groupIds.add(n.id);
      if (n.groupId && selectedIds.includes(n.id)) groupIds.add(n.groupId);
    }
    if (groupIds.size === 0) {
      setToast("当前选区不在任何分组里");
      return;
    }
    setGraph((prev) => ({
      ...prev,
      nodes: prev.nodes
        .filter((n) => !groupIds.has(n.id))
        .map((n) => (n.groupId && groupIds.has(n.groupId) ? { ...n, groupId: null } : n)),
      edges: prev.edges.filter((e) => !groupIds.has(e.from) && !groupIds.has(e.to)),
    }));
    setSelectedIds((s) => s.filter((x) => !groupIds.has(x)));
    setToast("已解组，组内节点都保留在画布上");
  }, [selectedIds]);

  /** After a node drag ends: re-wrap its group's frame if it stayed in,
   *  join a group whose frame now contains its center, or leave the
   *  group it was dragged out of. Group frames re-wrap around members. */
  const settleGroupMembership = useCallback((nodeId: string) => {
    setGraph((g) => {
      const node = g.nodes.find((n) => n.id === nodeId);
      if (!node || node.type === "group") return g;
      const cx = node.x + nodeWidth(node) / 2;
      const cy = node.y + nodeHeight(node) / 2;
      let nodes = g.nodes;
      let groupId = node.groupId;
      const containing = g.nodes.find(
        (n) =>
          n.type === "group" &&
          !n.collapsed &&
          cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h,
      );
      if (containing && groupId !== containing.id) groupId = containing.id;
      else if (!containing && groupId) {
        const old = g.nodes.find((n) => n.id === groupId);
        if (old && !(cx >= old.x && cx <= old.x + old.w && cy >= old.y && cy <= old.y + old.h)) {
          groupId = null;
        }
      }
      if (groupId !== node.groupId) {
        nodes = nodes.map((n) => (n.id === node.id ? { ...n, groupId } : n));
      }
      // Re-wrap every affected frame around its (remaining) members.
      const affected = new Set<string>();
      if (node.groupId) affected.add(node.groupId);
      if (groupId) affected.add(groupId);
      if (affected.size > 0) {
        nodes = nodes.map((n) => {
          if (n.type !== "group" || !affected.has(n.id) || n.collapsed) return n;
          const members = nodes.filter((m) => m.groupId === n.id);
          const rect = groupWrapRect(members);
          return rect ? { ...n, x: rect.x, y: rect.y, w: rect.w, h: rect.h } : n;
        });
      }
      return nodes === g.nodes ? g : { ...g, nodes };
    });
  }, []);

  /** Selection entry point from node cards: plain click selects one node,
   *  Shift+click toggles it in the multi-selection. */
  const handleSelect = useCallback((id: string, additive: boolean) => {
    setSelectedEdgeId(null);
    setSelectedIds((prev) => {
      if (additive) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      }
      // Clicking a node that is already part of a multi-selection keeps the
      // group (so the group can be dragged together); clicking any other
      // node selects just it.
      if (prev.length > 1 && prev.includes(id)) return prev;
      return prev.length === 1 && prev[0] === id ? prev : [id];
    });
  }, []);

  const duplicateNode = useCallback((id: string) => {
    const src = graphRef.current.nodes.find((n) => n.id === id);
    if (!src) return;
    const copy: CanvasNode = {
      ...src,
      id: uid("n"),
      x: src.x + 36,
      y: src.y + 36,
      title: `${src.title} 副本`,
      status: "idle",
      error: "",
    };
    setGraph((g) => ({ ...g, nodes: [...g.nodes, copy] }));
    setSelectedId(copy.id);
  }, [setSelectedId]);

  // ---- clipboard (copy / paste / duplicate-in-place) -----------------------

  const copySelection = useCallback(() => {
    const g = graphRef.current;
    const ids = new Set(
      selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [],
    );
    if (ids.size === 0) return;
    clipboardRef.current = {
      nodes: g.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n })),
      edges: g.edges
        .filter((e) => ids.has(e.from) && ids.has(e.to))
        .map((e) => ({ from: e.from, to: e.to })),
    };
  }, [selectedIds, selectedId]);

  const pasteClipboard = useCallback(
    (offsetX = 40, offsetY = 40, at?: { x: number; y: number }) => {
      const clip = clipboardRef.current;
      if (!clip || clip.nodes.length === 0) {
        setToast("剪贴板是空的：先选中节点按 Ctrl+C 复制");
        return;
      }
      const idMap = new Map<string, string>();
      let dx = offsetX;
      let dy = offsetY;
      if (at) {
        const minX = Math.min(...clip.nodes.map((n) => n.x));
        const minY = Math.min(...clip.nodes.map((n) => n.y));
        dx = at.x - minX;
        dy = at.y - minY;
      }
      const nodes: CanvasNode[] = clip.nodes.map((n) => {
        const id = uid("n");
        idMap.set(n.id, id);
        return { ...n, id, x: n.x + dx, y: n.y + dy, status: "idle" as const, error: "" };
      });
      const edges = clip.edges
        .map((e) => {
          const from = idMap.get(e.from);
          const to = idMap.get(e.to);
          return from && to ? { id: uid("e"), from, to } : null;
        })
        .filter((e): e is { id: string; from: string; to: string } => e != null);
      setGraph((g) => ({ ...g, nodes: [...g.nodes, ...nodes], edges: [...g.edges, ...edges] }));
      setSelectedIds(nodes.map((n) => n.id));
    },
    [],
  );

  // ---- align / distribute / auto-layout -------------------------------------

  const alignSelected = useCallback(
    (mode: "left" | "right" | "top" | "bottom" | "centerX" | "centerY") => {
      if (selectedIds.length < 2) return;
      setGraph((g) => {
        const sel = g.nodes.filter((n) => selectedIds.includes(n.id) && !n.locked);
        if (sel.length < 2) return g;
        const minX = Math.min(...sel.map((n) => n.x));
        const maxX = Math.max(...sel.map((n) => n.x + NODE_W));
        const minY = Math.min(...sel.map((n) => n.y));
        const maxY = Math.max(...sel.map((n) => n.y + nodeHeight(n)));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        return {
          ...g,
          nodes: g.nodes.map((n) => {
            if (!selectedIds.includes(n.id) || n.locked) return n;
            switch (mode) {
              case "left": return { ...n, x: minX };
              case "right": return { ...n, x: maxX - NODE_W };
              case "top": return { ...n, y: minY };
              case "bottom": return { ...n, y: maxY - nodeHeight(n) };
              case "centerX": return { ...n, x: cx - NODE_W / 2 };
              case "centerY": return { ...n, y: cy - nodeHeight(n) / 2 };
              default: return n;
            }
          }),
        };
      });
    },
    [selectedIds],
  );

  const distributeSelected = useCallback(
    (axis: "x" | "y") => {
      if (selectedIds.length < 3) return;
      setGraph((g) => {
        const sel = g.nodes
          .filter((n) => selectedIds.includes(n.id) && !n.locked)
          .sort((a, b) => (axis === "x" ? a.x - b.x : a.y - b.y));
        if (sel.length < 3) return g;
        const first = sel[0];
        const last = sel[sel.length - 1];
        if (!first || !last) return g;
        const start = axis === "x" ? first.x : first.y;
        const end = axis === "x" ? last.x : last.y;
        const step = (end - start) / (sel.length - 1);
        const pos = new Map(sel.map((n, i) => [n.id, start + step * i]));
        return {
          ...g,
          nodes: g.nodes.map((n) => {
            const p = pos.get(n.id);
            if (p == null) return n;
            return axis === "x" ? { ...n, x: p } : { ...n, y: p };
          }),
        };
      });
    },
    [selectedIds],
  );

  /** LibTV-style tidy: layer nodes by their wiring (longest path from a
   *  root), columns left→right, stacked top→bottom inside each column. */
  const autoLayout = useCallback(() => {
    setGraph((g) => {
      if (g.nodes.length === 0) return g;
      const layer = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
      for (let iter = 0; iter < g.nodes.length; iter++) {
        let changed = false;
        for (const e of g.edges) {
          const from = layer.get(e.from) ?? 0;
          const to = layer.get(e.to) ?? 0;
          if (to < from + 1) {
            layer.set(e.to, from + 1);
            changed = true;
          }
        }
        if (!changed) break;
      }
      const byLayer = new Map<number, CanvasNode[]>();
      for (const n of g.nodes) {
        const l = layer.get(n.id) ?? 0;
        const arr = byLayer.get(l) ?? [];
        arr.push(n);
        byLayer.set(l, arr);
      }
      const pos = new Map<string, { x: number; y: number }>();
      for (const [l, arr] of byLayer) {
        const sorted = [...arr].sort((a, b) => a.y - b.y || a.x - b.x);
        let y = 60;
        for (const n of sorted) {
          if (!n.locked) pos.set(n.id, { x: 60 + l * 380, y });
          y += nodeHeight(n) + 48;
        }
      }
      return {
        ...g,
        nodes: g.nodes.map((n) => {
          const p = pos.get(n.id);
          return p ? { ...n, x: p.x, y: p.y } : n;
        }),
      };
    });
    setToast("已按连线顺序整理画布");
  }, []);

  const completeLink = useCallback(
    (targetId: string) => {
      if (!linkFrom) return;
      if (!canConnect(graphRef.current, linkFrom, targetId)) {
        if (linkFrom !== targetId) {
          setToast("这条连线已存在或不合法（不能自连、不能重复、不能反向重复）");
        }
        setLinkFrom(null);
        return;
      }
      setGraph((g) => {
        if (!canConnect(g, linkFrom, targetId)) return g;
        return {
          ...g,
          edges: [...g.edges, { id: uid("e"), from: linkFrom, to: targetId }],
        };
      });
      setLinkFrom(null);
    },
    [linkFrom],
  );

  // ---- generation flows -----------------------------------------------------
  // Text and images run on the platform's own models via server actions:
  // text = ctx.inference, images = ctx.tool.generate_media, image-to-image
  // = vision inference + generate_media. The finished film is one click:
  // 「生成并合成成片」 queues a film request (requestFilm action) and Muse
  // generates one true-motion clip per shot in the background, edits them
  // into the film, and saves it back onto the 成片 node automatically.
  // There is no export step anywhere.

  /** Fetch one of our own blob URLs and re-encode it as a JPEG base64
   *  string the vision model can read (it accepts JPEG/PNG only). */
  const blobUrlToJpegBase64 = async (url: string): Promise<string> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("参考图读取失败");
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const c2d = canvas.getContext("2d");
    if (!c2d) throw new Error("参考图处理失败");
    c2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  };


  const handleGenerate = useCallback(
    async (node: CanvasNode) => {
      if (currentId == null) return;
      const g = graphRef.current;
      const fresh = g.nodes.find((n) => n.id === node.id) ?? node;
      // Generation context is collected along the wires: upstream text
      // nodes, a wired config node's style, and wired reference images
      // all merge into the prompt (effectivePrompt); aspect and quality
      // are inherited from the config node when one is wired in.
      const prompt = effectivePrompt(g, fresh);
      if (!prompt) {
        patchNode(node.id, {
          status: "error",
          error: "还没有提示词：先在本节点写补充描述，或连接一个写了内容的提示词节点",
        });
        return;
      }
      const aspect = effectiveAspect(g, fresh);
      const snapshot = {
        prompt,
        aspect,
        duration: fresh.duration,
        motion: fresh.motion,
        quality: effectiveQuality(g, fresh),
        refBlobKeys: upstreamImages(g, fresh.id)
          .map((u) => u.blobKey)
          .filter((k) => k !== ""),
        at: Date.now(),
      };
      patchNode(node.id, { status: "generating", error: "", snapshot });
      try {
        const res = await api.generateImage({
          projectId: currentId,
          nodeId: node.id,
          prompt,
          orientation: orientationOf(aspect),
        });
        patchNode(node.id, { status: "idle", blobKey: res.blob_key, url: res.url, frames: [] });
        queryClient.invalidateQueries({ queryKey: ["generations", currentId] });
        setToast("分镜图已生成");
      } catch (e) {
        patchNode(node.id, {
          status: "error",
          error: `生成失败：${errMsg(e)}（可点节点上的「原样重试」按上次参数再试）`,
        });
      }
    },
    [currentId, patchNode, queryClient],
  );

  /** One-click retry with the node's stored generation snapshot: the
   *  exact prompt / aspect / quality it last ran with, no re-editing.
   *  The snapshot's source is the node itself; for 图生图 variants the
   *  source node is the wired upstream image (see 定位源节点 in the
   *  node menu). */
  const handleRetrySnapshot = useCallback(
    async (node: CanvasNode) => {
      if (currentId == null) return;
      const fresh = graphRef.current.nodes.find((n) => n.id === node.id) ?? node;
      const snap = fresh.snapshot;
      if (!snap) {
        setToast("这个节点还没有生成过，没有可重试的参数快照");
        return;
      }
      patchNode(node.id, {
        status: "generating",
        error: "",
        snapshot: { ...snap, at: Date.now() },
      });
      try {
        const res = await api.generateImage({
          projectId: currentId,
          nodeId: node.id,
          prompt: snap.prompt,
          orientation: orientationOf(snap.aspect),
        });
        patchNode(node.id, { status: "idle", blobKey: res.blob_key, url: res.url, frames: [] });
        queryClient.invalidateQueries({ queryKey: ["generations", currentId] });
        setToast("已按上次参数重新生成");
      } catch (e) {
        patchNode(node.id, { status: "error", error: `重试失败：${errMsg(e)}` });
      }
    },
    [currentId, patchNode, queryClient],
  );

  const handleGenerateText = useCallback(
    async (node: CanvasNode, mode: TextMode) => {
      const fresh = graphRef.current.nodes.find((n) => n.id === node.id) ?? node;
      if (!fresh.text.trim()) return;
      setEnhancingId(node.id);
      try {
        const res = await api.generateText({ text: fresh.text.trim(), mode });
        if (res.text) patchNode(node.id, { text: res.text });
        setToast(
          mode === "expand"
            ? "提示词已扩写"
            : mode === "script"
              ? "脚本已生成"
              : mode === "storyboard"
                ? "分镜脚本已生成，可一键拆成分镜节点"
                : "文案已生成",
        );
      } catch (e) {
        setToast(`生成失败：${errMsg(e)}`);
      } finally {
        setEnhancingId(null);
      }
    },
    [patchNode],
  );

  /** Turn a storyboard-script text node into wired shot nodes:
   *  text → image×N → video, laid out in a row to the right. */
  const handleSplitStoryboard = useCallback(
    (node: CanvasNode) => {
      const fresh = graphRef.current.nodes.find((n) => n.id === node.id) ?? node;
      const shots = parseStoryboard(fresh.text);
      if (shots.length === 0) {
        setToast("没识别出分镜行：先用「分镜脚本」模式生成，或按 镜头N｜画面：… 的格式写");
        return;
      }
      const baseX = fresh.x + 380;
      const imageNodes: CanvasNode[] = shots.map((s, i) => {
        const n = makeNode("image", baseX, fresh.y + i * 372);
        n.title = `镜头 ${i + 1}`;
        n.text = s.prompt;
        n.caption = s.caption;
        n.aspect = fresh.aspect;
        n.duration = s.duration;
        n.motion = s.motion;
        return n;
      });
      const videoNode = makeNode(
        "video",
        baseX + 380,
        fresh.y + ((shots.length - 1) * 372) / 2,
      );
      videoNode.title = "成片";
      videoNode.aspect = fresh.aspect;
      setGraph((g) => ({
        ...g,
        nodes: [...g.nodes, ...imageNodes, videoNode],
        edges: [
          ...g.edges,
          ...imageNodes.map((n) => ({ id: uid("e"), from: fresh.id, to: n.id })),
          ...imageNodes.map((n) => ({ id: uid("e"), from: n.id, to: videoNode.id })),
        ],
      }));
      setSelectedId(videoNode.id);
      setToast(`已拆出 ${shots.length} 个镜头节点并连好成片节点，生成图片后点「生成并合成成片」就行`);
    },
    [setSelectedId],
  );

  /** Image-to-image: new variation node below the source, wired from it. */
  const handleVary = useCallback(
    async (node: CanvasNode) => {
      if (currentId == null) return;
      const fresh = graphRef.current.nodes.find((n) => n.id === node.id) ?? node;
      if (!fresh.url) return;
      patchNode(node.id, { status: "generating", error: "" });
      try {
        const imageBase64 = await blobUrlToJpegBase64(fresh.url);
        const instruction =
          fresh.text.trim() || "保持主体与氛围不变，换一个构图和镜头角度重新生成";
        const res = await api.varyImage({
          projectId: currentId,
          nodeId: node.id,
          instruction,
          imageBase64,
          orientation: orientationOf(fresh.aspect),
        });
        const variant = makeNode("image", fresh.x, fresh.y + nodeHeight(fresh) + 36);
        variant.title = `${fresh.title} 变体`;
        variant.text = fresh.text;
        variant.aspect = fresh.aspect;
        variant.duration = fresh.duration;
        variant.motion = fresh.motion;
        variant.blobKey = res.blob_key;
        variant.url = res.url;
        setGraph((g) => ({
          ...g,
          nodes: [...g.nodes, variant],
          edges: [...g.edges, { id: uid("e"), from: fresh.id, to: variant.id }],
        }));
        patchNode(node.id, { status: "idle" });
        setSelectedId(variant.id);
        queryClient.invalidateQueries({ queryKey: ["generations", currentId] });
        setToast("图生图变体已生成到下方新节点");
      } catch (e) {
        patchNode(node.id, { status: "error", error: `图生图失败：${errMsg(e)}` });
      }
    },
    [currentId, patchNode, queryClient, setSelectedId],
  );

  /** Run-all: generate every image node that still has no picture. Once
   *  the storyboard is complete, one click on 「生成并合成成片」 makes the
   *  film in the background. */
  const handleRunAll = useCallback(async () => {
    if (runningAll || currentId == null) return;
    const g = graphRef.current;
    const pendingImages = g.nodes.filter((n) => n.type === "image" && !n.url);
    if (pendingImages.length === 0) {
      setToast("分镜图都已生成，可以点「生成并合成成片」了");
      return;
    }
    setRunningAll(true);
    try {
      for (const img of pendingImages) {
        setToast(`运行中：生成分镜图「${img.title}」…`);
        await handleGenerate(img);
        await new Promise((r) => setTimeout(r, 60));
      }
      setToast("分镜图已全部生成，点「生成并合成成片」，成片会自动存回这里");
    } finally {
      setRunningAll(false);
    }
  }, [runningAll, currentId, handleGenerate]);

  const handleUpload = useCallback(
    async (node: CanvasNode, file: File) => {
      if (currentId == null) return;
      const kind = node.type === "video" ? "video" : "image";
      if (kind === "image" && !file.type.startsWith("image/")) {
        patchNode(node.id, { status: "error", error: "请选择图片文件" });
        return;
      }
      if (kind === "video" && !file.type.startsWith("video/")) {
        patchNode(node.id, { status: "error", error: "请选择视频文件" });
        return;
      }
      if (file.size > 30 * 1024 * 1024) {
        patchNode(node.id, { status: "error", error: "文件超过 30MB，无法上传" });
        return;
      }
      patchNode(node.id, { status: "generating", error: "" });
      try {
        const { dataBase64, mimeType } = await fileToBase64(file);
        const res = await api.uploadAsset({
          projectId: currentId,
          nodeId: node.id,
          kind,
          mime: mimeType || file.type,
          dataBase64,
        });
        patchNode(node.id, {
          status: "idle",
          blobKey: res.blob_key,
          url: res.url,
          ...(kind === "image" ? { frames: [] } : { filmAssembly: null }),
        });
        setToast("素材已上传");
      } catch (e) {
        patchNode(node.id, { status: "error", error: `上传失败：${errMsg(e)}` });
      }
    },
    [currentId, patchNode],
  );

  const handleGlobalUpload = useCallback(
    async (file: File) => {
      const isVideo = file.type.startsWith("video/");
      const node = addNode(isVideo ? "video" : "image");
      node.title = file.name.replace(/\.[^.]+$/, "").slice(0, 24) || node.title;
      patchNode(node.id, { title: node.title });
      await handleUpload(node, file);
    },
    [addNode, handleUpload, patchNode],
  );

  // ---- film generation (one click, fully automatic) ----------------------
  // The user never exports or sends anything: this flushes the latest
  // canvas to storage, queues a film request server-side, and Muse
  // generates one true-motion clip per shot in the background, edits them
  // into the finished film, and saves it back onto the 成片 node.
  // The film status query above polls while it runs and the film simply
  // appears here when it is done.

  const packageShotsOf = useCallback(
    (node: CanvasNode): PackageShotInfo[] =>
      upstream(graph, node.id)
        .filter((u) => u.type === "image")
        .map((u) => ({ id: u.id, title: u.title, url: u.url, duration: u.duration })),
    [graph],
  );

  const handleRequestFilm = useCallback(
    async (packageNode?: CanvasNode) => {
      if (currentId == null || filmRequesting || filmBusy) return;
      setFilmRequesting(true);
      try {
        // Flush the newest canvas first so the shot list the server reads
        // includes the images generated a moment ago.
        await api.saveProject({
          id: currentId,
          name: nameRef.current.trim() || "未命名项目",
          graph: JSON.stringify(graphRef.current),
        });
        savedGraphRef.current = JSON.stringify(graphRef.current);
        setSaveState("saved");
        const res = await api.requestFilm({
          projectId: currentId,
          packageNodeId: packageNode?.id,
        });
        if (!res.ok) {
          setToast(res.error || "成片请求失败，请重试");
          return;
        }
        queryClient.invalidateQueries({ queryKey: ["filmStatus", currentId] });
        setToast(
          res.already
            ? "成片已经在生成中了，好了会自动出现在成片节点上"
            : `已开始生成成片：${res.shot_count} 个镜头正在逐个生成真运动视频并剪辑，好了会自动存回这里`,
        );
      } catch (e) {
        setToast(`成片请求失败：${errMsg(e)}`);
      } finally {
        setFilmRequesting(false);
      }
    },
    [currentId, filmRequesting, filmBusy, queryClient],
  );

  /** End a stuck (or any in-flight) film generation. The server marks the
   *  request failed, which frees the project to generate again at once —
   *  the user never has to wait out a dead background task. */
  const handleCancelFilm = useCallback(async (): Promise<boolean> => {
    if (currentId == null || filmCancelling) return false;
    setFilmCancelling(true);
    try {
      const res = await api.cancelFilm({ projectId: currentId });
      await queryClient.invalidateQueries({ queryKey: ["filmStatus", currentId] });
      await filmQuery.refetch();
      setToast(
        res.cancelled
          ? "已结束这次生成，可以重新点「生成并合成成片」"
          : "这次生成已经结束了",
      );
      return res.cancelled;
    } catch (e) {
      setToast(`结束生成失败：${errMsg(e)}`);
      return false;
    } finally {
      setFilmCancelling(false);
    }
  }, [currentId, filmCancelling, queryClient, filmQuery]);

  /** Stalled-state one-click recovery: end the dead request, then start a
   *  fresh one right away (bypassing the filmBusy guard, which the cancel
   *  has just cleared server-side). */
  const handleRestartFilm = useCallback(
    async (packageNode?: CanvasNode) => {
      if (currentId == null || filmCancelling || filmRequesting) return;
      setFilmCancelling(true);
      try {
        await api.cancelFilm({ projectId: currentId });
      } catch (e) {
        setToast(`结束上次生成失败：${errMsg(e)}`);
        setFilmCancelling(false);
        return;
      }
      setFilmCancelling(false);
      await queryClient.invalidateQueries({ queryKey: ["filmStatus", currentId] });
      // Start fresh directly (handleRequestFilm would still see the stale
      // filmBusy flag from the last poll, so do the request inline).
      setFilmRequesting(true);
      try {
        await api.saveProject({
          id: currentId,
          name: nameRef.current.trim() || "未命名项目",
          graph: JSON.stringify(graphRef.current),
        });
        savedGraphRef.current = JSON.stringify(graphRef.current);
        setSaveState("saved");
        const res = await api.requestFilm({
          projectId: currentId,
          packageNodeId: packageNode?.id,
        });
        if (!res.ok) {
          setToast(res.error || "成片请求失败，请重试");
          return;
        }
        queryClient.invalidateQueries({ queryKey: ["filmStatus", currentId] });
        setToast(`已重新开始生成成片：${res.shot_count} 个镜头`);
      } catch (e) {
        setToast(`成片请求失败：${errMsg(e)}`);
      } finally {
        setFilmRequesting(false);
      }
    },
    [currentId, filmCancelling, filmRequesting, queryClient],
  );

  // ---- Agent 一句话成片 ------------------------------------------------------
  // One sentence → a NEW project whose workflow the server builds itself
  // (script → asset lock → storyboard images → 成片 node), then either the
  // background film pipeline (auto) or a confirm stop (step). The manual
  // canvas flow is untouched; everything here is additive.

  const handleStartAgent = useCallback(async () => {
    const instruction = agentInstruction.trim();
    if (!instruction || agentStarting) return;
    setAgentStarting(true);
    try {
      const started = await api.startAgentProduction({
        instruction,
        targetDuration: agentDuration,
        aspect: agentAspect,
        style: agentStyle.trim(),
        mode: agentMode,
      });
      if (!started.ok || started.project_id == null || started.run_id == null) {
        setToast(started.error || "自动制作启动失败，请重试");
        return;
      }
      setShowAgentPanel(false);
      markProjectUnloaded();
      setCurrentId(started.project_id);
      setToast("Agent 已接单：正在自动搭工作流、写剧本、定版资产、生成分镜图……");
      // Phase 2: the server builds the workflow; getAgentRunStatus polls
      // and the banner + canvas update live while this runs.
      try {
        const built = await api.buildAgentProduction({ runId: started.run_id });
        if (!built.ok) {
          setToast(built.error || "自动制作没有完成，请看上方提示");
        } else if (built.status === "awaiting_confirm") {
          setToast(
            built.error ||
              "分镜已经全部生成好并摆上画布了：检查或修改后点「继续生成成片」就进入成片阶段",
          );
        } else if (built.status === "filming") {
          setToast("分镜已就绪，成片阶段已开始：后台正在逐镜头生成真运动视频、配乐并剪辑，好了会自动存回成片节点");
        }
      } catch (e) {
        // The build can outlast a single request's time limit while the
        // server keeps working (progress is saved after every shot).
        // Check the run's real status before calling it a failure — the
        // banner polls it and takes over from here.
        let stillGoing = false;
        try {
          const st = await api.getAgentRunStatus({ projectId: started.project_id });
          stillGoing =
            st.status === "scripting" ||
            st.status === "assets" ||
            st.status === "storyboarding" ||
            st.status === "awaiting_confirm" ||
            st.status === "filming";
          if (st.status === "awaiting_confirm") {
            setToast(st.error || "分镜已经生成好了：检查或修改后点「继续生成成片」");
          } else if (st.status === "filming") {
            setToast("分镜已就绪，成片阶段已在后台开始，好了会自动存回成片节点");
          } else if (stillGoing) {
            setToast("自动搭建还在后台进行中，进度会实时显示在上方横幅里");
          }
        } catch {
          /* fall through to the error toast */
        }
        if (!stillGoing) setToast(`自动搭建失败：${errMsg(e)}`);
      }
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["agentStatus", started.project_id] });
    } catch (e) {
      setToast(`自动制作启动失败：${errMsg(e)}`);
    } finally {
      setAgentStarting(false);
    }
  }, [agentInstruction, agentDuration, agentAspect, agentStyle, agentMode, agentStarting, queryClient, markProjectUnloaded]);

  /** Flush canvas edits, then continue a parked agent run. */
  const handleContinueAgent = useCallback(
    async (next: "film" | "storyboard") => {
      if (currentId == null || agentContinuing) return;
      setAgentContinuing(true);
      try {
        await api.saveProject({
          id: currentId,
          name: nameRef.current.trim() || "未命名项目",
          graph: JSON.stringify(graphRef.current),
        });
        savedGraphRef.current = JSON.stringify(graphRef.current);
        setSaveState("saved");
        const res = await api.continueAgentProduction({ projectId: currentId, next });
        if (!res.ok) {
          setToast(res.error || "继续失败，请重试");
        } else if (next === "storyboard") {
          setToast(
            res.status === "awaiting_confirm"
              ? res.error || "分镜已重新生成，检查后点「继续生成成片」"
              : "分镜已重新生成，成片阶段已开始",
          );
        } else {
          setToast("已按画布当前状态开始生成成片：后台逐镜头生成真运动视频、配乐并剪辑，好了会自动存回这里");
        }
        queryClient.invalidateQueries({ queryKey: ["agentStatus", currentId] });
        queryClient.invalidateQueries({ queryKey: ["filmStatus", currentId] });
      } catch (e) {
        setToast(`继续失败：${errMsg(e)}`);
      } finally {
        setAgentContinuing(false);
      }
    },
    [currentId, agentContinuing, queryClient],
  );

  const handleCancelAgent = useCallback(async () => {
    if (currentId == null || agentCancelling) return;
    setAgentCancelling(true);
    try {
      const res = await api.cancelAgentRun({ projectId: currentId });
      queryClient.invalidateQueries({ queryKey: ["agentStatus", currentId] });
      queryClient.invalidateQueries({ queryKey: ["filmStatus", currentId] });
      setToast(
        res.cancelled
          ? "已结束这次自动制作，画布上的工作流和分镜都保留着"
          : "这次自动制作已经结束了",
      );
    } catch (e) {
      setToast(`结束失败：${errMsg(e)}`);
    } finally {
      setAgentCancelling(false);
    }
  }, [currentId, agentCancelling, queryClient]);

  // ---- single-image refine tools -----------------------------------------
  // Crop / split / upscale produce real pixels locally; the results go
  // back through uploadAsset so they are owned assets like any upload.
  // Mask edit and multi-angle reuse the image-to-image channel.

  const handleToolNewNode = useCallback(
    async (source: CanvasNode, blob: Blob, titleSuffix: string) => {
      if (currentId == null) return;
      const fresh = graphRef.current.nodes.find((n) => n.id === source.id) ?? source;
      const node = makeNode("image", fresh.x + 40, fresh.y + nodeHeight(fresh) + 40);
      node.title = `${fresh.title} · ${titleSuffix}`.slice(0, 40);
      node.text = fresh.text;
      node.aspect = fresh.aspect;
      node.duration = fresh.duration;
      node.motion = fresh.motion;
      node.groupId = fresh.groupId;
      setGraph((g) => ({
        ...g,
        nodes: [...g.nodes, node],
        edges: [...g.edges, { id: uid("e"), from: fresh.id, to: node.id }],
      }));
      setSelectedId(node.id);
      const file = new File([blob], `${titleSuffix}.jpg`, { type: blob.type || "image/jpeg" });
      await handleUpload(node, file);
    },
    [currentId, handleUpload, setSelectedId],
  );

  const handleToolReplace = useCallback(
    async (source: CanvasNode, blob: Blob) => {
      const file = new File([blob], "crop.jpg", { type: blob.type || "image/jpeg" });
      await handleUpload(source, file);
      setToast("已替换为处理后的图片");
    },
    [handleUpload],
  );

  /** Image-to-image with an explicit instruction (multi-angle, mask
   *  edit, and the default 图生图 button all share this path). */
  const handleVaryWith = useCallback(
    async (node: CanvasNode, instruction: string, titleSuffix: string) => {
      if (currentId == null) return;
      const fresh = graphRef.current.nodes.find((n) => n.id === node.id) ?? node;
      if (!fresh.url) return;
      patchNode(node.id, { status: "generating", error: "" });
      try {
        const imageBase64 = await blobUrlToJpegBase64(fresh.url);
        const res = await api.varyImage({
          projectId: currentId,
          nodeId: node.id,
          instruction,
          imageBase64,
          orientation: orientationOf(effectiveAspect(graphRef.current, fresh)),
        });
        const variant = makeNode("image", fresh.x, fresh.y + nodeHeight(fresh) + 36);
        variant.title = `${fresh.title} · ${titleSuffix}`.slice(0, 40);
        variant.text = fresh.text;
        variant.aspect = fresh.aspect;
        variant.duration = fresh.duration;
        variant.motion = fresh.motion;
        variant.blobKey = res.blob_key;
        variant.url = res.url;
        variant.groupId = fresh.groupId;
        setGraph((g) => ({
          ...g,
          nodes: [...g.nodes, variant],
          edges: [...g.edges, { id: uid("e"), from: fresh.id, to: variant.id }],
        }));
        patchNode(node.id, { status: "idle" });
        setSelectedId(variant.id);
        queryClient.invalidateQueries({ queryKey: ["generations", currentId] });
        setToast(`已生成「${titleSuffix}」新节点`);
      } catch (e) {
        patchNode(node.id, { status: "error", error: `生成失败：${errMsg(e)}` });
      }
    },
    [currentId, patchNode, queryClient, setSelectedId],
  );

  // ---- selection-aware assistant ------------------------------------------
  // The side assistant reads the current selection AND its upstream
  // nodes as context; replies can be inserted back onto the canvas as
  // new text nodes with one click.

  const assistantContext = useCallback((): string => {
    const g = graphRef.current;
    const ids = selectedIds.length > 0 ? selectedIds : selectedId ? [selectedId] : [];
    if (ids.length === 0) return "";
    const lines: string[] = [];
    const seen = new Set<string>();
    const describe = (n: CanvasNode, prefix: string) => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      const body = [n.text, n.caption ? `字幕：${n.caption}` : "", n.motionPrompt ? `运动：${n.motionPrompt}` : ""]
        .filter(Boolean)
        .join(" ")
        .slice(0, 300);
      lines.push(`${prefix}《${n.title}》${body ? `：${body}` : "（无文字内容）"}`);
    };
    for (const id of ids) {
      const n = g.nodes.find((x) => x.id === id);
      if (!n) continue;
      describe(n, "选中节点");
      for (const up of upstream(g, n.id)) describe(up, "其上游节点");
    }
    return lines.join("\n").slice(0, 3500);
  }, [selectedIds, selectedId]);

  const handleAssistantSend = useCallback(async () => {
    const msg = assistantInput.trim();
    if (!msg || assistantBusy) return;
    setAssistantLog((prev) => [...prev, { role: "user", text: msg }]);
    setAssistantInput("");
    setAssistantBusy(true);
    try {
      const res = await api.assistantChat({ message: msg, context: assistantContext() });
      setAssistantLog((prev) => [...prev, { role: "assistant", text: res.text }]);
    } catch (e) {
      setAssistantLog((prev) => [
        ...prev,
        { role: "assistant", text: `这次没答上来：${errMsg(e)}` },
      ]);
    } finally {
      setAssistantBusy(false);
    }
  }, [assistantInput, assistantBusy, assistantContext]);

  const insertAssistantText = useCallback(
    (text: string) => {
      const node = addNode("text");
      patchNode(node.id, { text, title: "助手插入" });
      setToast("已把助手回复插入画布为新节点");
    },
    [addNode, patchNode],
  );

  // ---- project import / export (backup & migration) ------------------------
  // Export packs the project JSON plus every node's media bytes into
  // one JSON file; import re-creates the project and re-uploads the
  // media as fresh owned assets. Chunked films (filmAssembly) cannot
  // travel in the package — their chunks belong to the source install —
  // so they are listed as skipped instead of silently producing a
  // broken node. This is project backup/migration only; it has nothing
  // to do with the film-generation flow.

  const handleExportProject = useCallback(async () => {
    if (currentId == null || transferBusy) return;
    setTransferBusy(true);
    try {
      const g = graphRef.current;
      const assets: Record<string, { mime: string; dataBase64: string }> = {};
      const skipped: string[] = [];
      for (const n of g.nodes) {
        if ((n.type === "image" || n.type === "video") && n.filmAssembly) {
          skipped.push(`${n.title}（分片成片不在导出包内）`);
          continue;
        }
        if ((n.type === "image" || n.type === "video") && n.url) {
          const res = await fetch(n.url);
          if (!res.ok) {
            skipped.push(n.title);
            continue;
          }
          const blob = await res.blob();
          const { dataBase64, mimeType } = await fileToBase64(
            new File([blob], "asset", { type: blob.type }),
          );
          assets[n.id] = {
            mime: mimeType || blob.type || "application/octet-stream",
            dataBase64,
          };
        }
      }
      const pkg = {
        format: "muse-canvas-project",
        version: 1,
        name: nameRef.current.trim() || "未命名项目",
        exportedAt: new Date().toISOString(),
        graph: g,
        assets,
      };
      const blob = new Blob([JSON.stringify(pkg)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${pkg.name}-项目包.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setToast(
        skipped.length > 0
          ? `项目包已导出（${skipped.length} 项未包含：${skipped.join("、")}）`
          : "项目包已导出：项目 JSON + 全部素材都在里面，可在项目列表里导入回来",
      );
    } catch (e) {
      setToast(`导出失败：${errMsg(e)}`);
    } finally {
      setTransferBusy(false);
    }
  }, [currentId, transferBusy]);

  const handleImportProject = useCallback(
    async (file: File) => {
      if (transferBusy) return;
      setTransferBusy(true);
      try {
        const pkg = JSON.parse(await file.text()) as {
          format?: string;
          name?: string;
          graph?: unknown;
          assets?: Record<string, { mime: string; dataBase64: string }>;
        };
        if (pkg.format !== "muse-canvas-project" || !pkg.graph) {
          setToast("这不是本工具导出的项目包文件");
          return;
        }
        const parsed = parseGraph(JSON.stringify(pkg.graph));
        const name = `${(pkg.name || "导入的项目").slice(0, 40)}（导入）`;
        const created = await api.createProject({ name });
        const assets = pkg.assets ?? {};
        for (const n of parsed.nodes) {
          const asset = assets[n.id];
          if (asset && (n.type === "image" || n.type === "video")) {
            const res = await api.uploadAsset({
              projectId: created.id,
              nodeId: n.id,
              kind: n.type === "video" ? "video" : "image",
              mime: asset.mime,
              dataBase64: asset.dataBase64,
            });
            n.blobKey = res.blob_key;
            n.url = res.url;
            n.filmAssembly = null;
          } else if (n.type === "image" || n.type === "video") {
            // No bytes in the package: the source install's URLs are
            // meaningless here, so the node starts empty, not broken.
            n.blobKey = "";
            n.url = "";
            n.filmAssembly = null;
          }
          n.status = "idle";
          n.error = "";
        }
        await api.saveProject({
          id: created.id,
          name,
          graph: JSON.stringify(parsed),
        });
        queryClient.invalidateQueries({ queryKey: ["projects"] });
        markProjectUnloaded();
        setCurrentId(created.id);
        setShowProjects(false);
        setToast(`项目「${name}」已导入`);
      } catch (e) {
        setToast(`导入失败：${errMsg(e)}`);
      } finally {
        setTransferBusy(false);
      }
    },
    [transferBusy, queryClient, markProjectUnloaded],
  );

  // ---- view helpers ---------------------------------------------------------

  const fitView = useCallback(() => {
    const g = graphRef.current;
    if (g.nodes.length === 0) {
      setViewport({ x: 40, y: 60, k: 0.85 });
      return;
    }
    setViewport(fitViewportForNodes(g.nodes, containerSize.w, containerSize.h));
  }, [containerSize, setViewport]);

  /** Camera focus: compute the viewport that centers a node in the
   *  current canvas size (keeping at least a readable zoom). Used by
   *  history locate, the selection toolbar, the node hover toolbar, and
   *  the automatic focus after the Agent finishes building a workflow. */
  const focusViewportForNode = useCallback(
    (node: CanvasNode, minK = 0.7) => {
      const k = clampK(Math.max(graphRef.current.viewport.k, minK));
      setViewport({
        k,
        x: containerSize.w / 2 - (node.x + nodeWidth(node) / 2) * k,
        y: containerSize.h / 2 - (node.y + nodeHeight(node) / 2) * k,
      });
      setSelectedId(node.id);
    },
    [containerSize, setViewport, setSelectedId],
  );

  const centerOnNode = focusViewportForNode;

  const zoomBy = useCallback(
    (factor: number) => {
      const vp = graphRef.current.viewport;
      const k = clampK(vp.k * factor);
      const cx = containerSize.w / 2;
      const cy = containerSize.h / 2;
      const w = screenToWorld(vp, cx, cy);
      setViewport({ k, x: cx - w.x * k, y: cy - w.y * k });
    },
    [containerSize, setViewport],
  );

  const resetZoom = useCallback(() => {
    const vp = graphRef.current.viewport;
    const cx = containerSize.w / 2;
    const cy = containerSize.h / 2;
    const w = screenToWorld(vp, cx, cy);
    setViewport({ k: 1, x: cx - w.x, y: cy - w.y });
  }, [containerSize, setViewport]);

  // When an Agent run finishes building (parks at awaiting_confirm) or
  // completes, fly the camera to the 成片 node so the user lands on the
  // result instead of wherever the canvas happened to be.
  const agentFocusKeyRef = useRef("");
  useEffect(() => {
    if (currentId == null) return;
    if (agentStatus !== "awaiting_confirm" && agentStatus !== "done") return;
    const key = `${currentId}|${agentStatus}`;
    if (agentFocusKeyRef.current === key) return;
    agentFocusKeyRef.current = key;
    const film = graphRef.current.nodes.find((n) => n.type === "video");
    if (film) focusViewportForNode(film, 0.5);
  }, [agentStatus, currentId, projectQuery.data, focusViewportForNode]);

  // ---- pointer handling -------------------------------------------------------

  const onBgPointerDown = (e: ReactPointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setMenu(null);
    // Link-in-progress + click on empty canvas: instead of silently
    // dropping the link, offer the create menu (the reference canvas
    // opens a create menu when a connection lands on empty space) —
    // pick a node type and it is created here AND wired from the source.
    if (linkFrom && e.button === 0 && pointersRef.current.size === 1) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const w = screenToWorld(
          graphRef.current.viewport,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
        setMenu({
          kind: "linkcreate",
          x: e.clientX,
          y: e.clientY,
          worldX: w.x,
          worldY: w.y,
        });
        return;
      }
    }
    const wantPan =
      e.button === 1 ||
      canvasTool === "pan" ||
      spacePanRef.current ||
      e.pointerType !== "mouse";
    if (!wantPan && e.pointerType === "mouse") {
      // Select tool: drag on empty canvas box-selects (Ctrl/Cmd/Shift
      // drag included); a modifier keeps the previous selection and
      // unions at the end.
      dragRef.current = {
        kind: "marquee",
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origX: 0,
        origY: 0,
        additive: e.shiftKey || e.ctrlKey || e.metaKey,
      };
      if (!dragRef.current.additive) {
        setSelectedId(null);
        setSelectedEdgeId(null);
      }
      return;
    }
    setSelectedId(null);
    setSelectedEdgeId(null);
    if (pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const a = pts[0] ?? { x: 0, y: 0 };
      const b = pts[1] ?? { x: 0, y: 0 };
      const rect = containerRef.current?.getBoundingClientRect();
      const midX = (a.x + b.x) / 2 - (rect?.left ?? 0);
      const midY = (a.y + b.y) / 2 - (rect?.top ?? 0);
      const vp = graphRef.current.viewport;
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        midX,
        midY,
        k: vp.k,
        vpX: vp.x,
        vpY: vp.y,
        worldX: (midX - vp.x) / vp.k,
        worldY: (midY - vp.y) / vp.k,
      };
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      kind: "pan",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: graphRef.current.viewport.x,
      origY: graphRef.current.viewport.y,
    };
  };

  const onBgPointerMove = (e: ReactPointerEvent) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    const drag0 = dragRef.current;
    if (drag0?.kind === "marquee" && drag0.pointerId === e.pointerId) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setMarquee({
          x: Math.min(drag0.startX, e.clientX) - rect.left,
          y: Math.min(drag0.startY, e.clientY) - rect.top,
          w: Math.abs(e.clientX - drag0.startX),
          h: Math.abs(e.clientY - drag0.startY),
        });
      }
      return;
    }
    if (pinchRef.current && pointersRef.current.size === 2) {
      const pts = [...pointersRef.current.values()];
      const a = pts[0] ?? { x: 0, y: 0 };
      const b = pts[1] ?? { x: 0, y: 0 };
      const rect = containerRef.current?.getBoundingClientRect();
      const midX = (a.x + b.x) / 2 - (rect?.left ?? 0);
      const midY = (a.y + b.y) / 2 - (rect?.top ?? 0);
      const start = pinchRef.current;
      const k = clampK(start.k * (Math.hypot(a.x - b.x, a.y - b.y) / start.dist || 1));
      setViewport({
        k,
        x: midX - start.worldX * k,
        y: midY - start.worldY * k,
      });
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.kind !== "pan" || drag.pointerId !== e.pointerId) return;
    const cx = e.clientX;
    const cy = e.clientY;
    queueMove(() => {
      setViewport({
        ...graphRef.current.viewport,
        x: drag.origX + (cx - drag.startX),
        y: drag.origY + (cy - drag.startY),
      });
    });
  };

  const onBgPointerUp = (e: ReactPointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    const drag = dragRef.current;
    if (drag?.kind === "marquee" && drag.pointerId === e.pointerId) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x1 = Math.min(drag.startX, e.clientX) - rect.left;
        const y1 = Math.min(drag.startY, e.clientY) - rect.top;
        const x2 = Math.max(drag.startX, e.clientX) - rect.left;
        const y2 = Math.max(drag.startY, e.clientY) - rect.top;
        const vp = graphRef.current.viewport;
        const wx1 = (x1 - vp.x) / vp.k;
        const wy1 = (y1 - vp.y) / vp.k;
        const wx2 = (x2 - vp.x) / vp.k;
        const wy2 = (y2 - vp.y) / vp.k;
        const hit = graphRef.current.nodes
          .filter(
            (n) =>
              !hiddenNodeIds.has(n.id) &&
              n.x + nodeWidth(n) > wx1 &&
              n.x < wx2 &&
              n.y + nodeHeight(n) > wy1 &&
              n.y < wy2,
          )
          .map((n) => n.id);
        setSelectedIds((prev) =>
          drag.additive ? [...new Set([...prev, ...hit])] : hit,
        );
      }
      setMarquee(null);
    }
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  const onNodeDragStart = (e: ReactPointerEvent, node: CanvasNode) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (node.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const origins = new Map<string, { x: number; y: number }>();
    if (node.type === "group") {
      // Dragging a group frame moves the frame AND all its members.
      origins.set(node.id, { x: node.x, y: node.y });
      for (const n of graphRef.current.nodes) {
        if (n.groupId === node.id && !n.locked) origins.set(n.id, { x: n.x, y: n.y });
      }
    } else {
      const ids = selectedIds.includes(node.id) ? selectedIds : [node.id];
      for (const n of graphRef.current.nodes) {
        if (ids.includes(n.id) && !n.locked && n.type !== "group") {
          origins.set(n.id, { x: n.x, y: n.y });
        }
      }
      if (!origins.has(node.id)) origins.set(node.id, { x: node.x, y: node.y });
    }
    dragRef.current = {
      kind: "node",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: node.x,
      origY: node.y,
      nodeId: node.id,
      origins,
    };
  };

  const onNodeDragMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "node" || drag.pointerId !== e.pointerId || !drag.nodeId)
      return;
    const cx = e.clientX;
    const cy = e.clientY;
    queueMove(() => {
      const k = graphRef.current.viewport.k;
      const dx = (cx - drag.startX) / k;
      const dy = (cy - drag.startY) / k;
      const origins = drag.origins;
      if (!origins || origins.size <= 1) {
        patchNode(drag.nodeId as string, { x: drag.origX + dx, y: drag.origY + dy });
        return;
      }
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          const o = origins.get(n.id);
          return o ? { ...n, x: o.x + dx, y: o.y + dy } : n;
        }),
      }));
    });
  };

  const onNodeDragEnd = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (drag?.pointerId === e.pointerId) {
      dragRef.current = null;
      // Dropping a node settles its group membership (join / leave /
      // re-wrap), mirroring the reference canvas's snap-into-group.
      if (drag.kind === "node" && drag.nodeId) {
        const dragged = graphRef.current.nodes.find((n) => n.id === drag.nodeId);
        if (dragged && dragged.type !== "group") settleGroupMembership(drag.nodeId);
      }
    }
  };

  // keyboard shortcuts (LibTV-style): undo/redo, copy/paste/duplicate,
  // select-all, delete, escape, fit view — ignored while typing in a field.
  // Backspace NEVER deletes a node or an edge: it is the key used to remove
  // a single character while writing prompts, captions and titles, so it is
  // left entirely to the text fields. Node/edge deletion is Delete-only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Editable detection covers the event target AND the focused element
      // (inputs, textareas, selects, contentEditable regions): while the
      // user is editing text, keys belong to the text, not to the canvas.
      const target = e.target instanceof HTMLElement ? e.target : null;
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const isEditable = (el: HTMLElement | null): boolean =>
        el != null &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      const typing = isEditable(target) || isEditable(active);
      if (e.key === "Escape") {
        setLinkFrom(null);
        setMenu(null);
        setShowHelp(false);
        if (!typing) setSelectedIds([]);
        return;
      }
      if (e.key === "Backspace") return;
      if (typing) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((mod && key === "z" && e.shiftKey) || (mod && key === "y")) {
        e.preventDefault();
        redo();
      } else if (mod && key === "a") {
        e.preventDefault();
        setSelectedIds(graphRef.current.nodes.map((n) => n.id));
      } else if (mod && key === "c") {
        copySelection();
      } else if (mod && key === "x") {
        copySelection();
        deleteSelected();
      } else if (mod && key === "v") {
        e.preventDefault();
        pasteClipboard();
      } else if (mod && key === "d") {
        e.preventDefault();
        copySelection();
        pasteClipboard(36, 36);
      } else if (mod && key === "s") {
        e.preventDefault();
        doSave();
      } else if (mod && key === "g" && e.shiftKey) {
        e.preventDefault();
        ungroupSelection();
      } else if (mod && key === "g") {
        e.preventDefault();
        groupSelection();
      } else if (e.key === "Delete") {
        if (selectedEdgeId) {
          setGraph((g) => ({
            ...g,
            edges: g.edges.filter((ed) => ed.id !== selectedEdgeId),
          }));
          setSelectedEdgeId(null);
        } else {
          deleteSelected();
        }
      } else if (key === "f") {
        fitView();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selectedEdgeId,
    deleteSelected,
    undo,
    redo,
    copySelection,
    pasteClipboard,
    doSave,
    fitView,
    groupSelection,
    ungroupSelection,
  ]);

  // Space (held) temporarily switches to the pan tool, like the
  // reference canvas — released, the previous tool returns. Ignored
  // while typing (space belongs to the text there).
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null): boolean =>
      el instanceof HTMLElement &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      spacePanRef.current = true;
      setSpacePanTick((t) => t + 1);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spacePanRef.current = false;
      setSpacePanTick((t) => t + 1);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ---- derived ----------------------------------------------------------------

  const vp = graph.viewport;
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );
  // Members of collapsed groups are hidden everywhere (canvas, marquee,
  // minimap) until the group is expanded again.
  const hiddenNodeIds = useMemo(() => {
    const collapsed = new Set(
      graph.nodes.filter((n) => n.type === "group" && n.collapsed).map((n) => n.id),
    );
    if (collapsed.size === 0) return new Set<string>();
    return new Set(
      graph.nodes.filter((n) => n.groupId && collapsed.has(n.groupId)).map((n) => n.id),
    );
  }, [graph.nodes]);
  const visibleNodes = useMemo(
    () => graph.nodes.filter((n) => !hiddenNodeIds.has(n.id)),
    [graph.nodes, hiddenNodeIds],
  );
  // Render order: group frames first (back), then normal nodes, with
  // selected nodes last (top) — NodeCard zIndex refines it further.
  const renderNodes = useMemo(() => {
    const groups = visibleNodes.filter((n) => n.type === "group");
    const rest = visibleNodes.filter((n) => n.type !== "group");
    return [...groups, ...rest];
  }, [visibleNodes]);
  // Minimap mirrors the reference canvas: a fixed 240×160 box; the
  // world bbox of ALL nodes is expanded by 500 units, then scaled to
  // fit; the viewport rect can be dragged to move around.
  const minimap = useMemo(() => {
    if (graph.nodes.length === 0) return null;
    const minX = Math.min(...graph.nodes.map((n) => n.x)) - 500;
    const minY = Math.min(...graph.nodes.map((n) => n.y)) - 500;
    const maxX = Math.max(...graph.nodes.map((n) => n.x + nodeWidth(n))) + 500;
    const maxY = Math.max(...graph.nodes.map((n) => n.y + nodeHeight(n))) + 500;
    const scale = Math.min(232 / (maxX - minX), 152 / (maxY - minY));
    return { minX, minY, scale };
  }, [graph.nodes]);
  const minimapDragRef = useRef(false);
  const minimapJump = useCallback(
    (clientX: number, clientY: number, rect: DOMRect) => {
      if (!minimap) return;
      const wx = minimap.minX + (clientX - rect.left - 4) / minimap.scale;
      const wy = minimap.minY + (clientY - rect.top - 4) / minimap.scale;
      const vpNow = graphRef.current.viewport;
      setViewport({
        k: vpNow.k,
        x: containerSize.w / 2 - wx * vpNow.k,
        y: containerSize.h / 2 - wy * vpNow.k,
      });
    },
    [minimap, containerSize, setViewport],
  );

  // The overlay shows only while the current project's data is truly
  // not on hand. It keys off reactive state (loadedId) — never a ref —
  // and data already fetched for this project counts as open even in
  // the brief moment before the load effect applies it, so no
  // background refresh can ever strand this overlay over a loaded
  // canvas again.
  const loading =
    currentId == null ||
    (loadedId !== currentId && projectQuery.data?.id !== currentId);

  // ---- render -------------------------------------------------------------------

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      {/* top bar */}
      <header className="z-20 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 pt-safe">
        <button
          type="button"
          className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm"
          aria-label="打开项目列表"
          onClick={() => setShowProjects(true)}
        >
          ▦ 项目
        </button>
        <input
          aria-label="项目名称"
          title={projectName}
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          onBlur={doSave}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 font-[family-name:var(--font-display)] text-base font-bold sm:max-w-56"
        />
        <span className="hidden text-[11px] text-[var(--dim)] sm:inline" role="status">
          {saveState === "saving"
            ? "保存中…"
            : saveState === "dirty"
              ? "有未保存更改"
              : "已保存"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-md border border-[var(--border)] px-2 py-1.5 text-sm disabled:opacity-40"
              aria-label="撤销"
              title="撤销 (Ctrl+Z)"
              disabled={!histState.canUndo}
              onClick={undo}
            >
              ↩
            </button>
            <button
              type="button"
              className="rounded-md border border-[var(--border)] px-2 py-1.5 text-sm disabled:opacity-40"
              aria-label="重做"
              title="重做 (Ctrl+Shift+Z)"
              disabled={!histState.canRedo}
              onClick={redo}
            >
              ↪
            </button>
            <button
              type="button"
              className="hidden rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm sm:block"
              aria-label="整理画布"
              title="按连线顺序自动排列节点"
              onClick={autoLayout}
            >
              整理
            </button>
          </div>
          <button
            type="button"
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            aria-label="Agent 一句话成片：一句话让 Agent 自动搭工作流、写剧本、分镜、生视频、配乐并返回成品"
            disabled={agentStarting}
            onClick={() => setShowAgentPanel(true)}
          >
            {agentStarting ? "Agent 制作中…" : "✦ Agent 一句话成片"}
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[var(--accent)] disabled:opacity-50"
            disabled={runningAll}
            onClick={() => void handleRunAll()}
          >
            {runningAll ? "运行中…" : "▶ 运行全部"}
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50 ${filmIsStalled ? "bg-[var(--accent)] text-white" : "bg-[var(--cyan)] text-black"}`}
            aria-label={filmIsStalled ? "成片生成已卡住，结束并重新生成" : "生成并合成成片"}
            disabled={(filmBusy && !filmIsStalled) || filmRequesting || filmCancelling}
            onClick={() => void (filmIsStalled ? handleRestartFilm() : handleRequestFilm())}
          >
            {filmCancelling
              ? "正在结束…"
              : filmIsStalled
                ? "已卡住 · 结束并重新生成"
                : filmBusy || filmRequesting
                  ? filmTotal > 0
                    ? `生成中 ${filmDoneShots}/${filmTotal}`
                    : "成片生成中…"
                  : "🎬 生成并合成成片"}
          </button>
          <button
            type="button"
            className={`rounded-md border px-2.5 py-1.5 text-sm ${showAssistant ? "border-[var(--cyan)] text-[var(--cyan)]" : "border-[var(--border)]"}`}
            aria-label="打开画布助手（读取当前选区及上游节点作为上下文）"
            aria-pressed={showAssistant}
            onClick={() => setShowAssistant((s) => !s)}
          >
            助手
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm"
            aria-label="打开生成历史"
            onClick={() => setShowHistory(true)}
          >
            历史
          </button>
        </div>
      </header>

      {/* film generation status banner */}
      {(filmBusy || filmStatus === "done" || filmStatus === "failed") && (
        <div
          role="status"
          className="z-20 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs"
        >
          {filmBusy && (
            <>
              <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${filmIsStalled ? "bg-[var(--accent)]" : "generating-glow bg-[var(--cyan)]"}`} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {filmIsStalled ? (
                  <span className="text-[#ff7a5c]">
                    <strong>可能卡住了：</strong>已经 {filmSinceUpdateLabel} 没有任何新进度
                    {filmTotal > 0 ? `（镜头进度停在 ${filmDoneShots}/${filmTotal}` : ""}
                    {Number.isFinite(filmCreatedMs) ? `，总共已等了 ${filmElapsedLabel}` : ""}）。
                    后台任务可能已中断，不用继续等——点右边「结束并重新生成」就会结束这次并立刻重开一次；只想结束不重开，点「结束这次生成」。如果一直不处理，超过 {filmStage.includes("保存") ? 30 : 15} 分钟无进度系统也会自动结束它。
                  </span>
                ) : (
                  <span>
                    成片生成中：{filmStageLabel}
                    {filmTotal > 0 ? ` · 镜头进度 ${filmDoneShots}/${filmTotal}` : ""}
                    {Number.isFinite(filmCreatedMs) ? ` · 已用时 ${filmElapsedLabel}` : ""}
                    。这一步在后台进行，通常要几分钟，你可以继续编辑画布——成片好了会自动存回成片节点，不用你做任何事。
                  </span>
                )}
                {filmDoneShots > 0 ? (
                  <div
                    className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-[var(--border)]"
                    role="progressbar"
                    aria-label="成片生成进度"
                    aria-valuemin={0}
                    aria-valuemax={filmTotal}
                    aria-valuenow={filmDoneShots}
                  >
                    <div
                      className="h-full rounded-full bg-[var(--cyan)] transition-[width] duration-700"
                      style={{ width: `${filmPct}%` }}
                    />
                  </div>
                ) : (
                  <div
                    className="relative h-1.5 w-full max-w-md overflow-hidden rounded-full bg-[var(--border)]"
                    role="progressbar"
                    aria-label="成片生成进度"
                  >
                    <div
                      className="film-progress-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-[var(--cyan)]"
                      aria-hidden
                    />
                  </div>
                )}
                {filmDoneShots > 0 && (
                  <span className="text-[11px] text-[var(--dim)]">
                    已完成 {filmDoneShots} / {filmTotal} 个镜头 · {filmPct}%
                  </span>
                )}
                {!filmIsStalled && (
                  <span className="text-[11px] text-[var(--dim)]">
                    上次进度更新于 {filmSinceUpdateLabel} 前 · 若长时间没有新进度，这里会提示可能卡住并给出结束入口（保存成片是分片上传，每存好一片都会报一次进度）
                  </span>
                )}
              </div>
              {filmIsStalled ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md bg-[var(--accent)] px-2.5 py-1.5 font-medium text-white disabled:opacity-50"
                    aria-label="结束这次生成并重新生成成片"
                    disabled={filmCancelling || filmRequesting}
                    onClick={() => void handleRestartFilm()}
                  >
                    {filmCancelling ? "正在结束…" : "结束并重新生成"}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border)] px-2.5 py-1.5 font-medium disabled:opacity-50"
                    aria-label="结束这次成片生成"
                    disabled={filmCancelling || filmRequesting}
                    onClick={() => void handleCancelFilm()}
                  >
                    结束这次生成
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] text-[var(--dim)] underline disabled:opacity-50"
                  aria-label="结束这次成片生成"
                  disabled={filmCancelling}
                  onClick={() => void handleCancelFilm()}
                >
                  结束这次生成
                </button>
              )}
            </>
          )}
          {filmStatus === "done" &&
          filmQuery.data &&
          ((filmQuery.data.film_url !== "" &&
            filmQuery.data.film_url === brokenFilmUrl) ||
            (filmQuery.data.film_chunked &&
              brokenFilmUrl === `assembly:${filmQuery.data.request_id}`)) ? (
            <>
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--accent)]" aria-hidden />
              <span className="text-[#ff7a5c]">
                存回工具的这份成片文件已损坏（保存时传输不完整），无法播放，下载下来也打不开。重新生成一份即可，新的保存会先校验文件完整再存入。
              </span>
              <button
                type="button"
                className="rounded-md border border-[var(--cyan)] px-2 py-1 font-medium text-[var(--cyan)] disabled:opacity-50"
                disabled={filmRequesting}
                onClick={() => void handleRequestFilm()}
              >
                重新生成
              </button>
            </>
          ) : filmStatus === "done" ? (
            <>
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--ok)]" aria-hidden />
              <span>
                成片已生成并存回工具：在成片节点里可以直接播放，也在「历史」里留了一份。
              </span>
              {filmQuery.data?.film_url && (
                <a
                  href={filmQuery.data.film_url}
                  download="成片.mp4"
                  className="font-medium text-[var(--cyan)]"
                  aria-label="下载成片"
                >
                  下载成片
                </a>
              )}
              {filmQuery.data?.film_chunked && filmQuery.data.request_id != null && (
                <button
                  type="button"
                  className="font-medium text-[var(--cyan)] disabled:opacity-50"
                  aria-label="下载成片"
                  disabled={bannerDownloading}
                  onClick={() => {
                    const reqId = filmQuery.data?.request_id;
                    if (reqId == null) return;
                    setBannerDownloading(true);
                    downloadAssembledFilm(reqId, "成片.mp4")
                      .catch((e: unknown) =>
                        setToast(
                          `下载成片失败：${e instanceof Error ? e.message : String(e)}`,
                        ),
                      )
                      .finally(() => setBannerDownloading(false));
                  }}
                >
                  {bannerDownloading ? "正在拼装校验…" : "下载成片"}
                </button>
              )}
            </>
          ) : null}
          {filmStatus === "failed" && (
            <>
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--accent)]" aria-hidden />
              <span className="text-[#ff7a5c]">
                上次成片生成没有完成
                {filmQuery.data?.error ? `：${filmQuery.data.error}` : ""}。
              </span>
              <button
                type="button"
                className="rounded-md border border-[var(--cyan)] px-2 py-1 font-medium text-[var(--cyan)] disabled:opacity-50"
                disabled={filmRequesting}
                onClick={() => void handleRequestFilm()}
              >
                重新生成
              </button>
            </>
          )}
        </div>
      )}

      {/* Agent 一句话成片 status banner */}
      {(agentActive || agentStatus === "awaiting_confirm" || agentStatus === "failed" || agentStatus === "cancelled") && (
        <div
          role="status"
          className="z-20 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs"
        >
          <span
            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${agentStatus === "awaiting_confirm" ? "bg-[#f5b83d]" : agentStatus === "failed" ? "bg-[var(--accent)]" : agentStatus === "cancelled" ? "bg-[var(--dim)]" : "generating-glow bg-[var(--accent)]"}`}
            aria-hidden
          />
          {agentActive && (
            <>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {agentIsStalled ? (
                  <span className="text-[#ff7a5c]">
                    <strong>可能卡住了：</strong>自动制作已经 {agentSinceUpdateLabel} 没有任何新进度
                    {agentTotal > 0 && agentBuilding ? `（进度停在 ${agentDone}/${agentTotal}` : ""}
                    {Number.isFinite(agentCreatedMs) ? `，总共已等了 ${agentElapsedLabel}` : ""}）。
                    后台可能已中断，不用继续等——点「结束这次制作」即可结束，画布上的工作流和已生成分镜都会保留；超过 15 分钟无进度系统也会自动结束。
                  </span>
                ) : (
                  <span>
                    Agent 自动制作中：{agentStageLabel}
                    {agentBuilding && agentTotal > 0 ? ` · 分镜图 ${agentDone}/${agentTotal}` : ""}
                    {!agentBuilding && agentTotal > 0 ? ` · 镜头 ${agentDone}/${agentTotal}` : ""}
                    {Number.isFinite(agentCreatedMs) ? ` · 已用时 ${agentElapsedLabel}` : ""}
                    。工作流会直接搭在画布上（创意 → 分镜脚本 → 资产定版 → 逐镜分镜图 → 成片），每一步都能看见、能改。
                  </span>
                )}
                {agentTotal > 0 && agentDone > 0 ? (
                  <div
                    className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-[var(--border)]"
                    role="progressbar"
                    aria-label="Agent 自动制作进度"
                    aria-valuemin={0}
                    aria-valuemax={agentTotal}
                    aria-valuenow={agentDone}
                  >
                    <div
                      className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-700"
                      style={{ width: `${agentPct}%` }}
                    />
                  </div>
                ) : agentBuilding ? (
                  <div
                    className="relative h-1.5 w-full max-w-md overflow-hidden rounded-full bg-[var(--border)]"
                    role="progressbar"
                    aria-label="Agent 自动制作进度"
                  >
                    <div className="film-progress-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-[var(--accent)]" aria-hidden />
                  </div>
                ) : null}
                {!agentIsStalled && (
                  <span className="text-[11px] text-[var(--dim)]">
                    上次进度更新于 {agentSinceUpdateLabel} 前
                  </span>
                )}
              </div>
              <button
                type="button"
                className="shrink-0 rounded-md border border-[var(--border)] px-2.5 py-1.5 font-medium disabled:opacity-50"
                aria-label="结束这次自动制作"
                disabled={agentCancelling}
                onClick={() => void handleCancelAgent()}
              >
                {agentCancelling ? "正在结束…" : "结束这次制作"}
              </button>
            </>
          )}
          {agentStatus === "awaiting_confirm" && (
            <>
              <span className="min-w-0 flex-1">
                <strong>分镜已就绪，等你确认。</strong>
                {agentQuery.data?.error
                  ? ` ${agentQuery.data.error}。`
                  : " 画布上的脚本、资产定版和每个镜头的提示词/运动提示词/字幕/时长都可以任意修改，改完点「继续生成成片」，会按画布当前状态重新收集镜头再进入成片阶段。"}
              </span>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-md bg-[var(--cyan)] px-2.5 py-1.5 font-semibold text-black disabled:opacity-50"
                  aria-label="继续生成成片"
                  disabled={agentContinuing || filmBusy}
                  onClick={() => void handleContinueAgent("film")}
                >
                  {agentContinuing ? "正在开始…" : "继续生成成片 →"}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-[var(--border)] px-2.5 py-1.5 font-medium disabled:opacity-50"
                  aria-label="重新生成分镜图"
                  disabled={agentContinuing}
                  onClick={() => void handleContinueAgent("storyboard")}
                >
                  重新生成分镜
                </button>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] text-[var(--dim)] underline disabled:opacity-50"
                  aria-label="结束这次自动制作"
                  disabled={agentCancelling}
                  onClick={() => void handleCancelAgent()}
                >
                  结束这次制作
                </button>
              </div>
            </>
          )}
          {agentStatus === "failed" && (
            <>
              <span className="min-w-0 flex-1 text-[#ff7a5c]">
                上次自动制作没有完成{agentQuery.data?.error ? `：${agentQuery.data.error}` : ""}。画布上的工作流和已生成内容都保留着。
              </span>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-md border border-[var(--cyan)] px-2.5 py-1.5 font-medium text-[var(--cyan)] disabled:opacity-50"
                  aria-label="重新生成分镜图"
                  disabled={agentContinuing}
                  onClick={() => void handleContinueAgent("storyboard")}
                >
                  重新生成分镜
                </button>
                <button
                  type="button"
                  className="rounded-md border border-[var(--border)] px-2.5 py-1.5 font-medium disabled:opacity-50"
                  aria-label="继续生成成片"
                  disabled={agentContinuing || filmBusy}
                  onClick={() => void handleContinueAgent("film")}
                >
                  继续生成成片
                </button>
              </div>
            </>
          )}
          {agentStatus === "cancelled" && (
            <span className="min-w-0 flex-1 text-[var(--dim)]">
              这次自动制作已结束。画布上的工作流和分镜都保留着，可以手动继续编辑，或在成片节点点「生成并合成成片」。
            </span>
          )}
        </div>
      )}

      {/* canvas */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        <div
          className={`absolute inset-0 ${graph.backgroundMode === "lines" ? "canvas-lines" : graph.backgroundMode === "blank" ? "canvas-blank" : "canvas-dots"} ${canvasTool === "pan" || spacePanRef.current ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
          style={{ touchAction: "none" }}
          role="application"
          aria-label="无限画布：选择工具下拖动框选，抓手工具或按住空格拖动平移，双击添加提示词节点"
          onPointerDown={onBgPointerDown}
          onPointerMove={onBgPointerMove}
          onPointerUp={onBgPointerUp}
          onPointerCancel={onBgPointerUp}
          onContextMenu={(e) => {
            e.preventDefault();
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            setMenu({
              kind: "canvas",
              x: e.clientX,
              y: e.clientY,
              worldX: (e.clientX - rect.left - vp.x) / vp.k,
              worldY: (e.clientY - rect.top - vp.y) / vp.k,
            });
          }}
          onDoubleClick={(e) => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const wx = (e.clientX - rect.left - vp.x) / vp.k;
            const wy = (e.clientY - rect.top - vp.y) / vp.k;
            const node = makeNode("text", wx - NODE_W / 2, wy - 40);
            setGraph((g) => ({ ...g, nodes: [...g.nodes, node] }));
            setSelectedId(node.id);
          }}
        />
        {/* world layer */}
        <div
          className="pointer-events-none absolute left-0 top-0"
          data-canvas-world=""
          style={{
            transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.k})`,
            transformOrigin: "0 0",
            width: 0,
            height: 0,
          }}
        >
          <svg
            className="absolute overflow-visible"
            style={{
              left: -WORLD_OFF,
              top: -WORLD_OFF,
              width: WORLD_OFF * 2,
              height: WORLD_OFF * 2,
            }}
            aria-hidden
          >
            {graph.edges.map((edge) => {
              const a = nodeById.get(edge.from);
              const b = nodeById.get(edge.to);
              if (!a || !b) return null;
              if (hiddenNodeIds.has(a.id) || hiddenNodeIds.has(b.id)) return null;
              const x1 = a.x + nodeWidth(a) + WORLD_OFF;
              const y1 = a.y + 24 + WORLD_OFF;
              const x2 = b.x + WORLD_OFF;
              const y2 = b.y + 24 + WORLD_OFF;
              // Cubic Bézier with curvature max(dx × 0.5, 50), plus a
              // 16px transparent hit path so thin lines stay clickable.
              const curve = Math.max(Math.abs(x2 - x1) * 0.5, 50);
              const d = `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
              const active =
                b.status === "generating" || selectedEdgeId === edge.id;
              return (
                <g key={edge.id} data-connection-id={edge.id}>
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    style={{ pointerEvents: "auto", cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedEdgeId(edge.id);
                    }}
                  >
                    <title>连线，点击选中后可删除</title>
                  </path>
                  <path
                    d={d}
                    fill="none"
                    stroke={
                      selectedEdgeId === edge.id
                        ? "var(--accent)"
                        : active
                          ? "var(--cyan)"
                          : "var(--dim)"
                    }
                    strokeWidth={selectedEdgeId === edge.id ? 3 : 2}
                    className={active && selectedEdgeId !== edge.id ? "edge-flow" : undefined}
                    style={{ pointerEvents: "none" }}
                  />
                </g>
              );
            })}
          </svg>
          {renderNodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={selectedIds.includes(node.id)}
              isLinkSource={linkFrom === node.id}
              linkMode={linkFrom != null}
              packageShots={node.type === "video" ? packageShotsOf(node) : []}
              memberCount={node.type === "group" ? groupMembers(graph, node.id).length : 0}
              inheritsConfig={configOf(graph, node.id) != null}
              enhancing={enhancingId === node.id}
              onPatch={patchNode}
              onSelect={handleSelect}
              onDelete={deleteNode}
              onDuplicate={duplicateNode}
              onDragStart={onNodeDragStart}
              onDragMove={onNodeDragMove}
              onDragEnd={onNodeDragEnd}
              onStartLink={(id) =>
                setLinkFrom((cur) => (cur === id ? null : id))
              }
              onCardClick={completeLink}
              onGenerate={(n) => void handleGenerate(n)}
              onGenerateText={(n, m) => void handleGenerateText(n, m)}
              onSplitStoryboard={handleSplitStoryboard}
              onVary={(n) => void handleVary(n)}
              onRetrySnapshot={(n) => void handleRetrySnapshot(n)}
              onFocusNode={(n) => focusViewportForNode(n)}
              onImageTool={(n, tool) => setImageTool({ node: n, tool })}
              onUngroup={(n) => ungroupNode(n)}
              filmBusy={filmBusy || filmRequesting}
              filmStatus={filmStatus}
              filmDone={filmDoneShots}
              filmTotal={filmTotal}
              filmStage={filmStageLabel}
              filmElapsed={Number.isFinite(filmCreatedMs) ? filmElapsedLabel : ""}
              filmStalled={filmIsStalled}
              filmSinceUpdate={filmSinceUpdateLabel}
              onCancelFilm={() => void handleCancelFilm()}
              onRestartFilm={(n) => void handleRestartFilm(n)}
              onVideoBroken={(url) => setBrokenFilmUrl(url)}
              onRequestFilm={(n) => void handleRequestFilm(n)}
              agentAwaiting={agentStatus === "awaiting_confirm"}
              agentContinuing={agentContinuing}
              onAgentContinue={() => void handleContinueAgent("film")}
              onAgentRestoryboard={() => void handleContinueAgent("storyboard")}
              onUpload={(n, f) => void handleUpload(n, f)}
              onNodeMenu={(n, x, y) => setMenu({ kind: "node", x, y, nodeId: n.id })}
            />
          ))}
        </div>

        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg)]/70">
            <p className="text-sm text-[var(--dim)]">正在打开画布…</p>
          </div>
        )}

        {linkFrom && (
          <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-[var(--cyan)] px-3 py-1.5 text-xs font-semibold text-black shadow">
            连线中：点击任意节点完成连线，点空白处取消
          </div>
        )}

        {selectedEdgeId && (
          <button
            type="button"
            className="absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-white shadow"
            onClick={() => {
              setGraph((g) => ({
                ...g,
                edges: g.edges.filter((e) => e.id !== selectedEdgeId),
              }));
              setSelectedEdgeId(null);
            }}
          >
            删除所选连线
          </button>
        )}

        {marquee && (
          <div
            className="pointer-events-none absolute z-10 border border-[var(--cyan)] bg-[var(--cyan)]/10"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            aria-hidden
          />
        )}

        {selectedIds.length >= 2 && (
          <div
            className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 shadow-lg"
            role="toolbar"
            aria-label="多选节点对齐工具"
          >
            <span className="px-1 text-[11px] text-[var(--dim)]">
              已选 {selectedIds.length} 个
            </span>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
              aria-label="把所选节点成组"
              onClick={groupSelection}
            >
              成组
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
              aria-label="解组所选节点"
              onClick={ungroupSelection}
            >
              解组
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
              aria-label="定位到所选节点"
              onClick={() => {
                const first = graphRef.current.nodes.find((n) => n.id === selectedIds[0]);
                if (first) focusViewportForNode(first);
              }}
            >
              ◎ 定位
            </button>
            {(
              [
                ["left", "左对齐"],
                ["centerX", "水平居中"],
                ["right", "右对齐"],
                ["top", "顶对齐"],
                ["centerY", "垂直居中"],
                ["bottom", "底对齐"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
                aria-label={label}
                onClick={() => alignSelected(mode)}
              >
                {label}
              </button>
            ))}
            {selectedIds.length >= 3 && (
              <>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
                  aria-label="水平分布"
                  onClick={() => distributeSelected("x")}
                >
                  水平分布
                </button>
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
                  aria-label="垂直分布"
                  onClick={() => distributeSelected("y")}
                >
                  垂直分布
                </button>
              </>
            )}
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--surface-2)]"
              aria-label="删除所选节点"
              onClick={deleteSelected}
            >
              删除所选
            </button>
          </div>
        )}

        {menu && (
          <>
            <button
              type="button"
              aria-label="关闭菜单"
              className="fixed inset-0 z-30 cursor-default"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            />
            <div
              className="fixed z-40 w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
              style={{
                left: Math.min(menu.x, window.innerWidth - 220),
                top: Math.min(menu.y, window.innerHeight - 340),
              }}
              role="menu"
              aria-label={menu.kind === "canvas" ? "画布菜单" : "节点菜单"}
            >
              {menu.kind === "canvas" && (
                <>
                  {(
                    [
                      ["text", "在此添加提示词节点"],
                      ["image", "在此添加分镜图节点"],
                      ["video", "在此添加成片节点"],
                      ["config", "在此添加生成配置节点"],
                      ["group", "在此添加空分组"],
                    ] as [NodeType, string][]
                  ).map(([t, label]) => (
                    <button
                      key={t}
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                      onClick={() => {
                        const n = makeNode(t, menu.worldX - NODE_W / 2, menu.worldY - 30);
                        if (t === "group") {
                          n.w = 380;
                          n.h = 260;
                        }
                        setGraph((g) => ({ ...g, nodes: [...g.nodes, n] }));
                        setSelectedId(n.id);
                        setMenu(null);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                    onClick={() => {
                      pasteClipboard(0, 0, { x: menu.worldX, y: menu.worldY });
                      setMenu(null);
                    }}
                  >
                    在此粘贴节点
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                    onClick={() => {
                      autoLayout();
                      setMenu(null);
                    }}
                  >
                    整理画布（自动排列）
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                    onClick={() => {
                      fitView();
                      setMenu(null);
                    }}
                  >
                    适应全部节点
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                    onClick={() => {
                      setMenu(null);
                      void handleRunAll();
                    }}
                  >
                    运行全部节点
                  </button>
                </>
              )}
              {menu.kind === "linkcreate" && (
                <>
                  <p className="px-3 py-2 text-[11px] text-[var(--dim)]">
                    连线落在这里：选一个节点类型，新建并自动连好
                  </p>
                  {(
                    [
                      ["text", "新建提示词节点并连线"],
                      ["image", "新建分镜图节点并连线"],
                      ["video", "新建成片节点并连线"],
                      ["config", "新建生成配置节点并连线"],
                    ] as [NodeType, string][]
                  ).map(([t, label]) => (
                    <button
                      key={t}
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                      onClick={() => {
                        const n = makeNode(t, menu.worldX - NODE_W / 2, menu.worldY - 30);
                        setGraph((g) => {
                          const nodes = [...g.nodes, n];
                          const edges =
                            linkFrom && canConnect({ ...g, nodes }, linkFrom, n.id)
                              ? [...g.edges, { id: uid("e"), from: linkFrom, to: n.id }]
                              : g.edges;
                          return { ...g, nodes, edges };
                        });
                        setLinkFrom(null);
                        setSelectedId(n.id);
                        setMenu(null);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left text-sm text-[var(--dim)] hover:bg-[var(--surface-2)]"
                    onClick={() => {
                      setLinkFrom(null);
                      setMenu(null);
                    }}
                  >
                    取消连线
                  </button>
                </>
              )}
              {menu.kind === "node" &&
                (() => {
                  const n = graph.nodes.find((x) => x.id === menu.nodeId);
                  if (!n) return null;
                  return (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                        onClick={() => {
                          setMenu(null);
                          focusViewportForNode(n);
                        }}
                      >
                        ◎ 定位到此节点
                      </button>
                      {n.type === "group" && (
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                          onClick={() => {
                            ungroupNode(n);
                            setMenu(null);
                          }}
                        >
                          解组（保留组内节点）
                        </button>
                      )}
                      {n.type === "image" && n.snapshot && (
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                          onClick={() => {
                            setMenu(null);
                            void handleRetrySnapshot(n);
                          }}
                        >
                          ⤺ 按上次参数原样重试
                        </button>
                      )}
                      {n.type === "image" &&
                        (() => {
                          const src = upstream(graph, n.id).find(
                            (u) => u.type === "image" && u.url,
                          );
                          if (!src) return null;
                          return (
                            <button
                              type="button"
                              role="menuitem"
                              className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                              onClick={() => {
                                setMenu(null);
                                focusViewportForNode(src);
                              }}
                            >
                              定位源图节点（{src.title}）
                            </button>
                          );
                        })()}
                      {n.type === "image" && (
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                          onClick={() => {
                            setMenu(null);
                            void handleGenerate(n);
                          }}
                        >
                          {n.url ? "重新生成图片" : "生成图片"}
                        </button>
                      )}
                      {n.type === "image" && n.url && (
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                          onClick={() => {
                            setMenu(null);
                            void handleVary(n);
                          }}
                        >
                          图生图变体
                        </button>
                      )}
                      {n.type === "video" && (
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)] disabled:opacity-50"
                          disabled={filmBusy || filmRequesting}
                          onClick={() => {
                            setMenu(null);
                            void handleRequestFilm(n);
                          }}
                        >
                          {filmBusy || filmRequesting ? "成片生成中…" : "生成并合成成片"}
                        </button>
                      )}
                      {n.type === "text" && (
                        <button
                          type="button"
                          role="menuitem"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                          onClick={() => {
                            setMenu(null);
                            void handleGenerateText(n, "expand");
                          }}
                        >
                          AI 扩写提示词
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                        onClick={() => {
                          setMenu(null);
                          setLinkFrom(n.id);
                        }}
                      >
                        从此节点连线…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                        onClick={() => {
                          duplicateNode(n.id);
                          setMenu(null);
                        }}
                      >
                        复制节点
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--surface-2)]"
                        onClick={() => {
                          patchNode(n.id, { locked: !n.locked });
                          setMenu(null);
                        }}
                      >
                        {n.locked ? "解锁节点" : "锁定节点位置"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="block w-full px-3 py-2 text-left text-sm text-[var(--accent)] hover:bg-[var(--surface-2)]"
                        onClick={() => {
                          deleteNode(n.id);
                          setMenu(null);
                        }}
                      >
                        删除节点
                      </button>
                    </>
                  );
                })()}
            </div>
          </>
        )}

        {showHelp && (
          <div
            className="absolute bottom-24 right-3 z-20 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl sm:bottom-28"
            role="dialog"
            aria-label="快捷键帮助"
            data-canvas-no-zoom=""
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">操作与快捷键</h3>
              <button
                type="button"
                aria-label="关闭快捷键帮助"
                className="text-[var(--dim)]"
                onClick={() => setShowHelp(false)}
              >
                ✕
              </button>
            </div>
            <ul className="space-y-1.5 text-xs leading-relaxed text-[var(--dim)]">
              <li>选择工具拖动框选 · 抓手工具/按住空格/中键拖动平移 · 滚轮以鼠标为锚缩放（5%–500%）· 双指缩放</li>
              <li>Shift/Ctrl/⌘+点选 加减选 · 框选可叠加 · 多选可整组拖动</li>
              <li>Ctrl/⌘+G 成组 · Ctrl/⌘+Shift+G 解组 · 节点拖进/拖出分组框自动加入/离开</li>
              <li>右键画布/节点 打开菜单 · 双击节点标题 重命名 · 双击空白加提示词节点</li>
              <li>Ctrl/⌘+Z 撤销 · Ctrl/⌘+Shift+Z 重做（历史上限 50 步）</li>
              <li>Ctrl/⌘+C 复制 · Ctrl/⌘+V 粘贴 · Ctrl/⌘+D 再制 · Ctrl/⌘+X 剪切</li>
              <li>Ctrl/⌘+A 全选 · Delete 删除所选 · Esc 取消选择/连线</li>
              <li>Backspace 只删文字，不删节点（删节点用 Delete 或节点上的 ✕）</li>
              <li>Ctrl/⌘+S 保存 · F 适应全部节点</li>
              <li>点节点右侧圆点开始连线，再点目标节点完成；连线中点空白处可选新建节点并连线；点连线可选中删除</li>
              <li>生成配置节点连到分镜图：画幅/画质/风格全组统一；每次生成都会存参数快照，可「原样重试」</li>
            </ul>
          </div>
        )}

        {/* bottom dock toolbar (mirrors the reference canvas dock):
            tool toggle, undo/redo, focus, create nodes, upload,
            appearance, delete selection, clear canvas */}
        <div className="absolute bottom-4 left-3 z-10 max-w-[calc(100vw-24px)]">
          <div
            className="flex items-center gap-1 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-lg [&>*]:shrink-0"
            role="toolbar"
            aria-label="画布工具栏"
          >
            <button
              type="button"
              aria-label={canvasTool === "select" ? "当前选择工具，点击切换为抓手平移" : "当前抓手工具，点击切换为选择工具"}
              title={canvasTool === "select" ? "选择工具（拖动框选）· 点此切抓手" : "抓手工具（拖动平移）· 点此切选择"}
              aria-pressed={canvasTool === "pan"}
              className={`rounded-lg px-2.5 py-2 text-xs font-medium ${canvasTool === "pan" ? "bg-[var(--surface-2)] text-[var(--cyan)]" : "hover:bg-[var(--surface-2)]"}`}
              onClick={() => setCanvasTool((t) => (t === "select" ? "pan" : "select"))}
            >
              {canvasTool === "select" ? "➤ 选择" : "✋ 抓手"}
            </button>
            <button
              type="button"
              aria-label="撤销"
              title="撤销 (Ctrl+Z)"
              disabled={!histState.canUndo}
              className="rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--surface-2)] disabled:opacity-40"
              onClick={undo}
            >
              ↩
            </button>
            <button
              type="button"
              aria-label="重做"
              title="重做 (Ctrl+Shift+Z)"
              disabled={!histState.canRedo}
              className="rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--surface-2)] disabled:opacity-40"
              onClick={redo}
            >
              ↪
            </button>
            <button
              type="button"
              aria-label="定位到所选节点"
              title="把视角聚焦到所选节点"
              disabled={selectedIds.length === 0}
              className="rounded-lg px-2.5 py-2 text-xs hover:bg-[var(--surface-2)] disabled:opacity-40"
              onClick={() => {
                const first = graphRef.current.nodes.find((n) => n.id === selectedIds[0]);
                if (first) focusViewportForNode(first);
              }}
            >
              ◎
            </button>
            <span className="mx-0.5 h-6 w-px bg-[var(--border)]" aria-hidden />
            <button
              type="button"
              aria-label="添加提示词节点"
              className="rounded-lg px-2.5 py-2 text-xs font-medium hover:bg-[var(--surface-2)]"
              onClick={() => addNode("text")}
            >
              <span style={{ color: "#f5b83d" }}>✎</span> 提示词
            </button>
            <button
              type="button"
              aria-label="添加分镜图节点"
              className="rounded-lg px-2.5 py-2 text-xs font-medium hover:bg-[var(--surface-2)]"
              onClick={() => addNode("image")}
            >
              <span style={{ color: "var(--accent)" }}>▦</span> 分镜图
            </button>
            <button
              type="button"
              aria-label="添加成片节点"
              className="rounded-lg px-2.5 py-2 text-xs font-medium hover:bg-[var(--surface-2)]"
              onClick={() => addNode("video")}
            >
              <span style={{ color: "var(--cyan)" }}>▶</span> 成片
            </button>
            <button
              type="button"
              aria-label="添加生成配置节点"
              className="rounded-lg px-2.5 py-2 text-xs font-medium hover:bg-[var(--surface-2)]"
              onClick={() => addNode("config")}
            >
              <span style={{ color: "#b78bfa" }}>⚙</span> 配置
            </button>
            <button
              type="button"
              aria-label="添加空分组"
              className="rounded-lg px-2.5 py-2 text-xs font-medium hover:bg-[var(--surface-2)]"
              onClick={() => addNode("group")}
            >
              ▣ 分组
            </button>
            <button
              type="button"
              aria-label="上传素材并添加节点"
              className="rounded-lg px-2.5 py-2 text-xs font-medium hover:bg-[var(--surface-2)]"
              onClick={() => globalUploadRef.current?.click()}
            >
              ⇪ 上传
            </button>
            <input
              ref={globalUploadRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              aria-label="上传素材文件"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handleGlobalUpload(f);
              }}
            />
            <span className="mx-0.5 h-6 w-px bg-[var(--border)]" aria-hidden />
            <button
              type="button"
              aria-label="画布外观（背景样式）"
              aria-expanded={appearanceOpen}
              className={`rounded-lg px-2.5 py-2 text-xs font-medium ${appearanceOpen ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]"}`}
              onClick={() => setAppearanceOpen((o) => !o)}
            >
              🎨 外观
            </button>
            {selectedIds.length > 0 && (
              <button
                type="button"
                aria-label="删除所选节点"
                className="rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--accent)] hover:bg-[var(--surface-2)]"
                onClick={deleteSelected}
              >
                删除所选
              </button>
            )}
            <button
              type="button"
              aria-label={clearArmed ? "再次点击确认清空画布" : "清空画布"}
              className={`rounded-lg px-2.5 py-2 text-xs font-medium hover:bg-[var(--surface-2)] ${clearArmed ? "text-[var(--accent)]" : ""}`}
              onClick={() => {
                if (!clearArmed) {
                  setClearArmed(true);
                  setTimeout(() => setClearArmed(false), 3000);
                  return;
                }
                setClearArmed(false);
                setGraph((g) => ({ ...g, nodes: [], edges: [] }));
                setSelectedIds([]);
                setToast("画布已清空（可用 Ctrl+Z 撤销）");
              }}
            >
              {clearArmed ? "确认清空？" : "清空"}
            </button>
          </div>
          {appearanceOpen && (
            <div
              className="absolute bottom-[calc(100%+8px)] left-24 w-60 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-2xl"
              role="dialog"
              aria-label="画布外观设置"
              data-canvas-no-zoom=""
            >
              <p className="text-xs font-medium text-[var(--dim)]">画布背景</p>
              <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-[var(--surface-2)] p-1">
                {(
                  [
                    ["dots", "点阵"],
                    ["lines", "线条"],
                    ["blank", "空白"],
                  ] as [BackgroundMode, string][]
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={graph.backgroundMode === mode}
                    aria-label={`背景样式：${label}`}
                    className={`rounded-md px-2 py-1.5 text-xs ${graph.backgroundMode === mode ? "bg-[var(--surface)] font-semibold shadow" : "text-[var(--dim)]"}`}
                    onClick={() =>
                      setGraph((g) => ({ ...g, backgroundMode: mode }))
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-[var(--dim)]">
                背景样式只影响画布底纹，会随项目一起保存。
              </p>
            </div>
          )}
        </div>

        {/* zoom controls + minimap (bottom right) */}
        <div className="absolute bottom-[76px] right-3 z-10 flex flex-col items-end gap-2 sm:bottom-4">
          {minimap && (
            <div
              className="relative hidden cursor-pointer overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]/90 sm:block"
              style={{ width: 240, height: 160, touchAction: "none" }}
              role="button"
              aria-label="小地图，拖拽视口框或点击跳转到对应位置"
              title="小地图：点击或拖拽视口框移动视角"
              onPointerDown={(e) => {
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                minimapDragRef.current = true;
                minimapJump(
                  e.clientX,
                  e.clientY,
                  (e.currentTarget as HTMLDivElement).getBoundingClientRect(),
                );
              }}
              onPointerMove={(e) => {
                if (!minimapDragRef.current) return;
                minimapJump(
                  e.clientX,
                  e.clientY,
                  (e.currentTarget as HTMLDivElement).getBoundingClientRect(),
                );
              }}
              onPointerUp={() => (minimapDragRef.current = false)}
              onPointerCancel={() => (minimapDragRef.current = false)}
            >
              {visibleNodes.map((n) => (
                <div
                  key={n.id}
                  className="absolute rounded-[2px]"
                  style={{
                    left: 4 + (n.x - minimap.minX) * minimap.scale,
                    top: 4 + (n.y - minimap.minY) * minimap.scale,
                    width: Math.max(3, nodeWidth(n) * minimap.scale),
                    height: Math.max(2, nodeHeight(n) * minimap.scale),
                    background:
                      n.type === "video"
                        ? "var(--cyan)"
                        : n.type === "image"
                          ? "var(--accent)"
                          : n.type === "config"
                            ? "#b78bfa"
                            : n.type === "group"
                              ? "var(--dim)"
                              : "#f5b83d",
                    opacity: n.type === "group" ? 0.3 : 0.75,
                  }}
                />
              ))}
              <div
                className="pointer-events-none absolute rounded-[2px] border border-[var(--text)] bg-[var(--text)]/10"
                style={{
                  left: 4 + (-vp.x / vp.k - minimap.minX) * minimap.scale,
                  top: 4 + (-vp.y / vp.k - minimap.minY) * minimap.scale,
                  width: Math.max(6, (containerSize.w / vp.k) * minimap.scale),
                  height: Math.max(5, (containerSize.h / vp.k) * minimap.scale),
                }}
              />
            </div>
          )}
          <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-lg">
            <button
              type="button"
              aria-label="缩小画布"
              className="rounded-lg px-2.5 py-1.5 text-sm hover:bg-[var(--surface-2)]"
              onClick={() => zoomBy(0.8)}
            >
              −
            </button>
            <button
              type="button"
              aria-label="重置缩放为 100%"
              title="重置为 100%"
              className="w-12 rounded-lg py-1.5 text-center font-mono text-xs hover:bg-[var(--surface-2)]"
              onClick={resetZoom}
            >
              {Math.round(vp.k * 100)}%
            </button>
            <button
              type="button"
              aria-label="放大画布"
              className="rounded-lg px-2.5 py-1.5 text-sm hover:bg-[var(--surface-2)]"
              onClick={() => zoomBy(1.25)}
            >
              ＋
            </button>
            <button
              type="button"
              aria-label="适应全部节点"
              className="rounded-lg px-2.5 py-1.5 text-xs hover:bg-[var(--surface-2)]"
              onClick={fitView}
            >
              适应
            </button>
            <button
              type="button"
              aria-label="重置视图（回到 100% 并居中）"
              title="重置视图：缩放回到 100%，视角回到画布原点附近"
              className="rounded-lg px-2.5 py-1.5 text-xs hover:bg-[var(--surface-2)]"
              onClick={() => setViewport({ x: 40, y: 60, k: 1 })}
            >
              重置视图
            </button>
            <button
              type="button"
              aria-label="快捷键帮助"
              className="rounded-lg px-2.5 py-1.5 text-xs hover:bg-[var(--surface-2)]"
              onClick={() => setShowHelp((s) => !s)}
            >
              快捷键
            </button>
          </div>
        </div>

        {hintVisible && !loading && (
          <div className="absolute bottom-20 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)]/95 px-3 py-1.5 text-[11px] text-[var(--dim)] shadow sm:flex">
            <span>选择工具拖动框选 · 抓手/空格平移 · 滚轮锚点缩放 · Ctrl+G 成组 · 右键菜单 · Ctrl+Z 撤销 · 点节点右侧圆点拉连线</span>
            <button
              type="button"
              aria-label="关闭操作提示"
              className="text-[var(--text)]"
              onClick={() => setHintVisible(false)}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* selection-aware assistant side panel */}
      {showAssistant && (
        <div
          className="fixed inset-y-0 right-0 z-40 flex w-84 max-w-[88vw] flex-col border-l border-[var(--border)] bg-[var(--surface)] pb-safe shadow-2xl"
          role="dialog"
          aria-label="画布助手"
          data-canvas-no-zoom=""
          style={{ width: 336 }}
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <h2 className="font-[family-name:var(--font-display)] text-base font-bold">
              画布助手
            </h2>
            <button
              type="button"
              aria-label="关闭画布助手"
              className="px-1 text-lg text-[var(--dim)]"
              onClick={() => setShowAssistant(false)}
            >
              ✕
            </button>
          </div>
          <div className="border-b border-[var(--border)] px-4 py-2 text-[11px] leading-snug text-[var(--dim)]">
            {selectedIds.length > 0 ? (
              <>
                当前上下文：已选 {selectedIds.length} 个节点
                {graph.nodes
                  .filter((n) => selectedIds.includes(n.id))
                  .map((n) => `《${n.title}》`)
                  .join("、")}
                ，连同它们的上游节点一起作为对话背景。换选节点，上下文自动跟着变。
              </>
            ) : (
              "还没有选中节点：先点选画布上的节点，助手会把选区及其上游节点作为上下文。"
            )}
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {assistantLog.length === 0 && (
              <p className="text-sm leading-relaxed text-[var(--dim)]">
                可以让我扩写提示词、润色字幕、给选中的镜头想运动提示词，或者聊聊这段工作流怎么改。回复下方有「插入画布」，能一键把内容放回画布成新节点。
              </p>
            )}
            <div className="flex flex-col gap-3">
              {assistantLog.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : ""}>
                  <div
                    className={`inline-block max-w-full rounded-xl px-3 py-2 text-left text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--surface-2)] text-[var(--text)]"
                    }`}
                    style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                  >
                    {m.text}
                  </div>
                  {m.role === "assistant" && (
                    <div>
                      <button
                        type="button"
                        className="mt-1 text-[11px] text-[var(--cyan)]"
                        aria-label="把这条助手回复插入画布为新节点"
                        onClick={() => insertAssistantText(m.text)}
                      >
                        ⤵ 插入画布为新节点
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {assistantBusy && (
                <p className="text-sm text-[var(--dim)]" role="status">
                  助手思考中…
                </p>
              )}
            </div>
          </div>
          <div className="flex gap-2 border-t border-[var(--border)] px-3 py-3">
            <textarea
              aria-label="给助手的消息"
              rows={2}
              value={assistantInput}
              placeholder="例如：帮我把选中镜头的提示词扩写得更有电影感"
              className="min-w-0 flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm"
              onChange={(e) => setAssistantInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleAssistantSend();
                }
              }}
            />
            <button
              type="button"
              className="shrink-0 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              aria-label="发送给助手"
              disabled={!assistantInput.trim() || assistantBusy}
              onClick={() => void handleAssistantSend()}
            >
              发送
            </button>
          </div>
        </div>
      )}

      {/* single-image refine dialog */}
      {imageTool && (
        <ImageToolsDialog
          node={imageTool.node}
          tool={imageTool.tool}
          busy={toolBusy}
          onClose={() => setImageTool(null)}
          onNewNode={(n, blob, suffix) => {
            setToolBusy(true);
            void handleToolNewNode(n, blob, suffix).finally(() => setToolBusy(false));
          }}
          onReplace={(n, blob) => {
            setToolBusy(true);
            void handleToolReplace(n, blob).finally(() => setToolBusy(false));
          }}
          onInstruct={(n, instruction, suffix) => {
            setImageTool(null);
            void handleVaryWith(n, instruction, suffix);
          }}
        />
      )}

      {/* Agent 一句话成片 panel */}
      {showAgentPanel && (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-label="Agent 一句话成片">
          <button
            type="button"
            aria-label="关闭 Agent 一句话成片面板"
            className="absolute inset-0 bg-black/50"
            onClick={() => !agentStarting && setShowAgentPanel(false)}
          />
          <div className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-4 pb-safe shadow-2xl sm:rounded-2xl">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-[family-name:var(--font-display)] text-lg font-bold">
                ✦ Agent 一句话成片
              </h2>
              <button
                type="button"
                aria-label="关闭"
                className="px-1 text-lg text-[var(--dim)] disabled:opacity-40"
                disabled={agentStarting}
                onClick={() => setShowAgentPanel(false)}
              >
                ✕
              </button>
            </div>
            <p className="text-xs leading-relaxed text-[var(--dim)]">
              工具自动搭好工作流（创意 → 分镜脚本 → 资产定版 → 逐镜分镜图 → 成片节点），后台 Muse 用自己的 Token 逐镜头生成真运动视频、配乐、剪辑并存回——页面内不直接生成视频。开始后会<strong className="text-[var(--text)]">新建一个项目</strong>来制作，不会动你现有的项目；自动流程最多 12 个镜头（脚本阶段就按这个上限收敛）。搭好的每一步都摆在画布上，之后随时能自己改。
            </p>
            <label className="mt-3 flex flex-col gap-1.5">
              <span className="text-sm font-medium">一句话创意</span>
              <textarea
                aria-label="一句话创意"
                rows={3}
                value={agentInstruction}
                placeholder="例如：一只橘猫在霓虹雨夜的未来都市里开悬浮跑车兜风，最后停在海边看日出"
                className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
                onChange={(e) => setAgentInstruction(e.target.value)}
              />
            </label>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--dim)]">目标时长</span>
                <select
                  aria-label="目标时长"
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm"
                  value={agentDuration}
                  onChange={(e) => setAgentDuration(Number(e.target.value))}
                >
                  <option value={0}>自动（约 30 秒）</option>
                  <option value={15}>约 15 秒</option>
                  <option value={30}>约 30 秒</option>
                  <option value={45}>约 45 秒</option>
                  <option value={60}>约 60 秒</option>
                  <option value={90}>约 90 秒</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--dim)]">画幅</span>
                <select
                  aria-label="画幅"
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm"
                  value={agentAspect}
                  onChange={(e) => setAgentAspect(e.target.value as "16:9" | "9:16" | "1:1")}
                >
                  <option value="16:9">16:9 横屏</option>
                  <option value="9:16">9:16 竖屏</option>
                  <option value="1:1">1:1 方形</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--dim)]">风格基调（选填）</span>
                <input
                  aria-label="风格基调"
                  type="text"
                  value={agentStyle}
                  placeholder="如：赛博朋克电影感"
                  className="min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm placeholder:text-[var(--dim)]"
                  onChange={(e) => setAgentStyle(e.target.value)}
                />
              </label>
            </div>
            <fieldset className="mt-3">
              <legend className="text-sm font-medium">制作方式</legend>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={agentMode === "auto"}
                  className={`rounded-lg border px-3 py-2 text-left ${agentMode === "auto" ? "border-[var(--accent)] bg-[var(--surface-2)]" : "border-[var(--border)]"}`}
                  onClick={() => setAgentMode("auto")}
                >
                  <span className="block text-sm font-semibold">全自动直达</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-[var(--dim)]">
                    搭工作流、写剧本、定版资产、生成分镜图之后，直接逐镜头生视频、配乐、剪辑，一次跑到成品存回。
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={agentMode === "step"}
                  className={`rounded-lg border px-3 py-2 text-left ${agentMode === "step" ? "border-[var(--accent)] bg-[var(--surface-2)]" : "border-[var(--border)]"}`}
                  onClick={() => setAgentMode("step")}
                >
                  <span className="block text-sm font-semibold">分步确认</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-[var(--dim)]">
                    分镜图生成好后先停下，你可以在画布上任意修改脚本、提示词、字幕和镜头，确认后点「继续生成成片」。
                  </span>
                </button>
              </div>
            </fieldset>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
              流程：写剧本 → 定版资产（先生成 1 张角色/场景定版参考图，并把统一的角色/风格描述文字注入每个镜头的生图提示词来保持一致——这是文字锚定，不是换脸或身份模型）→ 逐镜生成分镜图（逐张回报进度，单张失败会标在节点上可单独重试）→ 逐镜头真运动视频 → 按剧情情绪配乐 → 剪辑合成 → 存回成片节点。
            </p>
            <button
              type="button"
              className="mt-4 rounded-md bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              aria-label="开始自动制作"
              disabled={!agentInstruction.trim() || agentStarting}
              onClick={() => void handleStartAgent()}
            >
              {agentStarting
                ? "Agent 制作中：搭工作流 → 写剧本 → 定版资产 → 生成分镜图…"
                : "开始自动制作 →"}
            </button>
          </div>
        </div>
      )}

      {/* projects drawer */}
      {showProjects && (
        <div className="fixed inset-0 z-40 flex" role="dialog" aria-label="项目列表">
          <button
            type="button"
            aria-label="关闭项目列表"
            className="flex-1 bg-black/50"
            onClick={() => setShowProjects(false)}
          />
          <div className="flex w-80 max-w-[85vw] flex-col bg-[var(--surface)] pb-safe">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <h2 className="font-[family-name:var(--font-display)] text-base font-bold">
                我的项目
              </h2>
              <button
                type="button"
                aria-label="关闭"
                className="px-1 text-lg text-[var(--dim)]"
                onClick={() => setShowProjects(false)}
              >
                ✕
              </button>
            </div>
            <div className="flex gap-2 px-4 py-3">
              <input
                aria-label="新项目名称"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="新项目名称"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                disabled={!newProjectName.trim() || createProjectMut.isPending}
                onClick={() => createProjectMut.mutate(newProjectName.trim())}
              >
                新建
              </button>
            </div>
            <div className="flex gap-2 border-b border-[var(--border)] px-4 pb-3">
              <button
                type="button"
                className="flex-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs disabled:opacity-50"
                aria-label="导出当前项目为项目包（备份迁移）"
                disabled={currentId == null || transferBusy}
                onClick={() => void handleExportProject()}
              >
                {transferBusy ? "处理中…" : "⬇ 导出当前项目包"}
              </button>
              <button
                type="button"
                className="flex-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs disabled:opacity-50"
                aria-label="导入项目包"
                disabled={transferBusy}
                onClick={() => importFileRef.current?.click()}
              >
                ⬆ 导入项目包
              </button>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label="选择要导入的项目包文件"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleImportProject(f);
                }}
              />
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-4">
              {projects.length === 0 && (
                <p className="px-2 py-4 text-sm text-[var(--dim)]">还没有项目，先新建一个。</p>
              )}
              {projects.map((p) => (
                <div
                  key={p.id}
                  className={`flex items-center gap-2 rounded-lg px-2 py-2 ${
                    p.id === currentId ? "bg-[var(--surface-2)]" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    aria-label={`打开项目 ${p.name}`}
                    onClick={() => {
                      if (p.id !== currentId) {
                        markProjectUnloaded();
                        setCurrentId(p.id);
                      }
                      setShowProjects(false);
                    }}
                  >
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block text-[11px] text-[var(--dim)]">
                      {new Date(p.updated_at).toLocaleString()} 更新
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`删除项目 ${p.name}`}
                    className="rounded px-1.5 py-1 text-xs text-[var(--dim)] hover:text-[var(--accent)]"
                    onClick={() => deleteProjectMut.mutate(p.id)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* history drawer */}
      {showHistory && (
        <div className="fixed inset-0 z-40 flex" role="dialog" aria-label="生成历史">
          <button
            type="button"
            aria-label="关闭生成历史"
            className="flex-1 bg-black/50"
            onClick={() => setShowHistory(false)}
          />
          <div className="flex w-80 max-w-[85vw] flex-col bg-[var(--surface)] pb-safe">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <h2 className="font-[family-name:var(--font-display)] text-base font-bold">
                生成历史
              </h2>
              <button
                type="button"
                aria-label="关闭"
                className="px-1 text-lg text-[var(--dim)]"
                onClick={() => setShowHistory(false)}
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {generationsQuery.isPending && (
                <p className="text-sm text-[var(--dim)]">加载中…</p>
              )}
              {!generationsQuery.isPending && generations.length === 0 && (
                <p className="text-sm text-[var(--dim)]">
                  还没有生成记录。在画布上生成一张分镜图，这里就会出现。
                </p>
              )}
              <div className="flex flex-col gap-3">
                {generations.map((gen) => (
                  <div
                    key={gen.id}
                    className="overflow-hidden rounded-lg border border-[var(--border)]"
                  >
                    {gen.kind === "image" ? (
                      <img src={gen.url} alt={gen.prompt || "生成的图片"} className="w-full object-cover" />
                    ) : gen.chunked && gen.film_request_id != null ? (
                      brokenGenIds.has(gen.id) ? (
                        <p role="alert" className="px-2.5 py-3 text-xs leading-snug text-[#ff7a5c]">
                          这份成片拼装校验没通过，文件不完整，无法播放，也不会提供下载。
                        </p>
                      ) : (
                        <div className="px-2.5 py-2.5">
                          <AssembledFilmPlayer
                            assembly={{
                              requestId: gen.film_request_id,
                              chunkCount: 0,
                              totalBytes: 0,
                              sha256: "",
                              mime: "video/mp4",
                            }}
                            title={gen.prompt || "成片"}
                            autoLoad={false}
                            onBroken={() =>
                              setBrokenGenIds((prev) => new Set(prev).add(gen.id))
                            }
                          />
                        </div>
                      )
                    ) : brokenGenUrls.has(gen.url) ? (
                      <p role="alert" className="px-2.5 py-3 text-xs leading-snug text-[#ff7a5c]">
                        这份视频文件已损坏（保存时传输不完整），无法播放，下载下来也打不开。
                      </p>
                    ) : (
                      <video
                        src={gen.url}
                        controls
                        playsInline
                        className="w-full"
                        onError={() =>
                          setBrokenGenUrls((prev) => new Set(prev).add(gen.url))
                        }
                      />
                    )}
                    <div className="px-2.5 py-2">
                      <p className="line-clamp-2 text-xs text-[var(--text)]">
                        {gen.prompt || (gen.kind === "image" ? "生成的分镜图" : "生成的成片")}
                      </p>
                      <div className="mt-1.5 flex items-center justify-between">
                        <span className="text-[11px] text-[var(--dim)]">
                          {gen.kind === "image" ? "图片" : "视频"} ·{" "}
                          {new Date(gen.created_at).toLocaleString()}
                        </span>
                        <span className="flex gap-2">
                          <button
                            type="button"
                            className="text-[11px] text-[var(--cyan)]"
                            onClick={() => {
                              const node = graphRef.current.nodes.find(
                                (n) => n.id === gen.node_id,
                              );
                              if (node) {
                                centerOnNode(node);
                                setShowHistory(false);
                              } else {
                                setToast("该记录对应的节点已被删除");
                              }
                            }}
                          >
                            定位节点
                          </button>
                          {gen.kind === "video" && brokenGenUrls.has(gen.url) ? null : gen.chunked ? (
                            brokenGenIds.has(gen.id) || gen.film_request_id == null ? null : (
                              <button
                                type="button"
                                className="text-[11px] text-[var(--cyan)] disabled:opacity-50"
                                aria-label="下载该生成结果"
                                disabled={historyDlId === gen.id}
                                onClick={() => {
                                  const reqId = gen.film_request_id;
                                  if (reqId == null) return;
                                  setHistoryDlId(gen.id);
                                  downloadAssembledFilm(reqId, "成片.mp4")
                                    .catch((e: unknown) => {
                                      setBrokenGenIds((prev) => new Set(prev).add(gen.id));
                                      setToast(
                                        `下载失败：${e instanceof Error ? e.message : String(e)}`,
                                      );
                                    })
                                    .finally(() => setHistoryDlId(null));
                                }}
                              >
                                {historyDlId === gen.id ? "拼装中…" : "下载"}
                              </button>
                            )
                          ) : (
                            <a
                              href={gen.url}
                              download
                              className="text-[11px] text-[var(--cyan)]"
                              aria-label="下载该生成结果"
                            >
                              下载
                            </a>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[var(--text)] px-4 py-2 text-sm font-medium text-[var(--bg)] shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
