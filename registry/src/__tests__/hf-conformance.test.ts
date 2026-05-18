// WS13 M4 — HF protocol conformance lane.
//
// Gated on SIGNALMAN_HF_CONFORMANCE=1. Same shape as the OCI
// conformance gate; disabled by default.
//
// When enabled, pulls a small public model (`prajjwal1/bert-tiny`,
// ~17 MB, permissively-licensed) through the registry's virtual
// upstream and verifies the bytes match what `huggingface-cli
// download` would resolve directly from hf.co.
//
// The test is intentionally minimal because the integration lane
// already covers the protocol surface against a mocked fetcher; the
// conformance lane is the operator-visible smoke test against the
// real hf.co endpoint.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";

const ENABLED = process.env.SIGNALMAN_HF_CONFORMANCE === "1";
const SUITE = ENABLED ? describe : describe.skip;

const AUTH = "Bearer sk_TEST_0123456789ABCDEF";
const UPSTREAM = "https://huggingface.co";
const REPO_ORG = "prajjwal1";
const REPO_NAME = "bert-tiny";

SUITE("HF conformance lane (SIGNALMAN_HF_CONFORMANCE=1)", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hf-conf-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    server = await createServer({ storage });
    storage.index.addVirtualUpstream({
      org: REPO_ORG,
      kind: "huggingface",
      upstreamUrl: UPSTREAM,
      config: {},
    });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("downloads config.json through the registry + matches hf.co bytes", async () => {
    const r = await fetch(
      `${server.baseUrl}/hf/${REPO_ORG}/${REPO_NAME}/resolve/main/config.json`,
      { headers: { authorization: AUTH } },
    );
    expect(r.status).toBe(200);
    const proxied = Buffer.from(await r.arrayBuffer());

    const direct = await fetch(
      `${UPSTREAM}/${REPO_ORG}/${REPO_NAME}/resolve/main/config.json`,
    );
    expect(direct.status).toBe(200);
    const expected = Buffer.from(await direct.arrayBuffer());

    expect(crypto.createHash("sha256").update(proxied).digest("hex")).toBe(
      crypto.createHash("sha256").update(expected).digest("hex"),
    );
  });
});
