import { describe, it, expect } from 'vitest';
import {
  sanitizeVmName,
  sanitizeLabel,
  sanitizePath,
  sanitizeCommand,
  sanitizeCommandArg,
  escapePowerShellArg,
  sanitizeUrl,
  sanitizeTimeout,
} from '../sanitize.js';

describe('sanitizeVmName', () => {
  it('accepts valid names', () => {
    expect(sanitizeVmName('my-vm-01')).toBe('my-vm-01');
  });

  it('accepts underscores', () => {
    expect(sanitizeVmName('test_vm')).toBe('test_vm');
  });

  it('rejects empty string', () => {
    expect(() => sanitizeVmName('')).toThrow();
  });

  it('rejects special characters', () => {
    expect(() => sanitizeVmName("vm'; rm -rf /")).toThrow();
  });

  it('rejects spaces', () => {
    expect(() => sanitizeVmName('my vm')).toThrow();
  });

  it('rejects dots', () => {
    expect(() => sanitizeVmName('vm.test')).toThrow();
  });

  it('rejects names over 100 chars', () => {
    expect(() => sanitizeVmName('a'.repeat(101))).toThrow();
  });

  it('rejects names starting with hyphen', () => {
    expect(() => sanitizeVmName('-test')).toThrow();
  });

  it('accepts single character name', () => {
    expect(sanitizeVmName('a')).toBe('a');
  });

  it('accepts exactly 100 character name', () => {
    const name = 'a' + 'b'.repeat(99);
    expect(sanitizeVmName(name)).toBe(name);
  });

  it('accepts numeric-only names', () => {
    expect(sanitizeVmName('12345')).toBe('12345');
  });
});

describe('sanitizeLabel', () => {
  it('accepts valid labels with spaces', () => {
    expect(sanitizeLabel('my checkpoint 1')).toBe('my checkpoint 1');
  });

  it('rejects PowerShell injection', () => {
    expect(() => sanitizeLabel("'; Remove-Item /; '")).toThrow();
  });

  it('rejects labels over 200 chars', () => {
    expect(() => sanitizeLabel('a'.repeat(201))).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => sanitizeLabel('')).toThrow();
  });

  it('accepts hyphens and underscores', () => {
    expect(sanitizeLabel('before-test_run')).toBe('before-test_run');
  });

  it('rejects labels starting with space', () => {
    expect(() => sanitizeLabel(' leading space')).toThrow();
  });
});

describe('sanitizePath', () => {
  it('accepts normal paths', () => {
    expect(sanitizePath('C:\\Users\\test\\file.txt')).toBe(
      'C:\\Users\\test\\file.txt',
    );
  });

  it('rejects null bytes', () => {
    expect(() => sanitizePath('file\0.txt')).toThrow();
  });

  it('rejects PowerShell chars', () => {
    expect(() => sanitizePath('$(evil)')).toThrow();
  });

  it('rejects backticks', () => {
    expect(() => sanitizePath('file`test')).toThrow();
  });

  it('rejects single quotes', () => {
    expect(() => sanitizePath("file'test")).toThrow();
  });

  it('rejects semicolons', () => {
    expect(() => sanitizePath('C:\\path;evil')).toThrow();
  });

  it('rejects pipe characters', () => {
    expect(() => sanitizePath('file|evil')).toThrow();
  });

  it('rejects at signs', () => {
    expect(() => sanitizePath('@evil')).toThrow();
  });

  it('rejects curly braces', () => {
    expect(() => sanitizePath('file{test}')).toThrow();
  });

  it('rejects double quotes (PowerShell variable interpolation)', () => {
    expect(() => sanitizePath('C:\\path\\"$evil"')).toThrow();
    expect(() => sanitizePath('"test"')).toThrow();
  });

  it('accepts forward slashes', () => {
    expect(sanitizePath('C:/Users/test')).toBe('C:/Users/test');
  });
});

describe('sanitizeCommand', () => {
  it('accepts normal commands', () => {
    expect(sanitizeCommand('powershell')).toBe('powershell');
  });

  it('rejects semicolons', () => {
    expect(() => sanitizeCommand('cmd; evil')).toThrow();
  });

  it('rejects pipe', () => {
    expect(() => sanitizeCommand('cmd | evil')).toThrow();
  });

  it('rejects ampersand', () => {
    expect(() => sanitizeCommand('cmd & evil')).toThrow();
  });

  it('rejects null bytes', () => {
    expect(() => sanitizeCommand('cmd\0evil')).toThrow();
  });

  it('rejects backtick', () => {
    expect(() => sanitizeCommand('cmd`evil')).toThrow();
  });

  it('rejects dollar sign', () => {
    expect(() => sanitizeCommand('$evil')).toThrow();
  });

  it('accepts hyphenated commands', () => {
    expect(sanitizeCommand('Get-Process')).toBe('Get-Process');
  });
});

describe('sanitizeCommandArg', () => {
  it('accepts shell syntax because args are escaped data', () => {
    expect(sanitizeCommandArg('$value = Get-Content file.txt; Write-Output $value')).toBe(
      '$value = Get-Content file.txt; Write-Output $value',
    );
  });

  it('rejects null bytes', () => {
    expect(() => sanitizeCommandArg('arg\0evil')).toThrow();
  });
});

describe('escapePowerShellArg', () => {
  it('passes plain strings through', () => {
    expect(escapePowerShellArg('hello')).toBe('hello');
  });

  it('escapes single quotes by doubling', () => {
    expect(escapePowerShellArg("it's")).toBe("it''s");
  });

  it('handles multiple quotes', () => {
    expect(escapePowerShellArg("a'b'c")).toBe("a''b''c");
  });

  it('handles empty string', () => {
    expect(escapePowerShellArg('')).toBe('');
  });

  it('handles string of only quotes', () => {
    expect(escapePowerShellArg("'''")).toBe("''''''");
  });

  it('does not modify double quotes', () => {
    expect(escapePowerShellArg('"hello"')).toBe('"hello"');
  });
});

describe('sanitizeUrl', () => {
  it('accepts https URLs', () => {
    expect(sanitizeUrl('https://example.com/file.exe')).toBe(
      'https://example.com/file.exe',
    );
  });

  it('accepts http URLs', () => {
    expect(sanitizeUrl('http://example.com/file.exe')).toBe(
      'http://example.com/file.exe',
    );
  });

  it('rejects file:// URLs', () => {
    expect(() => sanitizeUrl('file:///etc/passwd')).toThrow();
  });

  it('rejects ftp:// URLs', () => {
    expect(() => sanitizeUrl('ftp://evil.com/file')).toThrow();
  });

  it('rejects non-URL strings', () => {
    expect(() => sanitizeUrl('not a url')).toThrow();
  });

  it('rejects javascript: protocol', () => {
    expect(() => sanitizeUrl('javascript:alert(1)')).toThrow();
  });

  it('rejects data: URLs', () => {
    expect(() => sanitizeUrl('data:text/html,<h1>hi</h1>')).toThrow();
  });

  it('accepts URLs with query strings', () => {
    expect(sanitizeUrl('https://example.com/file?v=1')).toBe(
      'https://example.com/file?v=1',
    );
  });
});

describe('sanitizeTimeout', () => {
  it('returns default 30000 for undefined', () => {
    expect(sanitizeTimeout(undefined)).toBe(30000);
  });

  it('accepts valid timeout within range', () => {
    expect(sanitizeTimeout(30000)).toBe(30000);
  });

  it('clamps below-minimum values up to 1000', () => {
    expect(sanitizeTimeout(500)).toBe(1000);
    expect(sanitizeTimeout(0)).toBe(1000);
    expect(sanitizeTimeout(-1)).toBe(1000);
  });

  it('clamps above-max values down to max', () => {
    expect(sanitizeTimeout(700000)).toBe(600000);
    expect(sanitizeTimeout(999999)).toBe(600000);
  });

  it('handles NaN by returning default then clamping', () => {
    expect(sanitizeTimeout(NaN)).toBe(30000);
  });

  it('accepts custom max and clamps accordingly', () => {
    expect(sanitizeTimeout(500000, 600000)).toBe(500000);
    expect(sanitizeTimeout(400000, 300000)).toBe(300000);
  });

  it('accepts exactly the min boundary (1000)', () => {
    expect(sanitizeTimeout(1000)).toBe(1000);
  });

  it('accepts exactly the max boundary (600000)', () => {
    expect(sanitizeTimeout(600000)).toBe(600000);
  });

  it('clamps negative values to minimum', () => {
    expect(sanitizeTimeout(-9999)).toBe(1000);
  });
});
