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

function done(stdout: string[], stderr: string[], exitCode: number): CliResult {
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

interface ParsedFlags {
  flags: Record<string, string | undefined>;
  positional: string[];
}

function parseFlags(args: string[], allowed: readonly string[]): ParsedFlags {
  const flags: Record<string, string | undefined> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!allowed.includes(name)) {
        throw new Error(`unknown flag: --${name}`);
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
