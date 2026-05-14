/**
 * ControlPlane — facade over storage + blob drivers.
 *
 * In v0.2.0 (local mode) the ControlPlane runs in-process inside the
 * CLI; verbs hold a ControlPlane instance and call its repos directly.
 * In v0.3.0+ (self-hosted, hosted) a separate `signalman serve`
 * process owns the ControlPlane and exposes it over HTTP — runners
 * become HTTP clients of that surface. The `ControlPlane` class is the
 * boundary that future split crosses; verb code should depend on this
 * facade, not on `SqliteStorageDriver` or `LocalFsBlobDriver` directly.
 *
 * See docs/design/meta-build-system.md §3 for the layered architecture.
 */

import * as os from "node:os";
import * as path from "node:path";
import { ensureDefaultOrg, DEFAULT_ORG_NAME } from "./bootstrap.js";
import {
  type BlobConfig,
  type BlobDriver,
  createBlobDriver,
} from "./blobs/index.js";
import {
  type StorageConfig,
  type StorageDriver,
  createStorageDriver,
} from "./storage/index.js";
import type { SignalmanConfig } from "../config.js";
import type { Org } from "./types.js";

export { DEFAULT_ORG_NAME, ensureDefaultOrg };
export type { Org } from "./types.js";
export type { StorageDriver, BlobDriver };

/**
 * Resolved control-plane config — either the user provided one, or
 * defaults derived from `SIGNALMAN_DATA_DIR` (env) or `~/.signalman/`.
 */
export interface ResolvedControlPlaneConfig {
  storage: StorageConfig;
  blobs: BlobConfig;
}

export function resolveControlPlaneConfig(
  config?: SignalmanConfig["controlPlane"],
): ResolvedControlPlaneConfig {
  const dataDir =
    process.env.SIGNALMAN_DATA_DIR && process.env.SIGNALMAN_DATA_DIR.length > 0
      ? path.resolve(process.env.SIGNALMAN_DATA_DIR)
      : path.join(os.homedir(), ".signalman");
  return {
    storage: config?.storage ?? {
      driver: "sqlite",
      url: path.join(dataDir, "signalman.db"),
    },
    blobs: config?.blobs ?? {
      driver: "local",
      root: path.join(dataDir, "blobs"),
    },
  };
}

export class ControlPlane {
  private constructor(
    readonly storage: StorageDriver,
    readonly blobs: BlobDriver,
    readonly resolvedConfig: ResolvedControlPlaneConfig,
  ) {}

  /** Construct from resolved config. Does NOT run migrations or bootstrap; call `init()` for that. */
  static create(config: ResolvedControlPlaneConfig): ControlPlane {
    const storage = createStorageDriver(config.storage);
    const blobs = createBlobDriver(config.blobs);
    return new ControlPlane(storage, blobs, config);
  }

  /** Convenience: resolve config + create. */
  static fromConfig(config?: SignalmanConfig["controlPlane"]): ControlPlane {
    return ControlPlane.create(resolveControlPlaneConfig(config));
  }

  /**
   * Run pending migrations and ensure the default org exists. Safe to
   * call repeatedly. Returns the default org for callers that want to
   * pin an org-scoped operation immediately.
   */
  async init(): Promise<{ defaultOrg: Org }> {
    await this.storage.migrate();
    const defaultOrg = await ensureDefaultOrg(this.storage);
    return { defaultOrg };
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  // ── Convenience accessors (forward to storage repos) ─────────────

  get orgs() {
    return this.storage.orgs;
  }
  get apiKeys() {
    return this.storage.apiKeys;
  }
  get products() {
    return this.storage.products;
  }
  get releases() {
    return this.storage.releases;
  }
  get artifacts() {
    return this.storage.artifacts;
  }
  get auditLog() {
    return this.storage.auditLog;
  }
  get targets() {
    return this.storage.targets;
  }
  get deployments() {
    return this.storage.deployments;
  }
  get healthChecks() {
    return this.storage.healthChecks;
  }
  get scenarios() {
    return this.storage.scenarios;
  }
  get runs() {
    return this.storage.runs;
  }
  get jobs() {
    return this.storage.jobs;
  }
  // v0.3.0-5 sub-task 5 — cloud cost guardrails:
  get cloudBudgets() {
    return this.storage.cloudBudgets;
  }
  get cloudUsage() {
    return this.storage.cloudUsage;
  }
  // v0.3.0-5 sub-task 6 — per-org credentials at rest:
  get cloudCredentials() {
    return this.storage.cloudCredentials;
  }
  // v0.4.0-3 (Epic 3, WS3) — scheduled health checks:
  get healthSchedules() {
    return this.storage.healthSchedules;
  }
  get webhookSubscriptions() {
    return this.storage.webhookSubscriptions;
  }
}
