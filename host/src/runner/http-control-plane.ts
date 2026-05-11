/**
 * HTTP-backed `BuildControlPlane` for the remote runner. Implements
 * the narrow subset of ControlPlane methods that runBuild
 * (control-plane/build/executor.ts) actually touches.
 *
 * Every call goes through the existing HttpClient (bearer-token
 * authenticated). The shim's `blobs.put` streams the body up to
 * POST /v1/blobs (the streamBody endpoint), avoiding the 1 MiB JSON
 * cap that the rest of the API uses.
 *
 * orgId arguments on the local interface are ignored by the HTTP
 * shim — the org is derived from the bearer token on the server side.
 */

import { Readable } from "node:stream";
import type {
  Artifact,
  ArtifactKind,
  AuditLogEntry,
  Product,
  Release,
  ReleaseStatus,
} from "../control-plane/types.js";
import type { BuildControlPlane } from "../control-plane/build/executor.js";
import { HttpClient } from "./client.js";

export class HttpControlPlane implements BuildControlPlane {
  readonly products;
  readonly releases;
  readonly artifacts;
  readonly auditLog;
  readonly blobs;

  constructor(private readonly client: HttpClient) {
    const c = client;

    this.products = {
      async get(id: string): Promise<Product | null> {
        try {
          const { product } = await c.get<{ product: Product }>(
            `/v1/products/${encodeURIComponent(id)}`,
          );
          return product;
        } catch (err) {
          if ((err as { status?: number }).status === 404) return null;
          throw err;
        }
      },
    };

    this.releases = {
      async getByTag(productId: string, tag: string): Promise<Release | null> {
        // The catalog has no "by-id-and-tag" endpoint (existing
        // /v1/releases filters by product *name*). Find the product
        // first, then list its releases and pick the tag.
        const product = await this.lookupProduct(productId);
        if (!product) return null;
        const { releases } = await c.get<{
          releases: Array<{ release: Release }>;
        }>(`/v1/releases?product=${encodeURIComponent(product.name)}`);
        const match = releases.find((r) => r.release.tag === tag);
        return match ? match.release : null;
      },
      // Internal — keeps the (id → name) lookup compact.
      async lookupProduct(id: string): Promise<Product | null> {
        try {
          const { product } = await c.get<{ product: Product }>(
            `/v1/products/${encodeURIComponent(id)}`,
          );
          return product;
        } catch (err) {
          if ((err as { status?: number }).status === 404) return null;
          throw err;
        }
      },
      async create(input: {
        orgId: string;
        productId: string;
        tag: string;
        commitSha: string;
        status?: ReleaseStatus;
      }): Promise<Release> {
        const { release } = await c.post<{ release: Release }>("/v1/releases", {
          product_id: input.productId,
          tag: input.tag,
          commit_sha: input.commitSha,
        });
        // Server returns status='building' on create. If caller wanted
        // a different initial status (unusual), patch it.
        if (input.status && input.status !== release.status) {
          const { release: patched } = await c.patch<{ release: Release }>(
            `/v1/releases/${release.id}`,
            { status: input.status },
          );
          return patched;
        }
        return release;
      },
      async softDelete(id: string): Promise<void> {
        await c.delete<void>(`/v1/releases/${encodeURIComponent(id)}`);
      },
      async update(
        id: string,
        patch: Partial<
          Pick<
            Release,
            | "status"
            | "manifestSha256"
            | "signedBy"
            | "builtAt"
            | "builtByRunnerId"
            | "buildYamlJson"
          >
        >,
      ): Promise<Release> {
        const httpPatch: Record<string, unknown> = {};
        if (patch.status !== undefined) httpPatch.status = patch.status;
        if (patch.manifestSha256 !== undefined)
          httpPatch.manifest_sha256 = patch.manifestSha256;
        if (patch.signedBy !== undefined) httpPatch.signed_by = patch.signedBy;
        if (patch.builtAt !== undefined) httpPatch.built_at = patch.builtAt;
        if (patch.builtByRunnerId !== undefined)
          httpPatch.built_by_runner_id = patch.builtByRunnerId;
        if (patch.buildYamlJson !== undefined)
          httpPatch.build_yaml_json = patch.buildYamlJson;
        const { release } = await c.patch<{ release: Release }>(
          `/v1/releases/${encodeURIComponent(id)}`,
          httpPatch,
        );
        return release;
      },
    };

    this.artifacts = {
      async create(input: {
        releaseId: string;
        component: string;
        kind: ArtifactKind;
        sha256?: string;
        sizeBytes?: number;
        blobUri?: string;
        imageRef?: string;
      }): Promise<Artifact> {
        const body: Record<string, unknown> = {
          component: input.component,
          kind: input.kind,
        };
        if (input.sha256 !== undefined) body.sha256 = input.sha256;
        if (input.sizeBytes !== undefined) body.size_bytes = input.sizeBytes;
        if (input.blobUri !== undefined) body.blob_uri = input.blobUri;
        if (input.imageRef !== undefined) body.image_ref = input.imageRef;
        const { artifact } = await c.post<{ artifact: Artifact }>(
          `/v1/releases/${encodeURIComponent(input.releaseId)}/artifacts`,
          body,
        );
        return artifact;
      },
    };

    this.auditLog = {
      async append(input: {
        orgId: string;
        actor: string;
        action: string;
        entityType: string;
        entityId: string;
        detail?: Record<string, unknown>;
      }): Promise<AuditLogEntry> {
        const { entry } = await c.post<{ entry: AuditLogEntry }>("/v1/audit", {
          actor: input.actor,
          action: input.action,
          entity_type: input.entityType,
          entity_id: input.entityId,
          ...(input.detail ? { detail: input.detail } : {}),
        });
        return entry;
      },
    };

    this.blobs = {
      async put(input: {
        orgId: string;
        body: Buffer | Readable;
        contentType?: string;
      }): Promise<{ uri: string; sha256: string; size: number }> {
        return c.uploadBlob(input.body, input.contentType);
      },
    };
  }
}
