/**
 * Storage driver factory and re-exports.
 *
 * The factory selects a driver from `controlPlane.storage` config.
 * v0.2 ships SQLite; v0.3 adds Postgres for self-hosted-large
 * deployments — see docs/design/meta-build-system.md §12.
 */

import { PostgresStorageDriver } from "./postgres.js";
import { SqliteStorageDriver } from "./sqlite.js";
import type { StorageDriver } from "./driver.js";

export type {
  ApiKeyRepo,
  ArtifactRepo,
  AuditLogRepo,
  DeploymentRepo,
  HealthCheckRepo,
  HealthScheduleRepo,
  OrgRepo,
  ProductRepo,
  ReleaseRepo,
  RunRepo,
  ScenarioRepo,
  StorageDriver,
  TargetRepo,
} from "./driver.js";
export {
  NotImplementedError,
  StorageConflictError,
  StorageNotFoundError,
} from "./driver.js";
export { SqliteStorageDriver } from "./sqlite.js";
export { PostgresStorageDriver } from "./postgres.js";

export interface StorageConfig {
  driver: "sqlite" | "postgres";
  url: string;
}

/** Build a StorageDriver from config. Caller is responsible for `.migrate()`. */
export function createStorageDriver(config: StorageConfig): StorageDriver {
  switch (config.driver) {
    case "sqlite":
      return new SqliteStorageDriver({ path: config.url });
    case "postgres":
      return new PostgresStorageDriver({ connectionString: config.url });
    default: {
      const exhaustive: never = config.driver;
      throw new Error(`unknown storage driver: ${exhaustive as string}`);
    }
  }
}
