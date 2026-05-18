// WS13 M2 — Maven path / coordinate parsers + composers.

import { describe, expect, it } from "vitest";
import {
  composeMavenFilename,
  composeMavenPath,
  groupPath,
  isSnapshotVersion,
  mavenManifestName,
  mavenManifestVersion,
  MAVEN_ERROR_CODES,
  MavenError,
  parseGroupPath,
  parseMavenManifestName,
  parseMavenPath,
  parseResolvedSnapshot,
  snapshotBaseVersion,
  validateMavenArtifactId,
  validateMavenClassifier,
  validateMavenGroupId,
  validateMavenVersion,
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

describe("validateMavenGroupId", () => {
  it("accepts dot-separated identifiers", () => {
    validateMavenGroupId("com.example");
    validateMavenGroupId("com.example.demo");
    validateMavenGroupId("org.apache.maven.plugins");
    validateMavenGroupId("io.github.user-name.lib_kit");
  });
  it("rejects empty", () => {
    expectMavenError(() => validateMavenGroupId(""), MAVEN_ERROR_CODES.GROUP_INVALID);
  });
  it("rejects non-string", () => {
    expectMavenError(
      () => validateMavenGroupId(null as unknown as string),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
  });
  it("rejects consecutive dots", () => {
    expectMavenError(
      () => validateMavenGroupId("com..example"),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
  });
  it("rejects bad chars", () => {
    expectMavenError(
      () => validateMavenGroupId("com.example/bad"),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
    expectMavenError(
      () => validateMavenGroupId("com.example bad"),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
    expectMavenError(
      () => validateMavenGroupId("0com.example"),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
  });
  it("rejects oversize", () => {
    expectMavenError(
      () => validateMavenGroupId("a." + "b".repeat(300)),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
  });
});

describe("validateMavenArtifactId", () => {
  it("accepts single-segment identifiers", () => {
    validateMavenArtifactId("demo-lib");
    validateMavenArtifactId("my_artifact");
    validateMavenArtifactId("Hello.World");
  });
  it("rejects empty / bad", () => {
    expectMavenError(
      () => validateMavenArtifactId(""),
      MAVEN_ERROR_CODES.ARTIFACT_INVALID,
    );
    expectMavenError(
      () => validateMavenArtifactId("foo/bar"),
      MAVEN_ERROR_CODES.ARTIFACT_INVALID,
    );
    expectMavenError(
      () => validateMavenArtifactId("1leading-digit"),
      MAVEN_ERROR_CODES.ARTIFACT_INVALID,
    );
  });
});

describe("validateMavenVersion", () => {
  it("accepts a wide range of versions", () => {
    validateMavenVersion("1.0.0");
    validateMavenVersion("1.2.3-SNAPSHOT");
    validateMavenVersion("1.2.3-20260517.123456-1");
    validateMavenVersion("0.0.1-rc.1");
    validateMavenVersion("2024.06.15");
    validateMavenVersion("v3.7.1+build.42");
  });
  it("rejects empty / bad chars", () => {
    expectMavenError(
      () => validateMavenVersion(""),
      MAVEN_ERROR_CODES.VERSION_INVALID,
    );
    expectMavenError(
      () => validateMavenVersion("1.2.3 bad"),
      MAVEN_ERROR_CODES.VERSION_INVALID,
    );
    expectMavenError(
      () => validateMavenVersion("../1.0"),
      MAVEN_ERROR_CODES.VERSION_INVALID,
    );
    expectMavenError(
      () => validateMavenVersion("1..2"),
      MAVEN_ERROR_CODES.VERSION_INVALID,
    );
  });
});

describe("validateMavenClassifier", () => {
  it("accepts sources/javadoc/custom", () => {
    validateMavenClassifier("sources");
    validateMavenClassifier("javadoc");
    validateMavenClassifier("native-linux-x86_64");
    validateMavenClassifier("tests");
  });
  it("rejects bad", () => {
    expectMavenError(
      () => validateMavenClassifier(""),
      MAVEN_ERROR_CODES.CLASSIFIER_INVALID,
    );
    expectMavenError(
      () => validateMavenClassifier("with space"),
      MAVEN_ERROR_CODES.CLASSIFIER_INVALID,
    );
    expectMavenError(
      () => validateMavenClassifier("with/slash"),
      MAVEN_ERROR_CODES.CLASSIFIER_INVALID,
    );
  });
});

describe("snapshot detection", () => {
  it("isSnapshotVersion catches the -SNAPSHOT suffix", () => {
    expect(isSnapshotVersion("1.0.0-SNAPSHOT")).toBe(true);
    expect(isSnapshotVersion("1.0.0")).toBe(false);
    expect(isSnapshotVersion("1.0.0-20260517.123456-1")).toBe(false);
  });
  it("parseResolvedSnapshot parses the timestamped tail", () => {
    expect(parseResolvedSnapshot("1.2.3-20260517.123456-1")).toEqual({
      timestamp: "20260517.123456",
      buildNumber: 1,
    });
    expect(parseResolvedSnapshot("1.2.3-20260517.123456-42")).toEqual({
      timestamp: "20260517.123456",
      buildNumber: 42,
    });
    expect(parseResolvedSnapshot("1.2.3")).toBeNull();
    expect(parseResolvedSnapshot("1.2.3-SNAPSHOT")).toBeNull();
  });
  it("snapshotBaseVersion strips the resolved tail", () => {
    expect(snapshotBaseVersion("1.2.3-20260517.123456-1")).toBe("1.2.3-SNAPSHOT");
    expect(snapshotBaseVersion("1.2.3-SNAPSHOT")).toBe("1.2.3-SNAPSHOT");
    expect(snapshotBaseVersion("1.2.3")).toBe("1.2.3");
  });
});

describe("groupPath / parseGroupPath", () => {
  it("composes + parses round-trip", () => {
    expect(groupPath("com.example.tools")).toBe("com/example/tools");
    expect(parseGroupPath("com/example/tools")).toBe("com.example.tools");
  });
  it("rejects empty / path-traversal segments", () => {
    expectMavenError(() => parseGroupPath(""), MAVEN_ERROR_CODES.GROUP_INVALID);
    expectMavenError(
      () => parseGroupPath("com//example"),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
    expectMavenError(
      () => parseGroupPath("com/../example"),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
    expectMavenError(
      () => parseGroupPath("./example"),
      MAVEN_ERROR_CODES.GROUP_INVALID,
    );
  });
});

describe("composeMavenFilename / composeMavenPath", () => {
  it("release jar", () => {
    const fname = composeMavenFilename({
      groupId: "com.example",
      artifactId: "demo-lib",
      version: "1.2.3",
      baseVersion: "1.2.3",
      extension: "jar",
      isSnapshot: false,
    });
    expect(fname).toBe("demo-lib-1.2.3.jar");
  });
  it("release jar with classifier", () => {
    const fname = composeMavenFilename({
      groupId: "com.example",
      artifactId: "demo-lib",
      version: "1.2.3",
      baseVersion: "1.2.3",
      classifier: "sources",
      extension: "jar",
      isSnapshot: false,
    });
    expect(fname).toBe("demo-lib-1.2.3-sources.jar");
  });
  it("composes a full repo-relative path", () => {
    const p = composeMavenPath({
      groupId: "com.example.demo",
      artifactId: "demo-lib",
      version: "1.2.3",
      baseVersion: "1.2.3",
      extension: "jar",
      isSnapshot: false,
    });
    expect(p).toBe("com/example/demo/demo-lib/1.2.3/demo-lib-1.2.3.jar");
  });
  it("snapshot pom.asc", () => {
    const fname = composeMavenFilename({
      groupId: "com.example",
      artifactId: "demo-lib",
      version: "1.2.3-20260517.123456-1",
      baseVersion: "1.2.3-SNAPSHOT",
      extension: "pom.asc",
      isSnapshot: true,
      snapshot: { timestamp: "20260517.123456", buildNumber: 1 },
    });
    expect(fname).toBe("demo-lib-1.2.3-20260517.123456-1.pom.asc");
  });
  it("rejects bad extension", () => {
    expectMavenError(
      () =>
        composeMavenFilename({
          groupId: "com.example",
          artifactId: "demo-lib",
          version: "1.2.3",
          baseVersion: "1.2.3",
          extension: "exe",
          isSnapshot: false,
        }),
      MAVEN_ERROR_CODES.EXTENSION_INVALID,
    );
  });
});

describe("parseMavenPath", () => {
  it("release jar round-trip", () => {
    const coord = parseMavenPath(
      "com/example/demo-lib/1.2.3/demo-lib-1.2.3.jar",
    );
    expect(coord).toEqual({
      groupId: "com.example",
      artifactId: "demo-lib",
      version: "1.2.3",
      baseVersion: "1.2.3",
      extension: "jar",
      isSnapshot: false,
    });
  });
  it("release jar with classifier", () => {
    const coord = parseMavenPath(
      "com/example/demo-lib/1.2.3/demo-lib-1.2.3-sources.jar",
    );
    expect(coord).toMatchObject({
      groupId: "com.example",
      artifactId: "demo-lib",
      version: "1.2.3",
      baseVersion: "1.2.3",
      classifier: "sources",
      extension: "jar",
      isSnapshot: false,
    });
  });
  it("checksum file", () => {
    const coord = parseMavenPath(
      "com/example/demo-lib/1.2.3/demo-lib-1.2.3.jar.sha1",
    );
    expect(coord).toMatchObject({
      groupId: "com.example",
      artifactId: "demo-lib",
      extension: "jar.sha1",
    });
  });
  it("signature file", () => {
    const coord = parseMavenPath(
      "com/example/demo-lib/1.2.3/demo-lib-1.2.3.pom.asc",
    );
    expect(coord).toMatchObject({
      groupId: "com.example",
      artifactId: "demo-lib",
      extension: "pom.asc",
    });
  });
  it("resolved snapshot", () => {
    const coord = parseMavenPath(
      "com/example/demo-lib/1.2.3-SNAPSHOT/demo-lib-1.2.3-20260517.123456-1.jar",
    );
    expect(coord).toMatchObject({
      groupId: "com.example",
      artifactId: "demo-lib",
      version: "1.2.3-20260517.123456-1",
      baseVersion: "1.2.3-SNAPSHOT",
      extension: "jar",
      isSnapshot: true,
      snapshot: { timestamp: "20260517.123456", buildNumber: 1 },
    });
  });
  it("resolved snapshot with classifier", () => {
    const coord = parseMavenPath(
      "com/example/demo-lib/1.2.3-SNAPSHOT/demo-lib-1.2.3-20260517.123456-1-sources.jar",
    );
    expect(coord).toMatchObject({
      classifier: "sources",
      isSnapshot: true,
      snapshot: { timestamp: "20260517.123456", buildNumber: 1 },
    });
  });
  it("returns null for empty / leading-slash / trailing-slash", () => {
    expect(parseMavenPath("")).toBeNull();
    expect(parseMavenPath("/foo")).toBeNull();
    expect(parseMavenPath("foo/")).toBeNull();
  });
  it("returns null when too short", () => {
    expect(parseMavenPath("a/b/c")).toBeNull();
  });
  it("throws when filename doesn't match artifactId prefix", () => {
    expectMavenError(
      () =>
        parseMavenPath(
          "com/example/demo-lib/1.2.3/different-prefix-1.2.3.jar",
        ),
      MAVEN_ERROR_CODES.FILENAME_INVALID,
    );
  });
  it("deep groupPath", () => {
    const coord = parseMavenPath(
      "org/apache/maven/plugins/very-deep-tool/0.1.0/very-deep-tool-0.1.0.jar",
    );
    expect(coord?.groupId).toBe("org.apache.maven.plugins");
    expect(coord?.artifactId).toBe("very-deep-tool");
  });
});

describe("mavenManifestName / parseMavenManifestName / mavenManifestVersion", () => {
  it("composes with groupId in dot form", () => {
    expect(mavenManifestName("myorg", "com.example", "demo-lib")).toBe(
      "maven/myorg/com.example/demo-lib",
    );
  });
  it("parses inverse", () => {
    expect(
      parseMavenManifestName("maven/myorg/com.example.tools/demo-lib"),
    ).toEqual({
      org: "myorg",
      groupId: "com.example.tools",
      artifactId: "demo-lib",
    });
  });
  it("returns null on bad prefix / shape", () => {
    expect(parseMavenManifestName("not-maven/foo")).toBeNull();
    expect(parseMavenManifestName("maven/onlyorg")).toBeNull();
  });
  it("version key is the filename (within (groupId, artifactId) namespace)", () => {
    expect(mavenManifestVersion("1.2.3", "demo-lib-1.2.3.jar")).toBe(
      "demo-lib-1.2.3.jar",
    );
    // baseVersion is still validated even though it's not embedded.
    expect(mavenManifestVersion("1.2.3-SNAPSHOT", "demo-lib-1.2.3-20260517.120000-1.jar"))
      .toBe("demo-lib-1.2.3-20260517.120000-1.jar");
  });
  it("version key rejects slashes in filename", () => {
    expectMavenError(
      () => mavenManifestVersion("1.2.3", "demo/bad-1.2.3.jar"),
      MAVEN_ERROR_CODES.FILENAME_INVALID,
    );
  });
});
