/**
 * Public entrypoint for `@signalman/registry`.
 *
 * Re-exports the types, storage drivers, signing helpers, and HTTP
 * application factory so embedders can build a registry process in
 * their own host. The `signalman-registry` BlobDriver in
 * `@signalman/host` imports nothing from this entrypoint; it only
 * talks to the registry over HTTP.
 *
 * Incrementally populated across the WS5 commit sequence; the
 * skeleton-only commit exports nothing yet.
 */

export {};
