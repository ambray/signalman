#!/usr/bin/env node
/**
 * `signalman-registry` CLI.
 *
 * v0.4.0 verbs:
 *   - `signalman-registry serve --port 8443 --storage-root ./data`
 *       Boot the HTTP API against a local-FS + SQLite store.
 *   - `signalman-registry verify <manifest-path> --public-key <pem>`
 *       Read a manifest JSON file and verify its embedded signature.
 *   - `signalman-registry keygen [--out-dir <dir>]`
 *       Generate an Ed25519 keypair, print fingerprint, optionally
 *       write `registry-signing.pub.pem` / `.key.pem` into a dir.
 *
 * Exit codes:
 *   0 — success
 *   1 — operational error (file missing, signature invalid)
 *   2 — usage error (bad flags)
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as process from "node:process";
import {
  fingerprintPublicKey,
  generateKeypair,
  SignatureVerificationError,
  verifyManifestInline,
} from "./signing.js";
import { LocalFsRegistryStorage } from "./storage/registry-storage.js";
import { createServer } from "./http/server.js";
import type { Manifest } from "./types.js";

// Exported so the CLI test suite can drive the parser directly
// without spawning a subprocess.
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  /**
   * Hook used by `serve` to keep the test from blocking on a real
   * `listen()`. Tests pass a function that resolves immediately and
   * returns a stop handle; production passes undefined to use the
   * real `createServer` from `http/server.ts`.
   */
  startServer?: typeof createServer;
}

export async function runCli(
  argv: string[],
  opts: CliOptions = {},
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = (s: string) => stdout.push(s);
  const err = (s: string) => stderr.push(s);

  const [verb, ...rest] = argv;
  if (!verb || verb === "--help" || verb === "-h") {
    out(usage());
    return { exitCode: verb ? 0 : 2, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }
  try {
    switch (verb) {
      case "serve": {
        const args = parseFlags(rest, ["port", "host", "storage-root"]);
        const port = args.flags.port ? Number(args.flags.port) : 8443;
        if (!Number.isFinite(port) || port < 0 || port > 65535) {
          err(`bad --port: ${args.flags.port}`);
          return done(stdout, stderr, 2);
        }
        const host = args.flags.host ?? "127.0.0.1";
        const storageRoot = args.flags["storage-root"];
        if (!storageRoot) {
          err("--storage-root is required");
          return done(stdout, stderr, 2);
        }
        const storage = LocalFsRegistryStorage.fromRoot(storageRoot);
        const start = opts.startServer ?? createServer;
        const handle = await start({ storage, host, port });
        out(`signalman-registry listening on ${handle.baseUrl}`);
        // Hook SIGINT for graceful shutdown in real runs; tests inject
        // an alternate startServer and consume the stdout immediately.
        if (!opts.startServer) {
          await new Promise<void>((resolve) => {
            process.once("SIGINT", () => resolve());
            process.once("SIGTERM", () => resolve());
          });
          await handle.close();
        }
        // Always close the SQLite store, even in test mode — otherwise
        // Windows holds a file lock on the .db-shm/.db-wal sidecars
        // and the test harness's afterEach rm() fails with EBUSY.
        storage.close();
        return done(stdout, stderr, 0);
      }

      case "verify": {
        const args = parseFlags(rest, ["public-key"]);
        const manifestPath = args.positional[0];
        const publicKeyPath = args.flags["public-key"];
        if (!manifestPath || !publicKeyPath) {
          err("usage: signalman-registry verify <manifest-path> --public-key <pem>");
          return done(stdout, stderr, 2);
        }
        const raw = await fsp.readFile(manifestPath, "utf-8");
        let manifest: Manifest;
        try {
          manifest = JSON.parse(raw) as Manifest;
        } catch (parseErr) {
          err(`could not parse manifest JSON: ${(parseErr as Error).message}`);
          return done(stdout, stderr, 1);
        }
        const publicKeyPem = await fsp.readFile(publicKeyPath, "utf-8");
        try {
          verifyManifestInline(manifest, publicKeyPem);
        } catch (verifyErr) {
          if (verifyErr instanceof SignatureVerificationError) {
            err(`signature verification FAILED: ${verifyErr.message}`);
            return done(stdout, stderr, 1);
          }
          throw verifyErr;
        }
        out(`signature OK (signed_by=${manifest.signature?.signedBy ?? "?"})`);
        return done(stdout, stderr, 0);
      }

      case "keygen": {
        const args = parseFlags(rest, ["out-dir"]);
        const keypair = generateKeypair();
        const fingerprint = fingerprintPublicKey(keypair.publicKeyPem);
        const outDir = args.flags["out-dir"];
        if (outDir) {
          await fsp.mkdir(outDir, { recursive: true });
          const pubPath = path.join(outDir, "registry-signing.pub.pem");
          const privPath = path.join(outDir, "registry-signing.key.pem");
          await fsp.writeFile(pubPath, keypair.publicKeyPem, "utf-8");
          await fsp.writeFile(privPath, keypair.privateKeyPem, {
            encoding: "utf-8",
            mode: 0o600,
          });
          out(`wrote ${pubPath}`);
          out(`wrote ${privPath}`);
        } else {
          out("-----BEGIN PUBLIC KEY-----");
          out(keypair.publicKeyPem.trim());
          out("-----BEGIN PRIVATE KEY-----");
          out(keypair.privateKeyPem.trim());
        }
        out(`fingerprint=${fingerprint}`);
        return done(stdout, stderr, 0);
      }

      // WS6 wave-3 M10.6 — virtual / audit / forensic verbs.
      case "virtual": {
        return await runVirtualVerb(rest, out, err);
      }
      case "audit": {
        return await runAuditVerb(rest, out, err);
      }
      case "forensic": {
        return await runForensicVerb(rest, out, err);
      }

      default: {
        err(`unknown verb: ${verb}`);
        err(usage());
        return done(stdout, stderr, 2);
      }
    }
  } catch (caught) {
    err(`error: ${(caught as Error).message}`);
    return done(stdout, stderr, 1);
  }
}

// ── WS6 wave-3 M10.6 — virtual / audit / forensic CLI verbs ──────

async function runVirtualVerb(
  rest: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const localOut = (s: string) => {
    out(s);
    stdout.push(s);
  };
  const localErr = (s: string) => {
    err(s);
    stderr.push(s);
  };
  const [sub, ...subRest] = rest;
  if (!sub) {
    localErr("usage: signalman-registry virtual <add|list|remove> ...");
    return done(stdout, stderr, 2);
  }
  switch (sub) {
    case "add": {
      const args = parseFlags(
        subRest,
        ["storage-root", "org", "kind", "upstream", "allow", "deny"],
        ["resign"],
      );
      const storageRoot = args.flags["storage-root"];
      const org = args.flags.org;
      const kind = args.flags.kind;
      const upstream = args.flags.upstream;
      if (!storageRoot || !org || !kind || !upstream) {
        localErr(
          "usage: signalman-registry virtual add --storage-root <p> --org <o> --kind <k> --upstream <url> [--resign] [--allow <glob>...] [--deny <glob>...]",
        );
        return done(stdout, stderr, 2);
      }
      if (!["cargo", "npm", "oci", "maven", "pip", "helm"].includes(kind)) {
        localErr(`unknown kind: ${kind}`);
        return done(stdout, stderr, 2);
      }
      const storage = LocalFsRegistryStorage.fromRoot(storageRoot);
      try {
        const config: Record<string, unknown> = {};
        if (args.flags.resign !== undefined) config.resign_on_cache = true;
        if (args.flags.allow) config.allow_patterns = args.flags.allow.split(",");
        if (args.flags.deny) config.deny_patterns = args.flags.deny.split(",");
        const row = storage.index.addVirtualUpstream({
          org,
          kind: kind as "cargo" | "npm" | "oci" | "maven" | "pip" | "helm",
          upstreamUrl: upstream,
          config,
        });
        localOut(JSON.stringify(row, null, 2));
        return done(stdout, stderr, 0);
      } finally {
        storage.close();
      }
    }
    case "list": {
      const args = parseFlags(
        subRest,
        ["storage-root", "org", "kind"],
        ["include-disabled"],
      );
      const storageRoot = args.flags["storage-root"];
      const org = args.flags.org;
      if (!storageRoot || !org) {
        localErr(
          "usage: signalman-registry virtual list --storage-root <p> --org <o> [--kind <k>] [--include-disabled]",
        );
        return done(stdout, stderr, 2);
      }
      const storage = LocalFsRegistryStorage.fromRoot(storageRoot);
      try {
        const rows = storage.index.listVirtualUpstreams({
          org,
          ...(args.flags.kind ? { kind: args.flags.kind as "cargo" | "npm" | "oci" | "maven" | "pip" | "helm" } : {}),
          includeDisabled: args.flags["include-disabled"] !== undefined,
        });
        localOut(JSON.stringify(rows, null, 2));
        return done(stdout, stderr, 0);
      } finally {
        storage.close();
      }
    }
    case "remove": {
      const args = parseFlags(subRest, ["storage-root", "id"]);
      const storageRoot = args.flags["storage-root"];
      const id = args.flags.id;
      if (!storageRoot || !id) {
        localErr(
          "usage: signalman-registry virtual remove --storage-root <p> --id <id>",
        );
        return done(stdout, stderr, 2);
      }
      const storage = LocalFsRegistryStorage.fromRoot(storageRoot);
      try {
        storage.index.removeVirtualUpstream(id);
        localOut(`removed virtual upstream ${id}`);
        return done(stdout, stderr, 0);
      } finally {
        storage.close();
      }
    }
    default: {
      localErr(`unknown virtual subcommand: ${sub}`);
      return done(stdout, stderr, 2);
    }
  }
}

async function runAuditVerb(
  rest: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const args = parseFlags(rest, [
    "storage-root",
    "action",
    "entity-type",
    "entity-id",
    "actor",
    "since",
    "limit",
  ]);
  const storageRoot = args.flags["storage-root"];
  if (!storageRoot) {
    err("usage: signalman-registry audit --storage-root <p> [--action <a>] [--entity-type <t>] [--entity-id <id>] [--actor <a>] [--since <iso>] [--limit <n>]");
    stderr.push("usage error");
    return done(stdout, stderr, 2);
  }
  const limit = args.flags.limit ? Number(args.flags.limit) : 200;
  if (!Number.isInteger(limit) || limit < 1) {
    err(`bad --limit: ${args.flags.limit}`);
    stderr.push("bad limit");
    return done(stdout, stderr, 2);
  }
  const storage = LocalFsRegistryStorage.fromRoot(storageRoot);
  try {
    const entries = storage.index.listAuditEntries({
      ...(args.flags.action ? { action: args.flags.action as never } : {}),
      ...(args.flags["entity-type"] ? { entityType: args.flags["entity-type"] as never } : {}),
      ...(args.flags["entity-id"] ? { entityId: args.flags["entity-id"] } : {}),
      ...(args.flags.actor ? { actor: args.flags.actor } : {}),
      ...(args.flags.since ? { since: args.flags.since } : {}),
      limit,
    });
    out(JSON.stringify(entries, null, 2));
    stdout.push(JSON.stringify(entries, null, 2));
    return done(stdout, stderr, 0);
  } finally {
    storage.close();
  }
}

async function runForensicVerb(
  rest: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const [sub, ...subRest] = rest;
  if (!sub) {
    err("usage: signalman-registry forensic <summary|upstreams> ...");
    return done(stdout, stderr, 2);
  }
  const args = parseFlags(subRest, ["storage-root"]);
  const storageRoot = args.flags["storage-root"];
  if (!storageRoot) {
    err("usage: signalman-registry forensic <summary|upstreams> --storage-root <p>");
    return done(stdout, stderr, 2);
  }
  const storage = LocalFsRegistryStorage.fromRoot(storageRoot);
  try {
    if (sub === "summary") {
      const counts = storage.index.manifestCountsByKindAndSource();
      const byKind: Record<string, Record<string, number>> = {};
      let total = 0;
      for (const r of counts) {
        byKind[r.kind] ??= {};
        byKind[r.kind][r.source] = r.count;
        total += r.count;
      }
      const body = { total_manifests: total, by_kind: byKind, raw: counts };
      out(JSON.stringify(body, null, 2));
      stdout.push(JSON.stringify(body, null, 2));
      return done(stdout, stderr, 0);
    }
    if (sub === "upstreams") {
      const rows = storage.index.artifactsByUpstream();
      out(JSON.stringify(rows, null, 2));
      stdout.push(JSON.stringify(rows, null, 2));
      return done(stdout, stderr, 0);
    }
    err(`unknown forensic subcommand: ${sub}`);
    return done(stdout, stderr, 2);
  } finally {
    storage.close();
  }
}

function done(stdout: string[], stderr: string[], exitCode: number): CliResult {
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

interface ParsedFlags {
  flags: Record<string, string | undefined>;
  positional: string[];
}

function parseFlags(
  args: string[],
  allowed: readonly string[],
  booleans: readonly string[] = [],
): ParsedFlags {
  const flags: Record<string, string | undefined> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!allowed.includes(name) && !booleans.includes(name)) {
        throw new Error(`unknown flag: --${name}`);
      }
      if (booleans.includes(name)) {
        flags[name] = "true";
        continue;
      }
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      flags[name] = next;
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function usage(): string {
  return [
    "Usage: signalman-registry <verb> [options]",
    "",
    "Verbs:",
    "  serve --storage-root <dir> [--port 8443] [--host 127.0.0.1]",
    "      Boot the HTTP API against a local-FS + SQLite store.",
    "",
    "  verify <manifest-path> --public-key <pem-path>",
    "      Read a manifest JSON file and verify its embedded signature",
    "      against the given Ed25519 public key.",
    "",
    "  keygen [--out-dir <dir>]",
    "      Generate an Ed25519 keypair. Prints both keys + fingerprint",
    "      to stdout; with --out-dir, writes registry-signing.pub.pem",
    "      and registry-signing.key.pem (mode 600) into the directory.",
    "",
    "  virtual add --storage-root <p> --org <o> --kind <k> --upstream <url>",
    "              [--resign] [--allow <glob>] [--deny <glob>]",
    "      Register a virtual-upstream row. The registry proxies + caches",
    "      <kind> requests for <org> against <url> on local miss.",
    "",
    "  virtual list --storage-root <p> --org <o> [--kind <k>] [--include-disabled]",
    "  virtual remove --storage-root <p> --id <id>",
    "",
    "  audit --storage-root <p> [--action <a>] [--entity-type <t>]",
    "        [--entity-id <id>] [--actor <a>] [--since <iso>] [--limit <n>]",
    "      Query the immutable audit log. Filters AND-combine.",
    "",
    "  forensic summary --storage-root <p>",
    "      Manifest counts grouped by (kind, provenance.source).",
    "  forensic upstreams --storage-root <p>",
    "      Per-upstream counts of proxy_cache manifests.",
  ].join("\n");
}

// Top-level invocation when run via the bin script. Tests import the
// module and call `runCli` directly so they don't trigger this path.
const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("cli.js");
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((res) => {
      if (res.stdout) process.stdout.write(`${res.stdout}\n`);
      if (res.stderr) process.stderr.write(`${res.stderr}\n`);
      process.exit(res.exitCode);
    })
    .catch((caught) => {
      process.stderr.write(`fatal: ${(caught as Error).stack ?? caught}\n`);
      process.exit(1);
    });
}
