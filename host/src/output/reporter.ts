/**
 * Output reporter — generates test result reports in multiple formats.
 *
 * Supports:
 * - JSON (machine-readable)
 * - Markdown (human-readable, good for PRs and docs)
 * - JUnit XML (CI integration — GitHub Actions, Jenkins, Azure DevOps)
 */

import * as fs from "fs";
import * as path from "path";

export interface TestResult {
  scenario: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  score: number;
  assertions: AssertionResultEntry[];
  screenshots: string[];
  errors: string[];
}

export interface AssertionResultEntry {
  id: string;
  description: string;
  severity: string;
  passed: boolean;
  actual?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// JSON reporter
// ---------------------------------------------------------------------------

export function writeJsonReport(result: TestResult, outputDir: string): string {
  const filePath = path.join(outputDir, "results.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Markdown reporter
// ---------------------------------------------------------------------------

export function writeMarkdownReport(
  result: TestResult,
  outputDir: string
): string {
  const filePath = path.join(outputDir, "results.md");
  fs.mkdirSync(outputDir, { recursive: true });

  let md = `# Test Results: ${result.scenario}\n\n`;
  md += `| Property | Value |\n|----------|-------|\n`;
  md += `| Status | ${result.passed ? "PASSED" : "FAILED"} |\n`;
  md += `| Score | ${(result.score * 100).toFixed(1)}% |\n`;
  md += `| Duration | ${result.durationMs}ms |\n`;
  md += `| Started | ${result.startedAt} |\n`;
  md += `| Finished | ${result.finishedAt} |\n\n`;

  md += `## Assertions\n\n`;
  md += `| # | ID | Severity | Status | Description |\n`;
  md += `|---|-----|----------|--------|-------------|\n`;

  result.assertions.forEach((a, i) => {
    const status = a.passed ? "PASS" : "FAIL";
    md += `| ${i + 1} | ${a.id} | ${a.severity} | ${status} | ${a.description} |\n`;
  });

  if (result.errors.length > 0) {
    md += `\n## Errors\n\n`;
    result.errors.forEach((e) => {
      md += `- ${e}\n`;
    });
  }

  if (result.screenshots.length > 0) {
    md += `\n## Screenshots\n\n`;
    result.screenshots.forEach((s) => {
      md += `![${path.basename(s)}](${s})\n\n`;
    });
  }

  fs.writeFileSync(filePath, md, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// JUnit XML reporter
// ---------------------------------------------------------------------------

export function writeJunitReport(
  result: TestResult,
  outputDir: string
): string {
  const filePath = path.join(outputDir, "results.xml");
  fs.mkdirSync(outputDir, { recursive: true });

  const testCount = result.assertions.length;
  const failures = result.assertions.filter((a) => !a.passed).length;
  const durationSec = (result.durationMs / 1000).toFixed(3);

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<testsuites>\n`;
  xml += `  <testsuite name="${escapeXml(result.scenario)}" tests="${testCount}" failures="${failures}" time="${durationSec}" timestamp="${result.startedAt}">\n`;

  for (const a of result.assertions) {
    xml += `    <testcase name="${escapeXml(a.id)}" classname="${escapeXml(result.scenario)}" time="0">\n`;

    if (!a.passed) {
      const message = a.error ?? `Expected assertion '${a.id}' to pass`;
      xml += `      <failure message="${escapeXml(message)}" type="${a.severity}">\n`;
      if (a.actual) {
        xml += `        Actual: ${escapeXml(a.actual)}\n`;
      }
      xml += `      </failure>\n`;
    }

    xml += `    </testcase>\n`;
  }

  xml += `  </testsuite>\n`;
  xml += `</testsuites>\n`;

  fs.writeFileSync(filePath, xml, "utf-8");
  return filePath;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
