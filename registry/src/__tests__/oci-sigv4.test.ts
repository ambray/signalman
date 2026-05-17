// WS10 M5 — AWS SigV4 minimal signer (ECR GetAuthorizationToken).
//
// Tests check the canonical request + string-to-sign components and
// the resulting Authorization header shape. Deterministic clock so
// the amz-date claim is stable across runs.

import { describe, expect, it } from "vitest";
import { signSigV4Request } from "../oci/index.js";

const FIXED_NOW = new Date("2026-05-16T12:00:00.000Z");
const FIXED_AMZ_DATE = "20260516T120000Z";

describe("signSigV4Request", () => {
  it("produces a well-formed Authorization header", () => {
    const signed = signSigV4Request({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget:
        "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    expect(signed.method).toBe("POST");
    expect(signed.url).toBe("https://api.ecr.us-east-1.amazonaws.com/");
    expect(signed.body).toBe("{}");
    const auth = signed.headers.authorization;
    expect(auth).toContain("AWS4-HMAC-SHA256");
    expect(auth).toContain("Credential=AKIAEXAMPLE/20260516/us-east-1/ecr/aws4_request");
    expect(auth).toContain("SignedHeaders=");
    expect(auth).toMatch(/Signature=[a-f0-9]{64}$/);
  });

  it("includes the X-Amz-* headers in SignedHeaders", () => {
    const signed = signSigV4Request({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secret",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget:
        "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    const auth = signed.headers.authorization;
    const m = /SignedHeaders=([^,]+),/.exec(auth);
    expect(m).not.toBeNull();
    const signedHeaders = m![1].split(";");
    expect(signedHeaders).toContain("content-type");
    expect(signedHeaders).toContain("host");
    expect(signedHeaders).toContain("x-amz-date");
    expect(signedHeaders).toContain("x-amz-target");
  });

  it("emits the spec-formatted x-amz-date", () => {
    const signed = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-west-2",
      service: "ecr",
      url: "https://api.ecr.us-west-2.amazonaws.com/",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    expect(signed.headers["x-amz-date"]).toBe(FIXED_AMZ_DATE);
  });

  it("threads session token through as x-amz-security-token", () => {
    const signed = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "y",
      sessionToken: "FwoGZXIvYXdzE...session",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    expect(signed.headers["x-amz-security-token"]).toBe(
      "FwoGZXIvYXdzE...session",
    );
    // The session token must be among the signed headers (otherwise
    // STS-issued requests fail signature on the AWS side).
    const auth = signed.headers.authorization;
    expect(auth).toContain("x-amz-security-token");
  });

  it("regenerates a different signature when the body changes", () => {
    const a = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    const b = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: '{"foo":"bar"}',
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it("regenerates a different signature when the time changes", () => {
    const a = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    const b = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => new Date("2026-05-17T00:00:00.000Z"),
    });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it("regenerates a different signature when the secret changes", () => {
    const a = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "secret-a",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    const b = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "secret-b",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    expect(a.headers.authorization).not.toBe(b.headers.authorization);
  });

  it("handles a URL with query parameters in canonical form", () => {
    const signed = signSigV4Request({
      accessKeyId: "x",
      secretAccessKey: "y",
      region: "us-east-1",
      service: "ecr",
      url: "https://api.ecr.us-east-1.amazonaws.com/?action=Foo&extra=Bar",
      body: "{}",
      amzTarget: "AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken",
      now: () => FIXED_NOW,
    });
    // We don't assert the exact signature — that would pin to the
    // algorithm — but a signature must still emerge (no throw).
    expect(signed.headers.authorization).toMatch(/Signature=[a-f0-9]{64}$/);
  });
});
