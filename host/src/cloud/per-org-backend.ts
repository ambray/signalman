/**
 * Per-org cloud-backend resolution (v0.3.0-5 sub-task 8 commit 2).
 *
 * Bridges the credential storage from sub-task 6 commit 2 into
 * the AwsBackend / AzureBackend constructor paths from sub-tasks
 * 2 + 3. The MCP `signalman_cloud_provision` handler calls
 * `resolveBackendForOrg(kind, orgId, ...)` when the caller passes
 * `org_id`; we look up the org's credential row (if any), decrypt,
 * and construct a fresh backend with those credentials. Fallback
 * is the existing `getCloudBackend(kind)` path — which uses env
 * vars + the SDK default credential chain.
 *
 * # Locked design
 *
 * - **HOF over construction.** The resolver takes
 *   `defaultBackend()` and `buildBackendWithCreds(kind, plaintext)`
 *   as injected callbacks. Production wiring supplies the real
 *   SDK-constructing implementations via
 *   {@link defaultBuildBackendWithCreds}; tests substitute stubs
 *   that don't pull in AWS / Azure SDKs.
 * - **No registry caching for per-org backends.** Each
 *   `resolveBackendForOrg` constructs a fresh backend. The
 *   registry's "one client per kind" invariant (sub-task 1
 *   locked design) holds for the env-credential path; per-org
 *   backends are a different identity and don't belong in the
 *   same cache. Operators that hot-loop provisions for a single
 *   org will see N client constructions; mitigation is a future
 *   per-(kind, org) cache when the cost shows up in real traces.
 * - **Decryption failure propagates.** If the credential row
 *   exists but decryption fails (key mismatch, corrupt
 *   ciphertext), the resolver throws. Silently falling back to
 *   the SDK default chain in that case would be a privilege-
 *   escalation surprise — operators set per-org creds expecting
 *   them to be used.
 * - **Absence of credential row = fallback, not failure.** This
 *   is the explicit back-compat: orgs that haven't opted into
 *   per-org credential storage keep using the env / SDK chain.
 *   Only an existing-but-broken credential aborts.
 */

import {
  type CredentialPlaintext,
  type AwsCredentialPlaintext,
  type AzureCredentialPlaintext,
  loadCredentialForOrg,
} from "./credentials.js";
import { getCloudBackend } from "./registry.js";
import {
  type CloudBackend,
  type CloudBackendKind,
  CloudBackendError,
} from "./types.js";
import type { CloudCredentialsRepo } from "../control-plane/storage/driver.js";

// ── Resolver ──────────────────────────────────────────────────────

export interface ResolveBackendForOrgOptions {
  /** Repo to read the encrypted credential row from. */
  credentialsRepo: CloudCredentialsRepo;
  /**
   * Fallback when no credential row exists for the (org, kind).
   * Production: `() => getCloudBackend(kind)`. Tests substitute.
   */
  defaultBackend: () => CloudBackend;
  /**
   * Construct a fresh backend with the decrypted credential.
   * Production: {@link defaultBuildBackendWithCreds} (async,
   * needs dynamic SDK imports). Tests can return synchronously.
   */
  buildBackendWithCreds: (
    kind: CloudBackendKind,
    plaintext: CredentialPlaintext,
  ) => CloudBackend | Promise<CloudBackend>;
}

/**
 * Resolve the right `CloudBackend` for an (org, kind) pair.
 *
 * - No credential row → fallback to `defaultBackend()`.
 * - Credential row + successful decrypt → fresh backend via
 *   `buildBackendWithCreds(kind, plaintext)`.
 * - Credential row but decryption fails →
 *   `CloudBackendError("invalid_config", ...)` propagates.
 */
export async function resolveBackendForOrg(
  kind: CloudBackendKind,
  orgId: string,
  opts: ResolveBackendForOrgOptions,
): Promise<CloudBackend> {
  if (kind !== "aws" && kind !== "azure") {
    throw new CloudBackendError(
      "unsupported_provider",
      `per-org backend resolution: unsupported kind '${kind}' (only 'aws' and 'azure' carry credential rows in v0.3.0-5)`,
    );
  }
  const plaintext = await loadCredentialForOrg(opts.credentialsRepo, orgId, kind);
  if (!plaintext) {
    return opts.defaultBackend();
  }
  return await opts.buildBackendWithCreds(kind, plaintext);
}

// ── Production builder ────────────────────────────────────────────

/**
 * Production `buildBackendWithCreds`: constructs a real
 * AwsBackend / AzureBackend with the decrypted plaintext as the
 * SDK credentials.
 *
 * AWS scoping (region): read from `AWS_REGION` env var, default
 * `"us-east-1"`. AWS clients are region-scoped; multi-region
 * operators register multiple backends.
 *
 * Azure scoping (subscriptionId, resourceGroup, region): read
 * from `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`,
 * `AZURE_REGION` env vars. Required because the credential
 * plaintext identifies *who* is calling, not *where* the
 * resources live — a v0.3.x followup may add per-org scoping
 * rows alongside credentials.
 */
export async function defaultBuildBackendWithCreds(
  kind: CloudBackendKind,
  plaintext: CredentialPlaintext,
): Promise<CloudBackend> {
  if (kind === "aws") {
    const aws = plaintext as AwsCredentialPlaintext;
    const region = process.env.AWS_REGION ?? "us-east-1";
    const { EC2Client } = await import("@aws-sdk/client-ec2");
    const { AwsBackend } = await import("./aws.js");
    const client = new EC2Client({
      region,
      credentials: {
        accessKeyId: aws.access_key_id,
        secretAccessKey: aws.secret_access_key,
        sessionToken: aws.session_token,
      },
    });
    return new AwsBackend({ region, client });
  }
  if (kind === "azure") {
    const azure = plaintext as AzureCredentialPlaintext;
    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
    const resourceGroup = process.env.AZURE_RESOURCE_GROUP;
    const region = process.env.AZURE_REGION ?? "eastus";
    if (!subscriptionId || !resourceGroup) {
      throw new CloudBackendError(
        "invalid_config",
        "per-org Azure backend requires AZURE_SUBSCRIPTION_ID + " +
          "AZURE_RESOURCE_GROUP env vars (the credential plaintext " +
          "identifies the caller, not the resource scope)",
      );
    }
    const { ClientSecretCredential } = await import("@azure/identity");
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const { AzureBackend } = await import("./azure.js");
    const credential = new ClientSecretCredential(
      azure.tenant_id,
      azure.client_id,
      azure.client_secret,
    );
    const client = new ComputeManagementClient(credential, subscriptionId);
    return new AzureBackend({ subscriptionId, resourceGroup, region, client });
  }
  throw new CloudBackendError(
    "unsupported_provider",
    `defaultBuildBackendWithCreds: unsupported kind '${kind}'`,
  );
}

/**
 * Convenience wrapper that wires `resolveBackendForOrg` with
 * production defaults: registry-resolved fallback +
 * SDK-constructing builder. Used by the MCP `signalman_cloud_*`
 * handlers when `org_id` is present.
 */
export async function resolveBackendForOrgWithDefaults(
  kind: CloudBackendKind,
  orgId: string,
  credentialsRepo: CloudCredentialsRepo,
): Promise<CloudBackend> {
  return resolveBackendForOrg(kind, orgId, {
    credentialsRepo,
    defaultBackend: () => getCloudBackend(kind),
    buildBackendWithCreds: defaultBuildBackendWithCreds,
  });
}
