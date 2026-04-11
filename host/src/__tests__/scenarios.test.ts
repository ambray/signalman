import { describe, it, expect } from 'vitest';
import { extractToolBlocks, evaluateAssertions } from '../scenarios/runner.js';
import { parseNarrative, narrativeToSummary } from '../scenarios/narrative.js';

describe('extractToolBlocks', () => {
  it('extracts a single tool block', () => {
    const md =
      '# Test\n\nSome text\n\n```tool\nvm_run_command:\n  vm: test-vm\n  command: echo\n```\n';
    const blocks = extractToolBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool).toBe('vm_run_command');
    expect(blocks[0].params.vm).toBe('test-vm');
  });

  it('extracts multiple tool blocks', () => {
    const md =
      '```tool\nvm_start:\n  vm: vm1\n```\n\nSome prose\n\n```tool\nvm_stop:\n  vm: vm2\n```\n';
    const blocks = extractToolBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tool).toBe('vm_start');
    expect(blocks[1].tool).toBe('vm_stop');
  });

  it('captures context between blocks', () => {
    const md =
      'Introductory text.\n\n```tool\nwait:\n  duration_ms: 5000\n```\n';
    const blocks = extractToolBlocks(md);
    expect(blocks[0].context).toContain('Introductory text');
  });

  it('handles empty markdown', () => {
    expect(extractToolBlocks('')).toHaveLength(0);
  });

  it('ignores non-tool code blocks', () => {
    const md =
      '```python\nprint("hello")\n```\n\n```tool\nvm_start:\n  vm: test\n```\n';
    const blocks = extractToolBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool).toBe('vm_start');
  });

  it('handles tool block with numeric params', () => {
    const md = '```tool\nwait:\n  duration_ms: 1000\n```\n';
    const blocks = extractToolBlocks(md);
    expect(blocks[0].params.duration_ms).toBe(1000);
  });

  it('extracts tool name correctly from multi-key YAML', () => {
    const md = '```tool\nvm_run_command:\n  vm: test\n  command: dir\n  args:\n    - /b\n```\n';
    const blocks = extractToolBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool).toBe('vm_run_command');
    expect(blocks[0].params.args).toEqual(['/b']);
  });

  it('preserves empty context for first block', () => {
    const md = '```tool\nvm_start:\n  vm: test\n```\n';
    const blocks = extractToolBlocks(md);
    expect(blocks[0].context).toBe('');
  });
});

describe('parseNarrative', () => {
  it('extracts title from H1', () => {
    const md = '# My Workflow\n\nSome content.\n';
    const narrative = parseNarrative(md);
    expect(narrative.title).toBe('My Workflow');
  });

  it('extracts narrator from blockquote', () => {
    const md =
      '# Title\n\n> **Narrator**: This is the context.\n\n## Step 1\n';
    const narrative = parseNarrative(md);
    expect(narrative.narrator).toContain('This is the context');
  });

  it('parses steps from headings', () => {
    const md =
      '# Title\n\n## Step 1: Setup\n\nDo stuff.\n\n## Step 2: Execute\n\nRun things.\n';
    const narrative = parseNarrative(md);
    expect(narrative.steps).toHaveLength(2);
    expect(narrative.steps[0].heading).toBe('Step 1: Setup');
    expect(narrative.steps[1].heading).toBe('Step 2: Execute');
  });

  it('extracts tool blocks within steps', () => {
    const md =
      '# Title\n\n## Step 1\n\nLaunch VM.\n\n```tool\nvm_start:\n  vm: test\n```\n';
    const narrative = parseNarrative(md);
    expect(narrative.steps[0].toolBlocks).toHaveLength(1);
    expect(narrative.steps[0].toolBlocks[0].tool).toBe('vm_start');
  });

  it('handles empty narrative', () => {
    const narrative = parseNarrative('');
    expect(narrative.title).toBe('');
    expect(narrative.steps).toHaveLength(0);
  });

  it('sets correct heading level', () => {
    const md = '# Title\n\n## Level 2\n\n### Level 3\n';
    const narrative = parseNarrative(md);
    expect(narrative.steps[0].level).toBe(2);
    expect(narrative.steps[1].level).toBe(3);
  });

  it('preserves prose content within steps', () => {
    const md =
      '# Title\n\n## Step 1\n\nThis is important context.\nAnother line.\n';
    const narrative = parseNarrative(md);
    expect(narrative.steps[0].prose).toContain('This is important context.');
    expect(narrative.steps[0].prose).toContain('Another line.');
  });

  it('handles multi-line narrator blockquote', () => {
    const md =
      '# Title\n\n> **Narrator**: First line.\n> Second line.\n> Third line.\n\n## Step 1\n';
    const narrative = parseNarrative(md);
    expect(narrative.narrator).toContain('First line');
    expect(narrative.narrator).toContain('Second line');
    expect(narrative.narrator).toContain('Third line');
  });

  it('captures preceding prose in tool blocks', () => {
    const md =
      '# Title\n\n## Step 1\n\nSome context here.\n\n```tool\nvm_start:\n  vm: x\n```\n';
    const narrative = parseNarrative(md);
    expect(narrative.steps[0].toolBlocks[0].precedingProse).toContain(
      'Some context here',
    );
  });
});

describe('narrativeToSummary', () => {
  it('generates summary with step counts', () => {
    const narrative = {
      title: 'Test',
      narrator: 'Some context',
      steps: [
        {
          heading: 'Step 1',
          level: 2,
          prose: '',
          toolBlocks: [
            {
              tool: 'vm_start',
              params: {},
              precedingProse: '',
            },
          ],
        },
      ],
    };
    const summary = narrativeToSummary(narrative);
    expect(summary).toContain('# Test');
    expect(summary).toContain('1 tool invocation');
  });

  it('includes narrator in summary', () => {
    const narrative = {
      title: 'My Test',
      narrator: 'Context about the test',
      steps: [],
    };
    const summary = narrativeToSummary(narrative);
    expect(summary).toContain('Context about the test');
  });

  it('shows correct heading levels', () => {
    const narrative = {
      title: 'Title',
      narrator: '',
      steps: [
        { heading: 'H2 Step', level: 2, prose: '', toolBlocks: [] },
        { heading: 'H3 Step', level: 3, prose: '', toolBlocks: [] },
      ],
    };
    const summary = narrativeToSummary(narrative);
    expect(summary).toContain('## H2 Step');
    expect(summary).toContain('### H3 Step');
  });

  it('handles empty steps', () => {
    const narrative = {
      title: 'Empty',
      narrator: '',
      steps: [],
    };
    const summary = narrativeToSummary(narrative);
    expect(summary).toContain('# Empty');
  });

  it('shows multiple tool invocations', () => {
    const narrative = {
      title: 'Multi',
      narrator: '',
      steps: [
        {
          heading: 'Step 1',
          level: 2,
          prose: '',
          toolBlocks: [
            { tool: 'a', params: {}, precedingProse: '' },
            { tool: 'b', params: {}, precedingProse: '' },
            { tool: 'c', params: {}, precedingProse: '' },
          ],
        },
      ],
    };
    const summary = narrativeToSummary(narrative);
    expect(summary).toContain('3 tool invocation');
  });
});

describe('evaluateAssertions', () => {
  it('passes when stdout contains expected string', () => {
    const config = {
      assertions: [
        {
          id: 'test-1',
          type: 'command_output' as const,
          source: 'step-1',
          description: 'test',
          expect: { stdout_contains: 'hello' },
          severity: 'high' as const,
        },
      ],
      pass_threshold: 1.0,
      critical_must_pass: true,
    };
    const outputs = new Map([['step-1', 'hello world']]);
    const { results, passed, score } = evaluateAssertions(
      config,
      outputs,
      new Map(),
    );
    expect(results[0].passed).toBe(true);
    expect(passed).toBe(true);
    expect(score).toBe(1.0);
  });

  it('fails when stdout does not contain expected', () => {
    const config = {
      assertions: [
        {
          id: 'test-1',
          type: 'command_output' as const,
          source: 'step-1',
          description: 'test',
          expect: { stdout_contains: 'missing' },
          severity: 'high' as const,
        },
      ],
      pass_threshold: 1.0,
      critical_must_pass: true,
    };
    const outputs = new Map([['step-1', 'hello world']]);
    const { results, passed } = evaluateAssertions(
      config,
      outputs,
      new Map(),
    );
    expect(results[0].passed).toBe(false);
    expect(passed).toBe(false);
  });

  it('reports missing source as error', () => {
    const config = {
      assertions: [
        {
          id: 'test-1',
          type: 'command_output' as const,
          source: 'missing',
          description: 'test',
          expect: { stdout_contains: 'x' },
          severity: 'low' as const,
        },
      ],
      pass_threshold: 0.0,
      critical_must_pass: false,
    };
    const { results } = evaluateAssertions(config, new Map(), new Map());
    expect(results[0].error).toContain('No output');
  });

  it('respects pass_threshold', () => {
    const config = {
      assertions: [
        {
          id: 'pass',
          type: 'command_output' as const,
          source: 's1',
          description: 'passes',
          expect: { stdout_contains: 'ok' },
          severity: 'low' as const,
        },
        {
          id: 'fail',
          type: 'command_output' as const,
          source: 's2',
          description: 'fails',
          expect: { stdout_contains: 'missing' },
          severity: 'low' as const,
        },
      ],
      pass_threshold: 0.5,
      critical_must_pass: false,
    };
    const outputs = new Map([
      ['s1', 'ok'],
      ['s2', 'nope'],
    ]);
    const { passed, score } = evaluateAssertions(config, outputs, new Map());
    expect(score).toBe(0.5);
    expect(passed).toBe(true);
  });

  it('fails when critical assertion fails despite threshold', () => {
    const config = {
      assertions: [
        {
          id: 'pass',
          type: 'command_output' as const,
          source: 's1',
          description: 'passes',
          expect: { stdout_contains: 'ok' },
          severity: 'low' as const,
        },
        {
          id: 'critical-fail',
          type: 'command_output' as const,
          source: 's2',
          description: 'critical',
          expect: { stdout_contains: 'missing' },
          severity: 'critical' as const,
        },
      ],
      pass_threshold: 0.5,
      critical_must_pass: true,
    };
    const outputs = new Map([
      ['s1', 'ok'],
      ['s2', 'nope'],
    ]);
    const { passed } = evaluateAssertions(config, outputs, new Map());
    expect(passed).toBe(false);
  });

  it('matches regex with stdout_matches', () => {
    const config = {
      assertions: [
        {
          id: 'regex',
          type: 'command_output' as const,
          source: 's1',
          description: 'regex test',
          expect: { stdout_matches: 'v\\d+\\.\\d+' },
          severity: 'low' as const,
        },
      ],
      pass_threshold: 1.0,
      critical_must_pass: false,
    };
    const outputs = new Map([['s1', 'version v1.23']]);
    const { results } = evaluateAssertions(config, outputs, new Map());
    expect(results[0].passed).toBe(true);
  });

  it('returns score 0 for empty assertions', () => {
    const config = {
      assertions: [],
      pass_threshold: 1.0,
      critical_must_pass: true,
    };
    const { score } = evaluateAssertions(config, new Map(), new Map());
    expect(score).toBe(0);
  });

  it('handles screenshot_check type with existing screenshot', () => {
    const config = {
      assertions: [
        {
          id: 'ss-1',
          type: 'screenshot_check' as const,
          source: 'screen1',
          description: 'check screenshot',
          expect: {},
          severity: 'medium' as const,
        },
      ],
      pass_threshold: 1.0,
      critical_must_pass: false,
    };
    const screenshots = new Map([['screen1', '/path/to/screenshot.png']]);
    const { results } = evaluateAssertions(config, new Map(), screenshots);
    expect(results[0].passed).toBe(true);
  });

  it('handles screenshot_check type with missing screenshot', () => {
    const config = {
      assertions: [
        {
          id: 'ss-1',
          type: 'screenshot_check' as const,
          source: 'screen1',
          description: 'check screenshot',
          expect: {},
          severity: 'low' as const,
        },
      ],
      pass_threshold: 0.0,
      critical_must_pass: false,
    };
    const { results } = evaluateAssertions(config, new Map(), new Map());
    expect(results[0].error).toContain('Screenshot not captured');
  });

  it('handles process_state with json_field check', () => {
    const config = {
      assertions: [
        {
          id: 'ps-1',
          type: 'process_state' as const,
          source: 's1',
          description: 'check process',
          expect: { json_field: 'status', json_field_not_equals: 'running' },
          severity: 'high' as const,
        },
      ],
      pass_threshold: 1.0,
      critical_must_pass: false,
    };
    const outputs = new Map([['s1', '{"status": "stopped"}']]);
    const { results } = evaluateAssertions(config, outputs, new Map());
    expect(results[0].passed).toBe(true);
  });
});
