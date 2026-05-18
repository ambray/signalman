// WS13 M3 — NuGet registration composition + service-index shape.

import { describe, expect, it } from "vitest";
import {
  composeRegistrationIndex,
  composeRegistrationLeaf,
  composeServiceIndex,
  NUGET_RESOURCE_TYPES,
} from "../nuget/index.js";
import type { Manifest, NugetManifestMetadata } from "../types.js";

function makeManifest(
  org: string,
  id: string,
  version: string,
  extra: Partial<NugetManifestMetadata> = {},
): Manifest {
  const nugetMetadata: NugetManifestMetadata = {
    id,
    version,
    packageHash: "AAAA==",
    packageHashAlgorithm: "SHA512",
    packageSize: 1234,
    listed: true,
    ...extra,
  };
  return {
    name: `nuget/${org}/${id}`,
    version,
    mediaType: "application/vnd.signalman.nuget-package.v1+json",
    kind: "nuget",
    blobs: [
      {
        mediaType: "application/octet-stream",
        sha256: "a".repeat(64),
        size: 1234,
        name: `${id}.${version}.nupkg`,
      },
    ],
    nugetMetadata,
    createdAt: "2026-05-17T12:00:00.000Z",
  };
}

describe("composeServiceIndex", () => {
  it("advertises required v3 resources", () => {
    const idx = composeServiceIndex("acme", "https://signalman");
    expect(idx.version).toBe("3.0.0");
    const types = idx.resources.map((r) => r["@type"]);
    expect(types).toContain(NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS);
    expect(types).toContain(NUGET_RESOURCE_TYPES.REGISTRATION_BASE_URL);
    expect(types).toContain(NUGET_RESOURCE_TYPES.PACKAGE_PUBLISH);
    expect(types).toContain(NUGET_RESOURCE_TYPES.SEARCH_QUERY_SERVICE);
  });
  it("absolute @id URLs use the publicBaseUrl", () => {
    const idx = composeServiceIndex("acme", "https://signalman");
    const pbAddr = idx.resources.find(
      (r) => r["@type"] === NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
    );
    expect(pbAddr).toBeDefined();
    expect(pbAddr!["@id"]).toBe("https://signalman/nuget/acme/v3/flat2/");
  });
  it("trims trailing slash from publicBaseUrl", () => {
    const idx = composeServiceIndex("acme", "https://signalman/");
    const pubResource = idx.resources.find(
      (r) => r["@type"] === NUGET_RESOURCE_TYPES.PACKAGE_PUBLISH,
    );
    expect(pubResource!["@id"]).toBe("https://signalman/nuget/acme/v3/publish");
  });
  it("emits relative URLs when publicBaseUrl is empty", () => {
    const idx = composeServiceIndex("acme", "");
    const pbAddr = idx.resources.find(
      (r) => r["@type"] === NUGET_RESOURCE_TYPES.PACKAGE_BASE_ADDRESS,
    );
    expect(pbAddr!["@id"]).toBe("/nuget/acme/v3/flat2/");
  });
});

describe("composeRegistrationLeaf", () => {
  it("composes a minimal leaf", () => {
    const m = makeManifest("acme", "demo", "1.0.0", {
      authors: "Acme",
      description: "demo lib",
      tags: ["util"],
    });
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "https://signalman",
      "registration5-semver1",
    );
    expect(leaf["@type"]).toBe("Package");
    expect(leaf.catalogEntry.id).toBe("demo");
    expect(leaf.catalogEntry.version).toBe("1.0.0");
    expect(leaf.catalogEntry.authors).toBe("Acme");
    expect(leaf.catalogEntry.description).toBe("demo lib");
    expect(leaf.catalogEntry.tags).toEqual(["util"]);
    expect(leaf.catalogEntry.listed).toBe(true);
    expect(leaf.catalogEntry.packageHash).toBe("AAAA==");
    expect(leaf.catalogEntry.packageHashAlgorithm).toBe("SHA512");
    expect(leaf.packageContent).toBe(
      "https://signalman/nuget/acme/v3/flat2/demo/1.0.0/demo.1.0.0.nupkg",
    );
    expect(leaf.registration).toBe(
      "https://signalman/nuget/acme/v3/registration5-semver1/demo/index.json",
    );
  });
  it("preserves originalId casing for display", () => {
    const m = makeManifest("acme", "newtonsoft.json", "13.0.3", {
      originalId: "Newtonsoft.Json",
    });
    const leaf = composeRegistrationLeaf(
      "acme",
      "newtonsoft.json",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.id).toBe("Newtonsoft.Json");
  });
  it("preserves dependencyGroups", () => {
    const m = makeManifest("acme", "demo", "1.0.0", {
      dependencyGroups: [
        {
          targetFramework: "net6.0",
          dependencies: [{ id: "Newtonsoft.Json", range: "13.0.0" }],
        },
      ],
    });
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.dependencyGroups).toEqual([
      {
        "@type": "PackageDependencyGroup",
        targetFramework: "net6.0",
        dependencies: [
          { "@type": "PackageDependency", id: "Newtonsoft.Json", range: "13.0.0" },
        ],
      },
    ]);
  });
  it("falls back to manifest.createdAt when published is unset", () => {
    const m = makeManifest("acme", "demo", "1.0.0");
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.published).toBe("2026-05-17T12:00:00.000Z");
  });
});

describe("composeRegistrationIndex", () => {
  it("wraps every manifest in a single inline page", () => {
    const m1 = makeManifest("acme", "demo", "1.0.0");
    const m2 = makeManifest("acme", "demo", "1.1.0");
    const m3 = makeManifest("acme", "demo", "2.0.0");
    const idx = composeRegistrationIndex(
      "acme",
      "demo",
      [m1, m2, m3],
      "https://signalman",
      "registration5-semver1",
    );
    expect(idx.count).toBe(1);
    expect(idx.items).toHaveLength(1);
    const page = idx.items[0];
    expect(page.count).toBe(3);
    expect(page.items).toHaveLength(3);
    expect(page.lower).toBe("1.0.0");
    expect(page.upper).toBe("2.0.0");
    expect(idx["@id"]).toBe(
      "https://signalman/nuget/acme/v3/registration5-semver1/demo/index.json",
    );
  });
  it("preserves order of input manifests for the page", () => {
    const m1 = makeManifest("acme", "demo", "1.0.0");
    const m2 = makeManifest("acme", "demo", "2.0.0");
    const idx = composeRegistrationIndex(
      "acme",
      "demo",
      [m1, m2],
      "",
      "registration5-semver1",
    );
    const versions = idx.items[0].items.map((l) => l.catalogEntry.version);
    expect(versions).toEqual(["1.0.0", "2.0.0"]);
  });
  it("supports semver2 prefix", () => {
    const m = makeManifest("acme", "demo", "1.0.0");
    const idx = composeRegistrationIndex(
      "acme",
      "demo",
      [m],
      "https://signalman",
      "registration5-semver2",
    );
    expect(idx["@id"]).toContain("registration5-semver2");
  });
  it("populates all optional catalogEntry fields when present", () => {
    const m = makeManifest("acme", "demo", "1.0.0", {
      authors: "Acme Inc",
      description: "demo description",
      summary: "demo summary",
      title: "Demo",
      tags: ["util", "fast"],
      projectUrl: "https://example.com",
      licenseUrl: "https://example.com/LICENSE",
      licenseExpression: "MIT",
      iconUrl: "https://example.com/icon.png",
      requireLicenseAcceptance: true,
      targetFrameworks: ["net6.0"],
      published: "2026-05-17T00:00:00Z",
    });
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.authors).toBe("Acme Inc");
    expect(leaf.catalogEntry.summary).toBe("demo summary");
    expect(leaf.catalogEntry.title).toBe("Demo");
    expect(leaf.catalogEntry.projectUrl).toBe("https://example.com");
    expect(leaf.catalogEntry.licenseUrl).toBe("https://example.com/LICENSE");
    expect(leaf.catalogEntry.licenseExpression).toBe("MIT");
    expect(leaf.catalogEntry.iconUrl).toBe("https://example.com/icon.png");
    expect(leaf.catalogEntry.requireLicenseAcceptance).toBe(true);
    expect(leaf.catalogEntry.targetFrameworks).toEqual(["net6.0"]);
    expect(leaf.catalogEntry.published).toBe("2026-05-17T00:00:00Z");
  });
  it("listed defaults to true when listed=undefined", () => {
    const m = makeManifest("acme", "demo", "1.0.0");
    delete m.nugetMetadata!.listed;
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.listed).toBe(true);
  });
  it("listed=false flows through", () => {
    const m = makeManifest("acme", "demo", "1.0.0", { listed: false });
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.listed).toBe(false);
  });
  it("handles dependency group with no dependencies array", () => {
    const m = makeManifest("acme", "demo", "1.0.0", {
      dependencyGroups: [{ targetFramework: "net6.0" }],
    });
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.dependencyGroups).toEqual([
      { "@type": "PackageDependencyGroup", targetFramework: "net6.0" },
    ]);
  });
  it("handles dependency group with no targetFramework", () => {
    const m = makeManifest("acme", "demo", "1.0.0", {
      dependencyGroups: [
        { dependencies: [{ id: "Newtonsoft.Json" }] },
      ],
    });
    const leaf = composeRegistrationLeaf(
      "acme",
      "demo",
      m,
      "",
      "registration5-semver1",
    );
    expect(leaf.catalogEntry.dependencyGroups?.[0].targetFramework).toBeUndefined();
    expect(leaf.catalogEntry.dependencyGroups?.[0].dependencies?.[0].id).toBe(
      "Newtonsoft.Json",
    );
  });
});
