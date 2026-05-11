/**
 * End-to-end test for PR 10a: build a release with --sign, then
 * verify it against the public key. Also covers the negative case
 * (wrong key fails verification) and the unsigned-release case
 * (verify returns reason='unsigned').
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../control-plane/index.js";
import { generateKeypair } from "../control-plane/build/signing.js";
import {
  runProductAdd,
  runReleaseBuild,
  runReleaseVerify,
} from "../verbs/control-plane.js";

let dataDir: string;
let workDir: string;
let cp: ControlPlane;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-sign-e2e-"));
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-sign-work-"));
  cp = ControlPlane.create({
    storage: { driver: "sqlite", url: path.join(dataDir, "signalman.db") },
    blobs: { driver: "local", root: path.join(dataDir, "blobs") },
  });
  await cp.init();
  // Synthetic product repo (no git involvement; pass commitSha via
  // the verb's override path).
  await fs.writeFile(
    path.join(workDir, "signalman.build.yaml"),
    YAML.stringify({
      schema_version: 1,
      components: [
        {
          name: "agent",
          build: {
            command: "node",
            args: [
              "-e",
              "require('fs').writeFileSync('agent.bin', 'agent-${TAG}')",
            ],
          },
          artifacts: [{ kind: "blob", path: "agent.bin" }],
        },
      ],
    }),
    "utf-8",
  );
});

afterEach(async () => {
  await cp.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(workDir, { recursive: true, force: true });
});

const silentSink: NodeJS.WritableStream = Object.assign(
  Object.create(null) as object,
  { write: () => true, end: () => undefined, on: () => silentSink, emit: () => true },
) as unknown as NodeJS.WritableStream;

describe("release build --sign + release verify", () => {
  it("signs at build time, verifies with the matching key", async () => {
    const kp = generateKeypair();
    await runProductAdd(cp, { name: "p", repoUrl: "u" });

    const built = await runReleaseBuild(
      cp,
      {
        productName: "p",
        tag: "v1.0.0",
        workDir,
        commitSha: "c".repeat(40),
        signingKeyPem: kp.privateKeyPem,
      },
      { out: silentSink },
    );
    expect(built.signature).toBeTruthy();
    expect(built.release.signedBy).toBe(built.signature!.signedBy);
    expect(built.release.signatureB64).toBe(built.signature!.signatureB64);

    const verified = await runReleaseVerify(cp, {
      releaseId: built.release.id,
      publicKeyPem: kp.publicKeyPem,
    });
    expect(verified.verified).toBe(true);
    expect(verified.reason).toBeUndefined();
  });

  it("fails verification with the wrong public key (fingerprint mismatch)", async () => {
    const signer = generateKeypair();
    const other = generateKeypair();
    await runProductAdd(cp, { name: "p", repoUrl: "u" });

    const built = await runReleaseBuild(
      cp,
      {
        productName: "p",
        tag: "v1.0.0",
        workDir,
        commitSha: "c".repeat(40),
        signingKeyPem: signer.privateKeyPem,
      },
      { out: silentSink },
    );

    const verified = await runReleaseVerify(cp, {
      releaseId: built.release.id,
      publicKeyPem: other.publicKeyPem,
    });
    expect(verified.verified).toBe(false);
    expect(verified.reason).toMatch(/fingerprint mismatch/);
  });

  it("an unsigned release returns verified=false with reason='unsigned'", async () => {
    await runProductAdd(cp, { name: "p", repoUrl: "u" });
    const built = await runReleaseBuild(
      cp,
      {
        productName: "p",
        tag: "v1.0.0",
        workDir,
        commitSha: "c".repeat(40),
        // No signingKeyPem → unsigned release.
      },
      { out: silentSink },
    );
    expect(built.signature).toBeUndefined();
    expect(built.release.signedBy).toBeNull();
    expect(built.release.signatureB64).toBeNull();

    const kp = generateKeypair();
    const verified = await runReleaseVerify(cp, {
      releaseId: built.release.id,
      publicKeyPem: kp.publicKeyPem,
    });
    expect(verified.verified).toBe(false);
    expect(verified.reason).toMatch(/unsigned/);
  });

  it("detects post-build tampering with an artifact row (manifest-reconstruction mismatch)", async () => {
    const kp = generateKeypair();
    await runProductAdd(cp, { name: "p", repoUrl: "u" });

    const built = await runReleaseBuild(
      cp,
      {
        productName: "p",
        tag: "v1.0.0",
        workDir,
        commitSha: "c".repeat(40),
        signingKeyPem: kp.privateKeyPem,
      },
      { out: silentSink },
    );

    // Tamper with an artifact row directly through the cp. The next
    // verify should detect the manifest-hash mismatch BEFORE the
    // crypto check, since the reconstructed manifest no longer
    // matches the stored manifestSha256.
    const arts = await cp.artifacts.listForRelease(built.release.id);
    const tamperedSha = "f".repeat(64);
    cp.storage.db
      .prepare(
        "UPDATE artifact SET sha256 = ?, updated_at = ? WHERE id = ?",
      )
      .run(tamperedSha, new Date().toISOString(), arts[0].id);

    const verified = await runReleaseVerify(cp, {
      releaseId: built.release.id,
      publicKeyPem: kp.publicKeyPem,
    });
    expect(verified.verified).toBe(false);
    expect(verified.reason).toMatch(/manifest reconstruction mismatch/);
  });
});
