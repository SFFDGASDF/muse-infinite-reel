import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "./types";
import type { ImageToolKind } from "./NodeCard";

/** Single-image refine tools, mirroring the reference canvas's image
 *  dialogs: crop, mask edit, grid split, upscale, multi-angle.
 *  Crop / split / upscale are real local pixel operations (canvas) whose
 *  results are uploaded back as owned assets. Mask edit and multi-angle
 *  go through the existing image-to-image channel (vision rewrite +
 *  generation on Muse's token): the painted mask marks the region in
 *  the instruction text — there is no pixel-exact inpainting model on
 *  this surface, and the dialog says so. */

export interface ImageToolsProps {
  node: CanvasNode;
  tool: ImageToolKind;
  busy: boolean;
  onClose: () => void;
  /** Upload processed pixels as a NEW node wired from the source. */
  onNewNode: (node: CanvasNode, blob: Blob, titleSuffix: string) => void;
  /** Upload processed pixels replacing this node's image. */
  onReplace: (node: CanvasNode, blob: Blob) => void;
  /** Run image-to-image with an instruction (angle / mask edit). */
  onInstruct: (node: CanvasNode, instruction: string, titleSuffix: string) => void;
}

const ANGLES: { label: string; instruction: string }[] = [
  { label: "俯视", instruction: "把视角改成高处俯视（鸟瞰角度），主体、场景、色调和氛围保持不变" },
  { label: "仰视", instruction: "把视角改成低处仰视，主体、场景、色调和氛围保持不变" },
  { label: "左转视角", instruction: "把视角向左旋转约 45 度，主体、场景、色调和氛围保持不变" },
  { label: "右转视角", instruction: "把视角向右旋转约 45 度，主体、场景、色调和氛围保持不变" },
  { label: "特写", instruction: "把镜头推近成主体特写，主体、场景、色调和氛围保持不变" },
  { label: "远景", instruction: "把镜头拉远成远景全景，主体、场景、色调和氛围保持不变" },
];

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = url;
  });
}

/** Encode a processed canvas for upload: JPEG (photos compress far
 *  better than PNG here, keeping both the encode and the upload quick)
 *  with the longest edge capped at 2048px. */
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const maxDim = Math.max(canvas.width, canvas.height);
  let out = canvas;
  if (maxDim > 2048) {
    const scale = 2048 / maxDim;
    out = document.createElement("canvas");
    out.width = Math.round(canvas.width * scale);
    out.height = Math.round(canvas.height * scale);
    const c2d = out.getContext("2d");
    if (c2d) {
      c2d.imageSmoothingEnabled = true;
      c2d.imageSmoothingQuality = "high";
      c2d.drawImage(canvas, 0, 0, out.width, out.height);
    } else {
      out = canvas;
    }
  }
  return new Promise((resolve, reject) => {
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("图片处理失败"))),
      "image/jpeg",
      0.9,
    );
  });
}

const btnCls =
  "rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50";
const primaryCls =
  "rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50";

export function ImageToolsDialog(props: ImageToolsProps) {
  const { node, tool } = props;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  // crop region, percent trimmed from each edge
  const [crop, setCrop] = useState({ l: 10, t: 10, r: 10, b: 10 });
  const [instruction, setInstruction] = useState("");
  const [brush, setBrush] = useState(36);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const maskWrapRef = useRef<HTMLDivElement>(null);
  const paintingRef = useRef(false);
  const [maskDrawn, setMaskDrawn] = useState(false);

  // Prepare the mask canvas at the displayed size.
  useEffect(() => {
    if (tool !== "mask") return;
    const canvas = maskRef.current;
    const wrap = maskWrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(50, Math.round(rect.width));
    canvas.height = Math.max(50, Math.round(rect.height));
  }, [tool]);

  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    setError("");
    try {
      await fn();
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const doCrop = (replace: boolean) =>
    run(async () => {
      const img = await loadImage(node.url);
      const sx = (crop.l / 100) * img.naturalWidth;
      const sy = (crop.t / 100) * img.naturalHeight;
      const sw = img.naturalWidth * (1 - (crop.l + crop.r) / 100);
      const sh = img.naturalHeight * (1 - (crop.t + crop.b) / 100);
      if (sw < 16 || sh < 16) throw new Error("裁剪区域太小了");
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(sw);
      canvas.height = Math.round(sh);
      const c2d = canvas.getContext("2d");
      if (!c2d) throw new Error("图片处理失败");
      c2d.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas);
      if (replace) props.onReplace(node, blob);
      else props.onNewNode(node, blob, "裁剪");
    });

  const doSplit = () =>
    run(async () => {
      const img = await loadImage(node.url);
      const cols = 2;
      const rows = 2;
      const cw = Math.floor(img.naturalWidth / cols);
      const ch = Math.floor(img.naturalHeight / rows);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const canvas = document.createElement("canvas");
          canvas.width = cw;
          canvas.height = ch;
          const c2d = canvas.getContext("2d");
          if (!c2d) throw new Error("图片处理失败");
          c2d.drawImage(img, c * cw, r * ch, cw, ch, 0, 0, cw, ch);
          const blob = await canvasBlob(canvas);
          props.onNewNode(node, blob, `切分 ${r * cols + c + 1}`);
        }
      }
    });

  const doUpscale = () =>
    run(async () => {
      const img = await loadImage(node.url);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth * 2;
      canvas.height = img.naturalHeight * 2;
      const c2d = canvas.getContext("2d");
      if (!c2d) throw new Error("图片处理失败");
      c2d.imageSmoothingEnabled = true;
      c2d.imageSmoothingQuality = "high";
      c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas);
      props.onNewNode(node, blob, "超分 2×");
    });

  const paintMask = (e: React.PointerEvent) => {
    const canvas = maskRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    c2d.fillStyle = "rgba(255,90,42,0.55)";
    c2d.beginPath();
    c2d.arc(x, y, brush / 2, 0, Math.PI * 2);
    c2d.fill();
    setMaskDrawn(true);
  };

  const titles: Record<ImageToolKind, string> = {
    crop: "裁剪图片",
    mask: "蒙版编辑",
    split: "切分图片",
    upscale: "超分放大",
    angle: "多角度生成",
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-label={`${titles[tool]} ${node.title}`}
    >
      <button
        type="button"
        aria-label="关闭精修工具"
        className="absolute inset-0 bg-black/50"
        onClick={() => !working && props.onClose()}
      />
      <div className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-4 pb-safe shadow-2xl sm:rounded-2xl">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-[family-name:var(--font-display)] text-base font-bold">
            {titles[tool]} · {node.title}
          </h2>
          <button
            type="button"
            aria-label="关闭"
            className="px-1 text-lg text-[var(--dim)] disabled:opacity-40"
            disabled={working}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>

        {tool === "crop" && (
          <>
            <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-md">
              <img src={node.url} alt={node.title} className="block w-full" draggable={false} />
              <div
                className="pointer-events-none absolute border-2 border-[var(--cyan)]"
                style={{
                  left: `${crop.l}%`,
                  top: `${crop.t}%`,
                  right: `${crop.r}%`,
                  bottom: `${crop.b}%`,
                  boxShadow: "0 0 0 999px rgba(0,0,0,0.45)",
                }}
                aria-hidden
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(
                [
                  ["l", "左裁 %"],
                  ["r", "右裁 %"],
                  ["t", "上裁 %"],
                  ["b", "下裁 %"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-xs text-[var(--dim)]">
                  <span className="w-14 shrink-0">{label}</span>
                  <input
                    type="range"
                    min={0}
                    max={45}
                    value={crop[key]}
                    aria-label={label}
                    className="min-w-0 flex-1"
                    onChange={(e) =>
                      setCrop((c) => ({ ...c, [key]: Number(e.target.value) }))
                    }
                  />
                  <span className="w-8 text-right font-mono">{crop[key]}</span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" className={primaryCls} disabled={working} onClick={() => void doCrop(false)}>
                {working ? "处理中…" : "裁剪为新节点"}
              </button>
              <button type="button" className={btnCls} disabled={working} onClick={() => void doCrop(true)}>
                替换本图
              </button>
            </div>
          </>
        )}

        {tool === "mask" && (
          <>
            <p className="text-xs leading-relaxed text-[var(--dim)]">
              在图上涂抹要修改的区域，再写明怎么改。生成走图生图通道：模型会结合原图和你的说明重绘整图，涂抹区域是重点修改区，不是像素级精确抠改。
            </p>
            <div
              ref={maskWrapRef}
              className="relative mx-auto mt-2 w-full max-w-sm overflow-hidden rounded-md"
              style={{ touchAction: "none" }}
            >
              <img src={node.url} alt={node.title} className="block w-full" draggable={false} />
              <canvas
                ref={maskRef}
                className="absolute inset-0 h-full w-full cursor-crosshair"
                aria-label="蒙版涂抹画布"
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
                  paintingRef.current = true;
                  paintMask(e);
                }}
                onPointerMove={(e) => paintingRef.current && paintMask(e)}
                onPointerUp={() => (paintingRef.current = false)}
                onPointerCancel={() => (paintingRef.current = false)}
              />
            </div>
            <label className="mt-2 flex items-center gap-2 text-xs text-[var(--dim)]">
              <span className="shrink-0">笔刷大小</span>
              <input
                type="range"
                min={12}
                max={90}
                value={brush}
                aria-label="笔刷大小"
                className="min-w-0 flex-1"
                onChange={(e) => setBrush(Number(e.target.value))}
              />
              <button
                type="button"
                className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-[11px]"
                aria-label="清除蒙版涂抹"
                onClick={() => {
                  const canvas = maskRef.current;
                  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
                  setMaskDrawn(false);
                }}
              >
                清除涂抹
              </button>
            </label>
            <label className="mt-2 flex flex-col gap-1">
              <span className="text-xs text-[var(--dim)]">修改说明</span>
              <input
                type="text"
                value={instruction}
                placeholder="例如：把涂抹区域的招牌文字改成「夜航书店」"
                aria-label="蒙版修改说明"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm"
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
            <button
              type="button"
              className={`${primaryCls} mt-3`}
              disabled={working || props.busy || !maskDrawn || !instruction.trim()}
              onClick={() =>
                props.onInstruct(
                  node,
                  `只重点修改图中被橙色涂抹标记的区域：${instruction.trim()}；其余区域的主体、构图、色调尽量保持不变`,
                  "蒙版编辑",
                )
              }
            >
              按蒙版说明生成新节点
            </button>
          </>
        )}

        {tool === "split" && (
          <>
            <img src={node.url} alt={node.title} className="mx-auto block w-full max-w-sm rounded-md" draggable={false} />
            <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
              把这张图按 2×2 切成 4 张，分别生成新节点连在本图后面，方便逐块再加工。
            </p>
            <button type="button" className={`${primaryCls} mt-3`} disabled={working} onClick={() => void doSplit()}>
              {working ? "切分中…" : "切分为 4 个新节点"}
            </button>
          </>
        )}

        {tool === "upscale" && (
          <>
            <img src={node.url} alt={node.title} className="mx-auto block w-full max-w-sm rounded-md" draggable={false} />
            <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
              把这张图放大到 2 倍分辨率（高质量平滑放大），结果存为新节点。放大不会凭空增加原图没有的细节。
            </p>
            <button type="button" className={`${primaryCls} mt-3`} disabled={working} onClick={() => void doUpscale()}>
              {working ? "放大中…" : "放大 2× 并存为新节点"}
            </button>
          </>
        )}

        {tool === "angle" && (
          <>
            <img src={node.url} alt={node.title} className="mx-auto block w-full max-w-sm rounded-md" draggable={false} />
            <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
              选一个新视角，图生图会保持主体与氛围、换角度重新生成一张，结果存为新节点。
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {ANGLES.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className={btnCls}
                  disabled={props.busy}
                  aria-label={`生成${a.label}视角`}
                  onClick={() => props.onInstruct(node, a.instruction, a.label)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs text-[#ff7a5c]">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
