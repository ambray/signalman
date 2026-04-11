import { describe, it, expect } from 'vitest';
import {
  writeJunitReport,
  writeMarkdownReport,
  writeJsonReport,
} from '../output/reporter.js';
import type { TestResult } from '../output/reporter.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function makeResult(passed = true): TestResult {
  return {
    scenario: 'test-scenario',
    startedAt: '2026-04-11T00:00:00Z',
    finishedAt: '2026-04-11T00:01:00Z',
    durationMs: 60000,
    passed,
    score: passed ? 1.0 : 0.5,
    assertions: [
      {
        id: 'a1',
        description: 'first check',
        severity: 'high',
        passed: true,
      },
      {
        id: 'a2',
        description: 'second check',
        severity: 'critical',
        passed,
        actual: passed ? 'ok' : 'bad',
        error: passed ? undefined : 'failed',
      },
    ],
    screenshots: [],
    errors: passed ? [] : ['Something went wrong'],
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'signalman-test-'));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true });
}

describe('writeJsonReport', () => {
  it('writes valid JSON file', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeJsonReport(makeResult(), dir);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.scenario).toBe('test-scenario');
      expect(content.assertions).toHaveLength(2);
    } finally {
      cleanupDir(dir);
    }
  });

  it('preserves all fields in JSON', () => {
    const dir = makeTempDir();
    try {
      const result = makeResult(false);
      const filePath = writeJsonReport(result, dir);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(content.passed).toBe(false);
      expect(content.score).toBe(0.5);
      expect(content.durationMs).toBe(60000);
      expect(content.errors).toEqual(['Something went wrong']);
    } finally {
      cleanupDir(dir);
    }
  });

  it('creates output directory if it does not exist', () => {
    const dir = makeTempDir();
    const nested = path.join(dir, 'nested', 'deep');
    try {
      writeJsonReport(makeResult(), nested);
      expect(fs.existsSync(nested)).toBe(true);
    } finally {
      cleanupDir(dir);
    }
  });
});

describe('writeMarkdownReport', () => {
  it('writes markdown with pass status', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeMarkdownReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('PASSED');
      expect(content).toContain('test-scenario');
    } finally {
      cleanupDir(dir);
    }
  });

  it('writes markdown with fail status and errors', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeMarkdownReport(makeResult(false), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('FAILED');
      expect(content).toContain('Something went wrong');
    } finally {
      cleanupDir(dir);
    }
  });

  it('includes assertion details', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeMarkdownReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('a1');
      expect(content).toContain('first check');
      expect(content).toContain('PASS');
    } finally {
      cleanupDir(dir);
    }
  });

  it('includes duration and timestamps', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeMarkdownReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('60000ms');
      expect(content).toContain('2026-04-11T00:00:00Z');
    } finally {
      cleanupDir(dir);
    }
  });

  it('includes score as percentage', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeMarkdownReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('100.0%');
    } finally {
      cleanupDir(dir);
    }
  });
});

describe('writeJunitReport', () => {
  it('writes valid XML', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeJunitReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('<?xml version="1.0"');
      expect(content).toContain('tests="2"');
      expect(content).toContain('failures="0"');
    } finally {
      cleanupDir(dir);
    }
  });

  it('includes failure details', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeJunitReport(makeResult(false), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('failures="1"');
      expect(content).toContain('<failure');
    } finally {
      cleanupDir(dir);
    }
  });

  it('escapes XML special characters', () => {
    const result = makeResult();
    result.scenario = 'test & <scenario>';
    const dir = makeTempDir();
    try {
      const filePath = writeJunitReport(result, dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('test &amp; &lt;scenario&gt;');
      expect(content).not.toContain('test & <scenario>');
    } finally {
      cleanupDir(dir);
    }
  });

  it('includes timestamp and duration', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeJunitReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('timestamp="2026-04-11T00:00:00Z"');
      expect(content).toContain('time="60.000"');
    } finally {
      cleanupDir(dir);
    }
  });

  it('includes testsuite and testcase structure', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeJunitReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('<testsuites>');
      expect(content).toContain('</testsuites>');
      expect(content).toContain('<testsuite');
      expect(content).toContain('<testcase');
    } finally {
      cleanupDir(dir);
    }
  });
});
