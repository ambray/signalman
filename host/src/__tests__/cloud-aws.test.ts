/**
 * v0.3.0-5 sub-task 2 — AWS cloud backend tests.
 *
 * Mocks the EC2Client's `send` method so no real AWS calls fire.
 * Each test constructs an `AwsBackend` with an injected client +
 * an instant-resolve sleep so the polling loop completes in
 * microseconds.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

import {
  AwsBackend,
  buildInstanceTags,
  mapAwsError,
  mapEc2State,
  AWS_PROVISION_POLL_INTERVAL_MS,
  AWS_PROVISION_TIMEOUT_MS,
} from "../cloud/aws.js";
import {
  CloudBackendError,
  SIGNALMAN_MANAGED_TAG_KEY,
  SIGNALMAN_MANAGED_TAG_VALUE,
  SIGNALMAN_ORG_TAG_KEY,
  type CloudInstanceConfig,
} from "../cloud/types.js";
import {
  getCloudBackend,
  listRegisteredBackends,
} from "../cloud/registry.js";

// ── Mock client helper ────────────────────────────────────────────

/**
 * Build a stub `EC2Client` with a `send` method controllable via
 * vi.fn. Each test scripts the expected sequence of responses.
 */
function makeMockClient(): {
  client: EC2Client;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  // Cast — only `send` is used; the rest of the EC2Client surface
  // isn't touched by AwsBackend.
  const client = { send } as unknown as EC2Client;
  return { client, send };
}

function instantSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

function fullConfig(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  return {
    region: "us-east-1",
    instance_type: "t3.medium",
    image_ref: "ami-0abcd1234",
    name: "test-vm",
    ...overrides,
  };
}

// ── Constructor validation ────────────────────────────────────────

describe("AwsBackend — constructor", () => {
  it("rejects an empty region with invalid_config", () => {
    expect(() => new AwsBackend({ region: "" })).toThrowError(
      expect.objectContaining({
        name: "CloudBackendError",
        code: "invalid_config",
      }),
    );
  });

  it("constructs cleanly with a valid region", () => {
    const b = new AwsBackend({ region: "us-east-1" });
    expect(b.name).toBe("aws");
  });

  it("uses the injected client when supplied", () => {
    const { client } = makeMockClient();
    const b = new AwsBackend({ region: "us-east-1", client });
    expect(b.name).toBe("aws");
  });
});

// ── provisionInstance — happy path ────────────────────────────────

describe("AwsBackend.provisionInstance — happy path", () => {
  it("sends RunInstancesCommand + polls until running + returns handle", async () => {
    const { client, send } = makeMockClient();
    // Sequence: 1) RunInstances → InstanceId. 2) DescribeInstances →
    // pending. 3) DescribeInstances → running with IPs.
    send
      .mockResolvedValueOnce({
        Instances: [{ InstanceId: "i-0abc" }],
      })
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-0abc",
                State: { Name: "pending" },
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-0abc",
                State: { Name: "running" },
                PublicIpAddress: "203.0.113.5",
                PrivateIpAddress: "10.0.0.5",
              },
            ],
          },
        ],
      });

    const backend = new AwsBackend({
      region: "us-east-1",
      client,
      sleep: instantSleep(),
    });
    const handle = await backend.provisionInstance(fullConfig());

    expect(handle).toEqual({
      id: "i-0abc",
      backend: "aws",
      name: "test-vm",
      region: "us-east-1",
    });
    // First send was RunInstances; the next two were DescribeInstances.
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toBeInstanceOf(RunInstancesCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DescribeInstancesCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DescribeInstancesCommand);
  });

  it("emits Signalman ownership tags on every RunInstances call", async () => {
    const { client, send } = makeMockClient();
    send
      .mockResolvedValueOnce({ Instances: [{ InstanceId: "i-tag1" }] })
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: "i-tag1", State: { Name: "running" } }] },
        ],
      });

    const backend = new AwsBackend({
      region: "us-east-1",
      client,
      sleep: instantSleep(),
    });
    await backend.provisionInstance(fullConfig({ org_id: "org-xyz" }));

    const runCmd = send.mock.calls[0][0] as RunInstancesCommand;
    const tags = runCmd.input.TagSpecifications?.[0]?.Tags ?? [];
    const tagMap = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
    expect(tagMap[SIGNALMAN_MANAGED_TAG_KEY]).toBe(SIGNALMAN_MANAGED_TAG_VALUE);
    expect(tagMap[SIGNALMAN_ORG_TAG_KEY]).toBe("org-xyz");
    expect(tagMap.Name).toBe("test-vm");
    expect(tagMap["signalman-ttl-minutes"]).toBe("60"); // DEFAULT
  });

  it("propagates org_id and ttl_minutes overrides", async () => {
    const { client, send } = makeMockClient();
    send
      .mockResolvedValueOnce({ Instances: [{ InstanceId: "i-ttl" }] })
      .mockResolvedValueOnce({
        Reservations: [
          { Instances: [{ InstanceId: "i-ttl", State: { Name: "running" } }] },
        ],
      });
    const backend = new AwsBackend({
      region: "us-east-1",
      client,
      sleep: instantSleep(),
    });
    await backend.provisionInstance(
      fullConfig({ org_id: "org-1", ttl_minutes: 120 }),
    );
    const runCmd = send.mock.calls[0][0] as RunInstancesCommand;
    const tagMap = Object.fromEntries(
      (runCmd.input.TagSpecifications?.[0]?.Tags ?? []).map((t) => [
        t.Key,
        t.Value,
      ]),
    );
    expect(tagMap["signalman-ttl-minutes"]).toBe("120");
    expect(tagMap[SIGNALMAN_ORG_TAG_KEY]).toBe("org-1");
  });
});

// ── provisionInstance — validation + error paths ──────────────────

describe("AwsBackend.provisionInstance — validation", () => {
  it("rejects missing image_ref", async () => {
    const backend = new AwsBackend({ region: "us-east-1", client: makeMockClient().client });
    await expect(
      backend.provisionInstance({ ...fullConfig(), image_ref: "" }),
    ).rejects.toMatchObject({
      name: "CloudBackendError",
      code: "invalid_config",
    });
  });

  it("rejects missing instance_type", async () => {
    const backend = new AwsBackend({ region: "us-east-1", client: makeMockClient().client });
    await expect(
      backend.provisionInstance({ ...fullConfig(), instance_type: "" }),
    ).rejects.toMatchObject({
      name: "CloudBackendError",
      code: "invalid_config",
    });
  });

  it("rejects a config whose region disagrees with the backend's", async () => {
    const backend = new AwsBackend({ region: "us-east-1", client: makeMockClient().client });
    await expect(
      backend.provisionInstance(fullConfig({ region: "us-west-2" })),
    ).rejects.toMatchObject({
      name: "CloudBackendError",
      code: "invalid_config",
    });
  });

  it("wraps RunInstances failures as provision_failed", async () => {
    const { client, send } = makeMockClient();
    const awsErr = new Error("RequestLimitExceeded");
    (awsErr as { name: string }).name = "RequestLimitExceeded";
    send.mockRejectedValueOnce(awsErr);
    const backend = new AwsBackend({ region: "us-east-1", client });
    await expect(backend.provisionInstance(fullConfig())).rejects.toMatchObject({
      name: "CloudBackendError",
      code: "provision_failed",
    });
  });

  it("maps AWS auth errors to auth_failed", async () => {
    const { client, send } = makeMockClient();
    const awsErr = new Error("Auth refused");
    (awsErr as { name: string }).name = "UnauthorizedOperation";
    send.mockRejectedValueOnce(awsErr);
    const backend = new AwsBackend({ region: "us-east-1", client });
    await expect(backend.provisionInstance(fullConfig())).rejects.toMatchObject({
      name: "CloudBackendError",
      code: "auth_failed",
    });
  });

  it("throws provision_failed when AWS returns no instance id", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({ Instances: [] });
    const backend = new AwsBackend({ region: "us-east-1", client });
    await expect(backend.provisionInstance(fullConfig())).rejects.toMatchObject({
      code: "provision_failed",
    });
  });
});

// ── provisionInstance — polling termination ───────────────────────

describe("AwsBackend.provisionInstance — polling", () => {
  it("throws provision_failed when the instance enters terminated mid-poll", async () => {
    const { client, send } = makeMockClient();
    send
      .mockResolvedValueOnce({ Instances: [{ InstanceId: "i-bad" }] })
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-bad",
                State: { Name: "terminated" },
                StateReason: { Message: "Client.UserInitiatedShutdown" },
              },
            ],
          },
        ],
      });
    const backend = new AwsBackend({
      region: "us-east-1",
      client,
      sleep: instantSleep(),
    });
    await expect(
      backend.provisionInstance(fullConfig({ name: "doomed-vm" })),
    ).rejects.toMatchObject({
      name: "CloudBackendError",
      code: "provision_failed",
    });
  });

  it("throws provision_failed when the poll timeout elapses", async () => {
    const { client, send } = makeMockClient();
    // Endless pending responses; the loop should bail at timeout.
    send.mockResolvedValueOnce({ Instances: [{ InstanceId: "i-slow" }] });
    send.mockResolvedValue({
      Reservations: [
        {
          Instances: [{ InstanceId: "i-slow", State: { Name: "pending" } }],
        },
      ],
    });
    const backend = new AwsBackend({
      region: "us-east-1",
      client,
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
      sleep: instantSleep(),
    });
    await expect(backend.provisionInstance(fullConfig())).rejects.toMatchObject({
      name: "CloudBackendError",
      code: "provision_failed",
    });
  });
});

// ── terminateInstance ────────────────────────────────────────────

describe("AwsBackend.terminateInstance", () => {
  it("sends TerminateInstancesCommand for the handle", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({
      TerminatingInstances: [
        { InstanceId: "i-term", CurrentState: { Name: "shutting-down" } },
      ],
    });
    const backend = new AwsBackend({ region: "us-east-1", client });
    await backend.terminateInstance({
      id: "i-term",
      backend: "aws",
      name: "vm",
      region: "us-east-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(TerminateInstancesCommand);
    const cmd = send.mock.calls[0][0] as TerminateInstancesCommand;
    expect(cmd.input.InstanceIds).toEqual(["i-term"]);
  });

  it("treats InvalidInstanceID.NotFound as idempotent success", async () => {
    const { client, send } = makeMockClient();
    const awsErr = new Error("not found");
    (awsErr as { name: string }).name = "InvalidInstanceID.NotFound";
    send.mockRejectedValueOnce(awsErr);
    const backend = new AwsBackend({ region: "us-east-1", client });
    await expect(
      backend.terminateInstance({
        id: "i-gone",
        backend: "aws",
        name: "vm",
        region: "us-east-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("wraps other terminate failures as terminate_failed", async () => {
    const { client, send } = makeMockClient();
    const awsErr = new Error("limit");
    (awsErr as { name: string }).name = "RequestLimitExceeded";
    send.mockRejectedValueOnce(awsErr);
    const backend = new AwsBackend({ region: "us-east-1", client });
    await expect(
      backend.terminateInstance({
        id: "i-lim",
        backend: "aws",
        name: "vm",
        region: "us-east-1",
      }),
    ).rejects.toMatchObject({ code: "terminate_failed" });
  });
});

// ── getInstanceStatus + getInstanceIp ─────────────────────────────

describe("AwsBackend.getInstanceStatus", () => {
  it("returns mapped state + IPs", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-stat",
              State: { Name: "running" },
              PublicIpAddress: "203.0.113.99",
              PrivateIpAddress: "10.0.0.99",
            },
          ],
        },
      ],
    });
    const backend = new AwsBackend({ region: "us-east-1", client });
    const status = await backend.getInstanceStatus({
      id: "i-stat",
      backend: "aws",
      name: "vm",
      region: "us-east-1",
    });
    expect(status.state).toBe("running");
    expect(status.public_ip).toBe("203.0.113.99");
    expect(status.private_ip).toBe("10.0.0.99");
  });

  it("maps InvalidInstanceID.NotFound to instance_not_found", async () => {
    const { client, send } = makeMockClient();
    const awsErr = new Error("gone");
    (awsErr as { name: string }).name = "InvalidInstanceID.NotFound";
    send.mockRejectedValueOnce(awsErr);
    const backend = new AwsBackend({ region: "us-east-1", client });
    await expect(
      backend.getInstanceStatus({
        id: "i-missing",
        backend: "aws",
        name: "vm",
        region: "us-east-1",
      }),
    ).rejects.toMatchObject({ code: "instance_not_found" });
  });

  it("getInstanceIp returns null when public IP isn't assigned", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-noip",
              State: { Name: "running" },
            },
          ],
        },
      ],
    });
    const backend = new AwsBackend({ region: "us-east-1", client });
    const ip = await backend.getInstanceIp({
      id: "i-noip",
      backend: "aws",
      name: "vm",
      region: "us-east-1",
    });
    expect(ip).toBeNull();
  });
});

// ── listInstances ────────────────────────────────────────────────

describe("AwsBackend.listInstances", () => {
  it("always filters by the signalman-managed tag", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({ Reservations: [] });
    const backend = new AwsBackend({ region: "us-east-1", client });
    await backend.listInstances();

    const cmd = send.mock.calls[0][0] as DescribeInstancesCommand;
    const filters = cmd.input.Filters ?? [];
    const managedFilter = filters.find(
      (f) => f.Name === `tag:${SIGNALMAN_MANAGED_TAG_KEY}`,
    );
    expect(managedFilter).toBeDefined();
    expect(managedFilter?.Values).toEqual([SIGNALMAN_MANAGED_TAG_VALUE]);
  });

  it("forwards caller tags as additional filters", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({ Reservations: [] });
    const backend = new AwsBackend({ region: "us-east-1", client });
    await backend.listInstances({ tags: { project: "demo" } });

    const cmd = send.mock.calls[0][0] as DescribeInstancesCommand;
    const filters = cmd.input.Filters ?? [];
    const projectFilter = filters.find((f) => f.Name === "tag:project");
    expect(projectFilter?.Values).toEqual(["demo"]);
  });

  it("maps reservation instances back to handles", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-A",
              Tags: [{ Key: "Name", Value: "vm-a" }],
            },
            {
              InstanceId: "i-B",
              Tags: [{ Key: "Name", Value: "vm-b" }],
            },
          ],
        },
      ],
    });
    const backend = new AwsBackend({ region: "us-east-1", client });
    const handles = await backend.listInstances();
    expect(handles).toHaveLength(2);
    // toMatchObject so the assertion remains valid when the
    // backend populates the new optional `tags` field
    // (v0.3.0-5 sub-task 5 — reaper needs the tag map).
    expect(handles[0]).toMatchObject({
      id: "i-A",
      backend: "aws",
      name: "vm-a",
      region: "us-east-1",
    });
    expect(handles[0].tags).toEqual({ Name: "vm-a" });
    expect(handles[1].name).toBe("vm-b");
  });

  it("falls back to instance id when no Name tag is present", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: "i-noname" }] }],
    });
    const backend = new AwsBackend({ region: "us-east-1", client });
    const handles = await backend.listInstances();
    expect(handles[0].name).toBe("i-noname");
  });

  it("throws quota_exceeded when the result is paginated", async () => {
    const { client, send } = makeMockClient();
    send.mockResolvedValueOnce({
      NextToken: "tok",
      Reservations: [],
    });
    const backend = new AwsBackend({ region: "us-east-1", client });
    await expect(backend.listInstances()).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });
});

// ── Helpers (exported pure functions) ─────────────────────────────

describe("buildInstanceTags", () => {
  it("always includes the Signalman sentinel tags", () => {
    const tags = buildInstanceTags(fullConfig(), "default", 60);
    const map = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
    expect(map[SIGNALMAN_MANAGED_TAG_KEY]).toBe(SIGNALMAN_MANAGED_TAG_VALUE);
    expect(map[SIGNALMAN_ORG_TAG_KEY]).toBe("default");
    expect(map["signalman-ttl-minutes"]).toBe("60");
    expect(map.Name).toBe("test-vm");
  });

  it("merges caller tags but refuses to override sentinel keys", () => {
    const tags = buildInstanceTags(
      fullConfig({
        tags: {
          // The malicious / accidental override attempt.
          [SIGNALMAN_MANAGED_TAG_KEY]: "false",
          [SIGNALMAN_ORG_TAG_KEY]: "spoofed-org",
          "signalman-ttl-minutes": "9999999",
          // Legitimate caller tag.
          project: "demo",
        },
      }),
      "real-org",
      60,
    );
    const map = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
    expect(map[SIGNALMAN_MANAGED_TAG_KEY]).toBe(SIGNALMAN_MANAGED_TAG_VALUE);
    expect(map[SIGNALMAN_ORG_TAG_KEY]).toBe("real-org");
    expect(map["signalman-ttl-minutes"]).toBe("60");
    expect(map.project).toBe("demo");
  });
});

describe("mapAwsError", () => {
  it("maps auth-related AWS codes to auth_failed regardless of default", () => {
    const e = new Error("bad creds");
    (e as { name: string }).name = "AuthFailure";
    const wrapped = mapAwsError(e, "provision_failed", "x");
    expect(wrapped.code).toBe("auth_failed");
  });

  it("uses the provided default code for non-auth AWS errors", () => {
    const e = new Error("limit");
    (e as { name: string }).name = "RequestLimitExceeded";
    const wrapped = mapAwsError(e, "terminate_failed", "Terminate boom");
    expect(wrapped.code).toBe("terminate_failed");
    expect(wrapped.message).toContain("RequestLimitExceeded");
    expect(wrapped.message).toContain("Terminate boom");
  });

  it("surfaces the underlying error as cause", () => {
    const e = new Error("limit");
    const wrapped = mapAwsError(e, "provision_failed", "x");
    expect(wrapped.cause).toBe(e);
  });
});

describe("mapEc2State", () => {
  it("maps AWS state strings to abstraction states", () => {
    expect(mapEc2State("pending")).toBe("pending");
    expect(mapEc2State("running")).toBe("running");
    expect(mapEc2State("stopping")).toBe("stopped");
    expect(mapEc2State("stopped")).toBe("stopped");
    expect(mapEc2State("shutting-down")).toBe("terminated");
    expect(mapEc2State("terminated")).toBe("terminated");
  });

  it("returns unknown for unrecognised or undefined states", () => {
    expect(mapEc2State(undefined)).toBe("unknown");
    expect(mapEc2State("rebooting")).toBe("unknown");
    expect(mapEc2State("")).toBe("unknown");
  });
});

// ── Constants ─────────────────────────────────────────────────────

describe("AWS_PROVISION_POLL_INTERVAL_MS + AWS_PROVISION_TIMEOUT_MS", () => {
  it("default poll interval is 2 seconds", () => {
    expect(AWS_PROVISION_POLL_INTERVAL_MS).toBe(2_000);
  });

  it("default poll timeout is 60 seconds", () => {
    expect(AWS_PROVISION_TIMEOUT_MS).toBe(60_000);
  });
});

// ── Module-load registration ──────────────────────────────────────

describe("AWS backend auto-registration", () => {
  it("registers an 'aws' factory on module import", async () => {
    // The aws.ts module's static import at the top of this test
    // file already triggered registration. Verify the factory is
    // discoverable + produces a valid AwsBackend instance.
    //
    // We do NOT reset the registry first: that would clear the
    // module-load registration, and re-importing the module
    // wouldn't restore it (ES-module side-effects run once per
    // worker lifetime). A `vi.resetModules` + dynamic import dance
    // would work but tests something less interesting than the
    // production import path. Verifying the post-import state is
    // the contract that matters.
    const backend = getCloudBackend("aws");
    expect(backend.name).toBe("aws");
  });

  it("listRegisteredBackends contains 'aws' after import", () => {
    // The registry exposes the kinds for audit / status tooling.
    // Same caveat as above re: not resetting first.
    expect(listRegisteredBackends()).toContain("aws");
  });
});
