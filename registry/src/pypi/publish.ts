/**
 * PyPI legacy upload endpoint — `POST /pypi/<org>/`.
 *
 * Accepts multipart/form-data with `:action=file_upload`, exactly
 * the shape twine + uv-publish + flit emit. The Warehouse-canonical
 * endpoint is `https://upload.pypi.org/legacy/`; ours mirrors that
 * shape at the per-org URL so operators can configure twine with
 * `--repository-url https://signalman-reg/pypi/<org>/`.
 *
 * Flow:
 *   1. Read body (capped at maxBodyBytes; default 256 MiB).
 *   2. Parse multipart; extract metadata + content via parseUploadBody.
 *   3. Re-hash content; verify against client-declared sha256_digest.
 *   4. Idempotent putBlob — sha collision means same bytes; re-upload
 *      is a no-op.
 *   5. Build a Manifest with kind='pypi', version=<filename>,
 *      blobs=[content], pypiMetadata=<projected metadata>.
 *   6. putManifest. MANIFEST_EXISTS-different-content is rejected as
 *      PyPI CONFLICT (operators cannot overwrite a published file).
 *   7. Audit-log action='upload', entity_type='manifest'.
 *
 * Auth: every route requires a federated bearer token through the
 * existing `sk_<prefix>_<secret>` shape. Operator-side twine
 * configures with username = `__token__` and password = the API
 * token — but our authenticator runs on the standard Authorization:
 * Bearer header. M8 lands a `/pypi/<org>/`-specific token-shim if
 * operators ask for `__token__:<sk_...>` Basic auth compat.
 */

import { Readable } from "node:stream";
import {
  type Manifest,
  type Provenance,
  type PypiManifestMetadata,
  type RegistryStorage,
  REGISTRY_ERROR_CODES,
  RegistryError,
} from "../types.js";
import type { Router } from "../http/router.js";
import type { SqliteManifestIndex } from "../storage/sqlite-index.js";
import { validateCargoOrgName } from "../cargo/paths.js";
import { PypiError, asPypiError, writePypiError } from "./errors.js";
import { PYPI_ERROR_CODES, type TwineUpload } from "./types.js";
import { pypiManifestName, parseWheelFilename } from "./paths.js";
import { extractBoundary, parseMultipart } from "./multipart.js";
import { parseUploadBody, singleField, repeatedField } from "./guards.js";

export interface MountPypiPublishOptions {
  storage: RegistryStorage;
  index?: SqliteManifestIndex;
  /** Max body size for a single twine upload. Default 256 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024 * 1024;

export function mountPypiPublishRoutes(
  router: Router,
  opts: MountPypiPublishOptions,
): void {
  const storage = opts.storage;
  const index = opts.index;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  router.post(
    "/pypi/:org/",
    async (ctx) => {
      const res = ctx.res!;
      try {
        validateCargoOrgName(ctx.params.org);
        if (!ctx.bodyStream) {
          throw new PypiError(
            PYPI_ERROR_CODES.UPLOAD_INVALID,
            "POST requires a multipart/form-data request body",
          );
        }
        const contentType = headerString(ctx.headers["content-type"]);
        const boundary = extractBoundary(contentType);
        if (!boundary) {
          throw new PypiError(
            PYPI_ERROR_CODES.UPLOAD_INVALID,
            `Content-Type must be multipart/form-data; got '${contentType ?? "<missing>"}'`,
          );
        }
        const body = await readBody(ctx.bodyStream, maxBodyBytes);
        const parsed = parseMultipart(body, boundary);
        const upload = parseUploadBody(parsed);

        const blobMeta = await storage.putBlob({
          body: upload.content,
          contentType:
            upload.filetype === "bdist_wheel"
              ? "application/octet-stream"
              : "application/octet-stream",
        });
        if (blobMeta.sha256 !== upload.declaredSha256) {
          // Should never happen — declaredSha256 was already verified
          // by parseUploadBody against the same bytes. Defensive.
          throw new PypiError(
            PYPI_ERROR_CODES.DIGEST_MISMATCH,
            `storage layer recomputed sha256:${blobMeta.sha256} but upload declared ${upload.declaredSha256}`,
          );
        }

        const pypiMetadata = projectMetadata(upload);
        const storageName = pypiManifestName(ctx.params.org, upload.packageName);

        // Idempotency: if a row already exists for this (storageName,
        // filename) AND its blob sha matches the bytes just uploaded,
        // treat as a no-op success. Matches Warehouse's behaviour —
        // twine retries don't double-publish. Different bytes for
        // the same filename surface as 409 CONFLICT.
        const existing = await storage.getManifest(storageName, upload.filename);
        if (existing) {
          const existingSha = existing.blobs[0]?.sha256;
          if (existingSha === blobMeta.sha256) {
            res.statusCode = 200;
            res.setHeader("content-length", "0");
            res.end();
            return;
          }
          throw new PypiError(
            PYPI_ERROR_CODES.CONFLICT,
            `file '${upload.filename}' for '${upload.packageName}' is already published with different content`,
          );
        }

        const manifest: Manifest = {
          name: storageName,
          version: upload.filename,
          mediaType: "application/vnd.signalman.pypi-file.v1+json",
          kind: "pypi",
          blobs: [
            {
              mediaType:
                upload.filetype === "bdist_wheel"
                  ? "application/octet-stream"
                  : "application/octet-stream",
              sha256: blobMeta.sha256,
              size: blobMeta.size,
              name: upload.filename,
            },
          ],
          pypiMetadata,
          createdAt: new Date().toISOString(),
        };
        const provenance: Provenance = {
          source: "upload",
          fetchedAt: manifest.createdAt,
          fetchedBy: ctx.auth.tokenPrefix?.slice(-16),
        };
        try {
          await storage.putManifest(manifest, provenance);
        } catch (err) {
          if (
            err instanceof RegistryError &&
            err.code === REGISTRY_ERROR_CODES.MANIFEST_EXISTS
          ) {
            // Same filename pushed before with different bytes (the
            // sha256 must already be different — putManifest would
            // accept identical content as idempotent). Surface as a
            // PyPI 409.
            throw new PypiError(
              PYPI_ERROR_CODES.CONFLICT,
              `file '${upload.filename}' for '${upload.packageName}' is already published with different content`,
            );
          }
          throw err;
        }

        if (index) {
          index.appendAuditEntry({
            action: "upload",
            entityType: "manifest",
            entityId: `${storageName}@${upload.filename}`,
            actor: ctx.auth.tokenPrefix ?? "anonymous",
            detail: {
              kind: "pypi",
              org: ctx.params.org,
              package: upload.packageName,
              version: upload.version,
              filename: upload.filename,
              filetype: upload.filetype,
              bytes: upload.content.length,
              sha256: upload.declaredSha256,
            },
          });
        }

        // Warehouse responds with an empty 200; pip / twine read the
        // status code and discard the body.
        res.statusCode = 200;
        res.setHeader("content-length", "0");
        res.end();
      } catch (err) {
        writePypiError(res, asPypiError(err));
      }
    },
    {
      rawResponse: true,
      streamBody: true,
      maxBodyBytes,
    },
  );
}

function projectMetadata(upload: TwineUpload): PypiManifestMetadata {
  const meta: PypiManifestMetadata = {
    version: upload.version,
    filename: upload.filename,
    filetype: upload.filetype,
  };
  // Wheel filename embeds python_tag / abi_tag / platform_tag.
  if (upload.filetype === "bdist_wheel") {
    try {
      const wheel = parseWheelFilename(upload.filename);
      meta.python_version = wheel.pythonTag;
      meta.abi = wheel.abiTag;
      meta.platform = wheel.platformTag;
    } catch {
      // Filename already validated by parseUploadBody; ignore.
    }
  }
  const reqPython = singleField(upload.fields, "requires_python");
  if (reqPython) meta.requires_python = reqPython;
  const yanked = singleField(upload.fields, "yanked");
  if (yanked) meta.yanked = yanked.length > 0 ? yanked : true;
  const md5 = singleField(upload.fields, "md5_digest");
  if (md5) meta.md5_digest = md5;
  const blake = singleField(upload.fields, "blake2_256_digest");
  if (blake) meta.blake2_256_digest = blake;
  const summary = singleField(upload.fields, "summary");
  if (summary) meta.summary = summary;
  const description = singleField(upload.fields, "description");
  if (description) meta.description = description;
  const descContentType = singleField(upload.fields, "description_content_type");
  if (descContentType) meta.description_content_type = descContentType;
  const author = singleField(upload.fields, "author");
  if (author) meta.author = author;
  const authorEmail = singleField(upload.fields, "author_email");
  if (authorEmail) meta.author_email = authorEmail;
  const maintainer = singleField(upload.fields, "maintainer");
  if (maintainer) meta.maintainer = maintainer;
  const maintainerEmail = singleField(upload.fields, "maintainer_email");
  if (maintainerEmail) meta.maintainer_email = maintainerEmail;
  const license = singleField(upload.fields, "license");
  if (license) meta.license = license;
  const keywords = singleField(upload.fields, "keywords");
  if (keywords) meta.keywords = keywords;
  const homePage = singleField(upload.fields, "home_page");
  if (homePage) meta.home_page = homePage;
  const classifiers = repeatedField(upload.fields, "classifiers");
  if (classifiers) meta.classifiers = classifiers;
  const requiresDist = repeatedField(upload.fields, "requires_dist");
  if (requiresDist) meta.requires_dist = requiresDist;
  const providesDist = repeatedField(upload.fields, "provides_dist");
  if (providesDist) meta.provides_dist = providesDist;
  const obsoletesDist = repeatedField(upload.fields, "obsoletes_dist");
  if (obsoletesDist) meta.obsoletes_dist = obsoletesDist;
  return meta;
}

function headerString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === "string") return value;
  return undefined;
}

async function readBody(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buf.length;
    if (received > max) {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        `upload body exceeded max ${max} bytes`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
