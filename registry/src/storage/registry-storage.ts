/**
 * `LocalFsRegistryStorage` composes the LocalFsBlobStore (bytes
 * on disk) and the SqliteManifestIndex (catalog rows in SQLite)
 * into a single `RegistryStorage` surface. The HTTP layer and
 * tests pass this around; production deployments build it via
 * `LocalFsRegistryStorage.fromRoot(root)`.
 *
 * Future drivers (S3, Postgres-indexed, signalman-registry-fronted)
 * implement the same `RegistryStorage` interface; the HTTP layer
 * does not know which is wired underneath.
 */

import * as path from "node:path";
import type { Readable } from "node:stream";
import { LocalFsBlobStore } from "./local-fs.js";
import type { LocalFsBlobStoreOptions } from "./local-fs.js";
import { SqliteManifestIndex } from "./sqlite-index.js";
import { canonicalManifestBytes } from "../signing.js";
import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type Blob,
  type ListedManifest,
  type Manifest,
  type Provenance,
  type RegistryStorage,
} from "../types.js";

export interface LocalFsRegistryStorageOptions {
  blobStore: LocalFsBlobStore;
  index: SqliteManifestIndex;
}

export class LocalFsRegistryStorage implements RegistryStorage {
  readonly blobStore: LocalFsBlobStore;
  readonly index: SqliteManifestIndex;

  constructor(opts: LocalFsRegistryStorageOptions) {
    this.blobStore = opts.blobStore;
    this.index = opts.index;
  }

  /**
   * Convenience factory for the common case: one storage root
   * containing both the blob tree and the SQLite catalog file.
   */
  static fromRoot(
    root: string,
    options: { now?: LocalFsBlobStoreOptions["now"] } = {},
  ): LocalFsRegistryStorage {
    const blobStore = new LocalFsBlobStore({
      root,
      ...(options.now ? { now: options.now } : {}),
    });
    const index = new SqliteManifestIndex({
      path: path.join(root, "registry.db"),
      ...(options.now ? { now: options.now } : {}),
    });
    return new LocalFsRegistryStorage({ blobStore, index });
  }

  async putBlob(input: {
    body: Buffer | Readable;
    contentType?: string;
  }): Promise<Blob> {
    const stored = await this.blobStore.putBlob(input);
    this.index.recordBlob(stored);
    return stored;
  }

  async getBlob(sha256: string): Promise<Readable> {
    return this.blobStore.getBlob(sha256);
  }

  async statBlob(sha256: string): Promise<Blob | null> {
    // Prefer the SQLite mirror for snappy stat; fall back to the
    // filesystem when the mirror is missing (e.g. recovered store
    // where the catalog was rebuilt from disk and the blob landed
    // before the mirror row).
    return (
      this.index.getBlobRecord(sha256) ?? (await this.blobStore.statBlob(sha256))
    );
  }

  async putManifest(
    manifest: Manifest,
    provenance?: Provenance,
  ): Promise<Manifest> {
    // Reject manifests that pin blobs the registry has never seen.
    // Catches accidental cross-registry refs and the order-of-ops
    // bug where a CI script uploads the manifest before the blobs.
    for (const ref of manifest.blobs) {
      const present = await this.statBlob(ref.sha256);
      if (!present) {
        throw new RegistryError(
          REGISTRY_ERROR_CODES.BLOB_NOT_FOUND,
          `manifest references unknown blob: ${ref.sha256}`,
        );
      }
    }
    const canonical = canonicalManifestBytes(manifest);
    return this.index.putManifest(manifest, canonical, provenance);
  }

  /** WS6 wave-3 (M10.1): row-side provenance. */
  async getProvenance(name: string, version: string): Promise<Provenance | null> {
    return this.index.getProvenance(name, version);
  }

  async getManifest(name: string, version: string): Promise<Manifest | null> {
    return this.index.getManifest(name, version);
  }

  async getCanonicalManifestBytes(
    name: string,
    version: string,
  ): Promise<Buffer | null> {
    return this.index.getCanonicalBytes(name, version);
  }

  async listManifestVersions(name: string): Promise<ListedManifest[]> {
    return this.index.listManifestVersions(name);
  }

  async deleteManifest(name: string, version: string): Promise<void> {
    this.index.deleteManifest(name, version);
  }

  close(): void {
    this.index.close();
  }
}
