/**
 * Tests for signalman.build.yaml parsing, validation, and variable
 * substitution.
 */

import { describe, expect, it } from "vitest";
import {
  BuildYamlValidationError,
  UnknownBuildVariableError,
  substituteComponent,
  substituteVariables,
  validateBuildYaml,
  type BuildVariables,
} from "../control-plane/build/yaml.js";
import { buildManifest, hashManifest } from "../control-plane/build/manifest.js";

const validYaml = {
  schema_version: 1,
  components: [
    {
      name: "agent_service",
      build: { cwd: "agent", command: "cargo", args: ["build", "--release"] },
      artifacts: [{ kind: "blob", path: "agent/target/release/example-agent.exe" }],
    },
    {
      name: "backend",
      build: { cwd: "backend", command: "docker", args: ["build", "-t", "x:${TAG}", "."] },
      artifacts: [{ kind: "image_ref", ref: "x:${TAG}" }],
    },
  ],
  verification: {
    smoke: ["example-agent-service"],
  },
};

const vars: BuildVariables = {
  TAG: "v1.2.3",
  COMMIT_SHA: "abc1234deadbeef0000000000000000000000000",
  COMMIT_SHORT: "abc1234",
};

describe("validateBuildYaml", () => {
  it("accepts a fully populated valid document", () => {
    const out = validateBuildYaml(validYaml);
    expect(out.components).toHaveLength(2);
    expect(out.verification?.smoke).toEqual(["example-agent-service"]);
  });

  it("rejects an unknown schema_version", () => {
    expect(() =>
      validateBuildYaml({ ...validYaml, schema_version: 2 }),
    ).toThrow(BuildYamlValidationError);
  });

  it("rejects components with duplicate names", () => {
    const bad = {
      ...validYaml,
      components: [validYaml.components[0], { ...validYaml.components[0] }],
    };
    expect(() => validateBuildYaml(bad)).toThrow(/duplicate component name/);
  });

  it("rejects a component with zero artifacts", () => {
    const bad = {
      ...validYaml,
      components: [{ ...validYaml.components[0], artifacts: [] }],
    };
    expect(() => validateBuildYaml(bad)).toThrow(/at least one artifact/);
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    expect(() =>
      validateBuildYaml({ ...validYaml, surprise: true }),
    ).toThrow(BuildYamlValidationError);
  });

  it("rejects an unknown component name format", () => {
    const bad = {
      ...validYaml,
      components: [{ ...validYaml.components[0], name: "BadName!" }],
    };
    expect(() => validateBuildYaml(bad)).toThrow(BuildYamlValidationError);
  });

  it("rejects an artifact with unknown kind", () => {
    const bad = {
      ...validYaml,
      components: [
        {
          ...validYaml.components[0],
          artifacts: [{ kind: "bogus", path: "x" }],
        },
      ],
    };
    expect(() => validateBuildYaml(bad)).toThrow(BuildYamlValidationError);
  });
});

describe("substituteVariables", () => {
  it("substitutes known variables", () => {
    expect(substituteVariables("hello-${TAG}", vars)).toBe("hello-v1.2.3");
    expect(substituteVariables("${COMMIT_SHORT}", vars)).toBe("abc1234");
  });

  it("returns input unchanged when no placeholders", () => {
    expect(substituteVariables("plain", vars)).toBe("plain");
  });

  it("throws UnknownBuildVariableError on unknown vars", () => {
    expect(() => substituteVariables("${MYSTERY}", vars)).toThrow(
      UnknownBuildVariableError,
    );
  });

  it("substitutes multiple occurrences in one string", () => {
    expect(substituteVariables("${TAG}-${TAG}", vars)).toBe("v1.2.3-v1.2.3");
  });
});

describe("substituteComponent", () => {
  it("substitutes build args and artifact refs", () => {
    const valid = validateBuildYaml(validYaml);
    const backend = substituteComponent(valid.components[1], vars);
    expect(backend.build.args).toEqual(["build", "-t", "x:v1.2.3", "."]);
    expect(backend.artifacts).toEqual([{ kind: "image_ref", ref: "x:v1.2.3" }]);
  });

  it("substitutes blob artifact path + produce", () => {
    const valid = validateBuildYaml({
      schema_version: 1,
      components: [
        {
          name: "dashboard",
          build: { command: "npm", args: ["run", "build"] },
          artifacts: [
            {
              kind: "blob",
              path: "dashboard/dist-${TAG}.tar.gz",
              produce: "tar -czf dashboard/dist-${TAG}.tar.gz dashboard/dist",
            },
          ],
        },
      ],
    });
    const out = substituteComponent(valid.components[0], vars);
    expect(out.artifacts[0]).toEqual({
      kind: "blob",
      path: "dashboard/dist-v1.2.3.tar.gz",
      produce: "tar -czf dashboard/dist-v1.2.3.tar.gz dashboard/dist",
    });
  });

  it("leaves the original component untouched", () => {
    const valid = validateBuildYaml(validYaml);
    const before = JSON.stringify(valid.components[1]);
    substituteComponent(valid.components[1], vars);
    expect(JSON.stringify(valid.components[1])).toBe(before);
  });
});

describe("buildManifest + hashManifest", () => {
  it("is deterministic across runs with the same inputs", () => {
    const m1 = buildManifest({
      product: "example",
      tag: "v1",
      commitSha: "abc",
      entries: [
        { component: "agent", kind: "blob", sha256: "a".repeat(64) },
        { component: "backend", kind: "image_ref", image_ref: "x:v1" },
      ],
    });
    const m2 = buildManifest({
      product: "example",
      tag: "v1",
      commitSha: "abc",
      // Different declaration order — should still produce the same hash.
      entries: [
        { component: "backend", kind: "image_ref", image_ref: "x:v1" },
        { component: "agent", kind: "blob", sha256: "a".repeat(64) },
      ],
    });
    expect(hashManifest(m1)).toBe(hashManifest(m2));
  });

  it("changes when an artifact sha changes", () => {
    const a = buildManifest({
      product: "p",
      tag: "v",
      commitSha: "c",
      entries: [{ component: "x", kind: "blob", sha256: "a".repeat(64) }],
    });
    const b = buildManifest({
      product: "p",
      tag: "v",
      commitSha: "c",
      entries: [{ component: "x", kind: "blob", sha256: "b".repeat(64) }],
    });
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });

  it("changes when commitSha changes", () => {
    const a = buildManifest({
      product: "p",
      tag: "v",
      commitSha: "c1",
      entries: [{ component: "x", kind: "image_ref", image_ref: "i:v" }],
    });
    const b = buildManifest({
      product: "p",
      tag: "v",
      commitSha: "c2",
      entries: [{ component: "x", kind: "image_ref", image_ref: "i:v" }],
    });
    expect(hashManifest(a)).not.toBe(hashManifest(b));
  });
});
