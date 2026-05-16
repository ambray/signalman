// WS10 (v0.5 OCI facade) — strict manifest + index + descriptor
// validation tests. The parser sees hostile input from untrusted HTTP
// clients; every field gets checked, and the spec-canonical error
// code surfaces on failure (DIGEST_INVALID vs SIZE_INVALID vs
// MANIFEST_INVALID).

import { describe, expect, it } from "vitest";
import {
  DOCKER_MEDIA_TYPES,
  OciError,
  OCI_ERROR_CODES,
  OCI_MEDIA_TYPES,
  parseDescriptor,
  parseManifestOrIndex,
  parseOciIndex,
  parseOciManifest,
} from "../oci/index.js";

const HEX = "f".repeat(64);
const HEX2 = "e".repeat(64);

function descriptor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    digest: `sha256:${HEX}`,
    size: 1234,
    ...over,
  };
}

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
    config: {
      mediaType: OCI_MEDIA_TYPES.CONFIG_V1,
      digest: `sha256:${HEX}`,
      size: 7,
    },
    layers: [
      {
        mediaType: OCI_MEDIA_TYPES.LAYER_TAR_GZIP,
        digest: `sha256:${HEX2}`,
        size: 100,
      },
    ],
    ...over,
  };
}

function index(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    mediaType: OCI_MEDIA_TYPES.INDEX_V1,
    manifests: [
      {
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
        digest: `sha256:${HEX}`,
        size: 500,
        platform: { architecture: "amd64", os: "linux" },
      },
      {
        mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
        digest: `sha256:${HEX2}`,
        size: 500,
        platform: { architecture: "arm64", os: "linux" },
      },
    ],
    ...over,
  };
}

function expectOciError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(OciError);
  expect((caught as OciError).code).toBe(code);
}

// ── parseDescriptor ────────────────────────────────────────────────

describe("parseDescriptor", () => {
  it("accepts the minimal shape", () => {
    const d = parseDescriptor(descriptor(), "config");
    expect(d.mediaType).toBe("application/vnd.oci.image.layer.v1.tar+gzip");
    expect(d.size).toBe(1234);
  });

  it("rejects non-object input", () => {
    expectOciError(() => parseDescriptor("oops", "x"), OCI_ERROR_CODES.MANIFEST_INVALID);
    expectOciError(() => parseDescriptor([1], "x"), OCI_ERROR_CODES.MANIFEST_INVALID);
    expectOciError(() => parseDescriptor(null, "x"), OCI_ERROR_CODES.MANIFEST_INVALID);
  });

  it("rejects empty mediaType", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ mediaType: "" }), "config"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects non-string mediaType", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ mediaType: 42 }), "config"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects bad digests (sha512, missing prefix, mixed case)", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ digest: `sha512:${HEX}` }), "x"),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
    expectOciError(
      () => parseDescriptor(descriptor({ digest: HEX }), "x"),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
    expectOciError(
      () => parseDescriptor(descriptor({ digest: `sha256:${HEX.toUpperCase()}` }), "x"),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
  });

  it("rejects bad sizes (negative, float, missing)", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ size: -1 }), "x"),
      OCI_ERROR_CODES.SIZE_INVALID,
    );
    expectOciError(
      () => parseDescriptor(descriptor({ size: 1.5 }), "x"),
      OCI_ERROR_CODES.SIZE_INVALID,
    );
    expectOciError(
      () => parseDescriptor(descriptor({ size: "100" }), "x"),
      OCI_ERROR_CODES.SIZE_INVALID,
    );
    const noSize = descriptor();
    delete (noSize as Record<string, unknown>).size;
    expectOciError(
      () => parseDescriptor(noSize, "x"),
      OCI_ERROR_CODES.SIZE_INVALID,
    );
  });

  it("rejects unsafe-integer sizes", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ size: Number.MAX_SAFE_INTEGER + 1 }), "x"),
      OCI_ERROR_CODES.SIZE_INVALID,
    );
  });

  it("accepts and preserves annotations", () => {
    const d = parseDescriptor(
      descriptor({ annotations: { "org.opencontainers.image.title": "hi" } }),
      "x",
    );
    expect(d.annotations).toEqual({ "org.opencontainers.image.title": "hi" });
  });

  it("rejects non-string annotation values", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ annotations: { key: 42 } }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects non-object annotations", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ annotations: ["a", "b"] }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("accepts and validates urls", () => {
    const d = parseDescriptor(
      descriptor({ urls: ["https://example.com/blob"] }),
      "x",
    );
    expect(d.urls).toEqual(["https://example.com/blob"]);
  });

  it("rejects non-array urls + non-string entries", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ urls: "https://x" }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () => parseDescriptor(descriptor({ urls: [42] }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("accepts platform with all optional fields", () => {
    const d = parseDescriptor(
      descriptor({
        platform: {
          architecture: "arm64",
          os: "linux",
          "os.version": "5.10",
          "os.features": ["sse4"],
          variant: "v8",
          features: ["sve"],
        },
      }),
      "x",
    );
    expect(d.platform).toEqual({
      architecture: "arm64",
      os: "linux",
      "os.version": "5.10",
      "os.features": ["sse4"],
      variant: "v8",
      features: ["sve"],
    });
  });

  it("rejects malformed platform inputs", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ platform: "linux" }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () => parseDescriptor(descriptor({ platform: { os: "linux" } }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () => parseDescriptor(descriptor({ platform: { architecture: "" } }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () =>
        parseDescriptor(
          descriptor({ platform: { architecture: "amd64", os: "" } }),
          "x",
        ),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () =>
        parseDescriptor(
          descriptor({
            platform: { architecture: "amd64", os: "linux", "os.version": 42 },
          }),
          "x",
        ),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () =>
        parseDescriptor(
          descriptor({
            platform: { architecture: "amd64", os: "linux", "os.features": "sse" },
          }),
          "x",
        ),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () =>
        parseDescriptor(
          descriptor({
            platform: { architecture: "amd64", os: "linux", "os.features": [42] },
          }),
          "x",
        ),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () =>
        parseDescriptor(
          descriptor({
            platform: { architecture: "amd64", os: "linux", variant: 42 },
          }),
          "x",
        ),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () =>
        parseDescriptor(
          descriptor({
            platform: { architecture: "amd64", os: "linux", features: "sve" },
          }),
          "x",
        ),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () =>
        parseDescriptor(
          descriptor({
            platform: { architecture: "amd64", os: "linux", features: [42] },
          }),
          "x",
        ),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("accepts and validates artifactType", () => {
    const d = parseDescriptor(
      descriptor({ artifactType: "application/vnd.example" }),
      "x",
    );
    expect(d.artifactType).toBe("application/vnd.example");
  });

  it("rejects non-string artifactType", () => {
    expectOciError(
      () => parseDescriptor(descriptor({ artifactType: 1 }), "x"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });
});

// ── parseOciManifest ───────────────────────────────────────────────

describe("parseOciManifest", () => {
  it("accepts a minimal OCI image manifest", () => {
    const m = parseOciManifest(manifest());
    expect(m.schemaVersion).toBe(2);
    expect(m.mediaType).toBe(OCI_MEDIA_TYPES.MANIFEST_V1);
    expect(m.layers).toHaveLength(1);
  });

  it("accepts the Docker v2.2 legacy manifest type", () => {
    const m = parseOciManifest(
      manifest({ mediaType: DOCKER_MEDIA_TYPES.MANIFEST_V2_2 }),
    );
    expect(m.mediaType).toBe(DOCKER_MEDIA_TYPES.MANIFEST_V2_2);
  });

  it("rejects an OCI index media-type on the single-manifest parser", () => {
    expectOciError(
      () => parseOciManifest(manifest({ mediaType: OCI_MEDIA_TYPES.INDEX_V1 })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects schemaVersion != 2", () => {
    expectOciError(
      () => parseOciManifest(manifest({ schemaVersion: 1 })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects non-object body", () => {
    expectOciError(
      () => parseOciManifest("oops"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects missing config", () => {
    const bad = manifest();
    delete (bad as Record<string, unknown>).config;
    expectOciError(
      () => parseOciManifest(bad),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects non-array layers", () => {
    expectOciError(
      () => parseOciManifest(manifest({ layers: "not an array" })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("accepts empty layers array (referrers / artifact manifests)", () => {
    const m = parseOciManifest(manifest({ layers: [] }));
    expect(m.layers).toEqual([]);
  });

  it("propagates child-descriptor errors with context", () => {
    expectOciError(
      () =>
        parseOciManifest(
          manifest({
            layers: [{ mediaType: "x", digest: "bad", size: 1 }],
          }),
        ),
      OCI_ERROR_CODES.DIGEST_INVALID,
    );
  });

  it("accepts and preserves the subject (OCI 1.1 referrers)", () => {
    const m = parseOciManifest(
      manifest({
        subject: {
          mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
          digest: `sha256:${HEX2}`,
          size: 99,
        },
      }),
    );
    expect(m.subject?.digest).toBe(`sha256:${HEX2}`);
  });

  it("rejects non-string annotations", () => {
    expectOciError(
      () => parseOciManifest(manifest({ annotations: "oops" })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("accepts and preserves the artifactType (top-level)", () => {
    const m = parseOciManifest(manifest({ artifactType: "application/x" }));
    expect(m.artifactType).toBe("application/x");
  });

  it("rejects non-string artifactType (top-level)", () => {
    expectOciError(
      () => parseOciManifest(manifest({ artifactType: 42 })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });
});

// ── parseOciIndex ──────────────────────────────────────────────────

describe("parseOciIndex", () => {
  it("accepts a minimal OCI index", () => {
    const i = parseOciIndex(index());
    expect(i.manifests).toHaveLength(2);
  });

  it("accepts the Docker manifest-list legacy type", () => {
    const i = parseOciIndex(
      index({ mediaType: DOCKER_MEDIA_TYPES.MANIFEST_LIST_V2_2 }),
    );
    expect(i.mediaType).toBe(DOCKER_MEDIA_TYPES.MANIFEST_LIST_V2_2);
  });

  it("rejects a single-manifest mediaType", () => {
    expectOciError(
      () => parseOciIndex(index({ mediaType: OCI_MEDIA_TYPES.MANIFEST_V1 })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects schemaVersion != 2", () => {
    expectOciError(
      () => parseOciIndex(index({ schemaVersion: 0 })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects non-array manifests", () => {
    expectOciError(
      () => parseOciIndex(index({ manifests: {} })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects non-object body", () => {
    expectOciError(
      () => parseOciIndex(["a"]),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("propagates child-descriptor errors", () => {
    expectOciError(
      () =>
        parseOciIndex(
          index({
            manifests: [
              {
                mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
                digest: `sha256:${HEX}`,
                size: -1,
              },
            ],
          }),
        ),
      OCI_ERROR_CODES.SIZE_INVALID,
    );
  });

  it("preserves annotations, subject + artifactType", () => {
    const i = parseOciIndex(
      index({
        annotations: { team: "platform" },
        subject: {
          mediaType: OCI_MEDIA_TYPES.MANIFEST_V1,
          digest: `sha256:${HEX2}`,
          size: 99,
        },
        artifactType: "application/x-test",
      }),
    );
    expect(i.annotations).toEqual({ team: "platform" });
    expect(i.subject?.digest).toBe(`sha256:${HEX2}`);
    expect(i.artifactType).toBe("application/x-test");
  });

  it("rejects non-string artifactType", () => {
    expectOciError(
      () => parseOciIndex(index({ artifactType: 99 })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });
});

// ── parseManifestOrIndex ───────────────────────────────────────────

describe("parseManifestOrIndex", () => {
  it("dispatches a single-platform manifest", () => {
    const r = parseManifestOrIndex(manifest());
    expect(r.kind).toBe("manifest");
    if (r.kind === "manifest") expect(r.value.layers).toHaveLength(1);
  });

  it("dispatches an image index", () => {
    const r = parseManifestOrIndex(index());
    expect(r.kind).toBe("index");
    if (r.kind === "index") expect(r.value.manifests).toHaveLength(2);
  });

  it("rejects unknown mediaType with MANIFEST_INVALID", () => {
    expectOciError(
      () => parseManifestOrIndex(manifest({ mediaType: "application/x-unknown" })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects missing or non-string mediaType", () => {
    const bad = manifest();
    delete (bad as Record<string, unknown>).mediaType;
    expectOciError(
      () => parseManifestOrIndex(bad),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
    expectOciError(
      () => parseManifestOrIndex(manifest({ mediaType: 99 })),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });

  it("rejects non-object body", () => {
    expectOciError(
      () => parseManifestOrIndex("oops"),
      OCI_ERROR_CODES.MANIFEST_INVALID,
    );
  });
});
