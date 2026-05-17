// WS10 M6 — cosign-style signing + verification.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeypair } from "../signing.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import {
  cosignTagFor,
  OCI_ERROR_CODES,
  OciError,
  parseRepoTagRef,
  signAndCommitCosign,
  signCosign,
  TagStore,
  verifyCosign,
} from "../oci/index.js";

const ORG = "acme";
const REPO = "svc";

describe("cosignTagFor", () => {
  it("derives the spec convention tag (sha256-<hex>.sig)", () => {
    const tag = cosignTagFor(`sha256:${"a".repeat(64)}`);
    expect(tag).toBe(`sha256-${"a".repeat(64)}.sig`);
    expect(tag.length).toBe(75);
  });

  it("rejects non-sha256 digests", () => {
    expect(() => cosignTagFor(`sha512:${"a".repeat(64)}`)).toThrowError(OciError);
  });

  it("rejects mixed-case hex", () => {
    expect(() => cosignTagFor(`sha256:${"A".repeat(64)}`)).toThrowError(OciError);
  });
});

describe("parseRepoTagRef", () => {
  it("parses <org>/<repo>:<tag>", () => {
    const parsed = parseRepoTagRef("acme/svc:v1.0");
    expect(parsed).toEqual({
      org: "acme",
      repo: "svc",
      tag: "v1.0",
      storageName: "oci/acme/svc",
      dockerReference: "acme/svc",
    });
  });

  it("supports multi-segment repos", () => {
    const parsed = parseRepoTagRef("acme/team/svc:latest");
    expect(parsed.org).toBe("acme");
    expect(parsed.repo).toBe("team/svc");
    expect(parsed.storageName).toBe("oci/acme/team/svc");
  });

  it("rejects missing tag", () => {
    expect(() => parseRepoTagRef("acme/svc")).toThrowError(OciError);
  });

  it("rejects empty tag", () => {
    expect(() => parseRepoTagRef("acme/svc:")).toThrowError(OciError);
  });

  it("rejects missing org or repo segment", () => {
    expect(() => parseRepoTagRef("svc:v1")).toThrowError(OciError);
    expect(() => parseRepoTagRef("acme/:v1")).toThrowError(OciError);
  });
});

describe("signCosign + verifyCosign (round-trip)", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let tagStore: TagStore;
  let keypair: { privateKeyPem: string; publicKeyPem: string };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-cosign-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    tagStore = new TagStore({ index: storage.index });
    keypair = generateKeypair();
  });

  afterEach(async () => {
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeManifestDigest(bytes: Buffer): string {
    return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  }

  it("signs a manifest digest and persists the .sig tag", async () => {
    const sample = Buffer.from(JSON.stringify({ schemaVersion: 2 }));
    const manifestDigest = makeManifestDigest(sample);
    const result = await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    expect(result.tag).toBe(cosignTagFor(manifestDigest));
    expect(result.signatureManifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.signatureB64.length).toBeGreaterThan(0);

    // Tag pointer installed.
    const tagRow = tagStore.get(`oci/${ORG}/${REPO}`, result.tag);
    expect(tagRow).not.toBeNull();
    expect(`sha256:${tagRow?.manifestSha256}`).toBe(result.signatureManifestDigest);

    // Manifest row + canonical bytes round-trip.
    const stored = storage.index.getManifest(
      `oci/${ORG}/${REPO}`,
      result.signatureManifestDigest.slice("sha256:".length),
    );
    expect(stored?.mediaType).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(stored?.ociMetadata?.isIndex).toBe(false);
  });

  it("verifies its own signature successfully", async () => {
    const sample = Buffer.from(JSON.stringify({ a: 1 }));
    const manifestDigest = makeManifestDigest(sample);
    await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    const verified = await verifyCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      manifestDigest,
      publicKeyPem: keypair.publicKeyPem,
    });
    expect(verified.payload.critical.image["docker-manifest-digest"]).toBe(
      manifestDigest,
    );
    expect(verified.payload.critical.identity["docker-reference"]).toBe(
      `${ORG}/${REPO}`,
    );
    expect(verified.payload.critical.type).toBe(
      "cosign container image signature",
    );
  });

  it("rejects verification with a different public key", async () => {
    const sample = Buffer.from("payload");
    const manifestDigest = makeManifestDigest(sample);
    await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    const other = generateKeypair();
    await expect(
      verifyCosign({
        index: storage.index,
        blobStore: storage.blobStore,
        tagStore,
        storageName: `oci/${ORG}/${REPO}`,
        manifestDigest,
        publicKeyPem: other.publicKeyPem,
      }),
    ).rejects.toThrow(/cryptographically invalid/);
  });

  it("returns MANIFEST_UNKNOWN when no signature has been pushed", async () => {
    const digest = `sha256:${"f".repeat(64)}`;
    let caught: unknown;
    try {
      await verifyCosign({
        index: storage.index,
        blobStore: storage.blobStore,
        tagStore,
        storageName: `oci/${ORG}/${REPO}`,
        manifestDigest: digest,
        publicKeyPem: keypair.publicKeyPem,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OciError);
    expect((caught as OciError).code).toBe(OCI_ERROR_CODES.MANIFEST_UNKNOWN);
  });

  it("enforces expectedDockerReference when supplied", async () => {
    const sample = Buffer.from("x");
    const manifestDigest = makeManifestDigest(sample);
    await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    let caught: unknown;
    try {
      await verifyCosign({
        index: storage.index,
        blobStore: storage.blobStore,
        tagStore,
        storageName: `oci/${ORG}/${REPO}`,
        manifestDigest,
        publicKeyPem: keypair.publicKeyPem,
        expectedDockerReference: "other/repo",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OciError);
    expect((caught as OciError).code).toBe(OCI_ERROR_CODES.MANIFEST_INVALID);
    expect((caught as OciError).message).toContain("docker-reference mismatch");
  });

  it("re-signing the same digest is idempotent (same tag, no error)", async () => {
    const sample = Buffer.from("idempotent");
    const manifestDigest = makeManifestDigest(sample);
    const a = await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    const b = await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    // Different signatures (Ed25519 is deterministic for same key+msg
    // — so signatures DO match here) but the tag is the same.
    expect(a.tag).toBe(b.tag);
    expect(a.payloadDigest).toBe(b.payloadDigest);
    expect(a.signatureB64).toBe(b.signatureB64);
  });

  it("signCosign without commit returns the planned digests", () => {
    const sample = Buffer.from("not-committed");
    const manifestDigest = makeManifestDigest(sample);
    const result = signCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    expect(result.tag).toBe(cosignTagFor(manifestDigest));
    // Nothing should be in storage yet — preview-only.
    expect(tagStore.get(`oci/${ORG}/${REPO}`, result.tag)).toBeNull();
  });

  it("verifies after re-loading the registry from disk", async () => {
    const sample = Buffer.from("durable");
    const manifestDigest = makeManifestDigest(sample);
    await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    // Reload from the same root.
    storage.close();
    storage = LocalFsRegistryStorage.fromRoot(root);
    const restored = new TagStore({ index: storage.index });
    const verified = await verifyCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore: restored,
      storageName: `oci/${ORG}/${REPO}`,
      manifestDigest,
      publicKeyPem: keypair.publicKeyPem,
    });
    expect(verified.payload.critical.image["docker-manifest-digest"]).toBe(
      manifestDigest,
    );
  });

  it("rejects a non-Ed25519 public key on verify", async () => {
    const sample = Buffer.from("rsa-verify");
    const manifestDigest = makeManifestDigest(sample);
    await signAndCommitCosign({
      index: storage.index,
      blobStore: storage.blobStore,
      tagStore,
      storageName: `oci/${ORG}/${REPO}`,
      dockerReference: `${ORG}/${REPO}`,
      manifestDigest,
      privateKeyPem: keypair.privateKeyPem,
    });
    const { publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await expect(
      verifyCosign({
        index: storage.index,
        blobStore: storage.blobStore,
        tagStore,
        storageName: `oci/${ORG}/${REPO}`,
        manifestDigest,
        publicKeyPem: publicKey as string,
      }),
    ).rejects.toThrow(/Ed25519/);
  });

  it("rejects a non-Ed25519 private key on sign", () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(() =>
      signCosign({
        index: storage.index,
        blobStore: storage.blobStore,
        tagStore,
        storageName: `oci/${ORG}/${REPO}`,
        dockerReference: `${ORG}/${REPO}`,
        manifestDigest: `sha256:${"a".repeat(64)}`,
        privateKeyPem: privateKey as string,
      }),
    ).toThrow();
  });
});
