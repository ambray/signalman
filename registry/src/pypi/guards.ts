/**
 * Strict-validating parsers for PyPI inputs that cross the trust
 * boundary — the twine upload form and the operator-supplied
 * package / version / filename triple.
 *
 * Every public function in this module either returns the strongly-
 * typed value or throws `PypiError` with a code the HTTP layer can
 * map to a 4XX with the spec envelope.
 */

import * as crypto from "node:crypto";
import { PypiError } from "./errors.js";
import {
  classifyFiletype,
  normalisePypiName,
  parseSdistFilename,
  parseWheelFilename,
  validatePypiVersion,
} from "./paths.js";
import { PYPI_ERROR_CODES, type TwineFileType, type TwineUpload } from "./types.js";
import type { ParsedMultipart } from "./multipart.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Map a parsed multipart body into the strongly-typed twine upload
 * shape we persist. Validates every operator-supplied field:
 *
 *   - `:action=file_upload` is the only accepted action.
 *   - `name` is normalised via PEP 503.
 *   - `version` is non-empty, PEP 440-shaped (lenient — `packaging`
 *     does the real parse).
 *   - `filetype` ∈ {sdist, bdist_wheel} AND matches the filename
 *     extension (wheel filenames end in .whl; sdists end in .tar.gz
 *     or sibling exts).
 *   - The wheel/sdist filename's embedded `<distribution>` and
 *     `<version>` agree with the form's name + version (after PEP
 *     503 normalisation on the name).
 *   - `content` part is present, non-empty.
 *   - The client-declared `sha256_digest` is a 64-char lowercase
 *     hex AND matches sha256(content).
 */
export function parseUploadBody(parsed: ParsedMultipart): TwineUpload {
  const get = (n: string): string | undefined => {
    const f = parsed.fields.find((p) => p.name === n);
    if (!f) return undefined;
    return f.body.toString("utf-8");
  };
  const action = get(":action");
  if (action !== "file_upload") {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      `expected :action=file_upload; got '${action ?? "<missing>"}'`,
    );
  }
  const nameRaw = get("name");
  if (typeof nameRaw !== "string" || nameRaw.length === 0) {
    throw new PypiError(
      PYPI_ERROR_CODES.NAME_INVALID,
      "form field `name` is required",
    );
  }
  const packageName = normalisePypiName(nameRaw);

  const version = get("version");
  if (typeof version !== "string" || version.length === 0) {
    throw new PypiError(
      PYPI_ERROR_CODES.VERSION_INVALID,
      "form field `version` is required",
    );
  }
  validatePypiVersion(version);

  const filetypeRaw = get("filetype");
  if (filetypeRaw !== "sdist" && filetypeRaw !== "bdist_wheel") {
    throw new PypiError(
      PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE,
      `form field \`filetype\` must be 'sdist' or 'bdist_wheel'; got '${filetypeRaw ?? "<missing>"}'`,
    );
  }
  const filetype: TwineFileType = filetypeRaw;

  const contentField = parsed.fields.find((f) => f.name === "content");
  if (!contentField) {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      "form field `content` (the binary file) is required",
    );
  }
  if (!contentField.filename) {
    throw new PypiError(
      PYPI_ERROR_CODES.UPLOAD_INVALID,
      "form field `content` missing filename= on Content-Disposition",
    );
  }
  const filename = contentField.filename;
  // Filename extension must match the declared filetype.
  const detected = classifyFiletype(filename);
  if (detected !== filetype) {
    throw new PypiError(
      PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE,
      `filename '${filename}' looks like '${detected}' but form field claims '${filetype}'`,
    );
  }
  // Filename's embedded name + version must match the form fields.
  if (filetype === "bdist_wheel") {
    const parsedWheel = parseWheelFilename(filename);
    if (normalisePypiName(parsedWheel.distribution) !== packageName) {
      throw new PypiError(
        PYPI_ERROR_CODES.FILENAME_INVALID,
        `wheel filename '${filename}' encodes distribution '${parsedWheel.distribution}' which does not normalise to '${packageName}'`,
      );
    }
    if (parsedWheel.version !== version) {
      throw new PypiError(
        PYPI_ERROR_CODES.FILENAME_INVALID,
        `wheel filename '${filename}' encodes version '${parsedWheel.version}' which does not match form version '${version}'`,
      );
    }
  } else {
    const parsedSdist = parseSdistFilename(filename);
    if (!parsedSdist) {
      throw new PypiError(
        PYPI_ERROR_CODES.FILENAME_INVALID,
        `sdist filename '${filename}' does not end in a recognised extension`,
      );
    }
    if (normalisePypiName(parsedSdist.distribution) !== packageName) {
      throw new PypiError(
        PYPI_ERROR_CODES.FILENAME_INVALID,
        `sdist filename '${filename}' encodes distribution '${parsedSdist.distribution}' which does not normalise to '${packageName}'`,
      );
    }
    if (parsedSdist.version !== version) {
      throw new PypiError(
        PYPI_ERROR_CODES.FILENAME_INVALID,
        `sdist filename '${filename}' encodes version '${parsedSdist.version}' which does not match form version '${version}'`,
      );
    }
  }

  const declaredSha256Raw = get("sha256_digest");
  if (typeof declaredSha256Raw !== "string") {
    throw new PypiError(
      PYPI_ERROR_CODES.DIGEST_INVALID,
      "form field `sha256_digest` is required",
    );
  }
  const declaredSha256 = declaredSha256Raw.toLowerCase();
  if (!SHA256_HEX.test(declaredSha256)) {
    throw new PypiError(
      PYPI_ERROR_CODES.DIGEST_INVALID,
      `sha256_digest '${declaredSha256Raw}' is not 64 hex chars`,
    );
  }
  const computed = crypto
    .createHash("sha256")
    .update(contentField.body)
    .digest("hex");
  if (computed !== declaredSha256) {
    throw new PypiError(
      PYPI_ERROR_CODES.DIGEST_MISMATCH,
      `sha256(content) = ${computed} ≠ form sha256_digest = ${declaredSha256}`,
    );
  }

  // Aggregate every other field for downstream forensic / metadata storage.
  const allFields: Record<string, string | string[]> = {};
  for (const f of parsed.fields) {
    if (f.name === "content") continue;
    const existing = allFields[f.name];
    const value = f.body.toString("utf-8");
    if (existing === undefined) allFields[f.name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else allFields[f.name] = [existing, value];
  }

  return {
    filename,
    filetype,
    version,
    packageName,
    declaredSha256,
    content: contentField.body,
    fields: allFields,
  };
}

/**
 * Pull a single string field out of the aggregated `fields` map.
 * Returns the value when present + single-valued, undefined otherwise.
 */
export function singleField(
  fields: Record<string, string | string[]>,
  name: string,
): string | undefined {
  const v = fields[name];
  if (typeof v === "string" && v.length > 0) return v;
  return undefined;
}

/**
 * Pull a repeatable field (PEP 345 / PEP 643 metadata fields like
 * `classifiers`, `requires_dist` arrive as multi-valued).
 */
export function repeatedField(
  fields: Record<string, string | string[]>,
  name: string,
): string[] | undefined {
  const v = fields[name];
  if (Array.isArray(v) && v.length > 0) return v;
  if (typeof v === "string" && v.length > 0) return [v];
  return undefined;
}
