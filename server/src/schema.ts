import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per canvas project. The whole node/edge graph lives in `graph`
// as a JSON document authored by the canvas editor.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  graph: text("graph").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per "generate & compose film" request queued from the tool.
// The request carries the ordered shot list (blob keys, prompts, captions,
// durations) so the background Muse task can read it back through the
// getFilmRequest action, generate one true-motion clip per shot chat-side,
// and save the finished film back via importFilmFromWorkspace: the
// task drops the delivery encode at ~/workspace/film-delivery/<id>/
// delivery.mp4, the tool reads it host-side (privileged contracts) and
// stores it as ≤32KB hash-verified chunks under a sealed assembly
// manifest, which flips the
// row to done and stores the assembly marker in film_blob_key.
export const filmRequests = sqliteTable("film_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  packageNodeId: text("package_node_id").notNull().default(""),
  status: text("status", { enum: ["queued", "running", "done", "failed"] })
    .notNull()
    .default("queued"),
  shotsJson: text("shots_json").notNull().default("[]"),
  shotCount: integer("shot_count").notNull().default(0),
  // Live progress reported by the background film task while it works:
  // how many shot clips are finished (0..shotCount) and a short stage
  // label (e.g. 正在剪辑合成）. The page polls these and renders a real,
  // moving progress bar + elapsed timer instead of a static note.
  progressDone: integer("progress_done").notNull().default(0),
  progressStage: text("progress_stage").notNull().default(""),
  filmBlobKey: text("film_blob_key").notNull().default(""),
  error: text("error").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per "Agent 一句话成片" production run. startAgentProduction
// creates a brand-new project plus one of these rows; the server-side
// build (script → asset lock → storyboard images) advances the status
// through scripting → assets → storyboarding, then either waits in
// awaiting_confirm (step mode, or when some shot images failed) or goes
// straight into the background film pipeline (filming → scoring →
// editing → saving → done). Progress fields mirror film_requests so the
// page can render a real progress bar, and updated_at drives the same
// stall detection (5 min warn / 15 min auto-fail / 45 min hard cap).
export const agentRuns = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  instruction: text("instruction").notNull().default(""),
  targetDuration: integer("target_duration").notNull().default(0),
  aspect: text("aspect").notNull().default("16:9"),
  style: text("style").notNull().default(""),
  mode: text("mode", { enum: ["auto", "step"] }).notNull().default("auto"),
  status: text("status", {
    enum: [
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
    ],
  })
    .notNull()
    .default("queued"),
  progressDone: integer("progress_done").notNull().default(0),
  progressTotal: integer("progress_total").notNull().default(0),
  progressStage: text("progress_stage").notNull().default(""),
  packageNodeId: text("package_node_id").notNull().default(""),
  filmRequestId: integer("film_request_id").notNull().default(0),
  musicMood: text("music_mood").notNull().default(""),
  error: text("error").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per chunked film save. The finished film is NEVER sent as one
// whole-file base64 action argument again — that channel proved fatal
// five times in one day (mangled bytes stored unchecked, tasks dying
// mid-call with the request hanging until a timeout). Instead the
// background task registers an assembly here (chunk count, total bytes,
// whole-file SHA-256), uploads the film as ordered ≤32KB chunks (one
// film_chunks row + one blob each, every chunk hash-verified by the
// server at ingest), and finalizeFilmSave seals the assembly only when
// every chunk is present with its declared size. The film_requests row's
// film_blob_key then holds the marker `film-assembly:<requestId>`; the
// client reassembles the chunks in the browser and verifies the whole
// file's length + SHA-256 + MP4 structure before playing/downloading.
export const filmAssemblies = sqliteTable("film_assemblies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestId: integer("request_id").notNull(),
  projectId: integer("project_id").notNull(),
  packageNodeId: text("package_node_id").notNull().default(""),
  chunkCount: integer("chunk_count").notNull().default(0),
  totalBytes: integer("total_bytes").notNull().default(0),
  sha256: text("sha256").notNull().default(""),
  mime: text("mime").notNull().default("video/mp4"),
  // Blob key of the OPTIONAL whole-file copy of the sealed film. The
  // chunked store above remains the integrity record of truth; this
  // single blob exists purely so playback/download can fetch the
  // complete MP4 in ONE request instead of reassembling chunks in the
  // browser on every click. Written at import/replace time (the server
  // holds the whole file then) or materialized later by getFilmFile;
  // empty when no whole-file copy exists yet — readers then fall back
  // to the chunked assembly path.
  fullBlobKey: text("full_blob_key").notNull().default(""),
  status: text("status", { enum: ["open", "sealed"] }).notNull().default("open"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per uploaded film chunk: its blob key, exact byte length, and
// the SHA-256 the server computed over the bytes it actually received
// (compared against the sender's declared hash before storing).
export const filmChunks = sqliteTable("film_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  assemblyId: integer("assembly_id").notNull(),
  idx: integer("idx").notNull(),
  blobKey: text("blob_key").notNull().default(""),
  byteLength: integer("byte_length").notNull().default(0),
  sha256: text("sha256").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per finished generation (image or composed video), so the
// history rail can show everything the user has made in a project.
export const generations = sqliteTable("generations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  kind: text("kind", { enum: ["image", "video"] }).notNull(),
  prompt: text("prompt").notNull().default(""),
  blobKey: text("blob_key").notNull(),
  nodeId: text("node_id").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
