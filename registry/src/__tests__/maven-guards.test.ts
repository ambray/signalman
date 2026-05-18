// WS13 M2 — Maven guard helpers (snapshot policy, extension role,
// checksum payload).

import { describe, expect, it } from "vitest";
import {
  classifyExtension,
  enforceSnapshotPolicy,
  filenameOfCoveredArtifact,
  MAVEN_ERROR_CODES,
  MavenError,
  parseChecksumPayload,
  splitMultiExtension,
} from "../maven/index.js";

function expectMavenError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MavenError);
  expect((caught as MavenError).code).toBe(code);
}

describe("enforceSnapshotPolicy", () => {
  const releaseCoord = {
    groupId: "com.example",
    artifactId: "demo",
    version: "1.0.0",
    baseVersion: "1.0.0",
    extension: "jar",
    isSnapshot: false,
  };
  const snapshotCoord = {
    ...releaseCoord,
    version: "1.0.0-SNAPSHOT",
    baseVersion: "1.0.0-SNAPSHOT",
    isSnapshot: true,
  };
  const resolvedSnapCoord = {
    ...releaseCoord,
    version: "1.0.0-20260517.120000-1",
    baseVersion: "1.0.0-SNAPSHOT",
    isSnapshot: true,
  };
  it("passes release under either policy", () => {
    enforceSnapshotPolicy(releaseCoord, "reject");
    enforceSnapshotPolicy(releaseCoord, "accept");
  });
  it("rejects snapshot under 'reject' policy", () => {
    expectMavenError(
      () => enforceSnapshotPolicy(snapshotCoord, "reject"),
      MAVEN_ERROR_CODES.SNAPSHOT_REFUSED,
    );
    expectMavenError(
      () => enforceSnapshotPolicy(resolvedSnapCoord, "reject"),
      MAVEN_ERROR_CODES.SNAPSHOT_REFUSED,
    );
  });
  it("accepts snapshot under 'accept' policy", () => {
    enforceSnapshotPolicy(snapshotCoord, "accept");
    enforceSnapshotPolicy(resolvedSnapCoord, "accept");
  });
});

describe("classifyExtension", () => {
  it("primary", () => {
    expect(classifyExtension("jar")).toBe("primary");
    expect(classifyExtension("pom")).toBe("primary");
    expect(classifyExtension("war")).toBe("primary");
    expect(classifyExtension("ear")).toBe("primary");
    expect(classifyExtension("module")).toBe("primary");
    expect(classifyExtension("aar")).toBe("primary");
    expect(classifyExtension("klib")).toBe("primary");
  });
  it("checksum (bare)", () => {
    expect(classifyExtension("sha1")).toBe("checksum");
    expect(classifyExtension("md5")).toBe("checksum");
    expect(classifyExtension("sha256")).toBe("checksum");
    expect(classifyExtension("sha512")).toBe("checksum");
  });
  it("signature (bare)", () => {
    expect(classifyExtension("asc")).toBe("signature");
  });
  it("multi-suffix forms", () => {
    expect(classifyExtension("jar.sha1")).toBe("checksum");
    expect(classifyExtension("pom.md5")).toBe("checksum");
    expect(classifyExtension("jar.asc")).toBe("signature");
    expect(classifyExtension("pom.asc")).toBe("signature");
  });
  it("unknown", () => {
    expect(classifyExtension("exe")).toBe("unknown");
    expect(classifyExtension("rpm.sha1")).toBe("unknown");
  });
});

describe("splitMultiExtension", () => {
  it("splits multi", () => {
    expect(splitMultiExtension("jar.sha1")).toEqual({
      covered: "jar",
      suffix: "sha1",
    });
    expect(splitMultiExtension("pom.asc")).toEqual({
      covered: "pom",
      suffix: "asc",
    });
  });
  it("returns null for bare", () => {
    expect(splitMultiExtension("jar")).toBeNull();
    expect(splitMultiExtension("")).toBeNull();
  });
});

describe("filenameOfCoveredArtifact", () => {
  it("strips checksum suffix", () => {
    expect(filenameOfCoveredArtifact("demo-1.2.3.jar.sha1")).toBe(
      "demo-1.2.3.jar",
    );
    expect(filenameOfCoveredArtifact("demo-1.2.3.pom.md5")).toBe(
      "demo-1.2.3.pom",
    );
  });
  it("strips signature suffix", () => {
    expect(filenameOfCoveredArtifact("demo-1.2.3.jar.asc")).toBe(
      "demo-1.2.3.jar",
    );
  });
  it("returns null for non-checksum/sig", () => {
    expect(filenameOfCoveredArtifact("demo-1.2.3.jar")).toBeNull();
    expect(filenameOfCoveredArtifact("noext")).toBeNull();
  });
});

describe("parseChecksumPayload", () => {
  it("accepts bare hex digest", () => {
    const sha1 = "a".repeat(40);
    expect(parseChecksumPayload(Buffer.from(sha1, "utf-8"), "sha1")).toBe(sha1);
  });
  it("accepts hex + filename (sha256sum-style)", () => {
    const sha256 = "b".repeat(64);
    const payload = `${sha256}  demo.jar\n`;
    expect(parseChecksumPayload(Buffer.from(payload, "utf-8"), "sha256")).toBe(
      sha256,
    );
  });
  it("normalises case", () => {
    const sha1 = "F".repeat(40);
    expect(parseChecksumPayload(Buffer.from(sha1, "utf-8"), "sha1")).toBe(
      "f".repeat(40),
    );
  });
  it("rejects wrong length", () => {
    expectMavenError(
      () => parseChecksumPayload(Buffer.from("a".repeat(20), "utf-8"), "sha1"),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
    expectMavenError(
      () => parseChecksumPayload(Buffer.from("a".repeat(64), "utf-8"), "sha1"),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("rejects non-hex", () => {
    expectMavenError(
      () => parseChecksumPayload(Buffer.from("x".repeat(40), "utf-8"), "sha1"),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("rejects unknown algorithm suffix", () => {
    expectMavenError(
      () => parseChecksumPayload(Buffer.from("a".repeat(40), "utf-8"), "sha999"),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("expected lengths", () => {
    expect(
      parseChecksumPayload(Buffer.from("d".repeat(32), "utf-8"), "md5"),
    ).toBe("d".repeat(32));
    expect(
      parseChecksumPayload(Buffer.from("c".repeat(128), "utf-8"), "sha512"),
    ).toBe("c".repeat(128));
  });
});
