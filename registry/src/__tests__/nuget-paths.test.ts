// WS13 M3 — NuGet path / coordinate parsers + composers.

import { describe, expect, it } from "vitest";
import {
  flatContainerIndexPath,
  flatContainerNupkgPath,
  flatContainerNuspecPath,
  NUGET_ERROR_CODES,
  NugetError,
  normalisePackageId,
  normaliseVersion,
  nugetManifestName,
  nugetManifestVersion,
  parseNugetManifestName,
  parseNugetPath,
  validateNugetPackageId,
  validateNugetVersion,
} from "../nuget/index.js";

function expectNugetError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(NugetError);
  expect((caught as NugetError).code).toBe(code);
}

describe("validateNugetPackageId", () => {
  it("accepts canonical ids", () => {
    validateNugetPackageId("Newtonsoft.Json");
    validateNugetPackageId("Microsoft.AspNetCore.App");
    validateNugetPackageId("Castle.Core");
    validateNugetPackageId("a1");
    validateNugetPackageId("xunit");
  });
  it("rejects empty", () => {
    expectNugetError(() => validateNugetPackageId(""), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
  });
  it("rejects non-string", () => {
    expectNugetError(
      () => validateNugetPackageId(null as unknown as string),
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
    );
  });
  it("rejects leading separator", () => {
    expectNugetError(() => validateNugetPackageId(".foo"), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
    expectNugetError(() => validateNugetPackageId("-foo"), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
    expectNugetError(() => validateNugetPackageId("_foo"), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
  });
  it("rejects trailing separator", () => {
    expectNugetError(() => validateNugetPackageId("foo."), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
    expectNugetError(() => validateNugetPackageId("foo-"), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
    expectNugetError(() => validateNugetPackageId("foo_"), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
  });
  it("rejects path traversal", () => {
    expectNugetError(
      () => validateNugetPackageId("foo..bar"),
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
    );
  });
  it("rejects bad chars", () => {
    expectNugetError(() => validateNugetPackageId("foo/bar"), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
    expectNugetError(() => validateNugetPackageId("foo bar"), NUGET_ERROR_CODES.PACKAGE_ID_INVALID);
    expectNugetError(
      () => validateNugetPackageId("foo:bar"),
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
    );
  });
  it("rejects oversize", () => {
    expectNugetError(
      () => validateNugetPackageId("a".repeat(101)),
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
    );
  });
});

describe("validateNugetVersion", () => {
  it("accepts 3-segment semver", () => {
    validateNugetVersion("1.0.0");
    validateNugetVersion("13.0.3");
    validateNugetVersion("0.0.1");
  });
  it("accepts 4-segment legacy", () => {
    validateNugetVersion("1.2.3.4");
    validateNugetVersion("6.0.100.20240417");
  });
  it("accepts prerelease tags", () => {
    validateNugetVersion("1.0.0-alpha");
    validateNugetVersion("1.0.0-alpha.1");
    validateNugetVersion("2.0.0-rc.2");
  });
  it("accepts build metadata", () => {
    validateNugetVersion("1.0.0+build.42");
    validateNugetVersion("1.0.0-alpha+build.1");
  });
  it("rejects empty + non-string", () => {
    expectNugetError(() => validateNugetVersion(""), NUGET_ERROR_CODES.VERSION_INVALID);
    expectNugetError(
      () => validateNugetVersion(undefined as unknown as string),
      NUGET_ERROR_CODES.VERSION_INVALID,
    );
  });
  it("rejects non-numeric segments", () => {
    expectNugetError(() => validateNugetVersion("1.x.0"), NUGET_ERROR_CODES.VERSION_INVALID);
    expectNugetError(() => validateNugetVersion("v1.0.0"), NUGET_ERROR_CODES.VERSION_INVALID);
  });
  it("rejects too-few segments", () => {
    expectNugetError(() => validateNugetVersion("1.0"), NUGET_ERROR_CODES.VERSION_INVALID);
    expectNugetError(() => validateNugetVersion("1"), NUGET_ERROR_CODES.VERSION_INVALID);
  });
  it("rejects oversize", () => {
    expectNugetError(
      () => validateNugetVersion("1.0.0-" + "a".repeat(80)),
      NUGET_ERROR_CODES.VERSION_INVALID,
    );
  });
});

describe("normalisePackageId", () => {
  it("lowercases", () => {
    expect(normalisePackageId("Newtonsoft.Json")).toBe("newtonsoft.json");
    expect(normalisePackageId("xUNIT")).toBe("xunit");
  });
  it("idempotent", () => {
    expect(normalisePackageId("already-lower")).toBe("already-lower");
  });
});

describe("normaliseVersion", () => {
  it("lowercases prerelease tags", () => {
    expect(normaliseVersion("1.0.0-Alpha")).toBe("1.0.0-alpha");
    expect(normaliseVersion("1.0.0-RC.1")).toBe("1.0.0-rc.1");
  });
  it("strips leading zeros", () => {
    expect(normaliseVersion("01.02.03")).toBe("1.2.3");
    expect(normaliseVersion("1.02.3")).toBe("1.2.3");
  });
  it("drops trailing .0 on 4-segment", () => {
    expect(normaliseVersion("1.2.3.0")).toBe("1.2.3");
    expect(normaliseVersion("1.2.3.4")).toBe("1.2.3.4");
  });
  it("strips build metadata", () => {
    expect(normaliseVersion("1.0.0+build.42")).toBe("1.0.0");
    expect(normaliseVersion("1.0.0-alpha+x")).toBe("1.0.0-alpha");
  });
  it("preserves canonical form", () => {
    expect(normaliseVersion("1.2.3")).toBe("1.2.3");
    expect(normaliseVersion("13.0.3")).toBe("13.0.3");
  });
});

describe("flatContainer path composers", () => {
  it("composes nupkg path with lowercase + normalised version", () => {
    expect(flatContainerNupkgPath("Newtonsoft.Json", "13.0.3")).toBe(
      "newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg",
    );
  });
  it("composes nuspec path", () => {
    expect(flatContainerNuspecPath("Demo.Lib", "1.0.0")).toBe(
      "demo.lib/1.0.0/demo.lib.nuspec",
    );
  });
  it("composes version-index path", () => {
    expect(flatContainerIndexPath("Demo.Lib")).toBe("demo.lib/index.json");
  });
  it("propagates validation errors", () => {
    expectNugetError(
      () => flatContainerNupkgPath("", "1.0.0"),
      NUGET_ERROR_CODES.PACKAGE_ID_INVALID,
    );
    expectNugetError(
      () => flatContainerNupkgPath("foo", "not-semver"),
      NUGET_ERROR_CODES.VERSION_INVALID,
    );
  });
});

describe("parseNugetPath", () => {
  it("recognises service-index", () => {
    expect(parseNugetPath("v3/index.json")).toEqual({ kind: "service-index" });
  });
  it("recognises publish + search", () => {
    expect(parseNugetPath("v3/publish")).toEqual({ kind: "publish" });
    expect(parseNugetPath("v3/search")).toEqual({ kind: "search" });
  });
  it("recognises flat-version-index", () => {
    expect(parseNugetPath("v3/flat2/Foo/index.json")).toEqual({
      kind: "flat-version-index",
      id: "foo",
    });
  });
  it("recognises flat-nupkg", () => {
    expect(parseNugetPath("v3/flat2/Foo/1.2.3/foo.1.2.3.nupkg")).toEqual({
      kind: "flat-nupkg",
      id: "foo",
      version: "1.2.3",
    });
  });
  it("recognises flat-nuspec", () => {
    expect(parseNugetPath("v3/flat2/Foo/1.2.3/foo.nuspec")).toEqual({
      kind: "flat-nuspec",
      id: "foo",
      version: "1.2.3",
    });
  });
  it("recognises registration-index (semver1)", () => {
    expect(parseNugetPath("v3/registration5-semver1/Foo/index.json")).toEqual({
      kind: "registration-index",
      id: "foo",
    });
  });
  it("recognises registration-leaf (semver1)", () => {
    expect(parseNugetPath("v3/registration5-semver1/Foo/1.0.0.json")).toEqual({
      kind: "registration-leaf",
      id: "foo",
      version: "1.0.0",
    });
  });
  it("recognises registration paths (semver2)", () => {
    expect(parseNugetPath("v3/registration5-semver2/Foo/index.json")).toEqual({
      kind: "registration-index",
      id: "foo",
    });
  });
  it("returns null for unknown shapes", () => {
    expect(parseNugetPath("nothing-at-all")).toBeNull();
    expect(parseNugetPath("v3/unknown-resource")).toBeNull();
  });
  it("rejects flat-container filename mismatch", () => {
    expectNugetError(
      () => parseNugetPath("v3/flat2/Foo/1.2.3/wrong-name.nupkg"),
      NUGET_ERROR_CODES.RESOURCE_NOT_FOUND,
    );
  });
  it("rejects leading slash", () => {
    expect(parseNugetPath("/v3/index.json")).toBeNull();
  });
});

describe("nugetManifestName / parseNugetManifestName", () => {
  it("composes manifest name", () => {
    expect(nugetManifestName("acme", "Newtonsoft.Json")).toBe(
      "nuget/acme/newtonsoft.json",
    );
  });
  it("round-trips", () => {
    expect(parseNugetManifestName("nuget/acme/newtonsoft.json")).toEqual({
      org: "acme",
      id: "newtonsoft.json",
    });
  });
  it("rejects non-nuget prefix", () => {
    expect(parseNugetManifestName("maven/acme/foo")).toBeNull();
    expect(parseNugetManifestName("acme/foo")).toBeNull();
  });
  it("rejects malformed shapes", () => {
    expect(parseNugetManifestName("nuget/acme")).toBeNull();
    expect(parseNugetManifestName("nuget/acme/foo/bar")).toBeNull();
  });
});

describe("nugetManifestVersion", () => {
  it("normalises", () => {
    expect(nugetManifestVersion("1.0.0")).toBe("1.0.0");
    expect(nugetManifestVersion("1.0.0.0")).toBe("1.0.0");
    expect(nugetManifestVersion("1.0.0-Alpha")).toBe("1.0.0-alpha");
  });
  it("rejects invalid versions", () => {
    expectNugetError(
      () => nugetManifestVersion("not-semver"),
      NUGET_ERROR_CODES.VERSION_INVALID,
    );
  });
});
