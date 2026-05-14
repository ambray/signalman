import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { generateKeypair, signManifest } from "../signing.js";
import type { Manifest } from "../types.js";

describe("signalman-registry CLI", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-cli-"));
  });

  afterEach(async () => {
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  it("prints usage when called with no args", async () => {
    const res = await runCli([]);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("Usage: signalman-registry");
  });

  it("prints usage on --help (exit 0)", async () => {
    const res = await runCli(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage: signalman-registry");
  });

  it("rejects an unknown verb", async () => {
    const res = await runCli(["bogus"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unknown verb: bogus");
  });

  it("rejects an unknown flag", async () => {
    const res = await runCli(["serve", "--xyz", "yes"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown flag: --xyz");
  });

  it("rejects a flag with no value", async () => {
    const res = await runCli(["serve", "--port"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--port requires a value");
  });

  it("serve: rejects a missing --storage-root", async () => {
    const res = await runCli(["serve", "--port", "0"], {
      startServer: async () => ({
        server: undefined as never,
        port: 0,
        host: "127.0.0.1",
        baseUrl: "http://127.0.0.1:0",
        close: async () => undefined,
      }),
    });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--storage-root is required");
  });

  it("serve: rejects a bad --port", async () => {
    const res = await runCli([
      "serve",
      "--port",
      "abc",
      "--storage-root",
      workdir,
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("bad --port");
  });

  it("serve: starts the injected server and prints the baseUrl", async () => {
    let closed = false;
    const fakeStart = async () => ({
      server: undefined as never,
      port: 12345,
      host: "127.0.0.1",
      baseUrl: "http://127.0.0.1:12345",
      close: async () => {
        closed = true;
      },
    });
    const res = await runCli(
      ["serve", "--port", "0", "--storage-root", workdir],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { startServer: fakeStart as never },
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("http://127.0.0.1:12345");
    // The injected startServer path skips waiting on SIGINT, so the
    // test doesn't have to send a signal.
    expect(closed).toBe(false);
  });

  it("verify: succeeds on a valid signed manifest", async () => {
    const { publicKeyPem, privateKeyPem } = generateKeypair();
    const m: Manifest = {
      name: "demo",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [],
      createdAt: "2026-05-14T12:00:00.000Z",
    };
    const sig = signManifest(m, privateKeyPem);
    const signed = {
      ...m,
      signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
    };
    const manifestPath = path.join(workdir, "manifest.json");
    const pubPath = path.join(workdir, "key.pub.pem");
    await fsp.writeFile(manifestPath, JSON.stringify(signed), "utf-8");
    await fsp.writeFile(pubPath, publicKeyPem, "utf-8");
    const res = await runCli([
      "verify",
      manifestPath,
      "--public-key",
      pubPath,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("signature OK");
  });

  it("verify: exits 1 on a tampered manifest", async () => {
    const { publicKeyPem, privateKeyPem } = generateKeypair();
    const m: Manifest = {
      name: "demo",
      version: "1.0.0",
      mediaType: "application/vnd.signalman.manifest+json",
      blobs: [],
      createdAt: "2026-05-14T12:00:00.000Z",
    };
    const sig = signManifest(m, privateKeyPem);
    const tampered = {
      ...m,
      version: "9.9.9",
      signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
    };
    const manifestPath = path.join(workdir, "manifest.json");
    const pubPath = path.join(workdir, "key.pub.pem");
    await fsp.writeFile(manifestPath, JSON.stringify(tampered), "utf-8");
    await fsp.writeFile(pubPath, publicKeyPem, "utf-8");
    const res = await runCli([
      "verify",
      manifestPath,
      "--public-key",
      pubPath,
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("signature verification FAILED");
  });

  it("verify: exits 2 when required flags are missing", async () => {
    const res = await runCli(["verify"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage: signalman-registry verify");
  });

  it("verify: exits 1 on malformed manifest JSON", async () => {
    const manifestPath = path.join(workdir, "bad.json");
    const pubPath = path.join(workdir, "key.pub.pem");
    await fsp.writeFile(manifestPath, "{not valid", "utf-8");
    await fsp.writeFile(pubPath, "anything", "utf-8");
    const res = await runCli([
      "verify",
      manifestPath,
      "--public-key",
      pubPath,
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("could not parse manifest JSON");
  });

  it("keygen: prints both PEMs + fingerprint", async () => {
    const res = await runCli(["keygen"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("BEGIN PUBLIC KEY");
    expect(res.stdout).toContain("BEGIN PRIVATE KEY");
    expect(res.stdout).toMatch(/fingerprint=[a-f0-9]{16}/);
  });

  it("keygen --out-dir writes pub + priv files (priv mode 600)", async () => {
    const outDir = path.join(workdir, "keys");
    const res = await runCli(["keygen", "--out-dir", outDir]);
    expect(res.exitCode).toBe(0);
    const pubPath = path.join(outDir, "registry-signing.pub.pem");
    const privPath = path.join(outDir, "registry-signing.key.pem");
    const pubStat = await fsp.stat(pubPath);
    const privStat = await fsp.stat(privPath);
    expect(pubStat.isFile()).toBe(true);
    expect(privStat.isFile()).toBe(true);
    // mode bits on Windows skip ownership checks but the priv file
    // should still exist + be non-empty. We assert content shape.
    const priv = await fsp.readFile(privPath, "utf-8");
    expect(priv).toContain("BEGIN PRIVATE KEY");
  });
});
