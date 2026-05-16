// WS10 M4 — /v2/ challenge endpoint + /oci/token issuer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer, type ServerHandle } from "../http/server.js";
import { LocalFsRegistryStorage } from "../storage/registry-storage.js";
import { generateKeypair } from "../signing.js";
import {
  mintJwt,
  OCI_ERROR_CODES,
  type OciErrorEnvelope,
} from "../oci/index.js";

const AUTH_BEARER = "Bearer sk_TEST_0123456789ABCDEF";

describe("OCI bearer-challenge auth flow", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-auth-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    const kp = generateKeypair();
    privateKeyPem = kp.privateKeyPem;
    publicKeyPem = kp.publicKeyPem;
    server = await createServer({
      storage,
      ociReaperIntervalMs: 60 * 60 * 1000,
      ociTokenSigningPrivateKeyPem: privateKeyPem,
    });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  // ── /v2/ challenge endpoint ─────────────────────────────────────
  it("GET /v2/ returns 200 with empty body when authenticated by sk_ bearer", async () => {
    const r = await fetch(`${server.baseUrl}/v2/`, {
      headers: { authorization: AUTH_BEARER },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("{}");
  });

  it("GET /v2/ returns 401 + WWW-Authenticate when not authenticated", async () => {
    const r = await fetch(`${server.baseUrl}/v2/`);
    expect(r.status).toBe(401);
    const challenge = r.headers.get("www-authenticate");
    expect(challenge).toContain("Bearer realm=");
    expect(challenge).toContain("/oci/token");
    expect(challenge).toContain('service="signalman-registry"');
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.UNAUTHORIZED);
  });

  it("GET /v2/ returns 401 + challenge when sk_ bearer is malformed", async () => {
    const r = await fetch(`${server.baseUrl}/v2/`, {
      headers: { authorization: "Bearer malformed" },
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer realm=");
  });

  it("GET /v2/ accepts a JWT bearer minted by the registry", async () => {
    const minted = mintJwt({
      privateKeyPem,
      subject: "sk_TEST",
      scope: "registry:catalog:*",
    });
    const r = await fetch(`${server.baseUrl}/v2/`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(r.status).toBe(200);
  });

  it("GET /v2/ rejects a JWT signed by a different key", async () => {
    const other = generateKeypair();
    const minted = mintJwt({
      privateKeyPem: other.privateKeyPem,
      subject: "sk_TEST",
      scope: "",
    });
    const r = await fetch(`${server.baseUrl}/v2/`, {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(r.status).toBe(401);
  });

  // ── /oci/token endpoint ─────────────────────────────────────────
  it("GET /oci/token with Basic Auth mints a JWT bound to the sk_ bearer", async () => {
    const basic = Buffer.from("sk_TEST_0123456789ABCDEF:")
      .toString("base64");
    const r = await fetch(
      `${server.baseUrl}/oci/token?service=signalman-registry&scope=repository:team/svc:pull`,
      { headers: { authorization: `Basic ${basic}` } },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      token: string;
      access_token: string;
      expires_in: number;
      issued_at: string;
    };
    expect(body.token).toBeDefined();
    expect(body.access_token).toBe(body.token);
    expect(body.expires_in).toBe(3600);
    expect(body.issued_at).toMatch(/^\d{4}-/);
    expect(body.token.split(".")).toHaveLength(3);
  });

  it("the minted JWT carries sub = sk_<prefix> + scope", async () => {
    const basic = Buffer.from("sk_TEST_0123456789ABCDEF:").toString("base64");
    const r = await fetch(
      `${server.baseUrl}/oci/token?scope=repository:team/svc:pull,push`,
      { headers: { authorization: `Basic ${basic}` } },
    );
    const body = (await r.json()) as { token: string };
    const [, payloadB64] = body.token.split(".");
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (padded.length % 4)) % 4;
    const payload = JSON.parse(
      Buffer.from(padded + "=".repeat(pad), "base64").toString("utf-8"),
    );
    expect(payload.sub).toBe("sk_TEST");
    expect(payload.scope).toBe("repository:team/svc:pull,push");
  });

  it("the minted JWT then authenticates a subsequent /v2/ request", async () => {
    const basic = Buffer.from("sk_TEST_0123456789ABCDEF:").toString("base64");
    const tok = await fetch(`${server.baseUrl}/oci/token?service=signalman-registry`, {
      headers: { authorization: `Basic ${basic}` },
    });
    const body = (await tok.json()) as { token: string };
    const r = await fetch(`${server.baseUrl}/v2/`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(r.status).toBe(200);
  });

  it("GET /oci/token without Basic Auth returns 401 + Basic challenge", async () => {
    const r = await fetch(`${server.baseUrl}/oci/token?service=signalman-registry`);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('Basic realm="signalman-registry"');
  });

  it("GET /oci/token with malformed Basic credentials returns 401", async () => {
    const r = await fetch(`${server.baseUrl}/oci/token`, {
      headers: { authorization: "Basic !!!bad-base64" },
    });
    expect(r.status).toBe(401);
  });

  it("GET /oci/token rejects when the basic username is not sk_-shaped", async () => {
    const basic = Buffer.from("alice@team.com:hunter2").toString("base64");
    const r = await fetch(`${server.baseUrl}/oci/token`, {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(r.status).toBe(401);
  });

  it("GET /oci/token rejects an unknown service parameter", async () => {
    const basic = Buffer.from("sk_TEST_0123456789ABCDEF:").toString("base64");
    const r = await fetch(`${server.baseUrl}/oci/token?service=other-registry`, {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(r.status).toBe(403);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.DENIED);
  });
});

// ── No signing key configured ──────────────────────────────────────
describe("OCI auth without a JWT signing key", () => {
  let root: string;
  let storage: LocalFsRegistryStorage;
  let server: ServerHandle;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "oci-auth-nokey-"));
    storage = LocalFsRegistryStorage.fromRoot(root);
    // No ociTokenSigningPrivateKeyPem — server runs in "sk_ direct only" mode.
    server = await createServer({ storage, ociReaperIntervalMs: 60 * 60 * 1000 });
  });

  afterEach(async () => {
    await server.close();
    storage.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("GET /v2/ still 200s with a valid sk_ bearer", async () => {
    const r = await fetch(`${server.baseUrl}/v2/`, {
      headers: { authorization: AUTH_BEARER },
    });
    expect(r.status).toBe(200);
  });

  it("GET /v2/ 401s without WWW-Authenticate (no challenge realm configured)", async () => {
    const r = await fetch(`${server.baseUrl}/v2/`);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBeNull();
  });

  it("GET /oci/token returns 405 UNSUPPORTED when token issuance is unconfigured", async () => {
    const basic = Buffer.from("sk_TEST_0123456789ABCDEF:").toString("base64");
    const r = await fetch(`${server.baseUrl}/oci/token`, {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(r.status).toBe(405);
    const env = (await r.json()) as OciErrorEnvelope;
    expect(env.errors[0].code).toBe(OCI_ERROR_CODES.UNSUPPORTED);
  });
});
