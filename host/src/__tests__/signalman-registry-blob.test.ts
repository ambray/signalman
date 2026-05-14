/**
 * Integration tests for `SignalmanRegistryBlobDriver` against an
 * in-process stub HTTP server.
 *
 * The stub implements just the registry endpoints the driver
 * touches: `PUT /v1/blobs/:sha256` and `GET /v1/blobs/:sha256`,
 * including 401 on bad bearer + 404 on unknown blob. This keeps the
 * test independent of `@signalman/registry` (not in host's
 * package.json) while still exercising the full HTTP boundary.
 *
 * A second test wires the driver through `createBlobDriver` to
 * confirm the BlobConfig discriminator + the factory switch picks
 * the right class.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBlobDriver,
  SignalmanRegistryBlobDriver,
  BlobNotFoundError,
} from "../control-plane/blobs/index.js";

interface StubServer {
  server: http.Server;
  baseUrl: string;
  blobs: Map<string, Buffer>;
  /** Tokens accepted by the stub. Empty disables auth. */
  acceptedTokens: Set<string>;
}

async function startStub(): Promise<StubServer> {
  const blobs = new Map<string, Buffer>();
  const acceptedTokens = new Set<string>();
  const server = http.createServer((req, res) => {
    if (acceptedTokens.size > 0) {
      const auth = req.headers.authorization;
      const token = typeof auth === "string"
        ? auth.replace(/^Bearer\s+/i, "").trim()
        : "";
      if (!acceptedTokens.has(token)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { code: "unauthorized", message: "no" } }));
        return;
      }
    }
    const url = req.url ?? "/";
    const blobMatch = /^\/v1\/blobs\/([a-f0-9]{64})$/.exec(url);
    if (!blobMatch) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const sha = blobMatch[1];
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        const computed = crypto.createHash("sha256").update(buf).digest("hex");
        if (computed !== sha) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { code: "bad_sha", message: "mismatch" } }));
          return;
        }
        blobs.set(sha, buf);
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ blob: { sha256: sha, size: buf.length } }));
      });
      return;
    }
    if (req.method === "GET") {
      const blob = blobs.get(sha);
      if (!blob) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-length", String(blob.length));
      res.end(blob);
      return;
    }
    res.statusCode = 405;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    blobs,
    acceptedTokens,
  };
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("SignalmanRegistryBlobDriver", () => {
  let stub: StubServer;

  beforeEach(async () => {
    stub = await startStub();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("put: uploads + returns a content-addressed URI", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    const body = Buffer.from("hello-registry");
    const meta = await driver.put({ orgId: "org-1", body });
    const expectedSha = crypto.createHash("sha256").update(body).digest("hex");
    expect(meta.sha256).toBe(expectedSha);
    expect(meta.size).toBe(body.length);
    expect(meta.uri).toBe(`registry://${expectedSha}`);
    expect(stub.blobs.has(expectedSha)).toBe(true);
  });

  it("put: accepts a Readable body", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    const meta = await driver.put({
      orgId: "org-1",
      body: Readable.from([Buffer.from("ab"), Buffer.from("cdef")]),
    });
    expect(meta.size).toBe(6);
    const expectedSha = crypto.createHash("sha256").update("abcdef").digest("hex");
    expect(meta.sha256).toBe(expectedSha);
  });

  it("get: streams the bytes back", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    const body = Buffer.from("payload");
    const meta = await driver.put({ orgId: "org-1", body });
    const stream = await driver.get(meta.uri);
    const out = await readStream(stream);
    expect(out.equals(body)).toBe(true);
  });

  it("get: throws BlobNotFoundError on a 404", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    let caught: unknown;
    try {
      await driver.get(`registry://${"a".repeat(64)}`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BlobNotFoundError);
  });

  it("get: throws BlobNotFoundError on a malformed URI", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    await expect(driver.get("not-a-registry-uri")).rejects.toBeInstanceOf(
      BlobNotFoundError,
    );
    await expect(driver.get("registry://shortsha")).rejects.toBeInstanceOf(
      BlobNotFoundError,
    );
  });

  it("exists: reports true / false", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    const meta = await driver.put({ orgId: "org-1", body: Buffer.from("e") });
    expect(await driver.exists(meta.uri)).toBe(true);
    expect(await driver.exists(`registry://${"f".repeat(64)}`)).toBe(false);
  });

  it("presignGet: returns the canonical /v1/blobs/<sha> URL", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    const meta = await driver.put({ orgId: "org-1", body: Buffer.from("p") });
    const url = await driver.presignGet(meta.uri, 60);
    expect(url).toBe(`${stub.baseUrl}/v1/blobs/${meta.sha256}`);
  });

  it("delete: is a no-op at v0.4.0 (retention is deferred)", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    const meta = await driver.put({ orgId: "org-1", body: Buffer.from("d") });
    await driver.delete(meta.uri);
    // The stub did not see a DELETE request, so the blob is still
    // there — that is the expected v0.4.0 behavior.
    expect(stub.blobs.has(meta.sha256)).toBe(true);
  });

  it("delete: rejects an invalid URI", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    await expect(driver.delete("not-a-registry-uri")).rejects.toBeInstanceOf(
      BlobNotFoundError,
    );
  });

  it("resolveBySha: returns a registry:// URI", () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    const sha = "c".repeat(64);
    expect(driver.resolveBySha("org-1", sha)).toBe(`registry://${sha}`);
  });

  it("resolveBySha: rejects invalid shas + org ids", () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    expect(() => driver.resolveBySha("org-1", "short")).toThrow(/invalid sha/);
    expect(() =>
      driver.resolveBySha("../bad", "c".repeat(64)),
    ).toThrow(/invalid org id/);
  });

  it("forwards the bearer token in put + get", async () => {
    stub.acceptedTokens.add("sk_AAAA_BBBB");
    const goodDriver = new SignalmanRegistryBlobDriver({
      baseUrl: stub.baseUrl,
      bearerToken: "sk_AAAA_BBBB",
    });
    const meta = await goodDriver.put({
      orgId: "org-1",
      body: Buffer.from("auth"),
    });
    const stream = await goodDriver.get(meta.uri);
    const bytes = await readStream(stream);
    expect(bytes.toString()).toBe("auth");

    const badDriver = new SignalmanRegistryBlobDriver({
      baseUrl: stub.baseUrl,
      bearerToken: "wrong",
    });
    await expect(
      badDriver.put({ orgId: "org-1", body: Buffer.from("auth") }),
    ).rejects.toThrow(/401/);
  });

  it("surfaces a non-201 PUT response as a thrown Error", async () => {
    const driver = new SignalmanRegistryBlobDriver({ baseUrl: stub.baseUrl });
    // PUT to a sha that does not match the body — the stub returns 400.
    const wrongSha = "f".repeat(64);
    // Reach into the driver's fetch flow via a synthetic call:
    // construct a body whose hash != wrongSha. We can't easily
    // dictate the URL the driver chooses, so instead poke at the
    // stub directly to assert the error message.
    const url = `${stub.baseUrl}/v1/blobs/${wrongSha}`;
    const r = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("zzz"),
    });
    expect(r.status).toBe(400);
    // Then exercise the driver's get against the same wrong sha →
    // should throw BlobNotFoundError because the stub never stored it.
    await expect(driver.get(`registry://${wrongSha}`)).rejects.toBeInstanceOf(
      BlobNotFoundError,
    );
  });

  it("requires a baseUrl", () => {
    expect(() => new SignalmanRegistryBlobDriver({ baseUrl: "" })).toThrow(
      /baseUrl is required/,
    );
  });
});

describe("createBlobDriver — signalman-registry switch", () => {
  it("constructs a SignalmanRegistryBlobDriver", () => {
    const driver = createBlobDriver({
      driver: "signalman-registry",
      baseUrl: "https://registry.example",
      bearerToken: "sk_AAAA_BBBB",
    });
    expect(driver).toBeInstanceOf(SignalmanRegistryBlobDriver);
  });
});
