/**
 * AWS Signature Version 4 — minimal implementation focused on the
 * one call the ECR upstream adapter needs:
 *
 *   POST https://api.ecr.<region>.amazonaws.com/
 *   X-Amz-Target: AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken
 *
 * Full SigV4 is large; this module covers the subset we exercise:
 *   - POST + JSON body
 *   - host + x-amz-date + x-amz-target signed headers
 *   - SHA-256 hashing of the canonical request
 *   - HMAC-SHA256 derivation chain (date → region → service → "aws4_request")
 *   - Authorization header composition
 *
 * Reference: AWS SigV4 documentation §Canonical Request, §String
 * to Sign, §Signing Key.
 */

import * as crypto from "node:crypto";

export interface SignedRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface SignSigV4Options {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS session token, threaded through as `x-amz-security-token` when present. */
  sessionToken?: string;
  region: string;
  service: string;
  url: string;
  body: string;
  amzTarget: string;
  /** Injectable for tests — defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Sign one ECR GetAuthorizationToken-shaped request. Returns the
 * headers + URL the caller fetches as-is.
 */
export function signSigV4Request(opts: SignSigV4Options): SignedRequest {
  const now = (opts.now ?? (() => new Date()))();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD
  const url = new URL(opts.url);
  const host = url.host;

  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-target": opts.amzTarget,
    "content-type": "application/x-amz-json-1.1",
  };
  if (opts.sessionToken) {
    headers["x-amz-security-token"] = opts.sessionToken;
  }

  const canonicalUri = url.pathname.length === 0 ? "/" : url.pathname;
  const canonicalQuery = canonicalQueryString(url.searchParams);
  const sortedHeaderNames = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const payloadHash = sha256Hex(opts.body);

  const canonicalRequest = [
    "POST",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    opts.secretAccessKey,
    dateStamp,
    opts.region,
    opts.service,
  );
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf-8")
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${opts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    method: "POST",
    url: opts.url,
    headers: { ...headers, authorization },
    body: opts.body,
  };
}

function formatAmzDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function canonicalQueryString(params: URLSearchParams): string {
  const entries = [...params.entries()];
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k).replace(/!/g, "%21")}=${encodeURIComponent(v).replace(/!/g, "%21")}`,
    )
    .join("&");
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf-8").digest();
}
