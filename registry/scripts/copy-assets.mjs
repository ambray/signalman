#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets from src/ into dist/.
 *
 * tsc only handles .ts files; SQLite migration scripts must be
 * co-located with the compiled output so the migration runner can
 * read them. This script mirrors the directory layout under dist/.
 *
 * Currently copies: .sql files anywhere under src/.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, "..", "src");
const distRoot = path.resolve(__dirname, "..", "dist");

const ASSET_EXTS = new Set([".sql"]);

async function walk(dir) {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await walk(full);
    } else if (ASSET_EXTS.has(path.extname(entry.name))) {
      const rel = path.relative(srcRoot, full);
      const dest = path.join(distRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(full, dest);
      count += 1;
    }
  }
  return count;
}

const copied = await walk(srcRoot);
console.log(`copy-assets: copied ${copied} file(s) into ${distRoot}`);
