// WS13 M4 — HF path / manifest-name composers + parsers.

import { describe, expect, it } from "vitest";
import {
  HF_ERROR_CODES,
  HfError,
  composeHfBlobPath,
  composeHfResolvePath,
  hfManifestName,
  hfManifestVersion,
  parseHfBlobPath,
  parseHfManifestName,
  parseHfManifestVersion,
  parseHfResolvePath,
  parseLfsOid,
  validateHexSha256,
  validateHfOrgName,
  validateHfPath,
  validateHfRepoName,
  validateHfRepoType,
  validateHfRevision,
} from "../hf/index.js";

function expectHfError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HfError);
  expect((caught as HfError).code).toBe(code);
}

describe("validateHfOrgName", () => {
  it("accepts normal org names", () => {
    validateHfOrgName("acme");
    validateHfOrgName("acme-co");
    validateHfOrgName("acme_co");
    validateHfOrgName("acme.co");
    validateHfOrgName("a");
  });
  it("rejects empty / null", () => {
    expectHfError(() => validateHfOrgName(""), HF_ERROR_CODES.ORG_INVALID);
    expectHfError(
      () => validateHfOrgName(null as unknown as string),
      HF_ERROR_CODES.ORG_INVALID,
    );
  });
  it("rejects uppercase + bad chars", () => {
    expectHfError(() => validateHfOrgName("Acme"), HF_ERROR_CODES.ORG_INVALID);
    expectHfError(() => validateHfOrgName("acme/co"), HF_ERROR_CODES.ORG_INVALID);
    expectHfError(() => validateHfOrgName("acme co"), HF_ERROR_CODES.ORG_INVALID);
  });
  it("rejects '..'", () => {
    expectHfError(() => validateHfOrgName("a..b"), HF_ERROR_CODES.ORG_INVALID);
  });
  it("rejects oversize", () => {
    expectHfError(
      () => validateHfOrgName("a".repeat(64)),
      HF_ERROR_CODES.ORG_INVALID,
    );
  });
});

describe("validateHfRepoName", () => {
  it("accepts mixed-case + dot/underscore/dash", () => {
    validateHfRepoName("bert-base-uncased");
    validateHfRepoName("BERT_uncased");
    validateHfRepoName("model.v1");
  });
  it("rejects empty / bad chars / leading symbol", () => {
    expectHfError(() => validateHfRepoName(""), HF_ERROR_CODES.REPO_INVALID);
    expectHfError(() => validateHfRepoName("/foo"), HF_ERROR_CODES.REPO_INVALID);
    expectHfError(() => validateHfRepoName(".hidden"), HF_ERROR_CODES.REPO_INVALID);
    expectHfError(() => validateHfRepoName("a..b"), HF_ERROR_CODES.REPO_INVALID);
  });
  it("rejects non-string + oversize", () => {
    expectHfError(
      () => validateHfRepoName(123 as unknown as string),
      HF_ERROR_CODES.REPO_INVALID,
    );
    expectHfError(
      () => validateHfRepoName("a".repeat(100)),
      HF_ERROR_CODES.REPO_INVALID,
    );
  });
});

describe("validateHfRepoType", () => {
  it("accepts the three canonical types", () => {
    validateHfRepoType("model");
    validateHfRepoType("dataset");
    validateHfRepoType("space");
  });
  it("rejects unknown types", () => {
    expectHfError(
      () => validateHfRepoType("bogus"),
      HF_ERROR_CODES.REPO_TYPE_INVALID,
    );
    expectHfError(
      () => validateHfRepoType("Model"),
      HF_ERROR_CODES.REPO_TYPE_INVALID,
    );
  });
});

describe("validateHfRevision", () => {
  it("accepts SHA-shaped + branch + tag", () => {
    validateHfRevision("main");
    validateHfRevision("v1.2.3");
    validateHfRevision("a".repeat(40)); // git sha
    validateHfRevision("release_2026-05-17");
  });
  it("rejects empty + bad chars + '..'", () => {
    expectHfError(() => validateHfRevision(""), HF_ERROR_CODES.REVISION_INVALID);
    expectHfError(
      () => validateHfRevision("v1/2"),
      HF_ERROR_CODES.REVISION_INVALID,
    );
    expectHfError(
      () => validateHfRevision("v1 2"),
      HF_ERROR_CODES.REVISION_INVALID,
    );
    expectHfError(
      () => validateHfRevision("a..b"),
      HF_ERROR_CODES.REVISION_INVALID,
    );
  });
});

describe("validateHfPath", () => {
  it("normalises and accepts POSIX paths", () => {
    expect(validateHfPath("config.json")).toBe("config.json");
    expect(validateHfPath("weights/model.bin")).toBe("weights/model.bin");
    expect(validateHfPath("./config.json")).toBe("config.json");
    expect(validateHfPath("a//b/c")).toBe("a/b/c");
  });
  it("rejects empty / absolute / trailing slash", () => {
    expectHfError(() => validateHfPath(""), HF_ERROR_CODES.PATH_INVALID);
    expectHfError(() => validateHfPath("/foo"), HF_ERROR_CODES.PATH_INVALID);
    expectHfError(() => validateHfPath("foo/"), HF_ERROR_CODES.PATH_INVALID);
  });
  it("rejects '..' traversal", () => {
    expectHfError(() => validateHfPath("../foo"), HF_ERROR_CODES.PATH_INVALID);
    expectHfError(() => validateHfPath("a/../b"), HF_ERROR_CODES.PATH_INVALID);
    expectHfError(() => validateHfPath(".."), HF_ERROR_CODES.PATH_INVALID);
  });
  it("rejects NUL / control / backslash", () => {
    expectHfError(() => validateHfPath("a\0b"), HF_ERROR_CODES.PATH_INVALID);
    expectHfError(() => validateHfPath("a\x01b"), HF_ERROR_CODES.PATH_INVALID);
    expectHfError(() => validateHfPath("a\\b"), HF_ERROR_CODES.PATH_INVALID);
  });
  it("rejects oversize + non-string", () => {
    expectHfError(
      () => validateHfPath("a".repeat(1025)),
      HF_ERROR_CODES.PATH_INVALID,
    );
    expectHfError(
      () => validateHfPath(null as unknown as string),
      HF_ERROR_CODES.PATH_INVALID,
    );
  });
  it("rejects paths that collapse to empty", () => {
    expectHfError(() => validateHfPath("./"), HF_ERROR_CODES.PATH_INVALID);
  });
});

describe("parseLfsOid", () => {
  it("accepts canonical sha256:<hex>", () => {
    const hex = "a".repeat(64);
    expect(parseLfsOid(`sha256:${hex}`)).toBe(hex);
  });
  it("rejects empty / malformed / wrong-algo", () => {
    expectHfError(() => parseLfsOid(""), HF_ERROR_CODES.OID_INVALID);
    expectHfError(
      () => parseLfsOid(`sha512:${"a".repeat(128)}`),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () => parseLfsOid("sha256:tooshort"),
      HF_ERROR_CODES.OID_INVALID,
    );
    expectHfError(
      () => parseLfsOid("sha256:" + "A".repeat(64)),
      HF_ERROR_CODES.OID_INVALID,
    );
  });
});

describe("validateHexSha256", () => {
  it("accepts a 64-char lowercase hex string", () => {
    validateHexSha256("0".repeat(64));
    validateHexSha256("a".repeat(64));
  });
  it("rejects wrong length / non-hex / uppercase", () => {
    expectHfError(() => validateHexSha256(""), HF_ERROR_CODES.OID_INVALID);
    expectHfError(() => validateHexSha256("xyz"), HF_ERROR_CODES.OID_INVALID);
    expectHfError(
      () => validateHexSha256("A".repeat(64)),
      HF_ERROR_CODES.OID_INVALID,
    );
  });
});

describe("hfManifestName + parseHfManifestName", () => {
  it("composes the canonical name", () => {
    expect(hfManifestName("acme", "demo", "model")).toBe("hf/acme/demo/model");
  });
  it("parses the canonical name", () => {
    expect(parseHfManifestName("hf/acme/demo/dataset")).toEqual({
      org: "acme",
      repo: "demo",
      repoType: "dataset",
    });
  });
  it("returns null on non-hf prefix / wrong shape / unknown repo_type", () => {
    expect(parseHfManifestName("foo/acme/demo/model")).toBeNull();
    expect(parseHfManifestName("hf/acme/demo")).toBeNull();
    expect(parseHfManifestName("hf/acme/demo/bogus")).toBeNull();
    expect(parseHfManifestName("hf/acme//model")).toBeNull();
  });
});

describe("hfManifestVersion + parseHfManifestVersion", () => {
  it("round-trips a (revision, path) pair", () => {
    const v = hfManifestVersion("v1", "weights/model.bin");
    expect(v).toBe("v1:weights%2Fmodel.bin");
    expect(parseHfManifestVersion(v)).toEqual({
      revision: "v1",
      path: "weights/model.bin",
    });
  });
  it("encodes a path containing the percent character literally", () => {
    const v = hfManifestVersion("v1", "weird%name.txt");
    expect(parseHfManifestVersion(v)).toEqual({
      revision: "v1",
      path: "weird%name.txt",
    });
  });
  it("rejects invalid revision + path components", () => {
    expectHfError(
      () => hfManifestVersion("bad rev", "config.json"),
      HF_ERROR_CODES.REVISION_INVALID,
    );
    expectHfError(
      () => hfManifestVersion("v1", "../oops"),
      HF_ERROR_CODES.PATH_INVALID,
    );
  });
  it("parseHfManifestVersion returns null on missing separator", () => {
    expect(parseHfManifestVersion("norevpath")).toBeNull();
    expect(parseHfManifestVersion(":no-revision")).toBeNull();
    expect(parseHfManifestVersion("v1:")).toBeNull();
  });
  it("parseHfManifestVersion returns null on bad percent-escape", () => {
    expect(parseHfManifestVersion("v1:bad%ZZescape")).toBeNull();
    expect(parseHfManifestVersion("v1:trunc%2")).toBeNull();
  });
});

describe("composeHfResolvePath + parseHfResolvePath", () => {
  it("composes the resolve path", () => {
    expect(composeHfResolvePath("v1", "config.json")).toBe("resolve/v1/config.json");
  });
  it("parses the resolve path", () => {
    expect(parseHfResolvePath("resolve/v1/config.json")).toEqual({
      revision: "v1",
      path: "config.json",
    });
    expect(parseHfResolvePath("resolve/v1/weights/model.bin")).toEqual({
      revision: "v1",
      path: "weights/model.bin",
    });
  });
  it("returns null on shape mismatches", () => {
    expect(parseHfResolvePath("other/v1/config.json")).toBeNull();
    expect(parseHfResolvePath("resolve/")).toBeNull();
    expect(parseHfResolvePath("resolve/v1/")).toBeNull();
  });
});

describe("composeHfBlobPath + parseHfBlobPath", () => {
  it("composes the blob path", () => {
    const hex = "f".repeat(64);
    expect(composeHfBlobPath(hex)).toBe(`lfs/sha256/${hex}`);
  });
  it("parses the blob path", () => {
    const hex = "f".repeat(64);
    expect(parseHfBlobPath(`lfs/sha256/${hex}`)).toEqual({ sha256: hex });
  });
  it("rejects malformed blob paths", () => {
    expect(parseHfBlobPath("lfs/sha256/short")).toBeNull();
    expect(parseHfBlobPath("lfs/sha256/" + "A".repeat(64))).toBeNull();
    expect(parseHfBlobPath("other/sha256/" + "f".repeat(64))).toBeNull();
    expectHfError(
      () => composeHfBlobPath("not-a-sha"),
      HF_ERROR_CODES.OID_INVALID,
    );
  });
});
