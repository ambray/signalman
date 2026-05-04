import { describe, it, expect } from "vitest";
import {
  validateScenarioConfig,
  validateAssertionConfig,
  ScenarioValidationError,
  scenarioConfigSchema,
  vmConfigSchema,
  kernelDebugConfigSchema,
} from "../scenarios/schema.js";

// ─── minimal valid fixture ─────────────────────────────────────────

function validScenario() {
  return {
    name: "Smoke",
    version: "1.0",
    tags: ["smoke"],
    vms: [
      {
        name: "endpoint-1",
        template: "win11",
        guest_agent_port: 50051,
      },
    ],
  };
}

// ─── scenarioConfigSchema — acceptance ─────────────────────────────

describe("validateScenarioConfig — happy paths", () => {
  it("accepts a minimal valid config", () => {
    const r = validateScenarioConfig(validScenario(), "setup.yaml");
    expect(r.name).toBe("Smoke");
    expect(r.vms.length).toBe(1);
  });

  it("defaults missing setup / teardown / checkpoints", () => {
    const r = validateScenarioConfig(validScenario(), "setup.yaml");
    expect(r.setup).toEqual([]);
    expect(r.teardown).toEqual([]);
    expect(r.checkpoints).toEqual({});
  });

  it("preserves tags when provided", () => {
    const r = validateScenarioConfig(
      { ...validScenario(), tags: ["driver", "smoke"] },
      "setup.yaml",
    );
    expect(r.tags).toEqual(["driver", "smoke"]);
  });

  it("allows unknown top-level fields (.passthrough)", () => {
    const r = validateScenarioConfig(
      { ...validScenario(), future_field: "experimental" },
      "setup.yaml",
    ) as Record<string, unknown>;
    expect(r.future_field).toBe("experimental");
  });

  it("accepts a VM with network block", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        vms: [
          {
            name: "endpoint-1",
            template: "win11",
            guest_agent_port: 50051,
            network: { switch: "RevnTestSwitch", static_ip: "172.30.0.10" },
          },
        ],
      },
      "setup.yaml",
    );
    expect(r.vms[0].network?.switch).toBe("RevnTestSwitch");
  });

  it("accepts a VM with checkpoint_restore", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        vms: [
          {
            name: "endpoint-1",
            template: "win11",
            guest_agent_port: 50051,
            checkpoint_restore: "debug-enabled",
          },
        ],
      },
      "setup.yaml",
    );
    expect(r.vms[0].checkpoint_restore).toBe("debug-enabled");
  });

  it("accepts a VM with kernel_debug enabled", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        vms: [
          {
            name: "endpoint-1",
            template: "win11",
            guest_agent_port: 50051,
            kernel_debug: {
              enabled: true,
              transport: "serial",
              pipe: "\\\\.\\pipe\\kd-{vm_name}",
              break_on_load: ["ospiri.sys"],
              break_on_bugcheck: true,
              symbol_path: "srv*C:\\Symbols",
            },
          },
        ],
      },
      "setup.yaml",
    );
    expect(r.vms[0].kernel_debug?.enabled).toBe(true);
    expect(r.vms[0].kernel_debug?.break_on_load).toEqual(["ospiri.sys"]);
  });

  it("accepts kernel_debug: enabled alone", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        vms: [
          {
            name: "endpoint-1",
            template: "win11",
            guest_agent_port: 50051,
            kernel_debug: { enabled: false },
          },
        ],
      },
      "setup.yaml",
    );
    expect(r.vms[0].kernel_debug?.enabled).toBe(false);
  });

  it("accepts setup + teardown step arrays", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        setup: [{ action: "vm_run_command", vm: "endpoint-1" }],
        teardown: [{ action: "vm_restore", checkpoint: "clean" }],
      },
      "setup.yaml",
    );
    expect(r.setup.length).toBe(1);
    expect(r.teardown.length).toBe(1);
    expect(r.setup[0].action).toBe("vm_run_command");
  });

  it("accepts multi-VM scenarios", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        vms: [
          { name: "a", template: "win11", guest_agent_port: 50051 },
          { name: "b", template: "win11", guest_agent_port: 50052 },
        ],
      },
      "setup.yaml",
    );
    expect(r.vms.length).toBe(2);
  });

  it("accepts sandbox_modes when present", () => {
    const r = validateScenarioConfig(
      { ...validScenario(), sandbox_modes: ["v1", "v2"] },
      "setup.yaml",
    );
    expect(r.sandbox_modes).toEqual(["v1", "v2"]);
  });

  // Runtime guard blocks: schema accepts the declarative shape; the
  // orchestrator tests pin enforcement behavior.
  it("accepts the capabilities block", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        capabilities: {
          hosts: ["endpoint-1"],
          networks: ["RevnTestSwitch"],
          host_paths: { read: ["./artifacts/**"], write: [] },
        },
      },
      "setup.yaml",
    );
    expect(r.capabilities?.hosts).toEqual(["endpoint-1"]);
  });

  it("accepts the parameters block (free-form values)", () => {
    const r = validateScenarioConfig(
      {
        ...validScenario(),
        parameters: {
          api_key: "${secret:OSPIRI_API_KEY}",
          endpoint: "${param:endpoint:-https://default.example}",
          retries: 3,
        },
      },
      "setup.yaml",
    );
    expect(r.parameters).toBeDefined();
    expect((r.parameters as Record<string, unknown>).api_key).toBe(
      "${secret:OSPIRI_API_KEY}",
    );
  });
});

// ─── scenarioConfigSchema — rejection ──────────────────────────────

describe("validateScenarioConfig — validation errors", () => {
  it("rejects a config missing name", () => {
    const bad = { ...validScenario() } as Partial<ReturnType<typeof validScenario>>;
    delete bad.name;
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow(
      ScenarioValidationError,
    );
  });

  it("error message names the failing path", () => {
    const bad = { ...validScenario() } as Record<string, unknown>;
    delete bad.name;
    try {
      validateScenarioConfig(bad, "setup.yaml");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioValidationError);
      if (e instanceof ScenarioValidationError) {
        expect(e.message).toContain("setup.yaml");
        expect(e.message).toContain("name");
      }
    }
  });

  it("rejects empty vms array", () => {
    expect(() =>
      validateScenarioConfig({ ...validScenario(), vms: [] }, "setup.yaml"),
    ).toThrow(/at least one VM/);
  });

  it("rejects missing version", () => {
    const bad = { ...validScenario() } as Partial<ReturnType<typeof validScenario>>;
    delete bad.version;
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow(
      /version/,
    );
  });

  it("rejects VM with empty name", () => {
    const bad = {
      ...validScenario(),
      vms: [{ name: "", template: "win11", guest_agent_port: 50051 }],
    };
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow(
      /VM name/,
    );
  });

  it("rejects VM with non-integer guest_agent_port", () => {
    const bad = {
      ...validScenario(),
      vms: [
        { name: "x", template: "win11", guest_agent_port: 50051.5 },
      ],
    };
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow();
  });

  it("rejects VM with out-of-range port", () => {
    const bad = {
      ...validScenario(),
      vms: [{ name: "x", template: "win11", guest_agent_port: 0 }],
    };
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow();
  });

  it("rejects kernel_debug.enabled as a string (not boolean)", () => {
    const bad = {
      ...validScenario(),
      vms: [
        {
          name: "endpoint-1",
          template: "win11",
          guest_agent_port: 50051,
          kernel_debug: { enabled: "yes" },
        },
      ],
    };
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow();
  });

  it("rejects kernel_debug.break_on_load as a bare string", () => {
    const bad = {
      ...validScenario(),
      vms: [
        {
          name: "endpoint-1",
          template: "win11",
          guest_agent_port: 50051,
          kernel_debug: { enabled: true, break_on_load: "ospiri.sys" },
        },
      ],
    };
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow();
  });

  it("rejects kernel_debug.transport with unknown value", () => {
    const bad = {
      ...validScenario(),
      vms: [
        {
          name: "endpoint-1",
          template: "win11",
          guest_agent_port: 50051,
          kernel_debug: { enabled: true, transport: "kdnet" },
        },
      ],
    };
    expect(() => validateScenarioConfig(bad, "setup.yaml")).toThrow();
  });

  it("reports multiple issues in a single error", () => {
    const bad: Record<string, unknown> = {};  // missing everything
    try {
      validateScenarioConfig(bad, "setup.yaml");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioValidationError);
      if (e instanceof ScenarioValidationError) {
        expect(e.issues.length).toBeGreaterThanOrEqual(3);
        // name, version, vms all missing
        const paths = e.issues.map((i) => i.path);
        expect(paths).toContain("name");
        expect(paths).toContain("version");
        expect(paths).toContain("vms");
      }
    }
  });

  it("nested error paths identify the exact field", () => {
    const bad = {
      ...validScenario(),
      vms: [
        {
          name: "x",
          template: "win11",
          guest_agent_port: 50051,
          kernel_debug: { enabled: "nope" },
        },
      ],
    };
    try {
      validateScenarioConfig(bad, "setup.yaml");
      expect.fail();
    } catch (e) {
      if (e instanceof ScenarioValidationError) {
        const issue = e.issues.find((i) => i.path.includes("enabled"));
        expect(issue?.path).toBe("vms.0.kernel_debug.enabled");
      }
    }
  });
});

// ─── assertionConfigSchema ────────────────────────────────────────

describe("validateAssertionConfig", () => {
  it("accepts an empty assertions file", () => {
    const r = validateAssertionConfig({ assertions: [] }, "assertions.yaml");
    expect(r.assertions).toEqual([]);
    expect(r.pass_threshold).toBe(1.0);
    expect(r.critical_must_pass).toBe(true);
  });

  it("accepts a realistic assertions file", () => {
    const r = validateAssertionConfig(
      {
        assertions: [
          {
            id: "service-exists",
            type: "json_field",
            source: "step-0",
            field: "Exists",
            expected: true,
          },
        ],
        pass_threshold: 0.8,
        critical_must_pass: true,
      },
      "assertions.yaml",
    );
    expect(r.assertions.length).toBe(1);
    expect(r.pass_threshold).toBe(0.8);
  });

  it("rejects pass_threshold > 1", () => {
    expect(() =>
      validateAssertionConfig(
        { assertions: [], pass_threshold: 2 },
        "assertions.yaml",
      ),
    ).toThrow();
  });

  it("rejects pass_threshold < 0", () => {
    expect(() =>
      validateAssertionConfig(
        { assertions: [], pass_threshold: -0.1 },
        "assertions.yaml",
      ),
    ).toThrow();
  });

  it("allows unknown top-level fields (.passthrough)", () => {
    const r = validateAssertionConfig(
      { assertions: [], experimental: true },
      "assertions.yaml",
    ) as Record<string, unknown>;
    expect(r.experimental).toBe(true);
  });
});

// ─── direct schema access (for composition in other loaders) ───────

describe("exported zod schemas", () => {
  it("vmConfigSchema parses a standalone VM config", () => {
    const parsed = vmConfigSchema.parse({
      name: "x",
      template: "win11",
      guest_agent_port: 50051,
    });
    expect(parsed.name).toBe("x");
  });

  it("vmConfigSchema defaults warm_checkpoint to true", () => {
    // P2 follow-up: warm-checkpoint is opt-out, not opt-in. Scenarios
    // that don't set the field inherit the fast restore semantics.
    const parsed = vmConfigSchema.parse({
      name: "x",
      template: "win11",
      guest_agent_port: 50051,
    });
    expect(parsed.warm_checkpoint).toBe(true);
  });

  it("vmConfigSchema accepts warm_checkpoint: false (explicit opt-out)", () => {
    const parsed = vmConfigSchema.parse({
      name: "x",
      template: "win11",
      guest_agent_port: 50051,
      warm_checkpoint: false,
    });
    expect(parsed.warm_checkpoint).toBe(false);
  });

  it("kernelDebugConfigSchema parses a standalone kernel_debug", () => {
    const parsed = kernelDebugConfigSchema.parse({
      enabled: true,
      break_on_bugcheck: false,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.break_on_bugcheck).toBe(false);
  });

  it("scenarioConfigSchema is exported for composition", () => {
    const r = scenarioConfigSchema.safeParse(validScenario());
    expect(r.success).toBe(true);
  });
});

// ─── error envelope API ────────────────────────────────────────────

describe("ScenarioValidationError shape", () => {
  it("carries filePath", () => {
    try {
      validateScenarioConfig({}, "/tmp/fixture.yaml");
      expect.fail();
    } catch (e) {
      if (e instanceof ScenarioValidationError) {
        expect(e.filePath).toBe("/tmp/fixture.yaml");
      }
    }
  });

  it("carries structured issues", () => {
    try {
      validateScenarioConfig({}, "f.yaml");
      expect.fail();
    } catch (e) {
      if (e instanceof ScenarioValidationError) {
        expect(Array.isArray(e.issues)).toBe(true);
        for (const issue of e.issues) {
          expect(typeof issue.path).toBe("string");
          expect(typeof issue.message).toBe("string");
        }
      }
    }
  });

  it("error name is stable", () => {
    try {
      validateScenarioConfig({}, "x");
      expect.fail();
    } catch (e) {
      if (e instanceof ScenarioValidationError) {
        expect(e.name).toBe("ScenarioValidationError");
      }
    }
  });
});
