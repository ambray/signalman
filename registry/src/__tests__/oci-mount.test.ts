// WS10 M2 — mountOciRoutes composition tests. The mount module is a
// thin composition layer; the integration suite already exercises
// the wired routes end-to-end. These tests pin the per-option-branch
// conditional spreads so an accidental shape change there shows up
// before it surfaces as a runtime regression.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { Router } from "../http/router.js";
import { mountOciRoutes } from "../oci/index.js";

describe("mountOciRoutes (composition)", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-mount-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("mounts with default opts and returns live handles", () => {
    const router = new Router();
    const handles = mountOciRoutes(router, {
      storage,
      index: storage.index,
      blobStore: storage.blobStore,
    });
    expect(handles.uploadStore).toBeDefined();
    expect(handles.uploadFs).toBeDefined();
    expect(handles.reaper).toBeDefined();
    handles.stop();
  });

  it("threads every optional knob through to the inner stores", () => {
    const router = new Router();
    const FIXED_NOW = new Date("2026-05-16T00:00:00.000Z");
    const handles = mountOciRoutes(router, {
      storage,
      index: storage.index,
      blobStore: storage.blobStore,
      publicBaseUrl: "https://reg.example.com",
      reaperIntervalMs: 60 * 60 * 1000,
      uploadTtlSeconds: 60,
      maxChunkBytes: 1024,
      now: () => FIXED_NOW,
    });
    const row = handles.uploadStore.create("oci/acme/svc", "sk_TEST");
    expect(row.createdAt).toBe(FIXED_NOW.toISOString());
    // Custom TTL = 60s
    const expected = new Date(FIXED_NOW.getTime() + 60 * 1000).toISOString();
    expect(row.expiresAt).toBe(expected);
    handles.stop();
  });

  it("reaperSweep handle reaps the seeded upload after stop()", async () => {
    const router = new Router();
    const handles = mountOciRoutes(router, {
      storage,
      index: storage.index,
      blobStore: storage.blobStore,
      reaperIntervalMs: 60 * 60 * 1000,
      uploadTtlSeconds: 0,
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });
    handles.uploadStore.create("oci/acme/svc", "sk_TEST");
    const reaped = await handles.reaperSweep();
    expect(reaped).toBe(1);
    handles.stop();
  });

  it("stop() is idempotent", () => {
    const router = new Router();
    const handles = mountOciRoutes(router, {
      storage,
      index: storage.index,
      blobStore: storage.blobStore,
    });
    handles.stop();
    handles.stop();
    handles.stop();
  });
});
