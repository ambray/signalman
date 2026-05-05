import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, loadConfig } from '../config.js';

describe('defaultConfig', () => {
  it('returns valid config structure', () => {
    const config = defaultConfig();
    expect(config.hypervisor.backend).toBe('service');
    expect(config.guestAgent.defaultPort).toBe(50051);
    expect(config.guestAgent.tls.enabled).toBe(false);
    // v0.1.0: default scenario path is `.signalman/scenarios` (P0 MCP
    // Surface Inversion). Legacy `./scenarios` still resolves via
    // src/scenarios/project-layout.ts when present.
    expect(config.scenarios.dir).toBe('./.signalman/scenarios');
    expect(config.scenarios.outputDir).toBe('./output');
  });

  it('returns fresh object each call', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a).toEqual(b);
    a.hypervisor.backend = 'vmware';
    expect(b.hypervisor.backend).toBe('service');
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

  it('has no tartPath by default', () => {
    const config = defaultConfig();
    expect(config.hypervisor.tartPath).toBeUndefined();
  });

  it('has no guest credentials by default', () => {
    const config = defaultConfig();
    expect(config.hypervisor.guestCredentials).toBeUndefined();
  });

  it('has no service transport override by default', () => {
    const config = defaultConfig();
    expect(config.hypervisor.service).toBeUndefined();
  });

  it('has no guest auth token by default', () => {
    const config = defaultConfig();
    expect(config.guestAgent.authToken).toBeUndefined();
  });
});

// ── guestAgent.tls block ──────────────────────────────────────────

describe('loadConfig — guestAgent.tls', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const TLS_ENV_KEYS = [
    'SIGNALMAN_GUEST_TLS',
    'SIGNALMAN_GUEST_TOKEN',
    'SIGNALMAN_GUEST_CA',
    'SIGNALMAN_GUEST_CERT',
    'SIGNALMAN_GUEST_KEY',
    'SIGNALMAN_SERVICE_HOST',
    'SIGNALMAN_SERVICE_PORT',
    'SIGNALMAN_SERVICE_CERT_DIR',
    'SIGNALMAN_CONFIG',
  ] as const;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalman-cfg-'));
    for (const k of TLS_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of TLS_ENV_KEYS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  it('loads guestAgent.tls block from YAML', () => {
    const cfgPath = path.join(tmpDir, 'signalman.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'guestAgent:',
        '  defaultPort: 50051',
        '  tls:',
        '    enabled: true',
        '    caPath: /etc/signalman/ca.pem',
        '    certPath: /etc/signalman/host.pem',
        '    keyPath: /etc/signalman/host.key',
      ].join('\n'),
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg.guestAgent.tls.enabled).toBe(true);
    expect(cfg.guestAgent.tls.caPath).toBe('/etc/signalman/ca.pem');
    expect(cfg.guestAgent.tls.certPath).toBe('/etc/signalman/host.pem');
    expect(cfg.guestAgent.tls.keyPath).toBe('/etc/signalman/host.key');
  });

  it('allows TLS block with only caPath (server-auth-only)', () => {
    const cfgPath = path.join(tmpDir, 'signalman.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'guestAgent:',
        '  tls:',
        '    enabled: true',
        '    caPath: /etc/signalman/ca.pem',
      ].join('\n'),
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg.guestAgent.tls.enabled).toBe(true);
    expect(cfg.guestAgent.tls.caPath).toBe('/etc/signalman/ca.pem');
    expect(cfg.guestAgent.tls.certPath).toBeUndefined();
    expect(cfg.guestAgent.tls.keyPath).toBeUndefined();
  });

  it('environment variables override YAML', () => {
    const cfgPath = path.join(tmpDir, 'signalman.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'guestAgent:',
        '  tls:',
        '    enabled: false',
        '    caPath: /yaml/ca.pem',
      ].join('\n'),
    );
    process.env.SIGNALMAN_GUEST_TLS = 'true';
    process.env.SIGNALMAN_GUEST_TOKEN = 'guest-secret';
    process.env.SIGNALMAN_GUEST_CA = '/env/ca.pem';
    process.env.SIGNALMAN_GUEST_CERT = '/env/host.pem';
    process.env.SIGNALMAN_GUEST_KEY = '/env/host.key';

    const cfg = loadConfig(cfgPath);
    expect(cfg.guestAgent.tls.enabled).toBe(true);
    expect(cfg.guestAgent.authToken).toBe('guest-secret');
    expect(cfg.guestAgent.tls.caPath).toBe('/env/ca.pem');
    expect(cfg.guestAgent.tls.certPath).toBe('/env/host.pem');
    expect(cfg.guestAgent.tls.keyPath).toBe('/env/host.key');
  });

  it('preserves existing tls fields when YAML omits them', () => {
    const cfgPath = path.join(tmpDir, 'signalman.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'hypervisor:',
        '  backend: hyperv',
      ].join('\n'),
    );
    const cfg = loadConfig(cfgPath);
    expect(cfg.guestAgent.tls.enabled).toBe(false);
    expect(cfg.guestAgent.tls.caPath).toBeUndefined();
  });

  it('loads service transport overrides from YAML', () => {
    const cfgPath = path.join(tmpDir, 'signalman.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'hypervisor:',
        '  backend: service',
        '  service:',
        '    host: 127.0.0.2',
        '    port: 17778',
        '    certDir: C:/Signalman/certs',
      ].join('\n'),
    );

    const cfg = loadConfig(cfgPath);
    expect(cfg.hypervisor.service).toEqual({
      host: '127.0.0.2',
      port: 17778,
      certDir: 'C:/Signalman/certs',
    });
  });

  it('lets environment variables override service transport settings', () => {
    const cfgPath = path.join(tmpDir, 'signalman.yaml');
    fs.writeFileSync(
      cfgPath,
      [
        'hypervisor:',
        '  backend: service',
        '  service:',
        '    host: 127.0.0.2',
        '    port: 17778',
        '    certDir: C:/Signalman/yaml-certs',
      ].join('\n'),
    );
    process.env.SIGNALMAN_SERVICE_HOST = '127.0.0.1';
    process.env.SIGNALMAN_SERVICE_PORT = '17779';
    process.env.SIGNALMAN_SERVICE_CERT_DIR = 'C:/Signalman/env-certs';

    const cfg = loadConfig(cfgPath);
    expect(cfg.hypervisor.service).toEqual({
      host: '127.0.0.1',
      port: 17779,
      certDir: 'C:/Signalman/env-certs',
    });
  });
});
