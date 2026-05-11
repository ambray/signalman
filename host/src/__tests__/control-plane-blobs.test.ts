/**
 * Tests for LocalFsBlobDriver — content-addressed local FS blob store.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsBlobDriver } from "../control-plane/blobs/local-fs.js";
import { BlobNotFoundError } from "../control-plane/blobs/driver.js";

let root: string;
let driver: LocalFsBlobDriver;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-blobs-"));
  driver = new LocalFsBlobDriver({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe("put", () => {
  it("stores a buffer and returns hash + size", async () => {
    const body = Buffer.from("hello world");
    const expectedSha = crypto.createHash("sha256").update(body).digest("hex");
    const meta = await driver.put({ orgId: "org_1", body });
    expect(meta.sha256).toBe(expectedSha);
    expect(meta.size).toBe(body.length);
    expect(meta.uri).toMatch(/^file:\/\//);
  });

  it("stores a stream and computes hash correctly", async () => {
    const body = crypto.randomBytes(64 * 1024);
    const expectedSha = crypto.createHash("sha256").update(body).digest("hex");
    const meta = await driver.put({ orgId: "org_1", body: Readable.from(body) });
    expect(meta.sha256).toBe(expectedSha);
    expect(meta.size).toBe(body.length);
  });

  it("dedupes identical content (second put hits the same path)", async () => {
    const body = Buffer.from("dup");
    const a = await driver.put({ orgId: "org_1", body });
    const b = await driver.put({ orgId: "org_1", body });
    expect(b.uri).toBe(a.uri);
    expect(b.sha256).toBe(a.sha256);
  });

  it("isolates orgs on disk", async () => {
    const body = Buffer.from("xx");
    const a = await driver.put({ orgId: "org_a", body });
    const b = await driver.put({ orgId: "org_b", body });
    // Same content, different orgs → different paths even though
    // sha matches.
    expect(a.uri).not.toBe(b.uri);
    expect(a.sha256).toBe(b.sha256);
  });

  it("rejects an org id that contains path separators", async () => {
    await expect(
      driver.put({ orgId: "../etc", body: Buffer.from("x") }),
    ).rejects.toThrow(/invalid org id/);
  });
});

describe("get / exists / delete", () => {
  it("round-trips put → get", async () => {
    const body = Buffer.from("payload");
    const meta = await driver.put({ orgId: "org_1", body });
    const stream = await driver.get(meta.uri);
    const round = await streamToBuffer(stream);
    expect(round.equals(body)).toBe(true);
  });

  it("get on a missing URI throws BlobNotFoundError", async () => {
    await expect(driver.get("file:///nope.bin")).rejects.toBeInstanceOf(
      BlobNotFoundError,
    );
  });

  it("exists reports correctly", async () => {
    const meta = await driver.put({
      orgId: "org_1",
      body: Buffer.from("hi"),
    });
    expect(await driver.exists(meta.uri)).toBe(true);
    await driver.delete(meta.uri);
    expect(await driver.exists(meta.uri)).toBe(false);
  });

  it("delete is idempotent", async () => {
    await expect(driver.delete("file:///nope.bin")).resolves.toBeUndefined();
  });

  it("rejects URIs that escape the root", async () => {
    // Construct a file:// URI pointing outside the blob root.
    const escape = `file:///${path.resolve(os.tmpdir(), "escape").replace(/\\/g, "/")}`;
    await expect(driver.get(escape)).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});

describe("presignGet", () => {
  it("returns the URI as-is for existing blobs", async () => {
    const meta = await driver.put({
      orgId: "org_1",
      body: Buffer.from("x"),
    });
    const url = await driver.presignGet(meta.uri, 60);
    expect(url).toBe(meta.uri);
  });

  it("throws on missing blobs", async () => {
    await expect(
      driver.presignGet("file:///gone.bin", 60),
    ).rejects.toBeInstanceOf(BlobNotFoundError);
  });
});
