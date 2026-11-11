// Privileged (host-side) handlers for the film save path.
//
// Why this exists: the finished film's bytes must never travel through
// the background agent's own tool-call output. Three live runs proved
// that channel unusable for bulk data — agents registered a chunked
// save (beginFilmSave landed) and then never landed a single chunk
// payload, at 256KB and at 32KB chunk sizes alike; the one task that
// did report back said its delivery file had been overwritten. The
// agent instead writes the delivery encode to a fixed drop path on
// this host (it runs on the same machine — its films have always lived
// under ~/workspace), and these handlers read it back host-side, where
// bytes cost no model output at all. The calling action then runs the
// exact same per-chunk hash verification, blob storage, and sealing as
// the manual saveFilmChunk path.
//
// The filesystem surface is deliberately minimal: the path is DERIVED
// from the numeric film-request id alone
// (~/workspace/film-delivery/<requestId>/delivery.mp4). No
// caller-supplied path, name, or segment ever reaches the filesystem,
// so there is nothing to traverse.

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

function deliveryFilePath(requestId: number): string {
  return join(
    homedir(),
    "workspace",
    "film-delivery",
    String(requestId),
    "delivery.mp4",
  );
}

export const contracts = definePrivilegedContracts({
  filmFileInfo: {
    request: z.object({ requestId: z.number().int().positive() }),
    response: z.object({
      found: z.boolean(),
      totalBytes: z.number(),
      sha256: z.string(),
    }),
    timeoutMs: 120_000,
  },
  readFilmChunk: {
    request: z.object({
      requestId: z.number().int().positive(),
      index: z.number().int().min(0),
      chunkBytes: z.number().int().positive().max(1024 * 1024),
    }),
    response: z.object({
      dataBase64: z.string(),
      byteLength: z.number(),
      sha256: z.string(),
    }),
    timeoutMs: 60_000,
  },
});

export const handlers = definePrivilegedHandlers(contracts, {
  async filmFileInfo({ requestId }) {
    const path = deliveryFilePath(requestId);
    try {
      const st = await stat(path);
      if (!st.isFile() || st.size <= 0) {
        return { found: false, totalBytes: 0, sha256: "" };
      }
      const hash = createHash("sha256");
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(1024 * 1024);
        let pos = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (bytesRead === 0) break;
          hash.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
      } finally {
        await fh.close();
      }
      return { found: true, totalBytes: st.size, sha256: hash.digest("hex") };
    } catch {
      return { found: false, totalBytes: 0, sha256: "" };
    }
  },

  async readFilmChunk({ requestId, index, chunkBytes }) {
    const path = deliveryFilePath(requestId);
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(chunkBytes);
      const { bytesRead } = await fh.read(buf, 0, chunkBytes, index * chunkBytes);
      const slice = buf.subarray(0, bytesRead);
      return {
        dataBase64: slice.toString("base64"),
        byteLength: bytesRead,
        sha256: createHash("sha256").update(slice).digest("hex"),
      };
    } finally {
      await fh.close();
    }
  },
});
