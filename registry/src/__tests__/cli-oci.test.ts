// WS10 — `signalman-registry oci sign|verify` CLI verbs.
//
// Wraps the M6 cosign programmatic API. Tests exercise the full path
// via `runCli` (no subprocess spawn) — set up a storage root, push a
// manifest, then drive sign + verify through the CLI flags.

import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { generateKeypair } from "../signing.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { OCI_MEDIA_TYPES, TagStore } from "../oci/index.js";
import type { Manifest } from "../types.js";

describe("`signalman-registry oci` CLI verbs", () => {
  let workdir: string;
  let storageRoot: string;
  let storage: LocalFsRegistryStorage;
  let keyPath: string;
  let pubPath: string;
  let manifestDigest: string;

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-oci-cli-"));
    storageRoot = path.join(workdir, "data");
    await fsp.mkdir(storageRoot, { recursive: true });
    keyPath = path.join(workdir, "signing.key");
    pubPath = path.join(workdir, "signing.pub");
    const kp = generateKeypair();
    await fsp.writeFile(keyPath, kp.privateKeyPem, "utf-8");
    await fsp.writeFile(pubPath, kp.publicKeyPem, "utf-8");

    // Push a tiny manifest into storage so the CLI has something to sign.
    storage = LocalFsRegistryStorage.fromRoot(storageRoot);
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
        config: {
          mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
          digest: `sha256:${"a".repeat(64)}`,
          size: 1,
        },
        layers: [],
      }),
    );
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    manifestDigest = `sha256:${sha}`;
    const manifest: Manifest = {
      name: "oci/acme/svc",
      version: sha,
      mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
      kind: "oci",
      blobs: [],
      ociMetadata: { isIndex: false, schemaVariant: "oci-v1" },
      createdAt: new Date().toISOString(),
    };
    storage.index.putManifest(manifest, body);
    const tagStore = new TagStore({ index: storage.index });
    tagStore.put("oci/acme/svc", "v1.0", sha);
    storage.close();
  });

  afterEach(async () => {
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  // ── usage / dispatch ────────────────────────────────────────────
  it("prints usage when called as `oci --help`", async () => {
    const res = await runCli(["oci", "--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage: signalman-registry oci");
  });

  it("exits 2 when called as `oci` with no subcommand", async () => {
    const res = await runCli(["oci"]);
    expect(res.exitCode).toBe(2);
  });

  it("rejects an unknown oci subcommand", async () => {
    const res = await runCli([
      "oci",
      "unknown",
      "acme/svc:v1",
      "--storage-root",
      storageRoot,
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unknown oci subcommand");
  });

  it("requires --storage-root", async () => {
    const res = await runCli(["oci", "sign", "acme/svc:v1.0"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--storage-root is required");
  });

  it("requires a positional <org>/<repo>:<tag>", async () => {
    const res = await runCli(["oci", "sign", "--storage-root", storageRoot]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("expected <org>/<repo>:<tag>");
  });

  it("rejects a malformed reference", async () => {
    const res = await runCli([
      "oci",
      "sign",
      "no-tag-here",
      "--storage-root",
      storageRoot,
    ]);
    expect(res.exitCode).toBe(2);
  });

  // ── sign ────────────────────────────────────────────────────────
  it("signs an existing tag and reports the cosign tag", async () => {
    const res = await runCli([
      "oci",
      "sign",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--key",
      keyPath,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("signed acme/svc:v1.0");
    expect(res.stdout).toContain(`manifest_digest=${manifestDigest}`);
    expect(res.stdout).toContain(
      `cosign_tag=sha256-${manifestDigest.slice("sha256:".length)}.sig`,
    );

    // Sanity: the cosign tag is now installed in the registry.
    const post = LocalFsRegistryStorage.fromRoot(storageRoot);
    const tagStore = new TagStore({ index: post.index });
    const cosignTag = `sha256-${manifestDigest.slice("sha256:".length)}.sig`;
    expect(tagStore.get("oci/acme/svc", cosignTag)).not.toBeNull();
    post.close();
  });

  it("`oci sign` without --key returns exit 2", async () => {
    const res = await runCli([
      "oci",
      "sign",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--key");
  });

  it("`oci sign` on an unknown tag returns exit 1", async () => {
    const res = await runCli([
      "oci",
      "sign",
      "acme/svc:doesnotexist",
      "--storage-root",
      storageRoot,
      "--key",
      keyPath,
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("not found");
  });

  // ── verify ──────────────────────────────────────────────────────
  it("verifies a signed manifest successfully", async () => {
    // Sign first.
    await runCli([
      "oci",
      "sign",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--key",
      keyPath,
    ]);
    const res = await runCli([
      "oci",
      "verify",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--public-key",
      pubPath,
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("signature OK for acme/svc:v1.0");
    expect(res.stdout).toContain("docker_reference=acme/svc");
  });

  it("`oci verify` without --public-key returns exit 2", async () => {
    const res = await runCli([
      "oci",
      "verify",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--public-key");
  });

  it("`oci verify` against a wrong public key returns exit 1", async () => {
    await runCli([
      "oci",
      "sign",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--key",
      keyPath,
    ]);
    const wrong = generateKeypair();
    const wrongPubPath = path.join(workdir, "wrong.pub");
    await fsp.writeFile(wrongPubPath, wrong.publicKeyPem, "utf-8");

    const res = await runCli([
      "oci",
      "verify",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--public-key",
      wrongPubPath,
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("signature verification FAILED");
  });

  it("`oci verify` on an unsigned tag returns exit 1", async () => {
    const res = await runCli([
      "oci",
      "verify",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--public-key",
      pubPath,
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("signature verification FAILED");
  });

  it("`oci verify` honours --expected-docker-reference", async () => {
    await runCli([
      "oci",
      "sign",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--key",
      keyPath,
    ]);
    const res = await runCli([
      "oci",
      "verify",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--public-key",
      pubPath,
      "--expected-docker-reference",
      "other/repo",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("docker-reference mismatch");
  });

  it("rejects an unknown flag", async () => {
    const res = await runCli([
      "oci",
      "sign",
      "acme/svc:v1.0",
      "--storage-root",
      storageRoot,
      "--key",
      keyPath,
      "--bogus",
      "value",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("unknown flag");
  });

  it("usage block in top-level --help includes `oci sign|verify`", async () => {
    const res = await runCli(["--help"]);
    expect(res.stdout).toContain("oci sign");
    expect(res.stdout).toContain("oci verify");
  });
});
