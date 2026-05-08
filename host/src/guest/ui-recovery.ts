import type { GuestAgentClient } from "./client.js";
import { ensureUiSidecar } from "./ui-sidecar.js";

export interface UiSidecarRecoveryOptions {
  username?: string;
  bind?: string;
  engine?: string;
  taskName?: string;
  waitReadyMs?: number;
  timeoutMs?: number;
}

export function isUiSidecarUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sidecar|ECONNREFUSED|connection refused|connect.*50151|deadline exceeded/i.test(message);
}

export async function withUiSidecarRecovery<T>(
  client: GuestAgentClient,
  options: UiSidecarRecoveryOptions | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (!options?.username || !isUiSidecarUnavailable(err)) {
      throw err;
    }
    await ensureUiSidecar(client, {
      username: options.username,
      bind: options.bind,
      engine: options.engine,
      taskName: options.taskName,
      runNow: true,
      waitReadyMs: options.waitReadyMs ?? 5_000,
      timeoutMs: options.timeoutMs,
    });
    return operation();
  }
}
