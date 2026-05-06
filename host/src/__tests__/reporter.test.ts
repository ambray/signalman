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

  // ── Phase-3 audit follow-up (2026-05-05) — toolBlocks synthesis ──
  //
  // The signalman driver-V3 scenarios use empty `assertions: []` and
  // express assertions inline as workflow.md `expect_*` parameters.
  // Pre-fix the JUnit reporter only counted `assertions:` entries,
  // so a scenario where step-2's `expect_exit_code` failed reported
  // `tests=0 failures=0`, indistinguishable from a green run.  These
  // tests pin the synthesis behaviour: every executed tool block
  // becomes a synthetic <testcase> in the JUnit report.

  function makeResultWithToolBlocks(): TestResult {
    return {
      scenario: 'fs-restrict-scenario',
      startedAt: '2026-05-05T00:00:00Z',
      finishedAt: '2026-05-05T00:02:00Z',
      durationMs: 120000,
      passed: false,
      score: 0.5,
      assertions: [], // canonical driver-V3 pattern
      toolBlocks: [
        { stepIndex: 0, tool: 'driver_load', passed: true, outputSnippet: '{"status":0}' },
        { stepIndex: 1, tool: 'kernel_etw_start', passed: true, outputSnippet: '{"status":0}' },
        {
          stepIndex: 2,
          tool: 'vm_run_command',
          passed: false,
          error: 'vm_run_command expectations failed: expect_exit_code: expected 0, got 1',
          outputSnippet: '{"passed":false,"steps":[]}',
        },
        { stepIndex: 3, tool: 'driver_unload', passed: true, outputSnippet: '{"status":0}' },
      ],
      screenshots: [],
      errors: [],
    };
  }

  it('synthesizes one <testcase> per tool block when assertions is empty', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeJunitReport(makeResultWithToolBlocks(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      // 4 tool blocks → tests=4
      expect(content).toContain('tests="4"');
      // 1 failed → failures=1
      expect(content).toContain('failures="1"');
      // Test names follow `step-<idx>.<tool>` shape
      expect(content).toContain('name="step-0.driver_load"');
      expect(content).toContain('name="step-2.vm_run_command"');
      expect(content).toContain('name="step-3.driver_unload"');
    } finally {
      cleanupDir(dir);
    }
  });

  it('emits <failure> with type="tool_block" for failed tool blocks', () => {
    const dir = makeTempDir();
    try {
      const filePath = writeJunitReport(makeResultWithToolBlocks(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('type="tool_block"');
      expect(content).toContain('expect_exit_code: expected 0, got 1');
      expect(content).toContain('Output snippet:');
    } finally {
      cleanupDir(dir);
    }
  });

  it('counts both assertions and tool blocks in the testsuite total', () => {
    const dir = makeTempDir();
    try {
      // Combine: 2 assertions (1 fail) + 4 tool blocks (1 fail) = tests=6, failures=2
      const result: TestResult = {
        ...makeResultWithToolBlocks(),
        assertions: [
          { id: 'a1', description: 'first', severity: 'high', passed: true },
          { id: 'a2', description: 'second', severity: 'critical', passed: false, error: 'bad' },
        ],
      };
      const filePath = writeJunitReport(result, dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('tests="6"');
      expect(content).toContain('failures="2"');
    } finally {
      cleanupDir(dir);
    }
  });

  it('reports tests=0 when both assertions and tool blocks are empty', () => {
    const dir = makeTempDir();
    try {
      const result: TestResult = {
        ...makeResult(),
        assertions: [],
        toolBlocks: [],
      };
      const filePath = writeJunitReport(result, dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('tests="0"');
      expect(content).toContain('failures="0"');
    } finally {
      cleanupDir(dir);
    }
  });

  it('handles legacy results without toolBlocks (backwards compat)', () => {
    const dir = makeTempDir();
    try {
      // Pre-Phase-3-audit TestResult shape (no toolBlocks key).
      const filePath = writeJunitReport(makeResult(), dir);
      const content = fs.readFileSync(filePath, 'utf-8');
      // Counts only the 2 assertions; no synthesized tool-block tests.
      expect(content).toContain('tests="2"');
    } finally {
      cleanupDir(dir);
    }
  });
});
