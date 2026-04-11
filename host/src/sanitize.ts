/**
 * Input sanitization for shell command construction.
 *
 * ALL user-supplied values that will be interpolated into shell commands
 * MUST pass through these validators first.
 */

/** Validate a VM name — alphanumeric, hyphens, underscores only. */
export function sanitizeVmName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name)) {
    throw new Error(
      `Invalid VM name: "${name}". Must be 1-100 chars, alphanumeric/hyphens/underscores.`,
    );
  }
  return name;
}

/** Validate a checkpoint label. */
export function sanitizeLabel(label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_ -]{0,199}$/.test(label)) {
    throw new Error(
      `Invalid label: "${label}". Must be 1-200 chars, alphanumeric/spaces/hyphens/underscores.`,
    );
  }
  return label;
}

/** Validate and sanitize a file path for PowerShell interpolation. */
export function sanitizePath(path: string): string {
  // Reject null bytes
  if (path.includes("\0")) {
    throw new Error("Path contains null byte");
  }
  // Reject PowerShell injection characters
  if (/[;`$@{}|]/.test(path)) {
    throw new Error(`Path contains dangerous characters: "${path}"`);
  }
  // Reject single quotes (would break PowerShell string escaping)
  if (path.includes("'")) {
    throw new Error(`Path contains single quote: "${path}"`);
  }
  return path;
}

/** Validate a command name. */
export function sanitizeCommand(command: string): string {
  if (command.includes("\0")) {
    throw new Error("Command contains null byte");
  }
  if (/[;`$@{}|&]/.test(command)) {
    throw new Error(
      `Command contains shell metacharacters: "${command}"`,
    );
  }
  return command;
}

/** Escape a single argument for PowerShell single-quoted string. */
export function escapePowerShellArg(arg: string): string {
  // In PowerShell single-quoted strings, the only escape is '' for literal '
  return arg.replace(/'/g, "''");
}

/** Validate a URL for direct download. */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Invalid URL protocol: ${parsed.protocol}`);
    }
    return url;
  } catch (e) {
    throw new Error(`Invalid URL: "${url}" — ${e}`);
  }
}

/**
 * Clamp a timeout value between a minimum floor and a maximum ceiling.
 *
 * - `undefined` / `NaN` values default to 30_000ms.
 * - Values below 1_000ms are clamped up to 1_000ms.
 * - Values above `max` (default 600_000ms) are clamped down to `max`.
 *
 * @param timeout  - The raw timeout in milliseconds.
 * @param max      - Upper bound (default 600_000ms).
 * @returns A safe integer timeout in [1_000, max].
 */
export function sanitizeTimeout(
  timeout: number | undefined,
  max = 600_000,
): number {
  const t = timeout == null || Number.isNaN(timeout) ? 30_000 : timeout;
  return Math.max(1_000, Math.min(t, max));
}
