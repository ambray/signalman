/**
 * P9.5 — VmTemplate validation + async resolve tests.
 *
 * The existing orchestrator.test.ts already covers
 * `loadTemplates` / `resolveTemplate` (sync). These tests focus on
 * the new P9.5 surfaces:
 *   - validateTemplateImageSource (path/url/sha rules)
 *   - resolveTemplateAsync (BYO -> path stat, URL -> fetchTemplateImage)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  validateTemplateImageSource,
  resolveTemplateAsync,
  type VmTemplate,
} from "../scenarios/templates.js";

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function fakeFetch(body: Buffer): typeof fetch {
  return (async () => {
    const nodeStream = Readable.from(body);
    const webStream = Readable.toWeb(
      nodeStream,
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(webStream, {
      status: 200,
      headers: { "content-length": String(body.length) },
    });
  }) as unknown as typeof fetch;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-tmpl-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

// ── validateTemplateImageSource ───────────────────────────────────

describe("validateTemplateImageSource", () => {
  it("accepts a template with neither field (abstract)", () => {
    const t: VmTemplate = { name: "abstract" };
    expect(() => validateTemplateImageSource(t)).not.toThrow();
  });

  it("accepts a BYO template with only base_image_path", () => {
    const t: VmTemplate = {
      name: "byo",
      base_image_path: "D:/images/win11.vhdx",
    };
    expect(() => validateTemplateImageSource(t)).not.toThrow();
  });

  it("accepts a URL template with both url + sha", () => {
    const t: VmTemplate = {
      name: "url",
      base_image_url: "https://example.com/x.vhdx",
      base_image_sha256: "a".repeat(64),
    };
    expect(() => validateTemplateImageSource(t)).not.toThrow();
  });

  it("rejects mixed _path + _url (operator must pick one)", () => {
    const t: VmTemplate = {
      name: "mixed",
      base_image_path: "D:/images/win11.vhdx",
      base_image_url: "https://example.com/x.vhdx",
      base_image_sha256: "a".repeat(64),
    };
    expect(() => validateTemplateImageSource(t)).toThrow(/Pick one/);
  });

  it("rejects base_image_url without base_image_sha256", () => {
    const t: VmTemplate = {
      name: "no-sha",
      base_image_url: "https://example.com/x.vhdx",
    };
    expect(() => validateTemplateImageSource(t)).toThrow(
      /SHA-256 is required/,
    );
  });

  it("rejects http:// base_image_url", () => {
    const t: VmTemplate = {
      name: "plain-http",
      base_image_url: "http://example.com/x.vhdx",
      base_image_sha256: "a".repeat(64),
    };
    expect(() => validateTemplateImageSource(t)).toThrow(/non-HTTPS/);
  });

  it("rejects malformed base_image_sha256", () => {
    const t: VmTemplate = {
      name: "bad-sha",
      base_image_url: "https://example.com/x.vhdx",
      base_image_sha256: "not-hex",
    };
    expect(() => validateTemplateImageSource(t)).toThrow(/Invalid SHA-256/);
  });

  it("rejects orphaned sha256 (no url)", () => {
    const t: VmTemplate = {
      name: "orphan-sha",
      base_image_sha256: "a".repeat(64),
    };
    expect(() => validateTemplateImageSource(t)).toThrow(/orphaned SHA/);
  });
});

// ── resolveTemplateAsync ──────────────────────────────────────────

describe("resolveTemplateAsync", () => {
  it("populates vhdxPath from base_image_path for BYO templates", async () => {
    const fakeVhdx = path.join(tmpRoot, "byo.vhdx");
    fs.writeFileSync(fakeVhdx, "byo-bytes");

    const registry = new Map<string, VmTemplate>();
    registry.set("byo", {
      name: "byo",
      base_image_path: fakeVhdx,
    });

    const resolved = await resolveTemplateAsync("byo", { templates: registry });
    expect(resolved.vhdxPath).toBe(path.resolve(fakeVhdx));
    // Did NOT trigger a fetch.
    expect(resolved.fetchResult).toBeUndefined();
  });

  it("throws when BYO base_image_path doesn't exist", async () => {
    const registry = new Map<string, VmTemplate>();
    registry.set("byo-missing", {
      name: "byo-missing",
      base_image_path: path.join(tmpRoot, "does-not-exist.vhdx"),
    });

    await expect(
      resolveTemplateAsync("byo-missing", { templates: registry }),
    ).rejects.toThrow(/does not exist on disk/);
  });

  it("calls fetchTemplateImage for URL-form templates", async () => {
    const body = Buffer.from("downloaded-vhdx-bytes");
    const sha = sha256Hex(body);

    const registry = new Map<string, VmTemplate>();
    registry.set("url-tmpl", {
      name: "url-tmpl",
      base_image_url: "https://example.com/x.vhdx",
      base_image_sha256: sha,
    });

    const resolved = await resolveTemplateAsync("url-tmpl", {
      templates: registry,
      cacheDir: tmpRoot,
      fetchImpl: fakeFetch(body),
    });

    expect(resolved.vhdxPath).toBeDefined();
    expect(fs.existsSync(resolved.vhdxPath!)).toBe(true);
    expect(resolved.fetchResult).toBeDefined();
    expect(resolved.fetchResult?.cached).toBe(false);
    expect(resolved.fetchResult?.sizeBytes).toBe(body.length);
  });

  it("returns vhdxPath undefined for abstract templates (no source declared)", async () => {
    const registry = new Map<string, VmTemplate>();
    registry.set("abstract", { name: "abstract" });

    const resolved = await resolveTemplateAsync("abstract", {
      templates: registry,
    });
    expect(resolved.vhdxPath).toBeUndefined();
    expect(resolved.fetchResult).toBeUndefined();
  });

  it("does not mutate the registry-backed template object", async () => {
    const fakeVhdx = path.join(tmpRoot, "noclobber.vhdx");
    fs.writeFileSync(fakeVhdx, "x");

    const registry = new Map<string, VmTemplate>();
    const original: VmTemplate = {
      name: "noclobber",
      base_image_path: fakeVhdx,
    };
    registry.set("noclobber", original);

    const resolved = await resolveTemplateAsync("noclobber", {
      templates: registry,
    });
    expect(resolved.vhdxPath).toBeDefined();
    // Original untouched.
    expect(original.vhdxPath).toBeUndefined();
  });

  it("propagates SHA mismatch errors from fetchTemplateImage", async () => {
    const body = Buffer.from("body-bytes");
    const wrongSha = "0".repeat(64);

    const registry = new Map<string, VmTemplate>();
    registry.set("bad-sha", {
      name: "bad-sha",
      base_image_url: "https://example.com/x.vhdx",
      base_image_sha256: wrongSha,
    });

    await expect(
      resolveTemplateAsync("bad-sha", {
        templates: registry,
        cacheDir: tmpRoot,
        fetchImpl: fakeFetch(body),
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
  });
});
