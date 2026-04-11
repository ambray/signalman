import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../config.js';

describe('defaultConfig', () => {
  it('returns valid config structure', () => {
    const config = defaultConfig();
    expect(config.hypervisor.backend).toBe('hyperv');
    expect(config.guestAgent.defaultPort).toBe(50051);
    expect(config.guestAgent.tls.enabled).toBe(false);
    expect(config.scenarios.dir).toBe('./scenarios');
    expect(config.scenarios.outputDir).toBe('./output');
  });

  it('returns fresh object each call', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a).toEqual(b);
    a.hypervisor.backend = 'vmware';
    expect(b.hypervisor.backend).toBe('hyperv');
  });

  it('includes screenshot directory', () => {
    const config = defaultConfig();
    expect(config.scenarios.screenshotDir).toBe('./output/screenshots');
  });

  it('has TLS disabled by default', () => {
    const config = defaultConfig();
    expect(config.guestAgent.tls.enabled).toBe(false);
    expect(config.guestAgent.tls.caPath).toBeUndefined();
    expect(config.guestAgent.tls.certPath).toBeUndefined();
    expect(config.guestAgent.tls.keyPath).toBeUndefined();
  });

  it('has no hub config by default', () => {
    const config = defaultConfig();
    expect(config.hub).toBeUndefined();
  });

  it('has no vmrunPath by default', () => {
    const config = defaultConfig();
    expect(config.hypervisor.vmrunPath).toBeUndefined();
  });

  it('has no guest credentials by default', () => {
    const config = defaultConfig();
    expect(config.hypervisor.guestCredentials).toBeUndefined();
  });
});
