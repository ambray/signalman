/**
 * Spec-paginated repository + tag enumeration.
 *
 *   GET /v2/_catalog?n=<count>&last=<repo>
 *   GET /v2/<name>/tags/list?n=<count>&last=<tag>
 *
 * Both endpoints emit a `Link: <next-url>; rel="next"` header per
 * RFC 5988 when more results follow; the header is omitted when the
 * current page is the last one. Spec §Listing Tags / §Catalog are
 * unambiguous about lexical ordering (ASCII) and the `last` cursor
 * being exclusive — `?last=foo` skips `foo` and returns whatever
 * comes after it.
 *
 * Catalog scope at v0.5: only the OCI namespace (storage manifests
 * with `name LIKE 'oci/%'`). Cargo + npm catalogs already have their
 * own surfaces. The spec's `_catalog` endpoint is purely about the
 * `/v2/` registry's repositories.
 */

import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { OciError } from "./errors.js";
import { OCI_ERROR_CODES } from "./types.js";
import { ociManifestName, validateOciRepositoryName, validateOciTag } from "./paths.js";
import { asOciError, writeOciError } from "./http.js";
import { TagStore } from "./tag-store.js";

export interface MountOciCatalogOptions {
  index: SqliteManifestIndex;
  tagStore: TagStore;
  publicBaseUrl?: string;
  /** Default page size. Spec leaves this to the server; we pick 100. */
  defaultPageSize?: number;
  /** Hard cap on page size. Default 1000. */
  maxPageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

interface ParsedRepository {
  org: string;
  repo: string;
  storageName: string;
}

function parseRepositoryParam(rawName: string): ParsedRepository {
  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `<name> path parameter is required`,
    );
  }
  const firstSlash = rawName.indexOf("/");
  if (firstSlash <= 0 || firstSlash === rawName.length - 1) {
    throw new OciError(
      OCI_ERROR_CODES.NAME_INVALID,
      `<name> must include both an org and a repository segment`,
    );
  }
  const org = rawName.slice(0, firstSlash);
  const repo = rawName.slice(firstSlash + 1);
  validateOciRepositoryName(rawName);
  return { org, repo, storageName: ociManifestName(org, repo) };
}

export function mountOciCatalogRoutes(
  router: Router,
  opts: MountOciCatalogOptions,
): void {
  const index = opts.index;
  const tagStore = opts.tagStore;
  const baseUrl = opts.publicBaseUrl ?? "";
  const defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const maxPageSize = opts.maxPageSize ?? MAX_PAGE_SIZE;

  // ── GET /v2/_catalog ────────────────────────────────────────────
  router.get(
    "/v2/_catalog",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const { n, last } = parsePaging(ctx.query, defaultPageSize, maxPageSize);
        // `n=0` is a spec-defined edge case: MUST return an empty list
        // and MUST NOT include a Link header.
        if (n === 0) {
          writeJson(res, 200, { repositories: [] });
          return;
        }
        const afterStorage = last ? `oci/${last}` : "oci/";
        // Read one extra row so we can decide whether a Link header is needed
        // without a second query.
        const rows = listRepositoriesAfter(index, afterStorage, n + 1);
        const overflow = rows.length > n;
        const page = (overflow ? rows.slice(0, n) : rows).map((r) =>
          r.name.slice("oci/".length),
        );
        if (overflow && page.length > 0) {
          const cursor = page[page.length - 1];
          res.setHeader(
            "Link",
            `<${baseUrl}/v2/_catalog?n=${n}&last=${encodeURIComponent(cursor)}>; rel="next"`,
          );
        }
        writeJson(res, 200, { repositories: page });
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );

  // ── GET /v2/<name>/tags/list ────────────────────────────────────
  router.get(
    "/v2/*name/tags/list",
    async (ctx) => {
      const res = ctx.res!;
      try {
        const repo = parseRepositoryParam(ctx.params.name);
        const { n, last } = parsePaging(ctx.query, defaultPageSize, maxPageSize);
        if (last !== undefined) {
          // The `last` parameter must itself be a valid tag — defend
          // against injection / malformed cursors.
          try {
            validateOciTag(last);
          } catch (err) {
            throw err instanceof OciError
              ? err
              : new OciError(
                  OCI_ERROR_CODES.MANIFEST_INVALID,
                  `invalid last cursor`,
                );
          }
        }
        if (n === 0) {
          writeJson(res, 200, { name: `${repo.org}/${repo.repo}`, tags: [] });
          return;
        }
        const rows = tagStore.list(repo.storageName, {
          ...(last ? { after: last } : {}),
          limit: n + 1,
        });
        const overflow = rows.length > n;
        const tags = (overflow ? rows.slice(0, n) : rows).map((r) => r.tag);
        if (overflow && tags.length > 0) {
          const cursor = tags[tags.length - 1];
          res.setHeader(
            "Link",
            `<${baseUrl}/v2/${repo.org}/${repo.repo}/tags/list?n=${n}&last=${encodeURIComponent(cursor)}>; rel="next"`,
          );
        }
        writeJson(res, 200, { name: `${repo.org}/${repo.repo}`, tags });
      } catch (err) {
        writeOciError(res, asOciError(err));
      }
    },
    { rawResponse: true },
  );
}

// ── Helpers ─────────────────────────────────────────────────────

interface Paging {
  n: number;
  last: string | undefined;
}

function parsePaging(
  query: Record<string, string | undefined>,
  defaultPageSize: number,
  maxPageSize: number,
): Paging {
  const rawN = query.n;
  let n = defaultPageSize;
  if (rawN !== undefined) {
    const parsed = Number(rawN);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new OciError(
        OCI_ERROR_CODES.MANIFEST_INVALID,
        `n must be a non-negative integer; got '${rawN}'`,
      );
    }
    n = Math.min(parsed, maxPageSize);
  }
  const last = query.last;
  return { n, last };
}

function writeJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(json).toString());
  res.end(json);
}

function listRepositoriesAfter(
  index: SqliteManifestIndex,
  afterStorage: string,
  limit: number,
): Array<{ name: string }> {
  // Distinct repository names in the OCI namespace, ASCII-ordered.
  // Strips the `oci/` prefix at the caller-site.
  const rows = index.db
    .prepare(
      `SELECT DISTINCT name
       FROM manifest
       WHERE name > ? AND name LIKE 'oci/%'
       ORDER BY name ASC
       LIMIT ?`,
    )
    .all(afterStorage, limit) as Array<{ name: string }>;
  return rows;
}
