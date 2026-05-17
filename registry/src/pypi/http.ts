/**
 * Response helpers for the PyPI facade. Mirrors the OCI `http.ts`
 * pattern: one helper per response shape plus content-type
 * negotiation for the dual PEP 503 / PEP 691 surface.
 */

import type { ServerResponse } from "node:http";
import { PYPI_API_VERSION, PYPI_MEDIA_TYPES } from "./types.js";

/** Pretty constants for Accept-header parsing. */
const HTML_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "*/*",
]);
const JSON_V1_TYPE = PYPI_MEDIA_TYPES.SIMPLE_JSON_V1;

/**
 * Decide whether the client wants JSON or HTML for a Simple Repository
 * response. PEP 691 §Content Negotiation says clients SHOULD set
 * `Accept` to indicate preference; servers SHOULD pick from the set.
 *
 *   - Accept includes `application/vnd.pypi.simple.v1+json` → JSON.
 *   - Accept includes `application/vnd.pypi.simple.v1+html` → HTML (PEP 691).
 *   - Accept includes `text/html` or `application/xhtml+xml` → HTML (PEP 503).
 *   - Accept includes `* / *` (escaped for JSDoc) → JSON (modern default).
 *   - Accept absent → HTML (PEP 503 default for compat with old pip).
 *
 * Returns the negotiated wire format.
 */
export function negotiateSimpleFormat(accept: string | undefined): "json" | "html" {
  if (!accept || accept.length === 0) return "html";
  // Tokenise — ignore q-params for the common case (modern pip
  // includes them but the highest-quality match is what we want).
  const tokens = accept
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (tokens.includes(JSON_V1_TYPE.toLowerCase())) return "json";
  if (tokens.includes("application/vnd.pypi.simple.v1+html")) return "html";
  if (tokens.some((t) => HTML_TYPES.has(t))) {
    // `* / *` (escaped for JSDoc) is ambiguous; pip 22.3+ sends `application/vnd.pypi.simple.v1+json`
    // before `* / *` (escaped for JSDoc), so seeing `* / *` (escaped for JSDoc) here means the client didn't ask for
    // JSON explicitly — serve HTML to keep old pip working. But if
    // `* / *` (escaped for JSDoc) is the ONLY token, prefer JSON (modern default).
    if (tokens.length === 1 && tokens[0] === "*/*") return "json";
    return "html";
  }
  return "html";
}

/**
 * Write a PEP 691 JSON response. Caller assembles the body shape.
 */
export function writeSimpleJson(
  res: ServerResponse,
  body: unknown,
  status: number = 200,
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", `${PYPI_MEDIA_TYPES.SIMPLE_JSON_V1}; charset=utf-8`);
  res.setHeader("content-length", Buffer.byteLength(payload).toString());
  res.end(payload);
}

/**
 * Write a PEP 503 HTML response. Caller assembles the body.
 */
export function writeSimpleHtml(
  res: ServerResponse,
  body: string,
  status: number = 200,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(body).toString());
  res.end(body);
}

/**
 * Compose the PEP 503 HTML index for a per-package listing.
 * Each file is one `<a>` element with a `#sha256=...` anchor;
 * optional `data-requires-python` + `data-yanked` attributes.
 */
export function renderPackageHtml(
  packageName: string,
  files: Array<{
    filename: string;
    url: string;
    sha256: string;
    requires_python?: string;
    yanked?: string | true;
    core_metadata_sha256?: string;
  }>,
): string {
  const lines: string[] = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    `<meta name="pypi:repository-version" content="${PYPI_API_VERSION}">`,
    `<title>Links for ${escapeHtml(packageName)}</title>`,
    "</head>",
    "<body>",
    `<h1>Links for ${escapeHtml(packageName)}</h1>`,
  ];
  for (const f of files) {
    const attrs: string[] = [`href="${escapeAttr(f.url)}#sha256=${f.sha256}"`];
    if (f.requires_python) {
      attrs.push(`data-requires-python="${escapeAttr(f.requires_python)}"`);
    }
    if (f.yanked !== undefined) {
      const reason = typeof f.yanked === "string" ? f.yanked : "";
      attrs.push(`data-yanked="${escapeAttr(reason)}"`);
    }
    if (f.core_metadata_sha256) {
      attrs.push(`data-core-metadata="sha256=${f.core_metadata_sha256}"`);
    }
    lines.push(`<a ${attrs.join(" ")}>${escapeHtml(f.filename)}</a><br/>`);
  }
  lines.push("</body>", "</html>");
  return lines.join("\n");
}

/**
 * Compose the PEP 503 root index (`/simple/`). Lists every project
 * the registry knows about. Modern clients fetch the per-package
 * pages instead, but pip's `--list` and uv's discovery use this.
 */
export function renderRootHtml(projects: string[]): string {
  const lines: string[] = [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    `<meta name="pypi:repository-version" content="${PYPI_API_VERSION}">`,
    "<title>Simple Index</title>",
    "</head>",
    "<body>",
  ];
  for (const p of projects) {
    lines.push(`<a href="./${escapeAttr(p)}/">${escapeHtml(p)}</a><br/>`);
  }
  lines.push("</body>", "</html>");
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
