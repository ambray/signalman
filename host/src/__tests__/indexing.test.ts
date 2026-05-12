/**
 * Tests for the best-effort scenario indexing hook.
 *
 * Confirms that `indexListResult` writes catalog rows from a runList
 * result, skips broken entries (those with `error`), and degrades
 * gracefully (returns instead of throwing) when storage isn't usable.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexListResult } from "../verbs/indexing.js";
import { ControlPlane } from "../control-plane/index.js";
import type { ListResult } from "../verbs/list.js";

let dataDir: string;
let priorDataDirEnv: string | undefined;

beforeEach(async () => {
  // The indexing module opens a ControlPlane from config + env. Point
  // it at a per-test data dir so concurrent tests don't share state.
  priorDataDirEnv = process.env.SIGNALMAN_DATA_DIR;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "signalman-indexing-"));
  process.env.SIGNALMAN_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (priorDataDirEnv === undefined) delete process.env.SIGNALMAN_DATA_DIR;
  else process.env.SIGNALMAN_DATA_DIR = priorDataDirEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function withFreshControlPlane(): Promise<ControlPlane> {
  const cp = ControlPlane.fromConfig();
  await cp.init();
  return cp;
}

describe("indexListResult", () => {
  it("upserts every well-formed entry into the scenario catalog", async () => {
    const list: ListResult = {
      scenarios: [
        {
          id: "example-v2-network-egress",
          path: ".signalman/scenarios/example-v2-network-egress",
          name: "Example v2 Network Egress",
          tags: ["smoke", "example-product"],
          scenario_hash: "sha256:abc",
        },
        {
          id: "silo-validation",
          path: ".signalman/scenarios/silo-validation",
          name: "Silo Validation",
          tags: ["torture"],
          scenario_hash: "sha256:def",
        },
      ],
    };
    await indexListResult(list);

    const cp = await withFreshControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const rows = await cp.scenarios.listForOrg(defaultOrg.id);
      expect(rows.map((r) => r.path).sort()).toEqual([
        ".signalman/scenarios/example-v2-network-egress",
        ".signalman/scenarios/silo-validation",
      ]);
      const egress = rows.find((r) =>
        r.path.endsWith("example-v2-network-egress"),
      )!;
      expect(egress.name).toBe("Example v2 Network Egress");
      expect(egress.tags).toEqual(["smoke", "example-product"]);
      expect(egress.source).toBe("disk");
    } finally {
      await cp.close();
    }
  });

  it("re-indexing updates the existing row (same path) — not a duplicate", async () => {
    const initial: ListResult = {
      scenarios: [
        {
          id: "x",
          path: ".signalman/scenarios/x",
          name: "X v1",
          tags: ["a"],
          scenario_hash: "sha256:1",
        },
      ],
    };
    await indexListResult(initial);
    const updated: ListResult = {
      scenarios: [
        {
          id: "x",
          path: ".signalman/scenarios/x",
          name: "X v2",
          tags: ["a", "b"],
          scenario_hash: "sha256:2",
        },
      ],
    };
    await indexListResult(updated);

    const cp = await withFreshControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const rows = await cp.scenarios.listForOrg(defaultOrg.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("X v2");
      expect(rows[0].scenarioHash).toBe("sha256:2");
      expect(rows[0].tags).toEqual(["a", "b"]);
    } finally {
      await cp.close();
    }
  });

  it("skips entries that have an error (broken YAML, etc.)", async () => {
    const list: ListResult = {
      scenarios: [
        {
          id: "good",
          path: ".signalman/scenarios/good",
          name: "Good",
          tags: [],
          scenario_hash: "sha256:g",
        },
        {
          id: "broken",
          path: ".signalman/scenarios/broken",
          error: "yaml-parse: bad indent",
        },
      ],
    };
    await indexListResult(list);
    const cp = await withFreshControlPlane();
    try {
      const { defaultOrg } = await cp.init();
      const rows = await cp.scenarios.listForOrg(defaultOrg.id);
      expect(rows.map((r) => r.path)).toEqual([".signalman/scenarios/good"]);
    } finally {
      await cp.close();
    }
  });

  it("returns without throwing on an empty list", async () => {
    await expect(indexListResult({ scenarios: [] })).resolves.toBeUndefined();
  });
});
