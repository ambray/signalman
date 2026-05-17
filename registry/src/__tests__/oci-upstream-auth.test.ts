// WS10 M5 — upstream auth adapter tests.
//
// Each adapter is tested in isolation with an injectable fetcher
// so no actual network calls happen. The factory's `createUpstream
// AuthAdapter` exhaustively dispatches across the three flavors.

import { describe, expect, it } from "vitest";
import {
  createUpstreamAuthAdapter,
  dockerHubAuthAdapter,
  ecrAuthAdapter,
  ghcrAuthAdapter,
  type UpstreamFetchResult,
} from "../oci/index.js";
import type { UpstreamFetch } from "../cargo/index.js";

function stubFetch(
  responder: (
    url: string,
    init?: {
      method?: "GET" | "POST" | "HEAD";
      headers?: Record<string, string>;
      body?: string;
    },
  ) => UpstreamFetchResult,
): UpstreamFetch {
  return async (url, init) => responder(url, init);
}

// ── Docker Hub ─────────────────────────────────────────────────────

describe("dockerHubAuthAdapter", () => {
  it("hits the token endpoint with the right scope + parses the token", async () => {
    let observedUrl = "";
    const adapter = dockerHubAuthAdapter({
      fetch: stubFetch((url) => {
        observedUrl = url;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ token: "test-token-xyz" })),
        };
      }),
    });
    const result = await adapter.authorize({
      repository: "library/alpine",
      action: "pull",
    });
    expect(observedUrl).toBe(
      "https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Falpine%3Apull",
    );
    expect(result.authorization).toBe("Bearer test-token-xyz");
  });

  it("accepts access_token alongside token (both Docker Hub variants)", async () => {
    const adapter = dockerHubAuthAdapter({
      fetch: stubFetch(() => ({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ access_token: "alt-token" })),
      })),
    });
    const result = await adapter.authorize({
      repository: "library/x",
      action: "pull",
    });
    expect(result.authorization).toBe("Bearer alt-token");
  });

  it("throws on non-200 from the token endpoint", async () => {
    const adapter = dockerHubAuthAdapter({
      fetch: stubFetch(() => ({ status: 500, headers: {}, body: Buffer.from("nope") })),
    });
    await expect(
      adapter.authorize({ repository: "library/alpine", action: "pull" }),
    ).rejects.toThrow(/returned 500/);
  });

  it("throws on non-JSON body", async () => {
    const adapter = dockerHubAuthAdapter({
      fetch: stubFetch(() => ({
        status: 200,
        headers: {},
        body: Buffer.from("not json"),
      })),
    });
    await expect(
      adapter.authorize({ repository: "x", action: "pull" }),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws when no token field is present", async () => {
    const adapter = dockerHubAuthAdapter({
      fetch: stubFetch(() => ({
        status: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ other: "field" })),
      })),
    });
    await expect(
      adapter.authorize({ repository: "x", action: "pull" }),
    ).rejects.toThrow(/no token/);
  });

  it("attaches Basic auth when configured (for private Docker Hub repos)", async () => {
    let observedHeaders: Record<string, string> | undefined;
    const adapter = dockerHubAuthAdapter({
      basicAuth: { username: "user", password: "pass" },
      fetch: stubFetch((_url, init) => {
        observedHeaders = init?.headers;
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ token: "t" })),
        };
      }),
    });
    await adapter.authorize({ repository: "private/repo", action: "pull" });
    expect(observedHeaders?.authorization).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });
});

// ── GHCR ───────────────────────────────────────────────────────────

describe("ghcrAuthAdapter", () => {
  it("returns empty Authorization when no bearer is configured (anonymous)", async () => {
    const result = await ghcrAuthAdapter({}).authorize({
      repository: "owner/repo",
      action: "pull",
    });
    expect(result.authorization).toBe("");
  });

  it("returns Bearer <token> when configured", async () => {
    const result = await ghcrAuthAdapter({
      bearerToken: "ghp_abcdef",
    }).authorize({
      repository: "owner/repo",
      action: "pull",
    });
    expect(result.authorization).toBe("Bearer ghp_abcdef");
  });
});

// ── ECR ────────────────────────────────────────────────────────────

describe("ecrAuthAdapter", () => {
  const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");

  it("calls GetAuthorizationToken with SigV4 + returns Basic Auth", async () => {
    let observedHeaders: Record<string, string> | undefined;
    let observedBody: string | undefined;
    const adapter = ecrAuthAdapter({
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      now: () => FIXED_NOW,
      fetch: stubFetch((_url, init) => {
        observedHeaders = init?.headers;
        observedBody = init?.body;
        return {
          status: 200,
          headers: { "content-type": "application/x-amz-json-1.1" },
          body: Buffer.from(
            JSON.stringify({
              authorizationData: [
                {
                  authorizationToken: Buffer.from("AWS:test-ecr-token").toString(
                    "base64",
                  ),
                },
              ],
            }),
          ),
        };
      }),
    });
    const result = await adapter.authorize({
      repository: "private/repo",
      action: "pull",
    });
    expect(observedBody).toBe("{}");
    expect(observedHeaders?.["x-amz-target"]).toBe(
      "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
    );
    expect(observedHeaders?.authorization).toContain("AWS4-HMAC-SHA256");
    expect(result.authorization).toMatch(/^Basic /);
    expect(
      Buffer.from(result.authorization.slice("Basic ".length), "base64").toString(
        "utf-8",
      ),
    ).toBe("AWS:test-ecr-token");
  });

  it("throws when AWS credentials are missing", () => {
    const prev = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    };
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      expect(() => ecrAuthAdapter({ region: "us-east-1" })).toThrow(/credentials/);
    } finally {
      if (prev.AWS_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = prev.AWS_ACCESS_KEY_ID;
      if (prev.AWS_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = prev.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("throws on non-200 from GetAuthorizationToken", async () => {
    const adapter = ecrAuthAdapter({
      region: "us-east-1",
      accessKeyId: "x",
      secretAccessKey: "y",
      now: () => FIXED_NOW,
      fetch: stubFetch(() => ({
        status: 403,
        headers: {},
        body: Buffer.from("denied"),
      })),
    });
    await expect(
      adapter.authorize({ repository: "x", action: "pull" }),
    ).rejects.toThrow(/returned 403/);
  });

  it("throws when authorizationData is missing", async () => {
    const adapter = ecrAuthAdapter({
      region: "us-east-1",
      accessKeyId: "x",
      secretAccessKey: "y",
      now: () => FIXED_NOW,
      fetch: stubFetch(() => ({
        status: 200,
        headers: {},
        body: Buffer.from("{}"),
      })),
    });
    await expect(
      adapter.authorize({ repository: "x", action: "pull" }),
    ).rejects.toThrow(/authorizationData/);
  });

  it("throws on non-JSON response", async () => {
    const adapter = ecrAuthAdapter({
      region: "us-east-1",
      accessKeyId: "x",
      secretAccessKey: "y",
      now: () => FIXED_NOW,
      fetch: stubFetch(() => ({
        status: 200,
        headers: {},
        body: Buffer.from("oops"),
      })),
    });
    await expect(
      adapter.authorize({ repository: "x", action: "pull" }),
    ).rejects.toThrow(/non-JSON/);
  });
});

// ── Factory ─────────────────────────────────────────────────────────

describe("createUpstreamAuthAdapter", () => {
  const fetch = stubFetch(() => ({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({ token: "x" })),
  }));

  it("dispatches to the dockerhub adapter", () => {
    const adapter = createUpstreamAuthAdapter({ flavor: "dockerhub", fetch });
    expect(adapter.kind).toBe("dockerhub");
  });

  it("dispatches to the ghcr adapter and threads the PAT through", async () => {
    const adapter = createUpstreamAuthAdapter({
      flavor: "ghcr",
      bearerToken: "ghp_xyz",
    });
    expect(adapter.kind).toBe("ghcr");
    const result = await adapter.authorize({ repository: "o/r", action: "pull" });
    expect(result.authorization).toBe("Bearer ghp_xyz");
  });

  it("dispatches to the ecr adapter", () => {
    const adapter = createUpstreamAuthAdapter({
      flavor: "ecr",
      config: {
        aws_region: "us-east-1",
        aws_access_key_id: "x",
        aws_secret_access_key: "y",
      },
      fetch,
    });
    expect(adapter.kind).toBe("ecr");
  });

  it("throws when ECR config lacks aws_region", () => {
    expect(() =>
      createUpstreamAuthAdapter({
        flavor: "ecr",
        config: {},
      }),
    ).toThrow(/aws_region/);
  });

  it("forwards dockerhub token_endpoint / token_service overrides", async () => {
    let observedUrl = "";
    const adapter = createUpstreamAuthAdapter({
      flavor: "dockerhub",
      config: {
        token_endpoint: "https://my-mirror.example.com/token",
        token_service: "my-registry",
      },
      fetch: stubFetch((url) => {
        observedUrl = url;
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({ token: "t" })),
        };
      }),
    });
    await adapter.authorize({ repository: "library/alpine", action: "pull" });
    expect(observedUrl).toContain("https://my-mirror.example.com/token");
    expect(observedUrl).toContain("service=my-registry");
  });
});
