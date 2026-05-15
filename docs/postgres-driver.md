# Postgres storage driver

Signalman's control plane ships two relational drivers behind one
`StorageDriver` interface: the default **SQLite** driver for local +
self-hosted-small deployments, and the **Postgres** driver
(`PostgresStorageDriver`) for self-hosted-large. Both satisfy the
same interface and apply the same migration files; verb code never
knows which is underneath.

## Configuration

Point signalman at Postgres in [`.signalman/config.yaml`](../.signalman/config.yaml):

```yaml
controlPlane:
  storage:
    driver: postgres
    url: postgres://signalman:secret@db.example.com:5432/signalman
```

The `url` is a standard libpq connection string and is forwarded to
[`pg.Pool`](https://node-postgres.com/api/pool). Connection options
(SSL, pool size, statement timeout, etc.) can be embedded as URL
query parameters or set via PG environment variables.

For programmatic construction (tests, embedded deployments) pass an
existing `pg.Pool`:

```ts
import { Pool } from "pg";
import { PostgresStorageDriver } from "@signalman/host/control-plane/storage";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const driver = new PostgresStorageDriver({ pool });
await driver.migrate();
```

## Schema portability

The migrations under [`host/src/control-plane/storage/migrations/`](../host/src/control-plane/storage/migrations/)
were authored with both drivers in mind. The same `.sql` files run
verbatim against SQLite and Postgres because we picked the portable
type for each column:

| Column shape | SQLite | Postgres | Choice |
|---|---|---|---|
| ULID PKs | `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | TEXT |
| ISO-8601 timestamps | `TEXT` | `TIMESTAMPTZ` would be idiomatic | TEXT (portable; cast at query time if needed) |
| JSON columns | `TEXT` | `JSONB` would be idiomatic | TEXT (round-trips through the same row mappers) |
| Booleans | `INTEGER` with CHECK | `BOOLEAN` | N/A — no boolean columns in the schema |
| Partial unique indexes | `… WHERE deleted_at IS NULL` | Identical syntax | Identical |
| CHECK enums | `CHECK (col IN (...))` | Identical | Identical |

If a future migration needs a Postgres-specific feature (e.g. JSONB
queries, generated columns, indexes on JSONB), we'll either split
migrations into per-driver subdirectories or write a small adapter in
the migration runner. We deliberately resisted both for v0.3.0 because
the current schema fits the portable subset cleanly.

### Split-migration pattern for CHECK-constraint changes

One case has already forced a per-driver split: enlarging a CHECK
constraint on the `target.kind` column. SQLite cannot modify a CHECK
constraint in place — it requires a full table-recreation dance
(create-new + copy + drop-old + rename) that has to preserve every
foreign-key reference. Postgres can do it with a single
`ALTER TABLE ... DROP CONSTRAINT / ADD CONSTRAINT` pair.

When this difference would have made one `.sql` file unmaintainable,
the migration runner picks the right variant based on driver kind by
suffix:

```
0050_target_kind_k8s.pg.sql       -- Postgres path: ALTER TABLE
0050_target_kind_k8s.sqlite.sql   -- SQLite path:   recreate target table
0072_target_kind_cloud.pg.sql     -- Postgres path: ALTER TABLE
0072_target_kind_cloud.sqlite.sql -- SQLite path:   recreate target table
```

The runner looks for `<id>_<name>.<driver>.sql` first and falls back
to `<id>_<name>.sql` when no variant is present. This keeps the bulk
of migrations driver-agnostic while giving an escape valve for the
narrow set of operations SQLite can't do in place.

### Tables added since v0.3.0

The doc was authored at the v0.3.0 cut. The following tables have
landed in v0.3.x and v0.4.x; all of them use the portable type
choices above and run verbatim on both drivers:

| Migration | Tables | Purpose |
|---|---|---|
| `0040_cloud_budgets.sql` | `cloud_org_budget`, `cloud_org_usage` | Per-org monthly cloud cost gate + per-instance usage ledger (see [cost guardrails](design/meta-build-system.md#135-cloud-cost-control)). |
| `0041_cloud_credentials.sql` | `cloud_org_credential` | AES-256-GCM ciphertext for per-org AWS / Azure credentials (key from `SIGNALMAN_CRED_KEY`). |
| `0050_target_kind_k8s.*.sql` | _(constraint change)_ | Adds `k8s_test` / `k8s_demo` to the `target.kind` CHECK. |
| `0060_health_schedule.sql` | `health_schedule` | WS3 Epic 3 — periodic re-runs of `health check` against a target. The scheduler tick selects on a partial index over `(last_run_at) WHERE deleted_at IS NULL AND active = 1`. |
| `0065_webhook_subscription.sql` | `webhook_subscription` | WS3 Epic 2 — outbound notification subscribers. `kind ∈ {generic, slack, email}`. Generic delivery is HMAC-SHA256 signed with `secret_hmac_key`. |
| `0070_promotion_policy.sql` | `promotion_policy`, `approval` | WS3 Epic 1 — auto-promotion + approval gates. `gate_kind ∈ {auto, manual, time_delay}`. The `approval` table has a partial unique index `(release_id, dest_target_id)` to prevent duplicate in-flight promotions. |
| `0071_promotion_health_gate.sql` | _(extends `promotion_policy`)_ | Optional health-probe gating between source and dest targets. |
| `0072_target_kind_cloud.*.sql` | _(constraint change)_ | Adds `cloud_vm` / `cloud_stack` to the `target.kind` CHECK. |

The `cloud_org_*` tables and `cloud_org_credential` are reserved
under the 0040–0049 migration block — see the comment in
`0040_cloud_budgets.sql` for the block-allocation convention. WS3
intentionally picked 0060+ to leave room for follow-on cloud work
in 0040–0049 and WS2 k8s work in 0050–0059.

Repo-level access is uniform: every new table is exposed via a
`*Repo` class on the storage driver that returns plain row records,
and every CHECK-enumerated status / kind column maps to a TypeScript
string-union type in `storage/types.ts` so verb code gets a
narrowed type without round-tripping through the database to
discover it.

## What's tested in CI vs operator-validated

CI runs the Postgres driver tests against
[`pg-mem`](https://github.com/oguimbal/pg-mem), an in-memory
Postgres-compatible engine. It covers the full CRUD surface across
all 12 repos, including the partial-unique-index invariant on
`deployment.target_id WHERE status='active'`.

Two semantics are **not faithfully emulated** by pg-mem and are
marked `it.skip("[integration only] …")` in
[`postgres-storage.test.ts`](../host/src/__tests__/postgres-storage.test.ts):

1. **`SELECT … FOR UPDATE SKIP LOCKED`** — pg-mem parses the AST but
   refuses to execute it. The `JobRepo.claimNext` SQL is the standard
   Postgres claim-by-skip pattern. Operators should validate against a
   real Postgres before relying on it for production runner queues.
2. **Concurrent-claim invariant under real connection pooling** — pg-mem
   serializes all queries on a single in-process engine; it can't
   demonstrate that two simultaneous `claimNext()` calls from different
   pool clients each see the row at most once. The SQLite suite proves
   the contract end-to-end (`BEGIN IMMEDIATE` + UPDATE-WHERE); the
   Postgres SQL is structurally equivalent.

To exercise the integration-only cases against a real Postgres, run:

```bash
docker run --rm -d --name signalman-pg \
  -e POSTGRES_PASSWORD=signalman \
  -e POSTGRES_USER=signalman \
  -e POSTGRES_DB=signalman \
  -p 5432:5432 \
  postgres:16

# Add a postgres-integration test file that drops the .skip's, point it
# at postgres://signalman:signalman@localhost:5432/signalman, and
# `npm test -- postgres-integration.test.ts`.
```

A formal `pgIntegration` test path with operator-supplied connection
strings will land in v0.3.1 alongside the multi-runner queue.

## Open questions / followups

- **Connection lifecycle.** v0.3.0 creates a `Pool` per
  `PostgresStorageDriver`. For long-lived `signalman serve` deployments
  this is fine; for one-shot CLI verbs against a remote Postgres the
  pool creation cost is real (one TCP handshake). The local-mode
  workflow doesn't hit Postgres directly, so this isn't a hot path yet.
- **`BlobDriver.resolveUriBySha`.** The local-FS layout is currently
  hardcoded in `http/app.ts`'s blob-download handler. When S3 lands,
  `BlobDriver` will grow a `resolveUriBySha(orgId, sha)` method and
  the hardcoded path-builder goes away.
- **Migration squashing.** As the schema grows past ~10 migrations
  we'll likely want a baseline-+-delta pattern. SQLite's `_migrations`
  ledger is the same shape on both drivers, so squashing affects both
  uniformly.
