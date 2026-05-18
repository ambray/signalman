// WS13 M2 — Maven metadata XML round-trip + composer.

import { describe, expect, it } from "vitest";
import {
  composeArtifactMetadata,
  composeSnapshotMetadata,
  deriveArtifactMetadata,
  MAVEN_ERROR_CODES,
  MavenError,
  parseArtifactMetadata,
  parseSnapshotMetadata,
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

describe("parseArtifactMetadata", () => {
  it("parses canonical Maven Central artifact metadata", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.example</groupId>
  <artifactId>demo-lib</artifactId>
  <versioning>
    <latest>1.2.4</latest>
    <release>1.2.3</release>
    <versions>
      <version>1.0.0</version>
      <version>1.1.0</version>
      <version>1.2.3</version>
      <version>1.2.4</version>
    </versions>
    <lastUpdated>20260517123456</lastUpdated>
  </versioning>
</metadata>`;
    const md = parseArtifactMetadata(xml);
    expect(md.groupId).toBe("com.example");
    expect(md.artifactId).toBe("demo-lib");
    expect(md.versioning.latest).toBe("1.2.4");
    expect(md.versioning.release).toBe("1.2.3");
    expect(md.versioning.versions).toEqual(["1.0.0", "1.1.0", "1.2.3", "1.2.4"]);
    expect(md.versioning.lastUpdated).toBe("20260517123456");
  });
  it("parses metadata without optional fields", () => {
    const xml = `<metadata>
      <groupId>g</groupId>
      <artifactId>a</artifactId>
      <versioning><versions><version>1</version></versions></versioning>
    </metadata>`;
    const md = parseArtifactMetadata(xml);
    expect(md.versioning.latest).toBeUndefined();
    expect(md.versioning.release).toBeUndefined();
    expect(md.versioning.versions).toEqual(["1"]);
  });
  it("rejects missing groupId / artifactId", () => {
    expectMavenError(
      () => parseArtifactMetadata("<metadata><artifactId>a</artifactId></metadata>"),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("rejects wrong root tag", () => {
    expectMavenError(
      () => parseArtifactMetadata("<wrong><groupId>g</groupId></wrong>"),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("rejects bad XML (unclosed tag)", () => {
    expectMavenError(
      () => parseArtifactMetadata("<metadata><groupId>g</metadata>"),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("decodes XML entities", () => {
    const xml = `<metadata>
      <groupId>com.example</groupId>
      <artifactId>a&amp;b</artifactId>
      <versioning><versions><version>1&lt;2</version></versions></versioning>
    </metadata>`;
    const md = parseArtifactMetadata(xml);
    expect(md.artifactId).toBe("a&b");
    expect(md.versioning.versions).toEqual(["1<2"]);
  });
});

describe("composeArtifactMetadata + round-trip", () => {
  it("round-trips canonical metadata", () => {
    const md = {
      groupId: "com.example",
      artifactId: "demo-lib",
      versioning: {
        latest: "1.2.4",
        release: "1.2.3",
        versions: ["1.0.0", "1.1.0", "1.2.3", "1.2.4"],
        lastUpdated: "20260517123456",
      },
    };
    const xml = composeArtifactMetadata(md);
    const parsed = parseArtifactMetadata(xml);
    expect(parsed).toEqual(md);
  });
  it("composes without optional fields", () => {
    const md = {
      groupId: "g",
      artifactId: "a",
      versioning: { versions: ["1"] },
    };
    const xml = composeArtifactMetadata(md);
    expect(xml).toContain("<versions>");
    expect(xml).not.toContain("<latest>");
    expect(xml).not.toContain("<release>");
    const parsed = parseArtifactMetadata(xml);
    expect(parsed.versioning.versions).toEqual(["1"]);
  });
  it("encodes XML entities", () => {
    const md = {
      groupId: "g",
      artifactId: "a&b",
      versioning: { versions: ["1<2", "3>4"] },
    };
    const xml = composeArtifactMetadata(md);
    expect(xml).toContain("a&amp;b");
    expect(xml).toContain("1&lt;2");
    expect(xml).toContain("3&gt;4");
    const parsed = parseArtifactMetadata(xml);
    expect(parsed.artifactId).toBe("a&b");
    expect(parsed.versioning.versions).toEqual(["1<2", "3>4"]);
  });
});

describe("parseSnapshotMetadata + round-trip", () => {
  it("parses canonical snapshot metadata", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.example</groupId>
  <artifactId>demo-lib</artifactId>
  <version>1.2.3-SNAPSHOT</version>
  <versioning>
    <snapshot>
      <timestamp>20260517.123456</timestamp>
      <buildNumber>3</buildNumber>
    </snapshot>
    <lastUpdated>20260517123456</lastUpdated>
    <snapshotVersions>
      <snapshotVersion>
        <extension>jar</extension>
        <value>1.2.3-20260517.123456-3</value>
        <updated>20260517123456</updated>
      </snapshotVersion>
      <snapshotVersion>
        <classifier>sources</classifier>
        <extension>jar</extension>
        <value>1.2.3-20260517.123456-3</value>
      </snapshotVersion>
      <snapshotVersion>
        <extension>pom</extension>
        <value>1.2.3-20260517.123456-3</value>
      </snapshotVersion>
    </snapshotVersions>
  </versioning>
</metadata>`;
    const md = parseSnapshotMetadata(xml);
    expect(md.version).toBe("1.2.3-SNAPSHOT");
    expect(md.versioning.snapshot.timestamp).toBe("20260517.123456");
    expect(md.versioning.snapshot.buildNumber).toBe(3);
    expect(md.versioning.snapshotVersions?.length).toBe(3);
    expect(md.versioning.snapshotVersions?.[1].classifier).toBe("sources");
  });
  it("round-trips", () => {
    const md = {
      groupId: "g",
      artifactId: "a",
      version: "1.0-SNAPSHOT",
      versioning: {
        snapshot: { timestamp: "20260517.123456", buildNumber: 1 },
        lastUpdated: "20260517123456",
        snapshotVersions: [
          { extension: "jar", value: "1.0-20260517.123456-1" },
        ],
      },
    };
    const xml = composeSnapshotMetadata(md);
    const parsed = parseSnapshotMetadata(xml);
    expect(parsed).toEqual(md);
  });
  it("rejects missing snapshot block", () => {
    const xml = `<metadata><groupId>g</groupId><artifactId>a</artifactId><version>v</version><versioning></versioning></metadata>`;
    expectMavenError(
      () => parseSnapshotMetadata(xml),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("rejects non-integer buildNumber", () => {
    const xml = `<metadata><groupId>g</groupId><artifactId>a</artifactId><version>v</version>
      <versioning><snapshot><timestamp>20260517.123456</timestamp><buildNumber>not-a-number</buildNumber></snapshot></versioning>
    </metadata>`;
    expectMavenError(
      () => parseSnapshotMetadata(xml),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
});

describe("deriveArtifactMetadata", () => {
  it("picks latest as max lex version and release as max non-snapshot", () => {
    const md = deriveArtifactMetadata(
      "com.example",
      "demo",
      ["1.0.0", "1.1.0", "1.2.0-SNAPSHOT", "1.2.0", "1.3.0-SNAPSHOT"],
      "20260517123456",
    );
    expect(md.versioning.latest).toBe("1.3.0-SNAPSHOT");
    expect(md.versioning.release).toBe("1.2.0");
    expect(md.versioning.versions).toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
      "1.2.0-SNAPSHOT",
      "1.3.0-SNAPSHOT",
    ]);
  });
  it("works with no versions", () => {
    const md = deriveArtifactMetadata("g", "a", [], "20260517123456");
    expect(md.versioning.latest).toBeUndefined();
    expect(md.versioning.release).toBeUndefined();
    expect(md.versioning.versions).toEqual([]);
  });
  it("works with only snapshots", () => {
    const md = deriveArtifactMetadata(
      "g",
      "a",
      ["1.0-SNAPSHOT", "1.1-SNAPSHOT"],
      "20260517123456",
    );
    expect(md.versioning.latest).toBe("1.1-SNAPSHOT");
    expect(md.versioning.release).toBeUndefined();
  });
});

describe("XML hardening", () => {
  it("rejects attributes (operator-supplied)", () => {
    expectMavenError(
      () =>
        parseArtifactMetadata(
          `<metadata xmlns="http://maven.apache.org/POM"><groupId>g</groupId></metadata>`,
        ),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("rejects DOCTYPE", () => {
    expectMavenError(
      () =>
        parseArtifactMetadata(
          `<!DOCTYPE metadata><metadata><groupId>g</groupId></metadata>`,
        ),
      MAVEN_ERROR_CODES.UPLOAD_INVALID,
    );
  });
  it("strips comments", () => {
    const xml = `<metadata>
      <!-- a comment -->
      <groupId>g</groupId>
      <artifactId>a</artifactId>
      <versioning><versions><version>1</version></versions></versioning>
    </metadata>`;
    const md = parseArtifactMetadata(xml);
    expect(md.groupId).toBe("g");
  });
});
