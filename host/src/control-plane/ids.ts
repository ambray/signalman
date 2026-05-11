/**
 * ID and timestamp helpers for the control plane.
 *
 * IDs are ULIDs (Crockford base32, 26 chars, lexicographically sortable
 * by creation time). Timestamps are ISO-8601 UTC strings; SQLite stores
 * them as TEXT, Postgres can ingest the same strings into TIMESTAMPTZ.
 *
 * Both helpers are intentionally tiny so they can be inlined into hot
 * paths (artifact creation, audit-log writes) without ceremony.
 */

import { ulid } from "ulid";

/** Generate a new ULID. */
export function newId(): string {
  return ulid();
}

/** Current time as an ISO-8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString();
}
