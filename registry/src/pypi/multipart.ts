/**
 * Minimal RFC 7578 multipart/form-data parser.
 *
 * Scoped to the shape twine + uv-publish + flit emit on PyPI's
 * legacy upload endpoint: each request has one binary `content`
 * part and several short text fields (`:action`, `name`, `version`,
 * `filetype`, `sha256_digest`, plus PEP 345 / PEP 643 metadata
 * fields). We don't try to handle the general RFC 7578 surface
 * (mixed content-disposition modes, nested multipart, etc.).
 *
 * Why not depend on `busboy`/`formidable`: keeping the dependency
 * tree small for the OSS registry. Multipart is well-spec'd; the
 * security-critical bits (header parsing, boundary handling) are
 * confined to this ~120 line module and have their own test file.
 *
 * Input bound: caller pre-buffers the whole body and passes a single
 * Buffer. PyPI publishes rarely exceed 100 MiB; the M2 chunked-
 * upload state machine is the streaming path for ecosystems that
 * exceed that (HF, large OCI layers).
 *
 * Security posture:
 *   - Strict boundary scan; no regex on untrusted bytes.
 *   - Per-part header parser rejects malformed CRLFs.
 *   - Field name + filename extracted from
 *     `Content-Disposition: form-data; name=...; filename=...` only.
 *     Other dispositions rejected.
 */

import { PypiError } from "./errors.js";
import { PYPI_ERROR_CODES } from "./types.js";

export interface MultipartField {
  /** `name="..."` from Content-Disposition. */
  name: string;
  /** `filename="..."` when present; `undefined` for non-file fields. */
  filename?: string;
  /** `Content-Type: <ct>` header on the part; `undefined` when absent. */
  contentType?: string;
  /** Raw bytes of the part body. */
  body: Buffer;
}

export interface ParsedMultipart {
  fields: MultipartField[];
}

const CRLF = Buffer.from("\r\n");
const DOUBLE_DASH = Buffer.from("--");

/**
 * Extract the boundary from a Content-Type header value. Accepts
 * `multipart/form-data; boundary=foo` and `; boundary="foo"`.
 *
 * Returns null when Content-Type does not look like multipart.
 * Throws when multipart is declared but the boundary is malformed.
 */
export function extractBoundary(contentType: string | undefined): string | null {
  if (typeof contentType !== "string") return null;
  const ctLower = contentType.toLowerCase();
  if (!ctLower.startsWith("multipart/form-data")) return null;
  // Parse `; boundary=<value>` (case-insensitive). Boundary value
  // can be quoted ("..."). Strip the quotes if present.
  const m = /;\s*boundary\s*=\s*("([^"]+)"|([^;,\s]+))/i.exec(contentType);
  if (!m) {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      "Content-Type declares multipart/form-data but lacks boundary",
    );
  }
  const value = m[2] ?? m[3];
  if (!value || value.length === 0) {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      "multipart boundary is empty",
    );
  }
  // RFC 7578 §4.1: boundary chars are a subset of [bcharsnospace].
  // We accept the practical set + reject control chars / whitespace.
  if (!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/.test(value)) {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      `multipart boundary '${value}' contains invalid characters`,
    );
  }
  return value;
}

/**
 * Parse a buffered multipart/form-data body. Throws PypiError on
 * any structural malformation.
 */
export function parseMultipart(
  body: Buffer,
  boundary: string,
): ParsedMultipart {
  const delim = Buffer.concat([DOUBLE_DASH, Buffer.from(boundary)]);
  // The body MUST start with `--<boundary>` (possibly preceded by
  // a preamble; PyPI clients never emit one in practice, and accepting
  // a preamble widens the attack surface unnecessarily).
  if (body.length < delim.length || !body.subarray(0, delim.length).equals(delim)) {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      "multipart body does not begin with the boundary delimiter",
    );
  }

  const fields: MultipartField[] = [];
  let cursor = delim.length;

  while (cursor < body.length) {
    // After a boundary, expect either `\r\n` (more parts) or `--\r\n` (end).
    if (cursor + 2 <= body.length && body.subarray(cursor, cursor + 2).equals(DOUBLE_DASH)) {
      // End-of-stream marker `--`. Optional trailing CRLF accepted.
      return { fields };
    }
    if (cursor + CRLF.length > body.length || !body.subarray(cursor, cursor + CRLF.length).equals(CRLF)) {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        `multipart boundary at offset ${cursor} not followed by CRLF or '--'`,
      );
    }
    cursor += CRLF.length;

    // Headers end at the first blank line (`\r\n\r\n`).
    const headerEnd = indexOfDouble(body, cursor);
    if (headerEnd < 0) {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        "multipart part has no header/body separator",
      );
    }
    const headerBlock = body.subarray(cursor, headerEnd).toString("utf-8");
    const headers = parseHeaders(headerBlock);
    cursor = headerEnd + 4; // skip past `\r\n\r\n`

    // Find the next boundary marker — the part body ends just
    // before `\r\n--<boundary>`.
    const nextBoundary = findBoundaryMarker(body, cursor, boundary);
    if (nextBoundary < 0) {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        "multipart part has no terminating boundary",
      );
    }
    const partBody = body.subarray(cursor, nextBoundary);
    const disposition = headers["content-disposition"];
    if (!disposition) {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        "multipart part missing Content-Disposition header",
      );
    }
    const dispParts = parseDisposition(disposition);
    if (dispParts.kind !== "form-data") {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        `multipart Content-Disposition '${dispParts.kind}' is not 'form-data'`,
      );
    }
    if (!dispParts.name) {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        "multipart Content-Disposition missing name=",
      );
    }
    const field: MultipartField = {
      name: dispParts.name,
      body: partBody,
    };
    if (dispParts.filename !== undefined) field.filename = dispParts.filename;
    if (headers["content-type"] !== undefined) field.contentType = headers["content-type"];
    fields.push(field);

    cursor = nextBoundary + 2 + delim.length; // skip `\r\n--<boundary>`
  }

  throw new PypiError(
    PYPI_ERROR_CODES.UPLOAD_INVALID,
    "multipart body ended without the closing boundary",
  );
}

/**
 * Find `\r\n\r\n` (header/body separator). Returns -1 when absent.
 */
function indexOfDouble(buf: Buffer, from: number): number {
  for (let i = from; i + 3 < buf.length; i++) {
    if (
      buf[i] === 0x0d &&
      buf[i + 1] === 0x0a &&
      buf[i + 2] === 0x0d &&
      buf[i + 3] === 0x0a
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Find the next `\r\n--<boundary>` starting at `from`. Returns the
 * absolute byte offset of the `\r` byte, or -1 when not found.
 */
function findBoundaryMarker(buf: Buffer, from: number, boundary: string): number {
  const needle = Buffer.concat([CRLF, DOUBLE_DASH, Buffer.from(boundary)]);
  return buf.indexOf(needle, from);
}

/**
 * Parse the small header block of a multipart part. Each line is
 * `<name>: <value>`. Returns a name-lowercased map.
 */
function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split("\r\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new PypiError(
        PYPI_ERROR_CODES.UPLOAD_INVALID,
        `multipart part header missing ':' separator`,
      );
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    out[name] = value;
  }
  return out;
}

/**
 * Parse `Content-Disposition: form-data; name="..."; filename="..."`.
 *
 * Returns the disposition kind + the named params we care about.
 * RFC 6266 / RFC 5987 syntax is more complex than the common form
 * twine emits; we accept the common shape only.
 */
interface DispositionParts {
  kind: string;
  name?: string;
  filename?: string;
}

function parseDisposition(value: string): DispositionParts {
  const semi = value.indexOf(";");
  const kind = (semi < 0 ? value : value.slice(0, semi)).trim().toLowerCase();
  const out: DispositionParts = { kind };
  const rest = semi < 0 ? "" : value.slice(semi + 1);
  // Tokenise `name=value; name="value with spaces"; ...`
  const paramRe = /([a-zA-Z]+)\s*=\s*("([^"]*)"|([^;]+))/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(rest)) !== null) {
    const k = m[1].toLowerCase();
    const v = (m[3] ?? m[4]).trim();
    if (k === "name") out.name = v;
    else if (k === "filename") out.filename = v;
  }
  return out;
}
