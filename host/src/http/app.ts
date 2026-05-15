/**
 * Build a Router populated with the v0.3.0 control-plane API.
 *
 * PR 6 shipped read-only endpoints. PR 7 adds writes + auth:
 *   * Every non-`/v1/healthz` route is authenticated. Bearer-token or
 *     loopback-bypass per `http/auth.ts`.
 *   * Multi-tenant scoping: `ctx.auth.orgId` comes from the auth
 *     context; handlers no longer look up the default org directly.
 *
 * Route table (writes marked with the verb):
 *
 *   public:
 *     GET    /v1/healthz
 *
 *   products:
 *     GET    /v1/products
 *     POST   /v1/products
 *     GET    /v1/products/by-name/:name
 *     GET    /v1/products/:id
 *     PATCH  /v1/products/:id
 *     DELETE /v1/products/:id
 *
 *   releases:
 *     GET    /v1/releases?product=&status=
 *     POST   /v1/releases
 *     GET    /v1/releases/:id
 *     PATCH  /v1/releases/:id
 *     DELETE /v1/releases/:id
 *     GET    /v1/releases/:id/artifacts
 *     POST   /v1/releases/:id/artifacts
 *
 *   targets:
 *     GET    /v1/targets
 *     POST   /v1/targets
 *     GET    /v1/targets/by-name/:name
 *     GET    /v1/targets/:id
 *     DELETE /v1/targets/:id
 *     GET    /v1/targets/:id/deployments?limit=
 *
 *   deployments:
 *     POST   /v1/deployments
 *     GET    /v1/deployments/:id
 *     PATCH  /v1/deployments/:id
 *     GET    /v1/deployments/:id/health
 *     POST   /v1/deployments/:id/health
 *
 *   scenarios:
 *     GET    /v1/scenarios
 *     GET    /v1/scenarios/:id
 *
 *   audit:
 *     GET    /v1/audit?limit=&entity_type=&entity_id=
 *     POST   /v1/audit
 *
 *   api keys:
 *     POST   /v1/api-keys             — create + return the token ONCE
 *     GET    /v1/api-keys             — list (no hashes/tokens)
 *     DELETE /v1/api-keys/:id         — revoke (soft-delete)
 */

import type { ControlPlane } from "../control-plane/index.js";
import type {
  ArtifactKind,
  DeploymentStatus,
  HealthStatus,
  JobStatus,
  ReleaseStatus,
  TargetConnection,
  TargetKind,
} from "../control-plane/types.js";
import { generateApiKey, makeAuthenticator, type AuthOptions } from "./auth.js";
import { badRequest, notFound } from "./errors.js";
import { Router, type RequestContext } from "./router.js";
import {
  validateGitRef,
  validateRepoUrl,
} from "../control-plane/build/git.js";

const VERSION = "0.2.1";

export interface AppOptions {
  controlPlane: ControlPlane;
  /** Auth knobs (forwarded to makeAuthenticator). */
  auth?: Omit<AuthOptions, "controlPlane">;
}

export function buildApp(opts: AppOptions): Router {
  const cp = opts.controlPlane;
  const authenticate = makeAuthenticator({
    controlPlane: cp,
    disableLoopbackBypass: opts.auth?.disableLoopbackBypass,
  });
  const router = new Router({
    authenticate,
    publicPaths: new Set(["/v1/healthz"]),
  });

  // ── Health / version ──────────────────────────────────────────────
  router.get("/v1/healthz", async () => ({ ok: true, version: VERSION }));

  // ── Products ──────────────────────────────────────────────────────
  router.get("/v1/products", async (ctx) => ({
    products: await cp.products.listForOrg(ctx.auth.orgId),
  }));

  router.post("/v1/products", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const name = readString(body, "name");
    const repoUrl = readString(body, "repo_url");
    // Reject option-injection URLs and other malformed values up front;
    // `validateRepoUrl` throws a `RepoUrlValidationError` which maps to
    // HTTP 400. See `host/src/control-plane/build/git.ts` for the rules.
    validateRepoUrl(repoUrl);
    const buildYamlPath = readOptionalString(body, "build_yaml_path");
    const product = await cp.products.create({
      orgId: ctx.auth.orgId,
      name,
      repoUrl,
      buildYamlPath,
    });
    return { status: 201, body: { product } };
  });

  router.get("/v1/products/by-name/:name", async (ctx) => {
    const product = await cp.products.getByName(ctx.auth.orgId, ctx.params.name);
    if (!product) throw notFound(`product not found: ${ctx.params.name}`);
    return { product };
  });

  router.get("/v1/products/:id", async (ctx) => {
    const product = await cp.products.get(ctx.params.id);
    if (!product || product.orgId !== ctx.auth.orgId) {
      throw notFound(`product not found: ${ctx.params.id}`);
    }
    return { product };
  });

  router.patch("/v1/products/:id", async (ctx) => {
    const existing = await cp.products.get(ctx.params.id);
    if (!existing || existing.orgId !== ctx.auth.orgId) {
      throw notFound(`product not found: ${ctx.params.id}`);
    }
    const body = asObject(ctx.body, "request body");
    const patch = {
      name: readOptionalString(body, "name"),
      repoUrl: readOptionalString(body, "repo_url"),
      buildYamlPath: readOptionalString(body, "build_yaml_path"),
    };
    if (patch.repoUrl !== undefined) {
      validateRepoUrl(patch.repoUrl);
    }
    const product = await cp.products.update(existing.id, patch);
    return { product };
  });

  router.delete("/v1/products/:id", async (ctx) => {
    const existing = await cp.products.get(ctx.params.id);
    if (!existing || existing.orgId !== ctx.auth.orgId) {
      throw notFound(`product not found: ${ctx.params.id}`);
    }
    await cp.products.softDelete(existing.id);
    return { status: 204, body: null };
  });

  // ── Releases ──────────────────────────────────────────────────────
  router.get("/v1/releases", async (ctx) => {
    const productName = readStringQuery(ctx, "product");
    const statusFilter = readStringQuery(ctx, "status");
    if (
      statusFilter !== undefined &&
      !["building", "ready", "failed"].includes(statusFilter)
    ) {
      throw badRequest(`invalid status: '${statusFilter}'`);
    }
    const status = statusFilter as ReleaseStatus | undefined;
    const products = productName
      ? [await cp.products.getByName(ctx.auth.orgId, productName)].filter(
          (p): p is NonNullable<typeof p> => p !== null,
        )
      : await cp.products.listForOrg(ctx.auth.orgId);
    const releases: Array<{
      product: { id: string; name: string };
      release: Awaited<ReturnType<typeof cp.releases.get>>;
    }> = [];
    for (const product of products) {
      const rs = await cp.releases.listForProduct(product.id, { status });
      for (const r of rs)
        releases.push({ product: { id: product.id, name: product.name }, release: r });
    }
    return { releases };
  });

  router.post("/v1/releases", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const productId = readString(body, "product_id");
    const tag = readString(body, "tag");
    // Same option-injection guard we apply to the build job's tag.
    // Rejecting at the release-row layer means downstream `release.build`
    // jobs can trust the tag they pull off the release row.
    validateGitRef(tag);
    const commitSha = readString(body, "commit_sha");
    const product = await cp.products.get(productId);
    if (!product || product.orgId !== ctx.auth.orgId) {
      throw notFound(`product not found: ${productId}`);
    }
    const release = await cp.releases.create({
      orgId: ctx.auth.orgId,
      productId: product.id,
      tag,
      commitSha,
    });
    return { status: 201, body: { release } };
  });

  router.get("/v1/releases/:id", async (ctx) => {
    const release = await releaseInOrg(cp, ctx);
    return { release };
  });

  router.patch("/v1/releases/:id", async (ctx) => {
    const release = await releaseInOrg(cp, ctx);
    const body = asObject(ctx.body, "request body");
    const patch = {
      status: readOptionalEnum(body, "status", [
        "building",
        "ready",
        "failed",
      ] as const),
      manifestSha256: readOptionalString(body, "manifest_sha256"),
      signedBy: readOptionalString(body, "signed_by"),
      builtAt: readOptionalString(body, "built_at"),
      builtByRunnerId: readOptionalString(body, "built_by_runner_id"),
      buildYamlJson: readOptionalString(body, "build_yaml_json"),
    };
    const updated = await cp.releases.update(release.id, patch);
    return { release: updated };
  });

  router.delete("/v1/releases/:id", async (ctx) => {
    const release = await releaseInOrg(cp, ctx);
    await cp.releases.softDelete(release.id);
    return { status: 204, body: null };
  });

  router.get("/v1/releases/:id/artifacts", async (ctx) => {
    const release = await releaseInOrg(cp, ctx);
    return { artifacts: await cp.artifacts.listForRelease(release.id) };
  });

  router.post("/v1/releases/:id/artifacts", async (ctx) => {
    const release = await releaseInOrg(cp, ctx);
    const body = asObject(ctx.body, "request body");
    const kind = readEnum(body, "kind", ["blob", "image_ref"] as const);
    const artifact = await cp.artifacts.create({
      releaseId: release.id,
      component: readString(body, "component"),
      kind: kind as ArtifactKind,
      sha256: readOptionalString(body, "sha256"),
      sizeBytes: readOptionalInt(body, "size_bytes"),
      blobUri: readOptionalString(body, "blob_uri"),
      imageRef: readOptionalString(body, "image_ref"),
    });
    return { status: 201, body: { artifact } };
  });

  // ── Targets ───────────────────────────────────────────────────────
  router.get("/v1/targets", async (ctx) => ({
    targets: await cp.targets.listForOrg(ctx.auth.orgId),
  }));

  router.post("/v1/targets", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const kind = readEnum(body, "kind", [
      "vm_test",
      "vm_demo",
      "docker_test",
      "docker_demo",
    ] as const);
    const connection = body.connection;
    if (!connection || typeof connection !== "object") {
      throw badRequest("connection must be an object");
    }
    const target = await cp.targets.create({
      orgId: ctx.auth.orgId,
      name: readString(body, "name"),
      kind: kind as TargetKind,
      connection: connection as TargetConnection,
    });
    return { status: 201, body: { target } };
  });

  router.get("/v1/targets/by-name/:name", async (ctx) => {
    const target = await cp.targets.getByName(ctx.auth.orgId, ctx.params.name);
    if (!target) throw notFound(`target not found: ${ctx.params.name}`);
    return { target };
  });

  router.get("/v1/targets/:id", async (ctx) => {
    const target = await targetInOrg(cp, ctx);
    return { target };
  });

  router.delete("/v1/targets/:id", async (ctx) => {
    const target = await targetInOrg(cp, ctx);
    await cp.targets.softDelete(target.id);
    return { status: 204, body: null };
  });

  router.get("/v1/targets/:id/deployments", async (ctx) => {
    const target = await targetInOrg(cp, ctx);
    const limit = readIntQuery(ctx, "limit");
    return {
      deployments: await cp.deployments.listForTarget(target.id, { limit }),
    };
  });

  // ── Deployments ───────────────────────────────────────────────────
  router.post("/v1/deployments", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const releaseId = readString(body, "release_id");
    const targetId = readString(body, "target_id");
    const previousDeploymentId = readOptionalString(body, "previous_deployment_id");
    const release = await cp.releases.get(releaseId);
    if (!release || release.orgId !== ctx.auth.orgId) {
      throw notFound(`release not found: ${releaseId}`);
    }
    const target = await cp.targets.get(targetId);
    if (!target || target.orgId !== ctx.auth.orgId) {
      throw notFound(`target not found: ${targetId}`);
    }
    const deployment = await cp.deployments.create({
      orgId: ctx.auth.orgId,
      releaseId: release.id,
      targetId: target.id,
      previousDeploymentId,
    });
    return { status: 201, body: { deployment } };
  });

  router.get("/v1/deployments/:id", async (ctx) => {
    const deployment = await deploymentInOrg(cp, ctx);
    return { deployment };
  });

  router.patch("/v1/deployments/:id", async (ctx) => {
    const deployment = await deploymentInOrg(cp, ctx);
    const body = asObject(ctx.body, "request body");
    const patch = {
      status: readOptionalEnum(body, "status", [
        "pending",
        "deploying",
        "active",
        "failed",
        "superseded",
        "rolled_back",
      ] as const) as DeploymentStatus | undefined,
      startedAt: readOptionalString(body, "started_at"),
      completedAt: readOptionalString(body, "completed_at"),
      healthSummary:
        body.health_summary === undefined
          ? undefined
          : (body.health_summary as Awaited<
              ReturnType<typeof cp.deployments.update>
            >["healthSummary"]),
    };
    const updated = await cp.deployments.update(deployment.id, patch);
    return { deployment: updated };
  });

  router.get("/v1/deployments/:id/health", async (ctx) => {
    const deployment = await deploymentInOrg(cp, ctx);
    const since = readStringQuery(ctx, "since");
    const limit = readIntQuery(ctx, "limit");
    return {
      checks: await cp.healthChecks.listForDeployment(deployment.id, {
        since,
        limit,
      }),
    };
  });

  router.post("/v1/deployments/:id/health", async (ctx) => {
    const deployment = await deploymentInOrg(cp, ctx);
    const body = asObject(ctx.body, "request body");
    const status = readEnum(body, "status", ["pass", "fail", "degraded"] as const);
    const check = await cp.healthChecks.append({
      deploymentId: deployment.id,
      probeName: readString(body, "probe_name"),
      status: status as HealthStatus,
      latencyMs: readOptionalInt(body, "latency_ms"),
      detail: readOptionalString(body, "detail"),
    });
    return { status: 201, body: { check } };
  });

  // ── Scenarios ─────────────────────────────────────────────────────
  router.get("/v1/scenarios", async (ctx) => ({
    scenarios: await cp.scenarios.listForOrg(ctx.auth.orgId),
  }));

  router.get("/v1/scenarios/:id", async (ctx) => {
    const scenario = await cp.scenarios.get(ctx.params.id);
    if (!scenario || scenario.orgId !== ctx.auth.orgId) {
      throw notFound(`scenario not found: ${ctx.params.id}`);
    }
    return { scenario };
  });

  // ── Audit log ─────────────────────────────────────────────────────
  router.get("/v1/audit", async (ctx) => {
    const limit = readIntQuery(ctx, "limit");
    const entityType = readStringQuery(ctx, "entity_type");
    const entityId = readStringQuery(ctx, "entity_id");
    return {
      entries: await cp.auditLog.listForOrg(ctx.auth.orgId, {
        limit,
        entityType,
        entityId,
      }),
    };
  });

  router.post("/v1/audit", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const entry = await cp.auditLog.append({
      orgId: ctx.auth.orgId,
      actor: readString(body, "actor"),
      action: readString(body, "action"),
      entityType: readString(body, "entity_type"),
      entityId: readString(body, "entity_id"),
      detail: body.detail as Record<string, unknown> | undefined,
    });
    return { status: 201, body: { entry } };
  });

  // ── API keys ──────────────────────────────────────────────────────
  router.post("/v1/api-keys", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const generated = generateApiKey();
    const apiKey = await cp.apiKeys.create({
      orgId: ctx.auth.orgId,
      name: readString(body, "name"),
      prefix: generated.prefix,
      hash: generated.hash,
      expiresAt: readOptionalString(body, "expires_at"),
    });
    // Return the plaintext token ONCE. Frontend / CLI is responsible
    // for surfacing it to the operator; once they close the response
    // it's gone forever.
    return {
      status: 201,
      body: {
        api_key: { ...apiKey, hash: undefined },
        token: generated.token,
      },
    };
  });

  router.get("/v1/api-keys", async (ctx) => {
    const keys = await cp.apiKeys.listForOrg(ctx.auth.orgId);
    // Strip the hash; nobody ever needs it after creation.
    return {
      api_keys: keys.map((k) => ({ ...k, hash: undefined })),
    };
  });

  router.delete("/v1/api-keys/:id", async (ctx) => {
    const key = await cp.apiKeys.get(ctx.params.id);
    if (!key || key.orgId !== ctx.auth.orgId) {
      throw notFound(`api key not found: ${ctx.params.id}`);
    }
    await cp.apiKeys.softDelete(key.id);
    return { status: 204, body: null };
  });

  // ── Runners (WS6 M3 — explicit registration + heartbeat) ──────────

  router.post("/v1/runners/heartbeat", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const name = readString(body, "name");
    const meta =
      body.meta !== undefined && body.meta !== null
        ? asObject(body.meta, "meta")
        : undefined;
    const runner = await cp.runners.heartbeat({
      orgId: ctx.auth.orgId,
      name,
      meta,
    });
    return { status: 200, body: { runner } };
  });

  router.get("/v1/runners", async (ctx) => {
    const runners = await cp.runners.listForOrg(ctx.auth.orgId);
    return { runners };
  });

  router.delete("/v1/runners/:id", async (ctx) => {
    const runner = await cp.runners.get(ctx.params.id);
    if (!runner || runner.orgId !== ctx.auth.orgId) {
      throw notFound(`runner not found: ${ctx.params.id}`);
    }
    await cp.runners.softDelete(runner.id);
    return { status: 204, body: null };
  });

  // ── Jobs (PR 8 — submit-mode runner queue) ────────────────────────

  router.post("/v1/jobs", async (ctx) => {
    const body = asObject(ctx.body, "request body");
    const kind = readString(body, "kind");
    const inputObj =
      body.input !== undefined ? asObject(body.input, "input") : undefined;
    // Per-kind input validation. `release.build` flows `input.tag`
    // through to `git clone --branch <tag>` on the runner side; reject
    // option-injection values up front so the runner doesn't have to.
    if (kind === "release.build" && inputObj) {
      const tag = inputObj.tag;
      if (typeof tag === "string") {
        validateGitRef(tag);
      }
    }
    const job = await cp.jobs.create({
      orgId: ctx.auth.orgId,
      kind,
      input: inputObj,
    });
    return { status: 201, body: { job } };
  });

  router.get("/v1/jobs", async (ctx) => {
    const limit = readIntQuery(ctx, "limit");
    const statusFilter = readStringQuery(ctx, "status");
    if (
      statusFilter !== undefined &&
      !["pending", "claimed", "running", "succeeded", "failed"].includes(
        statusFilter,
      )
    ) {
      throw badRequest(`invalid status: '${statusFilter}'`);
    }
    const status = statusFilter as JobStatus | undefined;
    return {
      jobs: await cp.jobs.listForOrg(ctx.auth.orgId, { limit, status }),
    };
  });

  router.get("/v1/jobs/:id", async (ctx) => {
    const job = await cp.jobs.get(ctx.params.id);
    if (!job || job.orgId !== ctx.auth.orgId) {
      throw notFound(`job not found: ${ctx.params.id}`);
    }
    return { job };
  });

  /**
   * Runner claim: returns the oldest pending job for the caller's org,
   * atomically transitioning it to `claimed`. Returns `{ job: null }`
   * when the queue is empty — the runner should sleep + poll again.
   */
  router.post("/v1/jobs/claim", async (ctx) => {
    const body = ctx.body !== undefined ? asObject(ctx.body, "request body") : {};
    const claimedBy = readOptionalString(body, "claimed_by") ?? "anonymous";
    const job = await cp.jobs.claimNext({
      orgId: ctx.auth.orgId,
      claimedBy,
    });
    return { job };
  });

  router.post("/v1/jobs/:id/complete", async (ctx) => {
    const job = await jobInOrg(cp, ctx);
    const body = ctx.body !== undefined ? asObject(ctx.body, "request body") : {};
    const result =
      body.result !== undefined ? asObject(body.result, "result") : undefined;
    const updated = await cp.jobs.update(job.id, {
      status: "succeeded",
      result: result ?? null,
      completedAt: new Date().toISOString(),
    });
    return { job: updated };
  });

  router.post("/v1/jobs/:id/fail", async (ctx) => {
    const job = await jobInOrg(cp, ctx);
    const body = ctx.body !== undefined ? asObject(ctx.body, "request body") : {};
    const error = readString(body, "error");
    const updated = await cp.jobs.update(job.id, {
      status: "failed",
      error,
      completedAt: new Date().toISOString(),
    });
    return { job: updated };
  });

  router.patch("/v1/jobs/:id", async (ctx) => {
    const job = await jobInOrg(cp, ctx);
    const body = asObject(ctx.body, "request body");
    const patch = {
      status: readOptionalEnum(body, "status", [
        "pending",
        "claimed",
        "running",
        "succeeded",
        "failed",
      ] as const) as JobStatus | undefined,
      startedAt: readOptionalString(body, "started_at"),
      completedAt: readOptionalString(body, "completed_at"),
      error: readOptionalString(body, "error"),
      result:
        body.result === undefined
          ? undefined
          : body.result === null
            ? null
            : asObject(body.result, "result"),
    };
    const updated = await cp.jobs.update(job.id, patch);
    return { job: updated };
  });

  // ── Blobs (PR 8b) ─────────────────────────────────────────────────
  registerBlobEndpoints(router, cp);

  return router;
}

async function jobInOrg(cp: ControlPlane, ctx: RequestContext) {
  const job = await cp.jobs.get(ctx.params.id);
  if (!job || job.orgId !== ctx.auth.orgId) {
    throw notFound(`job not found: ${ctx.params.id}`);
  }
  return job;
}

// ── Blobs (PR 8b — remote build artifact upload + retrieval) ────────
//
// `POST /v1/blobs` accepts a raw octet-stream and stores it via the
// configured BlobDriver. Returns the content-addressed sha256 + size
// + driver-issued URI. The 1 MiB JSON-body cap is bypassed via the
// `streamBody` route option; artifacts can be hundreds of MB.
//
// `GET /v1/blobs/:sha256` streams the blob bytes back. Used by the
// future runner-side downloader when staging artifacts onto a remote
// target. Streamed via `rawResponse` to avoid buffering.
//
// Blobs are org-scoped on disk (`<root>/<org_id>/<sha[0:2]>/<sha>`) so
// a sha256 collision across orgs is fine — we look up under the
// caller's org only.

function registerBlobEndpoints(router: Router, cp: ControlPlane): void {
  router.post(
    "/v1/blobs",
    async (ctx) => {
      if (!ctx.bodyStream) {
        throw badRequest("blob upload requires a request body");
      }
      const meta = await cp.blobs.put({
        orgId: ctx.auth.orgId,
        body: ctx.bodyStream,
      });
      return { status: 201, body: meta };
    },
    // 1 GiB cap (default for streamBody routes). Operators uploading
    // larger artifacts should raise this knowing the v0.3.0 S3 driver
    // buffers-then-PUTs (RAM-bound) — a streaming PUT path is on the
    // v0.3.x roadmap.
    { streamBody: true, maxBodyBytes: 1024 * 1024 * 1024 },
  );

  router.get(
    "/v1/blobs/:sha256",
    async (ctx) => {
      if (!ctx.res) {
        throw badRequest("internal: rawResponse handler missing res");
      }
      if (!/^[a-f0-9]{64}$/.test(ctx.params.sha256)) {
        ctx.res.statusCode = 400;
        ctx.res.setHeader("content-type", "application/json; charset=utf-8");
        ctx.res.end(
          JSON.stringify({
            error: { code: "bad_request", message: "sha256 must be 64 hex chars" },
          }),
        );
        return;
      }
      // Driver picks the on-disk / S3 layout to look under.
      const sha = ctx.params.sha256;
      const uri = cp.blobs.resolveBySha(ctx.auth.orgId, sha);
      let stream;
      try {
        stream = await cp.blobs.get(uri);
      } catch (err) {
        if ((err as Error).name === "BlobNotFoundError") {
          ctx.res.statusCode = 404;
          ctx.res.setHeader("content-type", "application/json; charset=utf-8");
          ctx.res.end(
            JSON.stringify({
              error: { code: "not_found", message: `blob not found: ${sha}` },
            }),
          );
          return;
        }
        throw err;
      }
      ctx.res.statusCode = 200;
      ctx.res.setHeader("content-type", "application/octet-stream");
      stream.pipe(ctx.res);
      // Settle when the stream finishes piping so the handler awaits
      // completion correctly.
      await new Promise<void>((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
        ctx.res!.on("error", reject);
      });
    },
    { rawResponse: true },
  );
}

// `blobUriFromSha` (PR 8b's local-FS-specific helper) replaced by
// `cp.blobs.resolveBySha(orgId, sha)` — see BlobDriver interface.

// ── Helpers ─────────────────────────────────────────────────────────

async function releaseInOrg(cp: ControlPlane, ctx: RequestContext) {
  const release = await cp.releases.get(ctx.params.id);
  if (!release || release.orgId !== ctx.auth.orgId) {
    throw notFound(`release not found: ${ctx.params.id}`);
  }
  return release;
}

async function targetInOrg(cp: ControlPlane, ctx: RequestContext) {
  const target = await cp.targets.get(ctx.params.id);
  if (!target || target.orgId !== ctx.auth.orgId) {
    throw notFound(`target not found: ${ctx.params.id}`);
  }
  return target;
}

async function deploymentInOrg(cp: ControlPlane, ctx: RequestContext) {
  const deployment = await cp.deployments.get(ctx.params.id);
  if (!deployment || deployment.orgId !== ctx.auth.orgId) {
    throw notFound(`deployment not found: ${ctx.params.id}`);
  }
  return deployment;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) {
    throw badRequest(`'${field}' is required (string)`);
  }
  return v;
}

function readOptionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw badRequest(`'${field}' must be a string`);
  }
  return v;
}

function readOptionalInt(
  body: Record<string, unknown>,
  field: string,
): number | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw badRequest(`'${field}' must be an integer`);
  }
  return v;
}

function readEnum<T extends readonly string[]>(
  body: Record<string, unknown>,
  field: string,
  allowed: T,
): T[number] {
  const v = readString(body, field);
  if (!allowed.includes(v as T[number])) {
    throw badRequest(`'${field}' must be one of ${allowed.join("|")}`);
  }
  return v as T[number];
}

function readOptionalEnum<T extends readonly string[]>(
  body: Record<string, unknown>,
  field: string,
  allowed: T,
): T[number] | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T[number])) {
    throw badRequest(`'${field}' must be one of ${allowed.join("|")}`);
  }
  return v as T[number];
}

function readStringQuery(ctx: RequestContext, name: string): string | undefined {
  const v = ctx.query[name];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    throw badRequest(`query param '${name}' must not be repeated`);
  }
  return v;
}

function readIntQuery(ctx: RequestContext, name: string): number | undefined {
  const raw = readStringQuery(ctx, name);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw badRequest(`query param '${name}' must be a non-negative integer`);
  }
  return n;
}

