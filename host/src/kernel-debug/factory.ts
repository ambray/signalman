/**
 * Default kernel-debug session factory.
 *
 * Exists as a standalone module so the orchestrator (which owns the
 * factory-injection hook) doesn't need to import the concrete
 * `KdSession` class. Anything that wants a real (kd.exe-spawning)
 * session calls `createRealKdSession(opts)`; tests substitute their
 * own factory via `orchestrator.setKdSessionFactory(...)`.
 *
 * Keeping this out of `orchestrator.ts` lets a future scenario runner
 * in a separate package use the orchestrator without pulling in the
 * `child_process`-using kd-session module unless it actually spawns
 * a kd process.
 */

import { KdSession, type KdSessionOptions } from "./kd-session.js";

/**
 * Signature every pluggable kd factory must satisfy. Named so the
 * orchestrator + tests can share it without re-declaring.
 */
export type KdSessionFactory = (opts: KdSessionOptions) => KdSession;

/**
 * Default factory: returns a fresh `KdSession` that will spawn kd.exe
 * when `.start()` is called. Stateless — safe to reuse across
 * multiple VMs in one scenario run.
 */
export const createRealKdSession: KdSessionFactory = (opts) =>
  new KdSession(opts);
