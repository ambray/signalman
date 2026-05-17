// WS13 M1 — PyPI path / name / filename parsers + HTTP helpers.

import { describe, expect, it } from "vitest";
import {
  classifyFiletype,
  negotiateSimpleFormat,
  normalisePypiName,
  parsePypiManifestName,
  parseSdistFilename,
  parseWheelFilename,
  PYPI_ERROR_CODES,
  PypiError,
  pypiFilePath,
  pypiManifestName,
  renderPackageHtml,
  renderRootHtml,
  validatePypiVersion,
} from "../pypi/index.js";

function expectPypiError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(PypiError);
  expect((caught as PypiError).code).toBe(code);
}

describe("normalisePypiName (PEP 503)", () => {
  it("lowercases + collapses [-_.]+", () => {
    expect(normalisePypiName("Foo_Bar.baz")).toBe("foo-bar-baz");
    expect(normalisePypiName("FOO__BAR.BAZ")).toBe("foo-bar-baz");
    expect(normalisePypiName("foo---bar")).toBe("foo-bar");
    expect(normalisePypiName("requests")).toBe("requests");
  });

  it("rejects empty + non-string inputs", () => {
    expectPypiError(() => normalisePypiName(""), PYPI_ERROR_CODES.NAME_INVALID);
    expectPypiError(
      () => normalisePypiName(undefined as unknown as string),
      PYPI_ERROR_CODES.NAME_INVALID,
    );
    expectPypiError(
      () => normalisePypiName(42 as unknown as string),
      PYPI_ERROR_CODES.NAME_INVALID,
    );
  });

  it("rejects names with characters outside [A-Za-z0-9._-]", () => {
    expectPypiError(() => normalisePypiName("foo bar"), PYPI_ERROR_CODES.NAME_INVALID);
    expectPypiError(() => normalisePypiName("foo/bar"), PYPI_ERROR_CODES.NAME_INVALID);
    expectPypiError(() => normalisePypiName("foo@bar"), PYPI_ERROR_CODES.NAME_INVALID);
  });

  it("rejects names with leading or trailing separators (after normalisation)", () => {
    expectPypiError(() => normalisePypiName("_foo"), PYPI_ERROR_CODES.NAME_INVALID);
    expectPypiError(() => normalisePypiName("foo_"), PYPI_ERROR_CODES.NAME_INVALID);
    expectPypiError(() => normalisePypiName("-foo"), PYPI_ERROR_CODES.NAME_INVALID);
  });

  it("rejects names > 100 chars", () => {
    const long = "a".repeat(101);
    expectPypiError(() => normalisePypiName(long), PYPI_ERROR_CODES.NAME_INVALID);
  });
});

describe("validatePypiVersion", () => {
  it("accepts canonical PEP 440 forms", () => {
    expect(() => validatePypiVersion("1.0.0")).not.toThrow();
    expect(() => validatePypiVersion("1.0.0a1")).not.toThrow();
    expect(() => validatePypiVersion("1.0.0.post1")).not.toThrow();
    expect(() => validatePypiVersion("1!2.3.4")).not.toThrow();
    expect(() => validatePypiVersion("1.0.0+local.id-123")).not.toThrow();
  });

  it("rejects empty + non-string", () => {
    expectPypiError(() => validatePypiVersion(""), PYPI_ERROR_CODES.VERSION_INVALID);
    expectPypiError(
      () => validatePypiVersion(undefined as unknown as string),
      PYPI_ERROR_CODES.VERSION_INVALID,
    );
  });

  it("rejects whitespace, slashes, and control chars", () => {
    expectPypiError(() => validatePypiVersion("1 0"), PYPI_ERROR_CODES.VERSION_INVALID);
    expectPypiError(() => validatePypiVersion("1/0"), PYPI_ERROR_CODES.VERSION_INVALID);
    expectPypiError(() => validatePypiVersion("1\n0"), PYPI_ERROR_CODES.VERSION_INVALID);
  });

  it("rejects '..' traversal", () => {
    expectPypiError(() => validatePypiVersion("1..0"), PYPI_ERROR_CODES.VERSION_INVALID);
  });

  it("rejects > 128 char versions", () => {
    expectPypiError(
      () => validatePypiVersion("1." + "0".repeat(128)),
      PYPI_ERROR_CODES.VERSION_INVALID,
    );
  });
});

describe("parseWheelFilename (PEP 491)", () => {
  it("parses a canonical wheel filename", () => {
    const w = parseWheelFilename("requests-2.28.1-py3-none-any.whl");
    expect(w.distribution).toBe("requests");
    expect(w.version).toBe("2.28.1");
    expect(w.pythonTag).toBe("py3");
    expect(w.abiTag).toBe("none");
    expect(w.platformTag).toBe("any");
    expect(w.build).toBeUndefined();
  });

  it("parses a wheel with a build tag", () => {
    const w = parseWheelFilename("pkg-1.0-1-cp310-cp310-linux_x86_64.whl");
    expect(w.build).toBe("1");
    expect(w.pythonTag).toBe("cp310");
    expect(w.platformTag).toBe("linux_x86_64");
  });

  it("rejects non-wheel filenames", () => {
    expectPypiError(
      () => parseWheelFilename("requests-2.28.1.tar.gz"),
      PYPI_ERROR_CODES.FILENAME_INVALID,
    );
  });

  it("rejects wheel filenames with missing tags", () => {
    expectPypiError(
      () => parseWheelFilename("pkg-1.0.whl"),
      PYPI_ERROR_CODES.FILENAME_INVALID,
    );
  });
});

describe("parseSdistFilename", () => {
  it("parses .tar.gz", () => {
    const s = parseSdistFilename("requests-2.28.1.tar.gz");
    expect(s).toEqual({ distribution: "requests", version: "2.28.1" });
  });

  it("parses .zip + .tar.bz2 + .tar.xz", () => {
    expect(parseSdistFilename("pkg-1.0.zip")?.version).toBe("1.0");
    expect(parseSdistFilename("pkg-1.0.tar.bz2")?.version).toBe("1.0");
    expect(parseSdistFilename("pkg-1.0.tar.xz")?.version).toBe("1.0");
  });

  it("returns null when extension is not a sdist", () => {
    expect(parseSdistFilename("requests-2.28.1-py3-none-any.whl")).toBeNull();
    expect(parseSdistFilename("README.md")).toBeNull();
  });

  it("rejects malformed stems (no dash separator)", () => {
    expectPypiError(
      () => parseSdistFilename("nodash.tar.gz"),
      PYPI_ERROR_CODES.FILENAME_INVALID,
    );
  });
});

describe("classifyFiletype", () => {
  it("returns 'bdist_wheel' for .whl", () => {
    expect(classifyFiletype("pkg-1.0-py3-none-any.whl")).toBe("bdist_wheel");
  });

  it("returns 'sdist' for recognised sdist extensions", () => {
    expect(classifyFiletype("pkg-1.0.tar.gz")).toBe("sdist");
    expect(classifyFiletype("pkg-1.0.zip")).toBe("sdist");
  });

  it("rejects unrecognised extensions", () => {
    expectPypiError(() => classifyFiletype("pkg-1.0.exe"), PYPI_ERROR_CODES.UNSUPPORTED_FILETYPE);
  });
});

describe("pypiManifestName + parsePypiManifestName", () => {
  it("round-trips a composed name", () => {
    expect(pypiManifestName("acme", "Foo_Bar")).toBe("pypi/acme/foo-bar");
    expect(parsePypiManifestName("pypi/acme/foo-bar")).toEqual({
      org: "acme",
      packageName: "foo-bar",
    });
  });

  it("returns null when the prefix is wrong", () => {
    expect(parsePypiManifestName("cargo/acme/foo")).toBeNull();
    expect(parsePypiManifestName("oci/acme/foo")).toBeNull();
  });

  it("returns null when the package segment is missing or empty", () => {
    expect(parsePypiManifestName("pypi/acme/")).toBeNull();
    expect(parsePypiManifestName("pypi/acme")).toBeNull();
    expect(parsePypiManifestName("pypi/")).toBeNull();
  });

  it("returns null when the package contains nested slashes", () => {
    expect(parsePypiManifestName("pypi/acme/foo/bar")).toBeNull();
  });
});

describe("pypiFilePath", () => {
  it("composes a relative URL using normalised package name", () => {
    expect(pypiFilePath("acme", "Foo_Bar", "Foo_Bar-1.0.tar.gz")).toBe(
      "/pypi/acme/files/foo-bar/Foo_Bar-1.0.tar.gz",
    );
  });
});

describe("negotiateSimpleFormat (PEP 691 Accept negotiation)", () => {
  it("returns 'html' on missing Accept", () => {
    expect(negotiateSimpleFormat(undefined)).toBe("html");
    expect(negotiateSimpleFormat("")).toBe("html");
  });

  it("returns 'json' when client explicitly asks for vnd.pypi.simple.v1+json", () => {
    expect(
      negotiateSimpleFormat("application/vnd.pypi.simple.v1+json"),
    ).toBe("json");
  });

  it("returns 'html' for vnd.pypi.simple.v1+html", () => {
    expect(
      negotiateSimpleFormat("application/vnd.pypi.simple.v1+html"),
    ).toBe("html");
  });

  it("returns 'html' for text/html or application/xhtml+xml", () => {
    expect(negotiateSimpleFormat("text/html")).toBe("html");
    expect(negotiateSimpleFormat("application/xhtml+xml")).toBe("html");
  });

  it("returns 'json' when the only Accept token is */*", () => {
    expect(negotiateSimpleFormat("*/*")).toBe("json");
  });

  it("returns 'html' when */* coexists with text/html (old pip pattern)", () => {
    expect(negotiateSimpleFormat("text/html, */*")).toBe("html");
  });

  it("strips q-params before matching", () => {
    expect(
      negotiateSimpleFormat("application/vnd.pypi.simple.v1+json; q=0.9, */*"),
    ).toBe("json");
  });
});

describe("renderPackageHtml (PEP 503)", () => {
  it("renders the canonical link list", () => {
    const html = renderPackageHtml("requests", [
      {
        filename: "requests-2.28.1.tar.gz",
        url: "/pypi/acme/files/requests/requests-2.28.1.tar.gz",
        sha256: "a".repeat(64),
      },
    ]);
    expect(html).toContain("<title>Links for requests</title>");
    expect(html).toContain(
      `href="/pypi/acme/files/requests/requests-2.28.1.tar.gz#sha256=${"a".repeat(64)}"`,
    );
    expect(html).toContain(`pypi:repository-version`);
  });

  it("includes data-requires-python when present", () => {
    const html = renderPackageHtml("pkg", [
      {
        filename: "pkg-1.0-py3-none-any.whl",
        url: "/url",
        sha256: "b".repeat(64),
        requires_python: ">=3.8",
      },
    ]);
    expect(html).toContain(`data-requires-python="&gt;=3.8"`);
  });

  it("includes data-yanked when truthy", () => {
    const reason = renderPackageHtml("pkg", [
      {
        filename: "pkg-1.0.tar.gz",
        url: "/u",
        sha256: "c".repeat(64),
        yanked: "security",
      },
    ]);
    expect(reason).toContain(`data-yanked="security"`);

    const flag = renderPackageHtml("pkg", [
      {
        filename: "pkg-1.1.tar.gz",
        url: "/u",
        sha256: "d".repeat(64),
        yanked: true,
      },
    ]);
    expect(flag).toContain(`data-yanked=""`);
  });

  it("escapes HTML / attribute characters in filenames + URLs", () => {
    const html = renderPackageHtml('pkg"&<>', [
      {
        filename: "weird<&>.tar.gz",
        url: '/u?q="x"',
        sha256: "e".repeat(64),
      },
    ]);
    // The escapeHtml function only replaces &, <, >, so " in filename is kept;
    // attribute escaping does encode " into &quot;.
    expect(html).toContain("&lt;&amp;&gt;.tar.gz");
    expect(html).toContain(`href="/u?q=&quot;x&quot;`);
  });
});

describe("renderRootHtml", () => {
  it("renders a project list", () => {
    const html = renderRootHtml(["requests", "django", "numpy"]);
    expect(html).toContain("<title>Simple Index</title>");
    expect(html).toContain(`<a href="./requests/">requests</a>`);
    expect(html).toContain(`<a href="./django/">django</a>`);
    expect(html).toContain(`<a href="./numpy/">numpy</a>`);
  });

  it("emits an empty list correctly", () => {
    const html = renderRootHtml([]);
    expect(html).toContain("<title>Simple Index</title>");
    expect(html).toContain("<body>");
  });
});
