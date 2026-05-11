/**
 * Blob driver factory and re-exports.
 *
 * v0.2 ships local FS; v0.3 adds S3 for shared-runner deployments.
 * Config selects via `controlPlane.blobs.driver` ("local" | "s3").
 */

import { LocalFsBlobDriver } from "./local-fs.js";
import { S3BlobDriver, type S3BlobOptions } from "./s3.js";
import type { BlobDriver } from "./driver.js";

export type { BlobDriver, BlobMetadata } from "./driver.js";
export { BlobNotFoundError } from "./driver.js";
export { LocalFsBlobDriver } from "./local-fs.js";
export { S3BlobDriver } from "./s3.js";
export type { S3BlobOptions } from "./s3.js";

/**
 * Tagged-union config. Local mode uses `root`; S3 mode uses
 * bucket/prefix/region/credentials. Discriminator keeps the
 * SignalmanConfig type narrow at the call site.
 */
export type BlobConfig =
  | { driver: "local"; root: string }
  | {
      driver: "s3";
      bucket: string;
      prefix?: string;
      region?: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };

export function createBlobDriver(config: BlobConfig): BlobDriver {
  switch (config.driver) {
    case "local":
      return new LocalFsBlobDriver({ root: config.root });
    case "s3": {
      const s3Opts: S3BlobOptions = {
        bucket: config.bucket,
        prefix: config.prefix,
        clientConfig: {
          ...(config.region ? { region: config.region } : {}),
          ...(config.endpoint ? { endpoint: config.endpoint } : {}),
          ...(config.accessKeyId && config.secretAccessKey
            ? {
                credentials: {
                  accessKeyId: config.accessKeyId,
                  secretAccessKey: config.secretAccessKey,
                },
              }
            : {}),
        },
      };
      return new S3BlobDriver(s3Opts);
    }
    default: {
      const exhaustive: never = config;
      throw new Error(
        `unknown blob driver: ${(exhaustive as { driver: string }).driver}`,
      );
    }
  }
}
