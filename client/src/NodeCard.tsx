import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { NODE_W, type Aspect, type CanvasNode, type Motion } from "./types";
import { DirectFilmDownload, DirectFilmPlayer } from "./filmAssembly";

export type TextMode = "expand" | "script" | "storyboard" | "captions";

const TEXT_MODES: { value: TextMode; label: string; button: string }[] = [
  { value: "expand", label: "扩写提示词", button: "✦ AI 扩写" },
  { value: "script", label: "短视频脚本", button: "✦ 生成脚本" },
  { value: "storyboard", label: "分镜脚本", button: "✦ 拆分镜脚本" },
  { value: "captions", label: "标题文案", button: "✦ 生成文案" },
];

const TYPE_META: Record<CanvasNode["type"], { label: string; color: string }> = {
  text: { label: "提示词", color: "#f5b83d" },
  image: { label: "分镜图", color: "#ff5a2a" },
  video: { label: "成片", color: "#39d0d8" },
  config: { label: "生成配置", color: "#b78bfa" },
  group: { label: "分组", color: "#8b919c" },
};

export type ImageToolKind = "crop" | "mask" | "split" | "upscale" | "angle";

const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];
const MOTIONS: { value: Motion; label: string }[] = [
  { value: "zoom-in", label: "推近" },
  { value: "zoom-out", label: "拉远" },
  { value: "pan-left", label: "左移" },
  { value: "pan-right", label: "右移" },
  { value: "static", label: "固定" },
];

/** One shot as collected into a 成片 node, in playback order. */
export interface PackageShotInfo {
  id: string;
  title: string;
  url: string;
  duration: number;
}

export interface NodeCardProps {
  node: CanvasNode;
  selected: boolean;
  isLinkSource: boolean;
  linkMode: boolean;
  /** Ordered shots wired into this 成片 node （成片 nodes only). */
  packageShots: PackageShotInfo[];
  /** A film is currently being generated in the background. */
  filmBusy: boolean;
  /** Latest film status for the project, for the 成片 node's status line. */
  filmStatus: "none" | "queued" | "running" | "done" | "failed";
  /** Live film progress reported by the background task: shot clips
   *  finished out of the total, the current stage label, and the elapsed
   *  time label — rendered as a moving progress bar while busy. */
  filmDone: number;
  filmTotal: number;
  filmStage: string;
  filmElapsed: string;
  /** True when the film has had no progress update for 5+ minutes. */
  filmStalled: boolean;
  filmSinceUpdate: string;
  onCancelFilm: () => void;
  onRestartFilm: (node: CanvasNode) => void;
  /** Reports that this node's stored film bytes are damaged (the player
   *  could not parse them), so page-level surfaces (status banner,
   *  history) can stop offering the same broken file for download. */
  onVideoBroken?: (url: string) => void;
  /** Agent 一句话成片： this project's run is parked at awaiting_confirm. */
  agentAwaiting?: boolean;
  agentContinuing?: boolean;
  onAgentContinue?: () => void;
  onAgentRestoryboard?: () => void;
  enhancing: boolean;
  onPatch: (id: string, patch: Partial<CanvasNode>) => void;
  onSelect: (id: string, additive: boolean) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDragStart: (e: ReactPointerEvent, node: CanvasNode) => void;
  onDragMove: (e: ReactPointerEvent) => void;
  onDragEnd: (e: ReactPointerEvent) => void;
  onStartLink: (id: string) => void;
  onCardClick: (id: string) => void;
  onGenerate: (node: CanvasNode) => void;
  onGenerateText: (node: CanvasNode, mode: TextMode) => void;
  onSplitStoryboard: (node: CanvasNode) => void;
  onVary: (node: CanvasNode) => void;
  /** Re-run this node's last generation with its stored snapshot. */
  onRetrySnapshot: (node: CanvasNode) => void;
  /** Camera-focus this node (used by the hover toolbar). */
  onFocusNode: (node: CanvasNode) => void;
  /** Open one of the single-image refine tools for this image node. */
  onImageTool: (node: CanvasNode, tool: ImageToolKind) => void;
  /** Group nodes: number of member nodes inside the frame. */
  memberCount: number;
  /** True when a 生成配置 node is wired into this node (its aspect /
   *  quality / style are inherited). */
  inheritsConfig: boolean;
  /** Dissolve this group node, keeping its members on the canvas. */
  onUngroup: (node: CanvasNode) => void;
  onRequestFilm: (node: CanvasNode) => void;
  onUpload: (node: CanvasNode, file: File) => void;
  onNodeMenu: (node: CanvasNode, clientX: number, clientY: number) => void;
}

const selectCls =
  "rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-1 text-xs text-[var(--text)]";
const labelCls = "text-[11px] text-[var(--dim)]";

export function NodeCard(props: NodeCardProps) {
  const { node } = props;
  const meta = TYPE_META[node.type];
  const fileRef = useRef<HTMLInputElement>(null);
  const [textMode, setTextMode] = useState<TextMode>("expand");
  // URL of a stored film whose bytes turned out to be damaged (the
  // browser's <video> cannot even parse it). Films saved before the
  // server-side integrity gate include transfers truncated mid-file;
  // when the player errors we say so plainly and stop offering the
  // download of a file that cannot play, instead of a silent black box.
  const [brokenVideoUrl, setBrokenVideoUrl] = useState("");
  const videoBroken = node.type === "video" && node.url !== "" && brokenVideoUrl === node.url;
  // Chunked films: the node carries an assembly manifest instead of a
  // URL. Playback/download go through the server's whole-file copy
  // (DirectFilmPlayer/DirectFilmDownload — one request, no browser
  // reassembly); the verified chunk-reassembly path remains only as
  // the fallback when no whole-file copy exists, and if that fails
  // the film is reported broken (no download).
  // If the server turns out to have NO assembly record for the request
  // (a stale manifest on an old-format save) and the node still holds a
  // plain video URL, assemblyGone drops the node back to the ordinary
  // blob player/download path instead of an error state.
  const [assemblyGone, setAssemblyGone] = useState(false);
  const hasAssembly = node.type === "video" && node.filmAssembly != null && !assemblyGone;
  const [assemblyBroken, setAssemblyBroken] = useState(false);
  const [assemblyDlError, setAssemblyDlError] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const busy = node.status === "generating";
  const modeMeta = TEXT_MODES.find((m) => m.value === textMode) ?? TEXT_MODES[0];

  const previewAspect =
    node.aspect === "16:9" ? "16/10" : node.aspect === "9:16" ? "16/10" : "16/11";

  const additiveOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
    e.shiftKey || e.ctrlKey || e.metaKey;

  // ---- group frame -------------------------------------------------------
  // A group is a frame node: it wraps its members (their groupId points
  // here), drags them along, and can collapse to hide them. It renders
  // behind every normal node.
  if (node.type === "group") {
    return (
      <div
        role="group"
        aria-label={`分组 ${node.title}，共 ${props.memberCount} 个节点`}
        data-node-id={node.id}
        className="absolute rounded-[14px] border-2 border-dashed bg-[var(--surface-2)]/40"
        style={{
          left: node.x,
          top: node.y,
          width: Math.max(120, node.w),
          height: Math.max(80, node.h),
          borderColor: props.selected ? "var(--accent)" : "var(--border)",
          boxShadow: props.selected ? "0 0 0 1.5px var(--accent)" : undefined,
          zIndex: 0,
          pointerEvents: "auto",
        }}
        onClick={(e) => {
          e.stopPropagation();
          props.onSelect(node.id, additiveOf(e));
          props.onCardClick(node.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onSelect(node.id, additiveOf(e));
          props.onNodeMenu(node, e.clientX, e.clientY);
        }}
      >
        <div
          className="flex cursor-grab items-center gap-2 px-3 py-2 active:cursor-grabbing"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => {
            props.onSelect(node.id, additiveOf(e));
            props.onDragStart(e, node);
          }}
          onPointerMove={props.onDragMove}
          onPointerUp={props.onDragEnd}
          onPointerCancel={props.onDragEnd}
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: meta.color }} aria-hidden />
          {editingTitle ? (
            <input
              aria-label="分组名称"
              value={titleDraft}
              autoFocus
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-sm font-semibold text-[var(--text)]"
              onChange={(e) => setTitleDraft(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => {
                setEditingTitle(false);
                const t = titleDraft.trim();
                if (t && t !== node.title) props.onPatch(node.id, { title: t.slice(0, 40) });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setTitleDraft(node.title);
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]"
              title="双击重命名"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setTitleDraft(node.title);
                setEditingTitle(true);
              }}
            >
              {node.title}
            </span>
          )}
          <span className="shrink-0 text-[11px] text-[var(--dim)]">
            {props.memberCount} 个节点{node.collapsed ? " · 已折叠" : ""}
          </span>
          <button
            type="button"
            aria-label={node.collapsed ? `展开分组 ${node.title}` : `折叠分组 ${node.title}`}
            title={node.collapsed ? "展开分组" : "折叠分组（隐藏组内节点）"}
            className="rounded px-1 text-xs text-[var(--dim)] hover:text-[var(--text)]"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              props.onPatch(node.id, { collapsed: !node.collapsed });
            }}
          >
            {node.collapsed ? "▸" : "▾"}
          </button>
          <button
            type="button"
            aria-label={`解组 ${node.title}`}
            title="解组（保留组内节点）"
            className="rounded px-1 text-xs text-[var(--dim)] hover:text-[var(--text)]"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              props.onUngroup(node);
            }}
          >
            解组
          </button>
          <button
            type="button"
            aria-label={`删除分组 ${node.title}`}
            title="只删除分组框，组内节点保留"
            className="rounded px-1 text-sm text-[var(--dim)] hover:text-[var(--accent)]"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              props.onUngroup(node);
            }}
          >
            ✕
          </button>
        </div>
        {node.collapsed && (
          <p className="px-3 text-[11px] text-[var(--dim)]">
            组内 {props.memberCount} 个节点已折叠隐藏，点标题栏的 ▸ 展开。
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={`${meta.label}节点 ${node.title}`}
      data-node-id={node.id}
      className="absolute flex flex-col overflow-visible rounded-[10px] border bg-[var(--surface)] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
      style={{
        left: node.x,
        top: node.y,
        width: NODE_W,
        borderColor: props.selected
          ? "var(--accent)"
          : props.isLinkSource
            ? "var(--cyan)"
            : "var(--border)",
        boxShadow: props.selected
          ? "0 0 0 1.5px var(--accent), 0 10px 30px rgba(0,0,0,0.35)"
          : undefined,
        // Layering mirrors the reference canvas: groups at the back,
        // normal nodes above them, the selected node on top.
        zIndex: props.selected ? 3 : 1,
        pointerEvents: "auto",
      }}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelect(node.id, additiveOf(e));
        props.onCardClick(node.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onSelect(node.id, additiveOf(e));
        props.onNodeMenu(node, e.clientX, e.clientY);
      }}
    >
      {/* floating quick toolbar (visible while this node is selected) */}
      {props.selected && (
        <div
          className="absolute -top-10 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1 py-1 shadow-xl"
          role="toolbar"
          aria-label={`${node.title} 快捷操作`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
            aria-label={`定位到节点 ${node.title}`}
            onClick={() => props.onFocusNode(node)}
          >
            ◎ 定位
          </button>
          {node.type === "image" && (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
              aria-label={`生成节点 ${node.title} 的图片`}
              disabled={busy}
              onClick={() => props.onGenerate(node)}
            >
              {node.url ? "↻ 重新生成" : "✦ 生成"}
            </button>
          )}
          {node.type === "image" && node.snapshot && (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
              aria-label={`按上次参数重试 ${node.title}`}
              disabled={busy}
              onClick={() => props.onRetrySnapshot(node)}
            >
              ⤺ 原样重试
            </button>
          )}
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] hover:bg-[var(--surface-2)]"
            aria-label={`复制节点 ${node.title}`}
            onClick={() => props.onDuplicate(node.id)}
          >
            ⧉ 复制
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--surface-2)]"
            aria-label={`删除节点 ${node.title}`}
            onClick={() => props.onDelete(node.id)}
          >
            删除
          </button>
        </div>
      )}
      {/* header / drag handle */}
      <div
        className="flex cursor-grab items-center gap-2 border-b border-[var(--border)] px-3 py-2 active:cursor-grabbing"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          props.onSelect(node.id, additiveOf(e));
          props.onDragStart(e, node);
        }}
        onPointerMove={props.onDragMove}
        onPointerUp={props.onDragEnd}
        onPointerCancel={props.onDragEnd}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: meta.color }}
          aria-hidden
        />
        {/* status badge: generating / failed / has-result */}
        {node.status === "generating" ? (
          <span className="generating-glow shrink-0 rounded-full bg-[var(--cyan)] px-1.5 py-px text-[10px] font-semibold text-black" role="status">
            生成中
          </span>
        ) : node.status === "error" ? (
          <span className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 py-px text-[10px] font-semibold text-white" role="status">
            失败
          </span>
        ) : (node.type === "image" || node.type === "video") && (node.url || node.filmAssembly) ? (
          <span className="shrink-0 rounded-full bg-[var(--ok)] px-1.5 py-px text-[10px] font-semibold text-black" role="status">
            已生成
          </span>
        ) : null}
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--dim)]">
          {meta.label}
        </span>
        {editingTitle ? (
          <input
            aria-label="节点名称"
            value={titleDraft}
            autoFocus
            className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface-2)] px-1 py-0.5 text-sm font-semibold text-[var(--text)]"
            onChange={(e) => setTitleDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onBlur={() => {
              setEditingTitle(false);
              const t = titleDraft.trim();
              if (t && t !== node.title) props.onPatch(node.id, { title: t.slice(0, 40) });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setTitleDraft(node.title);
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]"
            title="双击重命名"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setTitleDraft(node.title);
              setEditingTitle(true);
            }}
          >
            {node.title}
          </span>
        )}
        <button
          type="button"
          aria-label={node.locked ? `解锁节点 ${node.title}` : `锁定节点 ${node.title}`}
          title={node.locked ? "已锁定，点击解锁" : "锁定位置"}
          className="rounded px-1 text-xs text-[var(--dim)] hover:text-[var(--text)]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onPatch(node.id, { locked: !node.locked });
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
            <rect x="4" y="10" width="16" height="10" rx="2" />
            {node.locked ? (
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            ) : (
              <path d="M8 10V7a4 4 0 0 1 7.8-1.3" />
            )}
          </svg>
        </button>
        <button
          type="button"
          aria-label={`复制节点 ${node.title}`}
          className="rounded px-1 text-sm text-[var(--dim)] hover:text-[var(--text)]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onDuplicate(node.id);
          }}
        >
          ⧉
        </button>
        <button
          type="button"
          aria-label={`删除节点 ${node.title}`}
          className="rounded px-1 text-sm text-[var(--dim)] hover:text-[var(--accent)]"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onDelete(node.id);
          }}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5">
        {node.type === "config" && (
          <>
            <p className="text-[11px] leading-snug text-[var(--dim)]">
              把这个节点连到分镜图节点上，下游节点统一继承下面的画幅、画质和风格——改一处，全组生效。
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <label className="flex items-center gap-1">
                <span className={labelCls}>画幅</span>
                <select
                  aria-label="配置画幅"
                  className={selectCls}
                  value={node.aspect}
                  onChange={(e) =>
                    props.onPatch(node.id, { aspect: e.target.value as Aspect })
                  }
                >
                  {ASPECTS.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                <span className={labelCls}>画质</span>
                <select
                  aria-label="配置画质"
                  className={selectCls}
                  value={node.quality}
                  onChange={(e) =>
                    props.onPatch(node.id, {
                      quality: e.target.value === "hd" ? "hd" : "standard",
                    })
                  }
                >
                  <option value="standard">标准</option>
                  <option value="hd">高清</option>
                </select>
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className={labelCls}>统一风格（会合并进每个下游节点的生图提示词）</span>
              <textarea
                aria-label="统一风格描述"
                rows={3}
                value={node.text}
                placeholder="例如：赛博朋克霓虹色调，雨夜湿润反光，电影宽画幅构图"
                className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
                onChange={(e) => props.onPatch(node.id, { text: e.target.value })}
                onPointerDown={(e) => e.stopPropagation()}
              />
            </label>
          </>
        )}

        {node.type === "text" && (
          <>
            <label className={labelCls} htmlFor={`${node.id}-text`}>
              画面描述
            </label>
            <textarea
              id={`${node.id}-text`}
              aria-label="提示词内容"
              rows={4}
              value={node.text}
              placeholder="例如：黄昏时分的海边小镇，渔船归港，暖色调…"
              className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
              onChange={(e) => props.onPatch(node.id, { text: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <div className="flex items-center gap-1.5">
              <select
                aria-label="生文模式"
                className={selectCls}
                value={textMode}
                onChange={(e) => setTextMode(e.target.value as TextMode)}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {TEXT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <span className="text-[11px] text-[var(--dim)]">{node.text.length} 字</span>
              <button
                type="button"
                className="ml-auto rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)] disabled:opacity-50"
                disabled={props.enhancing || !node.text.trim()}
                onClick={() => props.onGenerateText(node, textMode)}
              >
                {props.enhancing ? "生成中…" : modeMeta?.button}
              </button>
            </div>
            {textMode === "storyboard" && node.text.includes("画面") && (
              <button
                type="button"
                className="rounded-md bg-[var(--accent)] px-2 py-1.5 text-xs font-semibold text-white"
                onClick={() => props.onSplitStoryboard(node)}
              >
                一键拆成分镜节点 →
              </button>
            )}
            <p className="text-[11px] leading-snug text-[var(--dim)]">
              生成结果会填入上方文本，可继续编辑；分镜脚本可一键拆成镜头节点。
            </p>
          </>
        )}

        {node.type === "image" && (
          <>
            <div
              className="relative w-full overflow-hidden rounded-md bg-[var(--surface-2)]"
              style={{ aspectRatio: previewAspect }}
            >
              {node.url ? (
                <img
                  src={node.url}
                  alt={node.title}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[var(--dim)]">
                  <span className="text-2xl" aria-hidden>▦</span>
                  <span className="px-3 text-center text-[11px]">
                    连接提示词节点后点「生成图片」，或上传一张图
                  </span>
                </div>
              )}
              {node.status === "generating" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-sm text-white">
                  AI 生成中…
                </div>
              )}
            </div>
            <textarea
              aria-label="本镜头补充描述"
              rows={2}
              value={node.text}
              placeholder="本镜头补充描述（可选，与上游提示词合并）"
              className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
              onChange={(e) => props.onPatch(node.id, { text: e.target.value })}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label="画面比例"
                className={selectCls}
                value={node.aspect}
                onChange={(e) =>
                  props.onPatch(node.id, { aspect: e.target.value as Aspect })
                }
              >
                {ASPECTS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
              <label className="flex items-center gap-1">
                <span className={labelCls}>时长</span>
                <input
                  aria-label="镜头时长（秒）"
                  type="number"
                  min={1}
                  max={10}
                  step={0.5}
                  value={node.duration}
                  className="w-14 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-1 text-xs text-[var(--text)]"
                  onChange={(e) =>
                    props.onPatch(node.id, {
                      duration: Math.min(10, Math.max(1, Number(e.target.value) || 3)),
                    })
                  }
                />
                <span className={labelCls}>秒</span>
              </label>
              <select
                aria-label="镜头运镜"
                className={selectCls}
                value={node.motion}
                onChange={(e) =>
                  props.onPatch(node.id, { motion: e.target.value as Motion })
                }
              >
                {MOTIONS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`flex-1 rounded-md bg-[var(--accent)] px-2 py-1.5 text-sm font-semibold text-white disabled:opacity-50 ${node.status === "generating" ? "generating-glow" : ""}`}
                disabled={busy}
                onClick={() => props.onGenerate(node)}
              >
                {node.status === "generating"
                  ? "生成中…"
                  : node.url
                    ? "重新生成"
                    : "生成图片"}
              </button>
              <button
                type="button"
                className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text)]"
                onClick={() => fileRef.current?.click()}
              >
                上传图
              </button>
            </div>
            {node.url && (
              <button
                type="button"
                className="rounded-md border border-[var(--cyan)] px-2 py-1.5 text-xs font-medium text-[var(--cyan)] disabled:opacity-50"
                disabled={busy}
                onClick={() => props.onVary(node)}
              >
                {node.status === "generating" ? "生成中…" : "图生图：按补充描述生成变体节点"}
              </button>
            )}
            {node.url && (
              <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="单图精修工具">
                <span className={labelCls}>精修：</span>
                {(
                  [
                    ["crop", "裁剪"],
                    ["mask", "蒙版编辑"],
                    ["split", "切分"],
                    ["upscale", "超分放大"],
                    ["angle", "多角度"],
                  ] as [ImageToolKind, string][]
                ).map(([tool, label]) => (
                  <button
                    key={tool}
                    type="button"
                    className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] hover:bg-[var(--surface-2)] disabled:opacity-50"
                    aria-label={`${label} ${node.title}`}
                    disabled={busy}
                    onClick={() => props.onImageTool(node, tool)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {props.inheritsConfig && (
              <p className="text-[11px] leading-snug text-[#b78bfa]">
                已连入「生成配置」节点：画幅、画质与风格以下游配置为准（本节点的画幅选择会被覆盖）。
              </p>
            )}
            {node.snapshot && (
              <div className="flex items-center gap-2 rounded-md bg-[var(--surface-2)] px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--dim)]" title={node.snapshot.prompt}>
                  上次生成参数：{node.snapshot.aspect} · {node.snapshot.quality === "hd" ? "高清" : "标准"} ·{" "}
                  {new Date(node.snapshot.at).toLocaleTimeString()}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[11px] disabled:opacity-50"
                  aria-label={`按上次参数原样重试 ${node.title}`}
                  disabled={busy}
                  onClick={() => props.onRetrySnapshot(node)}
                >
                  ⤺ 原样重试
                </button>
              </div>
            )}
            <label className="flex flex-col gap-1">
              <span className={labelCls}>视频运动提示词（这一镜里什么在动、怎么动，生成成片时按它逐镜头生成真运动视频）</span>
              <textarea
                aria-label="视频运动提示词"
                rows={2}
                value={node.motionPrompt}
                placeholder="例如：悬浮列车从左向右缓缓驶过，霓虹灯光在湿地面上拖出光轨，镜头微微推近"
                className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
                onChange={(e) => props.onPatch(node.id, { motionPrompt: e.target.value })}
                onPointerDown={(e) => e.stopPropagation()}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className={labelCls}>字幕</span>
              <input
                aria-label="本镜头字幕文案"
                type="text"
                value={node.caption}
                placeholder="这一镜的字幕文案（可空）"
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text)] placeholder:text-[var(--dim)]"
                onChange={(e) => props.onPatch(node.id, { caption: e.target.value })}
                onPointerDown={(e) => e.stopPropagation()}
              />
            </label>
          </>
        )}

        {node.type === "video" && (
          <>
            {hasAssembly && node.filmAssembly ? (
              <DirectFilmPlayer
                assembly={node.filmAssembly}
                title={node.title}
                autoLoad
                onUnavailable={
                  node.url ? () => setAssemblyGone(true) : undefined
                }
                onBroken={() => {
                  setAssemblyBroken(true);
                  if (node.filmAssembly) {
                    props.onVideoBroken?.(`assembly:${node.filmAssembly.requestId}`);
                  }
                }}
              />
            ) : node.url ? (
              videoBroken ? (
                <p
                  role="alert"
                  className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-[11px] leading-snug text-[#ff7a5c]"
                >
                  这份成片文件已经损坏（保存时传输不完整），无法播放，下载下来也打不开。点下方「生成并合成成片」重新生成一份即可。
                </p>
              ) : (
                <div
                  className="relative w-full overflow-hidden rounded-md bg-black"
                  style={{ aspectRatio: previewAspect }}
                >
                  <video
                    src={node.url}
                    controls
                    playsInline
                    draggable={false}
                    className="h-full w-full object-contain"
                    onError={() => {
                      setBrokenVideoUrl(node.url);
                      props.onVideoBroken?.(node.url);
                    }}
                  />
                </div>
              )
            ) : null}
            <p className="text-[11px] leading-snug text-[var(--dim)]">
              {node.url || hasAssembly
                ? videoBroken || assemblyBroken
                  ? "下面是组成它的镜头清单："
                  : "上面是已经存回这里的成片，可以直接播放。下面是组成它的镜头清单："
                : "把分镜图节点按剧情顺序连到这里组成镜头清单，再点下方按钮：Muse 会直接逐镜头生成真运动视频、按剧情剪成成片并自动存回这里，你什么都不用做。"}
            </p>
            {props.packageShots.length > 0 ? (
              <ol className="flex flex-col gap-1">
                {props.packageShots.map((s, i) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 rounded-md bg-[var(--surface-2)] px-1.5 py-1"
                  >
                    <span className="w-5 shrink-0 text-center font-mono text-[11px] text-[var(--dim)]">
                      {i + 1}
                    </span>
                    {s.url ? (
                      <img
                        src={s.url}
                        alt=""
                        className="h-8 w-12 shrink-0 rounded object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-[var(--border)] text-[10px] text-[var(--dim)]">
                        无图
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--text)]">
                      {s.title}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--dim)]">
                      {s.duration} 秒
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-center text-[11px] text-[var(--dim)]">
                还没有连入镜头：从分镜图节点右侧圆点拉一条线到这里
              </p>
            )}
            <p className="text-[11px] text-[var(--dim)]">
              共 {props.packageShots.length} 个镜头 · 总时长约{" "}
              {props.packageShots.reduce((sum, s) => sum + s.duration, 0)} 秒 · 一次最多 24 个镜头
            </p>
            {props.filmBusy ? (
              <div
                role="status"
                className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-[11px] leading-snug text-[var(--cyan)]"
              >
                {props.filmStalled ? (
                  <p className="text-center font-medium text-[#ff7a5c]">
                    可能卡住了：已 {props.filmSinceUpdate} 没有新进度，后台任务可能已中断，不用继续等。
                  </p>
                ) : (
                  <p className="text-center">
                    成片生成中：{props.filmStage || "正在逐镜头生成真运动视频并剪辑"}，做好后会自动出现在这里
                  </p>
                )}
                {props.filmDone > 0 && props.filmTotal > 0 ? (
                  <>
                    <div
                      className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]"
                      role="progressbar"
                      aria-label="成片生成进度"
                      aria-valuemin={0}
                      aria-valuemax={props.filmTotal}
                      aria-valuenow={props.filmDone}
                    >
                      <div
                        className="h-full rounded-full bg-[var(--cyan)] transition-[width] duration-700"
                        style={{
                          width: `${Math.min(100, Math.round((props.filmDone / props.filmTotal) * 100))}%`,
                        }}
                      />
                    </div>
                    <p className="mt-1 text-center text-[var(--dim)]">
                      镜头 {props.filmDone}/{props.filmTotal} ·{" "}
                      {Math.min(100, Math.round((props.filmDone / props.filmTotal) * 100))}%
                      {props.filmElapsed ? ` · 已用时 ${props.filmElapsed}` : ""}
                    </p>
                  </>
                ) : (
                  <>
                    <div
                      className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]"
                      role="progressbar"
                      aria-label="成片生成进度"
                    >
                      <div
                        className="film-progress-indeterminate absolute inset-y-0 w-2/5 rounded-full bg-[var(--cyan)]"
                        aria-hidden
                      />
                    </div>
                    {props.filmElapsed && (
                      <p className="mt-1 text-center text-[var(--dim)]">
                        已用时 {props.filmElapsed}
                      </p>
                    )}
                  </>
                )}
                {props.filmStalled && (
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      className="flex-1 rounded-md bg-[var(--accent)] px-2 py-1.5 text-[11px] font-semibold text-white"
                      aria-label="结束这次生成并重新生成成片"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onRestartFilm(node);
                      }}
                    >
                      结束并重新生成
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-[var(--border)] px-2 py-1.5 text-[11px]"
                      aria-label="结束这次成片生成"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onCancelFilm();
                      }}
                    >
                      结束这次生成
                    </button>
                  </div>
                )}
              </div>
            ) : props.filmStatus === "done" && (node.url || hasAssembly) && !videoBroken && !assemblyBroken ? (
              <p role="status" className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-center text-[11px] text-[var(--ok)]">
                成片已生成并存回这里 ✓
              </p>
            ) : props.filmStatus === "failed" ? (
              <p role="alert" className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-center text-[11px] text-[#ff7a5c]">
                上次成片生成没有完成，点下方按钮重新生成
              </p>
            ) : null}
            {props.agentAwaiting && !props.filmBusy && (
              <div
                role="status"
                className="rounded-md bg-[var(--surface-2)] px-2 py-2 text-[11px] leading-snug"
              >
                <p className="text-center font-medium text-[#f5b83d]">
                  Agent 分步确认：分镜已就绪，先检查/修改画布，确认后继续
                </p>
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    className="flex-1 rounded-md bg-[var(--cyan)] px-2 py-1.5 text-[11px] font-semibold text-black disabled:opacity-50"
                    aria-label="继续生成成片"
                    disabled={props.agentContinuing}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onAgentContinue?.();
                    }}
                  >
                    继续生成成片 →
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-[var(--border)] px-2 py-1.5 text-[11px] disabled:opacity-50"
                    aria-label="重新生成分镜图"
                    disabled={props.agentContinuing}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onAgentRestoryboard?.();
                    }}
                  >
                    重新生成分镜
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              className={`rounded-md px-2 py-1.5 text-sm font-semibold disabled:opacity-50 ${props.filmStalled ? "bg-[var(--accent)] text-white" : "bg-[var(--cyan)] text-black"}`}
              disabled={props.packageShots.length === 0 || (props.filmBusy && !props.filmStalled)}
              onClick={() => (props.filmStalled ? props.onRestartFilm(node) : props.onRequestFilm(node))}
            >
              {props.filmStalled
                ? "已卡住 · 结束并重新生成"
                : props.filmBusy
                  ? props.filmTotal > 0
                    ? `成片生成中 ${props.filmDone}/${props.filmTotal}…`
                    : "成片生成中…"
                  : "🎬 生成并合成成片"}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text)]"
                onClick={() => fileRef.current?.click()}
              >
                {node.url || hasAssembly ? "换一个视频文件" : "手动上传视频"}
              </button>
              {node.url && !videoBroken && (
                <a
                  href={node.url}
                  download={`${node.title}.mp4`}
                  draggable={false}
                  className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text)]"
                  aria-label={`下载视频 ${node.title}`}
                >
                  下载
                </a>
              )}
              {hasAssembly && node.filmAssembly && !assemblyBroken && (
                <DirectFilmDownload
                  requestId={node.filmAssembly.requestId}
                  filename={`${node.title}.mp4`}
                  className="rounded-md border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text)]"
                  ariaLabel={`下载视频 ${node.title}`}
                  onUnavailable={
                    // No server-side assembly record, but a plain
                    // video URL exists: fall back to it silently.
                    node.url ? () => setAssemblyGone(true) : undefined
                  }
                  onError={(message) => {
                    setAssemblyBroken(true);
                    setAssemblyDlError(message);
                  }}
                >
                  下载
                </DirectFilmDownload>
              )}
            </div>
            {assemblyDlError && (
              <p role="alert" className="text-[11px] leading-snug text-[#ff7a5c]">
                下载失败：{assemblyDlError}
              </p>
            )}
          </>
        )}

        {node.status === "error" && node.error && (
          <p role="alert" className="text-xs text-[#ff7a5c]">
            {node.error}
          </p>
        )}
      </div>

      {/* ports */}
      <span
        aria-hidden
        className="absolute top-6 -left-[7px] h-3.5 w-3.5 rounded-full border-2 border-[var(--surface)]"
        style={{ background: props.linkMode && !props.isLinkSource ? "var(--cyan)" : "var(--dim)" }}
      />
      <button
        type="button"
        aria-label={`从节点 ${node.title} 连出连线`}
        title="点一下，再点目标节点即可连线"
        className="absolute top-[22px] -right-[9px] h-[18px] w-[18px] rounded-full border-2 border-[var(--surface)]"
        style={{ background: props.isLinkSource ? "var(--cyan)" : "var(--accent)" }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          props.onStartLink(node.id);
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept={node.type === "video" ? "video/*" : "image/*"}
        className="hidden"
        aria-label={node.type === "video" ? "上传视频文件" : "上传图片文件"}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) props.onUpload(node, file);
        }}
      />
    </div>
  );
}
