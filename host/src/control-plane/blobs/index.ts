/**
 * Blob driver factory and re-exports.
 *
 * v0.2.0 ships local FS only; S3-compatible lands in v0.3.0
 * (self-hosted phase) — see docs/design/meta-build-system.md §12.
 */

import { LocalFsBlobDriver } from "./local-fs.js";
import type { BlobDriver } from "./driver.js";

export type { BlobDriver, BlobMetadata } from "./driver.js";
export { BlobNotFoundError } from "./driver.js";
export { LocalFsBlobDriver } from "./local-fs.js";

export interface BlobConfig {
  driver: "local" | "s3";
  root: string;
}

export function createBlobDriver(config: BlobConfig): BlobDriver {
  switch (config.driver) {
    case "local":
      return new LocalFsBlobDriver({ root: config.root });
    case "s3":
      throw new Error(
        "S3 blob driver is not implemented in v0.2.0 (planned for v0.3.0 self-hosted phase)",
      );
    default: {
      const exhaustive: never = config.driver;
      throw new Error(`unknown blob driver: ${exhaustive as string}`);
    }
  }
}
