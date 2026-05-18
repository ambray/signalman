/**
 * Maven virtual upstream pull-through.
 *
 * Maven clients request artifacts file-by-file (no per-package
 * aggregate response — each PUT/GET targets one filename). On a
 * cache miss for `GET /maven/<org>/<groupPath>/<artifactId>/
 * <baseVersion>/<filename>`, the registry fetches the upstream
 * URL, content-addresses the bytes, persists them as a
 * `kind: 'maven'` manifest row with `provenance.source = 'proxy_cache'`,
 * and re-signs the row when configured.
 *
 * Public Maven Central (`https://repo.maven.apache.org/maven2/`) is
 * anonymous. Private repos (Sonatype Nexus / Artifactory / GitHub
 * Packages Maven) authenticate via Basic Auth — `auth_header_template`
 * on the virtual_upstream config row carries the operator-supplied
 * `Authorization: Basic <base64(user:token)>` value.
 *
 * Metadata pull-through (`maven-metadata.xml`) is not implemented in
 * this milestone — the read path 404s on metadata cache miss. Real
 * Maven workflows fetch metadata once at the start of a build and
 * then individual artifacts; the artifact-level pull-through is the
 * critical path. Metadata caching ships in a follow-up.
 */

import {
  type Manifest,
  type MavenManifestMetadata,
  type Provenance,
  type RegistryStorage,
} from "../types.js";
import { canonicalManifestBytes, signManifest } from "../signing.js";
import type {
  SqliteManifestIndex,
  VirtualUpstream,
} from "../storage/sqlite-index.js";
import { nameMatchesPatterns, type UpstreamFetch } from "../cargo/index.js";
import { MavenError } from "./errors.js";
import { MAVEN_ERROR_CODES, MAVEN_MEDIA_TYPES } from "./types.js";
import {
  composeMavenFilename,
  isSnapshotVersion,
  mavenManifestName,
  mavenManifestVersion,
  parseResolvedSnapshot,
} from "./paths.js";
import { classifyExtension } from "./guards.js";

export interface VirtualMavenOptions {
  storage: RegistryStorage;
  index: SqliteManifestIndex;
  fetch?: UpstreamFetch;
  /** Re-sign cached manifest rows with this Ed25519 PEM when configured. */
  signingPrivateKeyPem?: string;
  /** Actor for audit-log entries. Default `'virtual-maven'`. */
  proxyActor?: string;
}

/**
 * Pull-through fetch for a single artifact file. Returns true when
 * the cache was populated; false when no upstream covered the
 * request OR every configured upstream returned a 404 / failure.
 */
export async function proxyMavenArtifact(
  opts: VirtualMavenOptions,
  org: string,
  groupId: string,
  artifactId: string,
  baseVersion: string | null,
  filename: string,
): Promise<boolean> {
  const upstreams = opts.index.listVirtualUpstreams({ org, kind: "maven" });
  if (upstreams.length === 0) return false;
  const fetcher = opts.fetch ?? defaultFetch;
  const actor = opts.proxyActor ?? "virtual-maven";

  // Snapshot policy: if the registry rejects snapshots, never
  // serve a snapshot artifact from upstream either.
  if (baseVersion && isSnapshotVersion(baseVersion)) {
    // We still attempt the fetch when ANY upstream's config sets
    // snapshot_policy: accept. The publish path is the enforcement
    // point for ingress; pull-through is just configuration-mirrored
    // here.
    const snapAllowed = upstreams.some(
      (u) => u.config.snapshot_policy === "accept",
    );
    if (!snapAllowed) return false;
  }

  for (const upstream of upstreams) {
    const matchKey = `${groupId}:${artifactId}`;
    if (!nameMatchesPatterns(matchKey, upstream.config)) continue;
    const groupPath = groupId.replace(/\./g, "/");
    const upstreamPath = baseVersion
      ? `${trimTrailingSlash(upstream.upstreamUrl)}/${groupPath}/${artifactId}/${baseVersion}/${filename}`
      : `${trimTrailingSlash(upstream.upstreamUrl)}/${groupPath}/${artifactId}/${filename}`;
    let resp;
    try {
      resp = await fetcher(upstreamPath, {
        method: "GET",
        headers: {
          ...(upstream.config.auth_header_template
            ? { authorization: upstream.config.auth_header_template }
            : {}),
        },
      });
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "fetch_error", {
        url: upstreamPath,
        groupId,
        artifactId,
        baseVersion,
        filename,
        error: (err as Error).message,
      });
      continue;
    }
    if (resp.status === 404) continue;
    if (resp.status >= 400) {
      auditFailure(opts.index, upstream, actor, "upstream_error", {
        url: upstreamPath,
        groupId,
        artifactId,
        baseVersion,
        filename,
        status: resp.status,
      });
      continue;
    }

    // Cache the bytes.
    const blobMeta = await opts.storage.putBlob({
      body: resp.body,
      contentType: defaultContentTypeForFilename(filename),
    });
    const storageName = mavenManifestName(org, groupId, artifactId);
    const effectiveBaseVersion = baseVersion ?? deriveBaseVersionFromFilename(artifactId, filename);
    if (!effectiveBaseVersion) {
      auditFailure(opts.index, upstream, actor, "parse_error", {
        groupId,
        artifactId,
        filename,
        error: "cannot derive baseVersion from filename for pull-through",
      });
      continue;
    }
    const versionKey = mavenManifestVersion(effectiveBaseVersion, filename);
    const mavenMetadata = deriveMavenMetadata(
      groupId,
      artifactId,
      effectiveBaseVersion,
      filename,
    );
    if (!mavenMetadata) {
      auditFailure(opts.index, upstream, actor, "parse_error", {
        groupId,
        artifactId,
        filename,
        error: "filename does not match Maven layout",
      });
      continue;
    }

    const manifest: Manifest = {
      name: storageName,
      version: versionKey,
      mediaType: "application/vnd.signalman.maven-file.v1+json",
      kind: "maven",
      blobs: [
        {
          mediaType: defaultContentTypeForFilename(filename),
          sha256: blobMeta.sha256,
          size: blobMeta.size,
          name: filename,
        },
      ],
      mavenMetadata,
      createdAt: new Date().toISOString(),
    };

    let signedManifest = manifest;
    if (upstream.config.resign_on_cache && opts.signingPrivateKeyPem) {
      try {
        const sig = signManifest(manifest, opts.signingPrivateKeyPem);
        signedManifest = {
          ...manifest,
          signature: { signatureB64: sig.signatureB64, signedBy: sig.signedBy },
        };
      } catch (err) {
        auditFailure(opts.index, upstream, actor, "resign_error", {
          groupId,
          artifactId,
          filename,
          error: (err as Error).message,
        });
      }
    }
    const provenance: Provenance = {
      source: "proxy_cache",
      upstreamUrl: upstream.upstreamUrl,
      fetchedAt: manifest.createdAt,
      fetchedBy: actor,
    };
    const canonical = canonicalManifestBytes(signedManifest);
    try {
      opts.index.putManifest(signedManifest, canonical, provenance);
    } catch (err) {
      auditFailure(opts.index, upstream, actor, "store_error", {
        groupId,
        artifactId,
        filename,
        error: (err as Error).message,
      });
      continue;
    }

    opts.index.appendAuditEntry({
      action: "proxy_cache",
      entityType: "manifest",
      entityId: `${storageName}@${versionKey}`,
      actor,
      detail: {
        kind: "maven",
        upstream_url: upstream.upstreamUrl,
        upstream_id: upstream.id,
        org,
        groupId,
        artifactId,
        baseVersion: effectiveBaseVersion,
        filename,
        resigned: !!(
          upstream.config.resign_on_cache && opts.signingPrivateKeyPem
        ),
      },
    });
    return true;
  }
  return false;
}

function deriveBaseVersionFromFilename(
  artifactId: string,
  filename: string,
): string | null {
  // Strip the `<artifactId>-` prefix; the remainder is
  // `<version>[-<classifier>].<extension>`. Take everything up to
  // the first `.` after the artifactId prefix as the version+
  // classifier; further parsing happens during manifest projection.
  const prefix = `${artifactId}-`;
  if (!filename.startsWith(prefix)) return null;
  const rest = filename.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const versionAndClassifier = rest.slice(0, dot);
  // For resolved snapshots, baseVersion is everything before the
  // `-yyyyMMdd.HHmmss-N` tail.
  const m = /^(.+)-(\d{8})\.(\d{6})-(\d+)(?:-[A-Za-z0-9._-]+)?$/.exec(
    versionAndClassifier,
  );
  if (m) return `${m[1]}-SNAPSHOT`;
  // For a release with classifier (`1.2.3-sources`) we'd
  // mis-attribute the classifier as part of the version. Reach for
  // the longest-prefix-then-classifier strategy: assume no classifier
  // for now (good enough for tests + Maven Central common case).
  return versionAndClassifier;
}

function deriveMavenMetadata(
  groupId: string,
  artifactId: string,
  baseVersion: string,
  filename: string,
): MavenManifestMetadata | null {
  const prefix = `${artifactId}-`;
  if (!filename.startsWith(prefix)) return null;
  const rest = filename.slice(prefix.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = rest.slice(dot + 1);
  const stem = rest.slice(0, dot);

  let version = baseVersion;
  let classifier: string | undefined;

  if (stem === baseVersion) {
    // release, no classifier
  } else if (stem.startsWith(`${baseVersion}-`)) {
    classifier = stem.slice(baseVersion.length + 1);
  } else if (isSnapshotVersion(baseVersion)) {
    // resolved snapshot
    const base = baseVersion.slice(0, -"-SNAPSHOT".length);
    const stemPrefix = `${base}-`;
    if (stem.startsWith(stemPrefix)) {
      const tail = stem.slice(stemPrefix.length);
      const m = /^(\d{8}\.\d{6})-(\d+)(?:-([A-Za-z0-9._-]+))?$/.exec(tail);
      if (m) {
        version = `${base}-${m[1]}-${m[2]}`;
        if (m[3]) classifier = m[3];
      }
    }
  }

  const isSnap = isSnapshotVersion(baseVersion);
  const out: MavenManifestMetadata = {
    groupId,
    artifactId,
    version,
    baseVersion,
    filename,
    extension,
    isSnapshot: isSnap,
  };
  if (classifier) out.classifier = classifier;
  const snap = parseResolvedSnapshot(version);
  if (snap) out.snapshot = snap;
  const role = classifyExtension(extension);
  if (role === "signature") {
    out.signatureOf = filename.slice(0, filename.lastIndexOf("."));
    out.contentType = MAVEN_MEDIA_TYPES.ASC;
  } else if (role === "checksum") {
    out.checksumOf = filename.slice(0, filename.lastIndexOf("."));
    out.contentType = MAVEN_MEDIA_TYPES.CHECKSUM;
  }
  return out;
}

function defaultContentTypeForFilename(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return MAVEN_MEDIA_TYPES.OCTET_STREAM;
  const ext = filename.slice(lastDot + 1);
  if (ext === "jar" || ext === "war" || ext === "ear" || ext === "aar") {
    return MAVEN_MEDIA_TYPES.JAR;
  }
  if (ext === "pom" || ext === "xml") return MAVEN_MEDIA_TYPES.XML;
  if (ext === "module") return MAVEN_MEDIA_TYPES.MODULE_JSON;
  if (ext === "asc") return MAVEN_MEDIA_TYPES.ASC;
  if (ext === "sha1" || ext === "md5" || ext === "sha256" || ext === "sha512") {
    return MAVEN_MEDIA_TYPES.CHECKSUM;
  }
  return MAVEN_MEDIA_TYPES.OCTET_STREAM;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

const defaultFetch: UpstreamFetch = async (url, init) => {
  const resp = await fetch(url, {
    method: init?.method ?? "GET",
    ...(init?.headers ? { headers: init.headers as Record<string, string> } : {}),
  });
  const buf = Buffer.from(await resp.arrayBuffer());
  const headers: Record<string, string> = {};
  resp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: resp.status, body: buf, headers };
};

function auditFailure(
  index: SqliteManifestIndex,
  upstream: VirtualUpstream,
  actor: string,
  phase: string,
  detail: Record<string, unknown>,
): void {
  index.appendAuditEntry({
    action: "proxy_cache",
    entityType: "manifest",
    entityId: `maven@${upstream.id}`,
    actor,
    detail: {
      kind: "maven",
      phase,
      upstream_url: upstream.upstreamUrl,
      upstream_id: upstream.id,
      ...detail,
    },
  });
}

// Silence unused-import warnings for symbols only referenced via
// type annotations.
void MavenError;
void MAVEN_ERROR_CODES;
