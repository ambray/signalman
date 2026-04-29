/**
 * P9.5 — template-fetch tests.
 *
 * Mocks fetch via vi.fn so the suite never touches the real network.
 * The streamed body is built from a Buffer so the SHA-256 digest is
 * deterministic across runs. Each test scopes its cache to a fresh
 * tmpdir so assertions over file existence stay independent.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import {
  fetchTemplateImage,
  cachePathFor,
  defaultCacheDir,
  normalizeSha256,
  requireHttpsUrl,
  sha256File,
} from "../provisioning/template-fetch.js";

// ── Helpers ───────────────────────────────────────────────────────

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Build a fetch-shaped Response from a Buffer. fetch's body is a
 * Web ReadableStream; we adapt a Node Readable via Readable.toWeb so
 * the production code's `Readable.fromWeb(response.body)` round-trips
 * cleanly.
 */
function makeResponse(body: Buffer, status = 200): Response {
  const nodeStream = Readable.from(body);
  // toWeb returns a ReadableStream<Uint8Array> compatible with
  // Response. The cast is safe because Response accepts streams.
  const webStream = Readable.toWeb(
    nodeStream,
  ) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    status,
    headers: { "content-length": String(body.length) },
  });
}

/** Build a fake fetch impl that returns a fixed body. */
function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () => makeResponse(body, status)) as unknown as typeof fetch;
}

/** Build a fake fetch that throws mid-stream. */
function failingMidStreamFetch(prefix: Buffer): typeof fetch {
  return (async () => {
    const stream = new Readable({
      read() {
        this.push(prefix);
        // Schedule a forced error after the prefix is consumed.
        setImmediate(() => this.destroy(new Error("network died")));
      },
    });
    const webStream = Readable.toWeb(
      stream,
    ) as unknown as ReadableStream<Uint8Array>;
    return new Response(webStream, {
      status: 200,
      headers: { "content-length": String(prefix.length + 1024) }, // claim more than we actually deliver
    });
  }) as unknown as typeof fetch;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sigma-fetch-"));
});

afterEach(() => {
  // Best-effort cleanup. rmSync recursive handles the typical case.
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

// ── Validators ────────────────────────────────────────────────────

describe("normalizeSha256", () => {
  it("accepts 64 lowercase hex chars", () => {
    const sha = "a".repeat(64);
    expect(normalizeSha256(sha)).toBe(sha);
  });

  it("lowercases uppercase input", () => {
    const sha = "A".repeat(64);
    expect(normalizeSha256(sha)).toBe("a".repeat(64));
  });

  it("rejects wrong length", () => {
    expect(() => normalizeSha256("abc")).toThrow(/Invalid SHA-256/);
  });

  it("rejects non-hex characters", () => {
    expect(() => normalizeSha256("z".repeat(64))).toThrow(/Invalid SHA-256/);
  });
});

describe("requireHttpsUrl", () => {
  it("accepts https://", () => {
    expect(requireHttpsUrl("https://example.com/file.vhdx")).toBe(
      "https://example.com/file.vhdx",
    );
  });

  it("rejects http:// (TLS-stripping risk)", () => {
    expect(() => requireHttpsUrl("http://example.com/file.vhdx")).toThrow(
      /non-HTTPS/,
    );
  });

  it("rejects file:// and other schemes", () => {
    expect(() => requireHttpsUrl("file:///etc/passwd")).toThrow(/non-HTTPS/);
    expect(() => requireHttpsUrl("ftp://example.com")).toThrow(/non-HTTPS/);
  });

  it("rejects malformed URLs", () => {
    expect(() => requireHttpsUrl("not a url")).toThrow(/Invalid URL/);
  });
});

describe("cachePathFor / defaultCacheDir", () => {
  it("uses the SHA prefix as filename", () => {
    const sha = "f".repeat(64);
    const p = cachePathFor("win11-eval", sha, "/tmp/cache");
    expect(p).toContain("win11-eval");
    expect(p).toContain("ffffffffffffffff.vhdx");
  });

  it("returns a platform-appropriate default dir", () => {
    const dir = defaultCacheDir();
    expect(dir).toMatch(/templates$/);
    if (process.platform === "win32") {
      expect(dir).toMatch(/Signalman/);
    } else {
      expect(dir.toLowerCase()).toMatch(/signalman/);
    }
  });
});

// ── fetchTemplateImage core ───────────────────────────────────────

describe("fetchTemplateImage — input validation", () => {
  it("rejects http:// URL before touching the network", async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return makeResponse(Buffer.from("dummy"));
    }) as unknown as typeof fetch;
    await expect(
      fetchTemplateImage({
        templateName: "x",
        url: "http://example.com/x.vhdx",
        expectedSha256: "a".repeat(64),
        cacheDir: tmpRoot,
        fetchImpl: f,
      }),
    ).rejects.toThrow(/non-HTTPS/);
    expect(called).toBe(0);
  });

  it("rejects malformed SHA-256", async () => {
    await expect(
      fetchTemplateImage({
        templateName: "x",
        url: "https://example.com/x.vhdx",
        expectedSha256: "not-a-sha",
        cacheDir: tmpRoot,
        fetchImpl: fakeFetch(Buffer.from("dummy")),
      }),
    ).rejects.toThrow(/Invalid SHA-256/);
  });

  it("rejects missing SHA-256 (empty string)", async () => {
    await expect(
      fetchTemplateImage({
        templateName: "x",
        url: "https://example.com/x.vhdx",
        expectedSha256: "",
        cacheDir: tmpRoot,
        fetchImpl: fakeFetch(Buffer.from("dummy")),
      }),
    ).rejects.toThrow(/Invalid SHA-256/);
  });
});

describe("fetchTemplateImage — happy path", () => {
  it("downloads, verifies, and caches", async () => {
    const body = Buffer.from("hello-vhdx-bytes");
    const sha = sha256Hex(body);

    const result = await fetchTemplateImage({
      templateName: "test-tmpl",
      url: "https://example.com/test.vhdx",
      expectedSha256: sha,
      cacheDir: tmpRoot,
      fetchImpl: fakeFetch(body),
    });

    expect(result.cached).toBe(false);
    expect(result.sizeBytes).toBe(body.length);
    expect(fs.existsSync(result.vhdxPath)).toBe(true);
    expect(fs.readFileSync(result.vhdxPath)).toEqual(body);
    // No leftover .tmp file.
    expect(fs.existsSync(`${result.vhdxPath}.tmp`)).toBe(false);
  });

  it("warm cache returns cached=true without calling fetch", async () => {
    const body = Buffer.from("warm-cache-bytes");
    const sha = sha256Hex(body);

    // First call downloads.
    let callCount = 0;
    const counting = (async () => {
      callCount++;
      return makeResponse(body);
    }) as unknown as typeof fetch;
    await fetchTemplateImage({
      templateName: "warm",
      url: "https://example.com/warm.vhdx",
      expectedSha256: sha,
      cacheDir: tmpRoot,
      fetchImpl: counting,
    });
    expect(callCount).toBe(1);

    // Second call hits the cache.
    const second = await fetchTemplateImage({
      templateName: "warm",
      url: "https://example.com/warm.vhdx",
      expectedSha256: sha,
      cacheDir: tmpRoot,
      fetchImpl: counting,
    });
    expect(second.cached).toBe(true);
    expect(callCount).toBe(1); // no second download
  });

  it("force=true re-downloads even when cache is warm", async () => {
    const body = Buffer.from("force-bytes");
    const sha = sha256Hex(body);
    let callCount = 0;
    const counting = (async () => {
      callCount++;
      return makeResponse(body);
    }) as unknown as typeof fetch;

    await fetchTemplateImage({
      templateName: "force",
      url: "https://example.com/x.vhdx",
      expectedSha256: sha,
      cacheDir: tmpRoot,
      fetchImpl: counting,
    });
    const second = await fetchTemplateImage({
      templateName: "force",
      url: "https://example.com/x.vhdx",
      expectedSha256: sha,
      cacheDir: tmpRoot,
      force: true,
      fetchImpl: counting,
    });
    expect(callCount).toBe(2);
    expect(second.cached).toBe(false);
  });
});

describe("fetchTemplateImage — failure modes", () => {
  it("SHA mismatch deletes the .tmp file and throws", async () => {
    const body = Buffer.from("real-body");
    const wrongSha = "0".repeat(64);

    const cachePath = cachePathFor("bad-sha", wrongSha, tmpRoot);
    const tmpPath = `${cachePath}.tmp`;

    await expect(
      fetchTemplateImage({
        templateName: "bad-sha",
        url: "https://example.com/x.vhdx",
        expectedSha256: wrongSha,
        cacheDir: tmpRoot,
        fetchImpl: fakeFetch(body),
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);

    expect(fs.existsSync(cachePath)).toBe(false);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("mid-stream failure leaves no <sha>.vhdx (atomic rename invariant)", async () => {
    const realBody = Buffer.from("would-have-been-the-full-body");
    const sha = sha256Hex(realBody);
    const cachePath = cachePathFor("mid-fail", sha, tmpRoot);

    await expect(
      fetchTemplateImage({
        templateName: "mid-fail",
        url: "https://example.com/x.vhdx",
        expectedSha256: sha,
        cacheDir: tmpRoot,
        fetchImpl: failingMidStreamFetch(realBody.subarray(0, 5)),
      }),
    ).rejects.toThrow();

    // The atomic-rename invariant: the final filename never appears
    // unless the SHA verified.
    expect(fs.existsSync(cachePath)).toBe(false);
    // The .tmp file is also cleaned up on failure.
    expect(fs.existsSync(`${cachePath}.tmp`)).toBe(false);
  });

  it("non-200 response throws with status info", async () => {
    const sha = sha256Hex(Buffer.from("anything"));
    const f = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(
      fetchTemplateImage({
        templateName: "missing",
        url: "https://example.com/x.vhdx",
        expectedSha256: sha,
        cacheDir: tmpRoot,
        fetchImpl: f,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("cache file with wrong SHA is treated as a miss and re-downloaded", async () => {
    const body = Buffer.from("good-body");
    const sha = sha256Hex(body);
    const cachePath = cachePathFor("corrupt", sha, tmpRoot);

    // Pre-populate the cache with garbage.
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, "corrupt-data-with-wrong-sha");

    let downloaded = false;
    const f = (async () => {
      downloaded = true;
      return makeResponse(body);
    }) as unknown as typeof fetch;

    const result = await fetchTemplateImage({
      templateName: "corrupt",
      url: "https://example.com/x.vhdx",
      expectedSha256: sha,
      cacheDir: tmpRoot,
      fetchImpl: f,
    });

    expect(downloaded).toBe(true);
    expect(result.cached).toBe(false);
    expect(fs.readFileSync(result.vhdxPath)).toEqual(body);
  });
});

describe("fetchTemplateImage — disk-fill cap (Sec follow-up)", () => {
  // What this catches: an operator paste-error pointing fetchTemplateImage
  // at a multi-TB URL, OR a hostile/misconfigured server replying with
  // an oversize body. The cap defends both.

  it("rejects pre-flight when Content-Length exceeds maxBytes", async () => {
    const body = Buffer.from("x".repeat(1000));
    const sha = sha256Hex(body);
    let openedBody = false;
    const fetchSpy: typeof fetch = (async () => {
      openedBody = true;
      return makeResponse(body); // Content-Length = 1000
    }) as unknown as typeof fetch;

    await expect(
      fetchTemplateImage({
        templateName: "tiny",
        url: "https://example.com/tiny.vhdx",
        expectedSha256: sha,
        cacheDir: tmpRoot,
        fetchImpl: fetchSpy,
        maxBytes: 500, // smaller than the body
      }),
    ).rejects.toThrow(/exceeds maxBytes cap 500/);

    // The spy still ran (we always make the request), but no .tmp
    // file should have been created because we abort BEFORE opening
    // the write stream.
    expect(openedBody).toBe(true);
    const tmpFiles = fs
      .readdirSync(tmpRoot, { recursive: true })
      .filter((f) => String(f).endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  it("aborts mid-stream + shreds .tmp when running total exceeds maxBytes", async () => {
    // Build a fetch that reports a small Content-Length but actually
    // streams more bytes — Content-Length spoofing scenario.
    const realBody = Buffer.from("x".repeat(2000));
    const sha = sha256Hex(realBody);

    const fetchSpy: typeof fetch = (async () => {
      const stream = Readable.from(realBody);
      const webStream = Readable.toWeb(
        stream,
      ) as unknown as ReadableStream<Uint8Array>;
      return new Response(webStream, {
        status: 200,
        // Lie about the size so pre-flight passes.
        headers: { "content-length": "100" },
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchTemplateImage({
        templateName: "spoof",
        url: "https://example.com/spoof.vhdx",
        expectedSha256: sha,
        cacheDir: tmpRoot,
        fetchImpl: fetchSpy,
        maxBytes: 500,
      }),
    ).rejects.toThrow(/exceeded maxBytes cap 500/);

    // No .tmp file remains — the catch path shreds it.
    const tmpFiles = fs
      .readdirSync(tmpRoot, { recursive: true })
      .filter((f) => String(f).endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  it("default cap admits typical VHDX downloads (50 GiB)", async () => {
    // Sanity: the default maxBytes is large enough that a normal-size
    // download isn't accidentally clipped. We don't actually download
    // 25 GiB — just check that the option resolution doesn't refuse a
    // 4 KiB body when no maxBytes is supplied.
    const body = Buffer.from("y".repeat(4096));
    const sha = sha256Hex(body);
    const result = await fetchTemplateImage({
      templateName: "default-cap",
      url: "https://example.com/dc.vhdx",
      expectedSha256: sha,
      cacheDir: tmpRoot,
      fetchImpl: fakeFetch(body),
      // no maxBytes specified — default (50 GiB) applies
    });
    expect(result.sizeBytes).toBe(4096);
  });
});

describe("sha256File", () => {
  it("computes the SHA of an on-disk file by streaming", async () => {
    const body = Buffer.from("contents-to-hash");
    const filePath = path.join(tmpRoot, "f.bin");
    fs.writeFileSync(filePath, body);
    const got = await sha256File(filePath);
    expect(got).toBe(sha256Hex(body));
  });
});
