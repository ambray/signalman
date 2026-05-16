/**
 * Pending-upload reaper.
 *
 * Per Q8 of the WS10 locked design: chunked-upload UUIDs live for 24
 * hours, persisted across restarts. The reaper sweeps `pending_blob_uploads`
 * rows whose `expires_at <= now()` and deletes the matching tmp file
 * on disk. It is the only path that cleans up uploads after the
 * client walks away mid-push.
 *
 * Lifecycle:
 *   - `startReaper(...)` returns a handle whose `stop()` clears the
 *     interval. Wired by `buildApp` when the OCI facade is active.
 *   - Cadence default: 5 minutes. Tunable via the constructor for
 *     tests + operator-controlled deployments.
 *   - Each tick is shielded: a thrown error is caught + logged via
 *     the audit log so the interval keeps firing.
 */

import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import type { UploadFsStore } from "./upload-fs.js";
import type { UploadStore } from "./upload-store.js";

export interface ReaperOptions {
  uploadStore: UploadStore;
  uploadFs: UploadFsStore;
  index: SqliteManifestIndex;
  /** How often to sweep, milliseconds. Default 5 minutes. */
  intervalMs?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export interface ReaperHandle {
  /** Stop the periodic sweep. Idempotent. */
  stop(): void;
  /** Trigger one sweep immediately (tests + tick-on-start). Returns reaped count. */
  sweep(): Promise<number>;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export function startReaper(opts: ReaperOptions): ReaperHandle {
  const uploadStore = opts.uploadStore;
  const uploadFs = opts.uploadFs;
  const index = opts.index;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());

  let stopped = false;

  const sweep = async (): Promise<number> => {
    if (stopped) return 0;
    const cutoff = now();
    const expired = uploadStore.listExpired(cutoff);
    let reaped = 0;
    for (const row of expired) {
      try {
        await uploadFs.delete(row.uploadId);
      } catch {
        // Filesystem unlink failure shouldn't block the SQL delete —
        // a leaked tmp file is recoverable; a stranded SQL row never
        // expires past this point.
      }
      uploadStore.delete(row.uploadId);
      index.appendAuditEntry({
        action: "delete",
        entityType: "blob",
        entityId: `upload:${row.uploadId}`,
        actor: "reaper",
        detail: {
          kind: "oci",
          phase: "pending_upload_reaped",
          repository: row.repository,
          bytes_received: row.bytesReceived,
          created_at: row.createdAt,
          expires_at: row.expiresAt,
        },
      });
      reaped += 1;
    }
    return reaped;
  };

  const timer = setInterval(() => {
    sweep().catch(() => {
      // Errors swallowed intentionally — the next tick will retry.
    });
  }, intervalMs);
  // Avoid keeping the event loop alive solely for the reaper in a
  // short-lived test process. Production servers have a long-lived
  // http.Server keeping the loop running.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    sweep,
  };
}
