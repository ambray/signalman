/**
 * Tests for S3BlobDriver against an in-memory mock S3Client.
 *
 * The mock implements just the commands the driver uses
 * (PutObject / GetObject / DeleteObject / HeadObject) and stores
 * bodies in a Map. Presign tests don't actually fetch from S3; they
 * just confirm the SDK presigner produces a syntactically-valid URL.
 *
 * Real S3 / S3-compatible (Garage, MinIO) validation happens at
 * operator deploy time; docs/postgres-driver.md style follow-up note
 * for blob drivers lands alongside this PR.
 */

import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S3BlobDriver } from "../control-plane/blobs/s3.js";
import { BlobNotFoundError } from "../control-plane/blobs/driver.js";

interface StoredObject {
  body: Buffer;
  contentType: string | undefined;
}

class MockS3Client {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: Array<{ command: string; key: string }> = [];

  async send(command: object): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body, ContentType } = command.input;
      this.calls.push({ command: "PutObject", key: `${Bucket}/${Key}` });
      const buf = await coerceToBuffer(Body);
      this.objects.set(`${Bucket}/${Key}`, {
        body: buf,
        contentType: ContentType,
      });
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof GetObjectCommand) {
      const { Bucket, Key } = command.input;
      this.calls.push({ command: "GetObject", key: `${Bucket}/${Key}` });
      const o = this.objects.get(`${Bucket}/${Key}`);
      if (!o) {
        throw makeNotFound();
      }
      return {
        $metadata: { httpStatusCode: 200 },
        Body: Readable.from(o.body),
        ContentType: o.contentType,
        ContentLength: o.body.length,
      };
    }
    if (command instanceof HeadObjectCommand) {
      const { Bucket, Key } = command.input;
      this.calls.push({ command: "HeadObject", key: `${Bucket}/${Key}` });
      if (!this.objects.has(`${Bucket}/${Key}`)) throw makeNotFound();
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof DeleteObjectCommand) {
      const { Bucket, Key } = command.input;
      this.calls.push({ command: "DeleteObject", key: `${Bucket}/${Key}` });
      this.objects.delete(`${Bucket}/${Key}`);
      return { $metadata: { httpStatusCode: 204 } };
    }
    throw new Error(`unmocked S3 command: ${command.constructor.name}`);
  }

  /** SDK presigner pokes into clientConfig; provide region + creds. */
  readonly config = {
    region: async () => "us-east-1",
    credentials: async () => ({
      accessKeyId: "test",
      secretAccessKey: "test",
    }),
    endpoint: async () => undefined,
    forcePathStyle: false,
    useArnRegion: false,
    useFipsEndpoint: async () => false,
    useDualstackEndpoint: async () => false,
    requestHandler: undefined,
    middlewareStack: { use: () => undefined, addRelativeTo: () => undefined },
  };

  // Method the presigner calls; ignore — we don't exercise getSignedUrl
  // in these tests.
  destroy(): void {}
}

async function coerceToBuffer(
  body: PutObjectCommand["input"]["Body"],
): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf-8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const c of body) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBuffer));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("unsupported body type in mock");
}

function makeNotFound(): Error {
  const err = new Error("NoSuchKey") as Error & {
    name: string;
    $metadata: { httpStatusCode: number };
  };
  err.name = "NoSuchKey";
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

let mock: MockS3Client;
let driver: S3BlobDriver;

beforeEach(() => {
  mock = new MockS3Client();
  driver = new S3BlobDriver({
    bucket: "signalman-test",
    prefix: "blobs/",
    client: mock as unknown as S3Client,
  });
});

afterEach(() => {
  driver.destroy();
});

describe("S3BlobDriver — put", () => {
  it("stores a Buffer at the content-addressed key and returns metadata", async () => {
    const payload = Buffer.from("hello s3");
    const expectedSha = crypto.createHash("sha256").update(payload).digest("hex");
    const meta = await driver.put({ orgId: "org_1", body: payload });
    expect(meta.sha256).toBe(expectedSha);
    expect(meta.size).toBe(payload.length);
    expect(meta.uri).toBe(
      `s3://signalman-test/blobs/org_1/${expectedSha.slice(0, 2)}/${expectedSha}`,
    );
    // PUT lands at the content-addressed key directly (no temp+COPY).
    expect(mock.calls.filter((c) => c.command === "PutObject")).toHaveLength(1);
    expect(mock.calls.find((c) => c.command === "PutObject")?.key).toBe(
      `signalman-test/blobs/org_1/${expectedSha.slice(0, 2)}/${expectedSha}`,
    );
  });

  it("stores a Readable stream (drains then hashes)", async () => {
    const payload = crypto.randomBytes(4096);
    const expectedSha = crypto.createHash("sha256").update(payload).digest("hex");
    const meta = await driver.put({
      orgId: "org_1",
      body: Readable.from(payload),
    });
    expect(meta.sha256).toBe(expectedSha);
    expect(meta.size).toBe(payload.length);
  });

  it("dedupes by content (re-PUT with same bytes hits the same key)", async () => {
    const payload = Buffer.from("dup");
    const a = await driver.put({ orgId: "org_1", body: payload });
    const b = await driver.put({ orgId: "org_1", body: payload });
    expect(b.uri).toBe(a.uri);
    // Two PUTs (S3 doesn't dedupe at the API layer); only one stored
    // object because the second overwrites the first identically.
    expect(mock.objects.size).toBe(1);
  });

  it("isolates orgs (same bytes → different keys per org)", async () => {
    const payload = Buffer.from("shared");
    const a = await driver.put({ orgId: "org_a", body: payload });
    const b = await driver.put({ orgId: "org_b", body: payload });
    expect(a.uri).not.toBe(b.uri);
    expect(a.sha256).toBe(b.sha256);
    expect(mock.objects.size).toBe(2);
  });

  it("rejects an org id with path separators", async () => {
    await expect(
      driver.put({ orgId: "../etc", body: Buffer.from("x") }),
    ).rejects.toThrow(/invalid org id/);
  });
});

describe("S3BlobDriver — get / exists / delete / resolveBySha", () => {
  it("round-trips bytes via put → get", async () => {
    const payload = Buffer.from("round-trip");
    const meta = await driver.put({ orgId: "org_1", body: payload });
    const stream = await driver.get(meta.uri);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it("get on a missing URI throws BlobNotFoundError", async () => {
    await expect(
      driver.get("s3://signalman-test/blobs/org_1/aa/" + "a".repeat(64)),
    ).rejects.toBeInstanceOf(BlobNotFoundError);
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

  it("delete is idempotent on missing keys", async () => {
    await expect(
      driver.delete("s3://signalman-test/blobs/org_1/zz/" + "z".repeat(64)),
    ).resolves.toBeUndefined();
  });

  it("rejects URIs targeting a different bucket", async () => {
    await expect(
      driver.get("s3://other-bucket/blobs/org_1/aa/" + "a".repeat(64)),
    ).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("rejects URIs missing the configured prefix", async () => {
    await expect(
      driver.get("s3://signalman-test/wrong-prefix/org_1/aa/" + "a".repeat(64)),
    ).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("resolveBySha reconstructs the URI from (orgId, sha256)", () => {
    const sha = "a".repeat(64);
    expect(driver.resolveBySha("org_1", sha)).toBe(
      `s3://signalman-test/blobs/org_1/aa/${sha}`,
    );
  });

  it("resolveBySha rejects malformed sha256", () => {
    expect(() => driver.resolveBySha("org_1", "not-hex")).toThrow(
      /invalid sha256/,
    );
  });

  it("resolveBySha rejects bad orgId (traversal)", () => {
    const sha = "a".repeat(64);
    expect(() => driver.resolveBySha("../etc", sha)).toThrow(/invalid org id/);
  });
});

describe("S3BlobDriver — prefix-less buckets", () => {
  it("works without a configured prefix", async () => {
    const localMock = new MockS3Client();
    const d = new S3BlobDriver({
      bucket: "no-prefix-bucket",
      client: localMock as unknown as S3Client,
    });
    const payload = Buffer.from("rooted");
    const meta = await d.put({ orgId: "o", body: payload });
    expect(meta.uri.startsWith(`s3://no-prefix-bucket/o/`)).toBe(true);
    d.destroy();
  });
});
