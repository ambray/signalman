/**
 * Forensic + provenance HTTP routes (WS6 wave-3 M10.5).
 *
 * The "code-to-cloud" picture: every artifact in the registry
 * carries provenance (M10.1) — "where did this come from", with
 * source ∈ { upload, proxy_cache, manifest_create, migration } and
 * the upstream URL when applicable. Every ingest event also lands
 * in the immutable audit log. These routes surface both for
 * forensic + compliance use.
 *
 * Routes mounted under /v1/:
 *
 *   GET /v1/provenance/manifest/:name/:version
 *     Returns { manifest, provenance } for a single manifest. The
 *     manifest is the operator-signed body; provenance is the
 *     server-side metadata.
 *
 *   GET /v1/audit
 *     Paginated audit log. Query params:
 *       action: 'upload' | 'proxy_cache' | 'manifest_create'
 *                | 'yank' | 'unyank'
 *       entity_type: 'blob' | 'manifest' | 'cargo_crate'
 *                    | 'virtual_upstream'
 *       entity_id: filter to a specific entity
 *       actor: filter to a specific token prefix
 *       since: ISO-8601 lower bound on created_at
 *       limit: default 200, max 1000
 *
 *   GET /v1/forensic/summary
 *     Aggregate view: counts by (kind, provenance.source). Powers
 *     the operator question "what's in my registry and where did
 *     it come from?"
 *
 *   GET /v1/forensic/upstreams
 *     Aggregate view: per-upstream artifact counts. Powers the
 *     "what came from crates.io" question.
 *
 * Auth: all routes require a valid bearer token. The v0.4.0
 * accept-any-valid-shape model applies; real RBAC ('forensic:read'
 * scope) lands with M10.6 follow-up.
 */

import {
  REGISTRY_ERROR_CODES,
  RegistryError,
  type Manifest,
  type RegistryStorage,
} from "../types.js";
import { badRequest, notFound } from "./errors.js";
import type { Router } from "./router.js";
import type {
  AuditAction,
  AuditEntityType,
  SqliteManifestIndex,
} from "../storage/sqlite-index.js";

const AUDIT_LIMIT_DEFAULT = 200;
const AUDIT_LIMIT_MAX = 1000;

export interface MountForensicOptions {
  storage: RegistryStorage;
  /**
   * SqliteManifestIndex for direct audit-log / aggregate queries.
   * Optional — when absent, audit + summary routes return 501.
   */
  index?: SqliteManifestIndex;
}

export function mountForensicRoutes(
  router: Router,
  opts: MountForensicOptions,
): void {
  const storage = opts.storage;
  const index = opts.index;

  // ── /v1/provenance/manifest/:name/:version ─────────────────────

  router.get("/v1/provenance/manifest/:name/:version", async (ctx) => {
    const { name, version } = ctx.params;
    const manifest = await storage.getManifest(name, version);
    if (!manifest) {
      throw notFound(`manifest not found: ${name}@${version}`);
    }
    const provenance = storage.getProvenance
      ? await storage.getProvenance(name, version)
      : null;
    return {
      manifest,
      provenance: provenance ?? null,
    } as { manifest: Manifest; provenance: unknown };
  });

  // ── /v1/audit ─────────────────────────────────────────────────

  router.get("/v1/audit", async (ctx) => {
    if (!index) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.UNAUTHORIZED, // closest available; remap to 501-ish
        "audit log is unavailable: storage backing is not sqlite-indexed",
      );
    }
    const action = parseAuditAction(ctx.query.action);
    const entityType = parseAuditEntityType(ctx.query.entity_type);
    const entityId = ctx.query.entity_id;
    const actor = ctx.query.actor;
    const since = ctx.query.since;
    const limitRaw = ctx.query.limit;
    let limit = AUDIT_LIMIT_DEFAULT;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw badRequest(`limit must be a positive integer (got '${limitRaw}')`);
      }
      limit = Math.min(parsed, AUDIT_LIMIT_MAX);
    }
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw badRequest(`since must be ISO-8601 (got '${since}')`);
    }
    const entries = index.listAuditEntries({
      action,
      entityType,
      entityId,
      actor,
      since,
      limit,
    });
    return {
      entries,
      filters: {
        action: action ?? null,
        entity_type: entityType ?? null,
        entity_id: entityId ?? null,
        actor: actor ?? null,
        since: since ?? null,
        limit,
      },
    };
  });

  // ── /v1/forensic/summary ──────────────────────────────────────

  router.get("/v1/forensic/summary", async (_ctx) => {
    if (!index) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.UNAUTHORIZED,
        "forensic summary is unavailable: storage backing is not sqlite-indexed",
      );
    }
    const counts = index.manifestCountsByKindAndSource();
    // Roll up into a per-kind { source -> count } map for easier
    // operator consumption.
    const byKind: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const row of counts) {
      byKind[row.kind] ??= {};
      byKind[row.kind][row.source] = row.count;
      total += row.count;
    }
    return {
      total_manifests: total,
      by_kind: byKind,
      raw: counts,
    };
  });

  // ── /v1/forensic/upstreams ────────────────────────────────────

  router.get("/v1/forensic/upstreams", async (_ctx) => {
    if (!index) {
      throw new RegistryError(
        REGISTRY_ERROR_CODES.UNAUTHORIZED,
        "upstream summary is unavailable: storage backing is not sqlite-indexed",
      );
    }
    const rows = index.artifactsByUpstream();
    return {
      upstreams: rows.map((r) => ({
        upstream_url: r.upstreamUrl,
        manifest_count: r.count,
      })),
    };
  });
}

function parseAuditAction(s: string | undefined): AuditAction | undefined {
  if (s === undefined) return undefined;
  switch (s) {
    case "upload":
    case "proxy_cache":
    case "manifest_create":
    case "yank":
    case "unyank":
    case "delete":
      return s;
    default:
      throw badRequest(`unknown audit action: ${s}`);
  }
}

function parseAuditEntityType(s: string | undefined): AuditEntityType | undefined {
  if (s === undefined) return undefined;
  switch (s) {
    case "blob":
    case "manifest":
    case "cargo_crate":
    case "virtual_upstream":
      return s;
    default:
      throw badRequest(`unknown entity type: ${s}`);
  }
}
