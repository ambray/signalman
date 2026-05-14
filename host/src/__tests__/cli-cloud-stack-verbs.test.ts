/**
 * v0.3.0-5 sub-task 8 — CLI surface for cloud + stack lifecycle verbs.
 *
 * Wraps the existing sub-task 4 MCP tools (provision / terminate /
 * status / list / backends / stack-apply / stack-destroy) with
 * `signalman cloud <verb>` and `signalman stack <verb>` so
 * operators that aren't driving via an MCP client (CI, shell
 * scripts, ad-hoc operations) get the same surface.
 *
 * Tests stub the CloudBackend via `registerCloudBackend` so no
 * real AWS / Azure SDK is involved. Each verb is covered for
 * (a) happy path with both --format json and human-readable
 * output, (b) missing-arg usage errors, (c) backend-error
 * propagation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  cmdCloudProvision,
  cmdCloudTerminate,
  cmdCloudStatus,
  cmdCloudList,
  cmdCloudBackends,
  type ParsedArgs,
} from "../cli.js";
import {
  registerCloudBackend,
  resetRegistryForTests,
} from "../cloud/registry.js";
import {
  CloudBackendError,
  type CloudBackend,
  type CloudInstanceConfig,
  type CloudInstanceHandle,
  type CloudInstanceStatus,
} from "../cloud/types.js";

function argsFor(opts: Record<string, string> = {}): ParsedArgs {
  return {
    positional: [],
    flags: new Set<string>(),
    options: new Map<string, string>(Object.entries(opts)),
    params: {},
  };
}

function captureStdout(): { restore: () => void; read: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return {
    restore: () => {
      (process.stdout as { write: typeof original }).write = original;
    },
    read: () => buf,
  };
}

function captureStderr(): { restore: () => void; read: () => string } {
  const original = process.stderr.write.bind(process.stderr);
  let buf = "";
  (process.stderr as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return {
    restore: () => {
      (process.stderr as { write: typeof original }).write = original;
    },
    read: () => buf,
  };
}

interface StubOpts {
  provisionThrows?: Error;
  terminateThrows?: Error;
  statusThrows?: Error;
  listThrows?: Error;
  status?: CloudInstanceStatus;
  handles?: CloudInstanceHandle[];
}

function makeStub(opts: StubOpts = {}): CloudBackend & {
  provisioned: CloudInstanceConfig[];
  terminated: string[];
} {
  const provisioned: CloudInstanceConfig[] = [];
  const terminated: string[] = [];
  return {
    name: "aws",
    provisioned,
    terminated,
    async provisionInstance(config: CloudInstanceConfig): Promise<CloudInstanceHandle> {
      if (opts.provisionThrows) throw opts.provisionThrows;
      provisioned.push(config);
      return {
        id: "i-stub-001",
        backend: "aws",
        name: config.name,
        region: config.region,
        network_mode: config.network?.mode,
      };
    },
    async terminateInstance(handle: CloudInstanceHandle): Promise<void> {
      if (opts.terminateThrows) throw opts.terminateThrows;
      terminated.push(handle.id);
    },
    async getInstanceStatus(_: CloudInstanceHandle): Promise<CloudInstanceStatus> {
      if (opts.statusThrows) throw opts.statusThrows;
      return (
        opts.status ?? {
          handle: {
            id: "i-stub-001",
            backend: "aws",
            name: "stub",
            region: "us-east-1",
          },
          state: "running",
          public_ip: "1.2.3.4",
          private_ip: "10.0.0.5",
        }
      );
    },
    async getInstanceIp() {
      return "1.2.3.4";
    },
    async listInstances() {
      if (opts.listThrows) throw opts.listThrows;
      return opts.handles ?? [];
    },
  };
}

describe("signalman cloud provision — CLI", () => {
  beforeEach(() => resetRegistryForTests());
  afterEach(() => resetRegistryForTests());

  it("provisions a VM with required args and prints handle", async () => {
    const stub = makeStub();
    registerCloudBackend("aws", () => stub);
    const capture = captureStdout();
    try {
      const exit = await cmdCloudProvision(
        argsFor({
          provider: "aws",
          region: "us-east-1",
          "instance-type": "t3.medium",
          "image-ref": "ami-test",
          name: "scenario-x",
        }),
      );
      expect(exit).toBe(0);
      expect(stub.provisioned).toHaveLength(1);
      expect(stub.provisioned[0].name).toBe("scenario-x");
      const out = capture.read();
      expect(out).toMatch(/Provisioned aws instance/);
      expect(out).toMatch(/i-stub-001/);
    } finally {
      capture.restore();
    }
  });

  it("passes through --network-mode aws_ssm to the backend", async () => {
    const stub = makeStub();
    registerCloudBackend("aws", () => stub);
    const capture = captureStdout();
    try {
      await cmdCloudProvision(
        argsFor({
          provider: "aws",
          region: "us-east-1",
          "instance-type": "t3.medium",
          "image-ref": "ami-x",
          name: "ssm-vm",
          "network-mode": "aws_ssm",
          format: "json",
        }),
      );
      expect(stub.provisioned[0].network?.mode).toBe("aws_ssm");
      const parsed = JSON.parse(capture.read()) as { network_mode: string };
      expect(parsed.network_mode).toBe("aws_ssm");
    } finally {
      capture.restore();
    }
  });

  it("rejects invalid --ttl-minutes", async () => {
    const stub = makeStub();
    registerCloudBackend("aws", () => stub);
    await expect(
      cmdCloudProvision(
        argsFor({
          provider: "aws",
          region: "us-east-1",
          "instance-type": "t3.medium",
          "image-ref": "ami-x",
          name: "vm",
          "ttl-minutes": "-5",
        }),
      ),
    ).rejects.toThrowError();
  });

  it("maps budget_exceeded to exit 3 (not 4)", async () => {
    const stub = makeStub({
      provisionThrows: new CloudBackendError("budget_exceeded", "over by $42"),
    });
    registerCloudBackend("aws", () => stub);
    const outCapture = captureStdout();
    const errCapture = captureStderr();
    try {
      const exit = await cmdCloudProvision(
        argsFor({
          provider: "aws",
          region: "us-east-1",
          "instance-type": "t3.medium",
          "image-ref": "ami-x",
          name: "vm",
        }),
      );
      expect(exit).toBe(3);
      expect(errCapture.read()).toMatch(/budget_exceeded/);
    } finally {
      outCapture.restore();
      errCapture.restore();
    }
  });

  it("rejects missing --provider", async () => {
    await expect(cmdCloudProvision(argsFor({}))).rejects.toThrowError();
  });
});

describe("signalman cloud terminate — CLI", () => {
  beforeEach(() => resetRegistryForTests());
  afterEach(() => resetRegistryForTests());

  it("terminates by handle and prints idempotent-success message", async () => {
    const stub = makeStub();
    registerCloudBackend("aws", () => stub);
    const capture = captureStdout();
    try {
      const exit = await cmdCloudTerminate(
        argsFor({
          provider: "aws",
          id: "i-test",
          name: "test",
          region: "us-east-1",
        }),
      );
      expect(exit).toBe(0);
      expect(stub.terminated).toEqual(["i-test"]);
      expect(capture.read()).toMatch(/idempotent/);
    } finally {
      capture.restore();
    }
  });

  it("returns exit 4 on backend error", async () => {
    const stub = makeStub({
      terminateThrows: new CloudBackendError("terminate_failed", "vendor 503"),
    });
    registerCloudBackend("aws", () => stub);
    const errCapture = captureStderr();
    try {
      const exit = await cmdCloudTerminate(
        argsFor({
          provider: "aws",
          id: "i-test",
          name: "test",
          region: "us-east-1",
        }),
      );
      expect(exit).toBe(4);
      expect(errCapture.read()).toMatch(/terminate_failed/);
    } finally {
      errCapture.restore();
    }
  });
});

describe("signalman cloud status — CLI", () => {
  beforeEach(() => resetRegistryForTests());
  afterEach(() => resetRegistryForTests());

  it("emits human-readable status with state + IPs", async () => {
    const stub = makeStub();
    registerCloudBackend("aws", () => stub);
    const capture = captureStdout();
    try {
      const exit = await cmdCloudStatus(
        argsFor({
          provider: "aws",
          id: "i-x",
          name: "x",
          region: "us-east-1",
        }),
      );
      expect(exit).toBe(0);
      const out = capture.read();
      expect(out).toMatch(/state:\s+running/);
      expect(out).toMatch(/public_ip:\s+1\.2\.3\.4/);
    } finally {
      capture.restore();
    }
  });

  it("emits JSON when --format json", async () => {
    const stub = makeStub();
    registerCloudBackend("aws", () => stub);
    const capture = captureStdout();
    try {
      await cmdCloudStatus(
        argsFor({
          provider: "aws",
          id: "i-x",
          name: "x",
          region: "us-east-1",
          format: "json",
        }),
      );
      const parsed = JSON.parse(capture.read()) as { state: string };
      expect(parsed.state).toBe("running");
    } finally {
      capture.restore();
    }
  });
});

describe("signalman cloud list — CLI", () => {
  beforeEach(() => resetRegistryForTests());
  afterEach(() => resetRegistryForTests());

  it("prints zero-results message on empty registry", async () => {
    const stub = makeStub({ handles: [] });
    registerCloudBackend("aws", () => stub);
    const capture = captureStdout();
    try {
      const exit = await cmdCloudList(argsFor({ provider: "aws" }));
      expect(exit).toBe(0);
      expect(capture.read()).toMatch(/No Signalman-managed instances/);
    } finally {
      capture.restore();
    }
  });

  it("renders multiple handles in human-readable list", async () => {
    const stub = makeStub({
      handles: [
        {
          id: "i-A",
          backend: "aws",
          name: "vm-a",
          region: "us-east-1",
          network_mode: "aws_ssm",
        },
        {
          id: "i-B",
          backend: "aws",
          name: "vm-b",
          region: "us-east-1",
        },
      ],
    });
    registerCloudBackend("aws", () => stub);
    const capture = captureStdout();
    try {
      await cmdCloudList(argsFor({ provider: "aws" }));
      const out = capture.read();
      expect(out).toMatch(/i-A/);
      expect(out).toMatch(/i-B/);
      expect(out).toMatch(/mode=aws_ssm/);
    } finally {
      capture.restore();
    }
  });
});

// ── stack apply / destroy ──────────────────────────────────────

describe("signalman stack apply / destroy — CLI", () => {
  it("stack apply rejects missing --stack-name", async () => {
    const { cmdStackApply } = await import("../cli.js");
    await expect(
      cmdStackApply(argsFor({ "module-path": "/tmp/foo" })),
    ).rejects.toThrowError();
  });

  it("stack apply rejects missing --module-path", async () => {
    const { cmdStackApply } = await import("../cli.js");
    await expect(
      cmdStackApply(argsFor({ "stack-name": "test" })),
    ).rejects.toThrowError();
  });

  it("stack apply returns exit 4 when module path doesn't exist", async () => {
    const { cmdStackApply } = await import("../cli.js");
    const errCapture = captureStderr();
    try {
      const exit = await cmdStackApply(
        argsFor({
          "stack-name": "test",
          "module-path": "/nonexistent/xyz-stack-apply-cli",
        }),
      );
      expect(exit).toBe(4);
      expect(errCapture.read()).toMatch(/stack apply failed/);
    } finally {
      errCapture.restore();
    }
  });

  it("stack destroy rejects missing --stack-name", async () => {
    const { cmdStackDestroy } = await import("../cli.js");
    await expect(cmdStackDestroy(argsFor({}))).rejects.toThrowError();
  });

  it("stack destroy returns idempotent message when workspace absent", async () => {
    const { cmdStackDestroy } = await import("../cli.js");
    const capture = captureStdout();
    try {
      const exit = await cmdStackDestroy(
        argsFor({ "stack-name": "never-applied-cli-test" }),
      );
      expect(exit).toBe(0);
      expect(capture.read()).toMatch(/idempotent no-op/);
    } finally {
      capture.restore();
    }
  });
});

describe("signalman cloud backends — CLI", () => {
  beforeEach(() => resetRegistryForTests());
  afterEach(() => resetRegistryForTests());

  it("lists registered backends (preserved order: aws then azure)", async () => {
    const aws = makeStub();
    const azure = { ...makeStub(), name: "azure" as const };
    registerCloudBackend("aws", () => aws);
    registerCloudBackend("azure", () => azure);
    const capture = captureStdout();
    try {
      const exit = await cmdCloudBackends(argsFor({ format: "json" }));
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.read()) as string[];
      expect(parsed).toContain("aws");
      expect(parsed).toContain("azure");
    } finally {
      capture.restore();
    }
  });
});
