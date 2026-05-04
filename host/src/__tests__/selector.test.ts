import { describe, expect, it } from "vitest";

import { defaultConfig } from "../config.js";
import { buildBackendList } from "../hypervisors/selector.js";

describe("buildBackendList", () => {
  it("defaults to service before direct Hyper-V", () => {
    const names = buildBackendList(defaultConfig()).map((backend) => backend.name);

    expect(names[0]).toBe("service");
    expect(names.indexOf("service")).toBeLessThan(names.indexOf("hyperv"));
  });

  it("honors explicit direct Hyper-V preference without duplicating backends", () => {
    const config = defaultConfig();
    config.hypervisor.backend = "hyperv";

    const names = buildBackendList(config).map((backend) => backend.name);

    expect(names[0]).toBe("hyperv");
    expect(names.filter((name) => name === "hyperv")).toHaveLength(1);
    expect(names.filter((name) => name === "service")).toHaveLength(1);
  });
});
