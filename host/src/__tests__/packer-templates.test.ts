/**
 * Sanity-check the Packer scaffolding shipped in `infra/packer/` and
 * the `.github/workflows/golden-images.yml` workflow file.
 *
 * Generated for WS6 wave-3 carve-out #4. This is NOT a real Packer
 * validation — that would need the packer binary in CI for unit
 * tests, which we don't ship. The workflow's own `packer validate`
 * step is the real check; this suite just guards against the most
 * obvious accidents (an empty template file, a renamed source block,
 * a workflow that lost its credential-gating expression).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The host package's vitest cwd is `host/`, so the repo root is one
// level up. Compose paths against that so the test runs from any
// invocation directory.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PACKER_DIR = path.join(REPO_ROOT, "infra", "packer");
const WORKFLOW = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "golden-images.yml",
);

function readFileOrFail(p: string): string {
  expect(fs.existsSync(p), `expected ${p} to exist`).toBe(true);
  const body = fs.readFileSync(p, "utf8");
  expect(body.length, `expected ${p} to be non-empty`).toBeGreaterThan(0);
  return body;
}

describe("Packer template scaffolding", () => {
  it("ships the common variable defaults", () => {
    const body = readFileOrFail(
      path.join(PACKER_DIR, "common", "build.pkrvars.hcl"),
    );
    // Every template references these four — if one goes missing the
    // build either errors on missing-var or silently picks a bad
    // default. The defaults file is the single source of truth.
    expect(body).toMatch(/agent_version\s*=/);
    expect(body).toMatch(/image_tag\s*=/);
    expect(body).toMatch(/linux_guest_binary\s*=/);
    expect(body).toMatch(/mtls_root_ca\s*=/);
  });

  it("ships the AWS template with an amazon-ebs source", () => {
    const body = readFileOrFail(
      path.join(PACKER_DIR, "aws", "ami.pkr.hcl"),
    );
    expect(body).toContain('source "amazon-ebs"');
    // The cross-backend invariant: signalman-managed must be on the
    // AMI tags so the cost-reaper can identify Packer-built images.
    expect(body).toContain('"signalman-managed"');
    // Manifest post-processor is what surfaces AMI ids to CI.
    expect(body).toMatch(/post-processor\s+"manifest"/);
    // Carve-out #4 header — guards against a stale copy without
    // attribution to the wave-3 audit.
    expect(body).toContain("WS6 wave-3 carve-out #4");
  });

  it("ships the Azure template with an azure-arm source", () => {
    const body = readFileOrFail(
      path.join(PACKER_DIR, "azure", "managed-image.pkr.hcl"),
    );
    expect(body).toContain('source "azure-arm"');
    expect(body).toContain('"signalman-managed"');
    expect(body).toMatch(/post-processor\s+"manifest"/);
    expect(body).toContain("WS6 wave-3 carve-out #4");
  });

  it("ships the Hyper-V template with a hyperv-iso source", () => {
    const body = readFileOrFail(
      path.join(PACKER_DIR, "hyperv", "vhdx.pkr.hcl"),
    );
    expect(body).toContain('source "hyperv-iso"');
    expect(body).toMatch(/post-processor\s+"manifest"/);
    expect(body).toContain("WS6 wave-3 carve-out #4");
  });

  it("ships an operator README", () => {
    const body = readFileOrFail(path.join(PACKER_DIR, "README.md"));
    // The README documents both image-ref flow and the cost-reaper
    // tag contract; both are load-bearing for operators consuming
    // the artifacts.
    expect(body).toMatch(/image[- ]?ref/i);
    expect(body).toMatch(/signalman-managed/);
  });
});

describe("Golden-images workflow", () => {
  it("exists and is non-empty", () => {
    readFileOrFail(WORKFLOW);
  });

  it("references the right credential-gating secrets", () => {
    const body = readFileOrFail(WORKFLOW);
    // AWS job gates on AWS_ACCESS_KEY_ID; Azure job gates on
    // AZURE_TENANT_ID. If either is renamed, forks lose the
    // friendly-skip behaviour and the workflow goes red on every
    // run.
    expect(body).toContain("secrets.AWS_ACCESS_KEY_ID");
    expect(body).toContain("secrets.AZURE_TENANT_ID");
  });

  it("runs packer init + validate + build for each job", () => {
    const body = readFileOrFail(WORKFLOW);
    // These three commands are the minimum the operator expects
    // from CI: init pulls plugins, validate catches typos, build
    // is the real workload. Lose any one and the CI signal is
    // degraded.
    expect(body).toMatch(/packer init/);
    expect(body).toMatch(/packer validate/);
    expect(body).toMatch(/packer build/);
  });

  it("uploads manifests as artifacts", () => {
    const body = readFileOrFail(WORKFLOW);
    expect(body).toMatch(/upload-artifact/);
    expect(body).toMatch(/manifest\.json/);
  });
});
