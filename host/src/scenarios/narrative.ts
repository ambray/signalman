/**
 * Narrative parser — converts workflow.md into a structured execution plan.
 *
 * Narratives are Markdown documents with embedded tool blocks and prose
 * context. They can be executed in two modes:
 *
 * 1. **Sequential**: Tool blocks extracted and run in order
 * 2. **LLM-driven**: The full narrative is given to an LLM which calls
 *    MCP tools, interprets results and screenshots, and adapts the
 *    workflow dynamically
 *
 * The narrative format supports:
 * - Markdown headings for step labels
 * - Fenced code blocks (`tool` language) for MCP tool invocations
 * - Prose between blocks that provides context to the LLM
 * - Tables for expected outcomes (consumed by assertion evaluator)
 */

import * as yaml from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NarrativeStep {
  /** Step heading (e.g., "Step 1: Verify Restriction State"). */
  heading: string;
  /** Heading level (1-6). */
  level: number;
  /** Prose context before tool blocks. */
  prose: string;
  /** Tool invocations within this step. */
  toolBlocks: NarrativeToolBlock[];
}

export interface NarrativeToolBlock {
  /** MCP tool name (e.g., "vm_run_command"). */
  tool: string;
  /** Tool parameters as a flat object. */
  params: Record<string, unknown>;
  /** Prose immediately preceding this tool block. */
  precedingProse: string;
}

export interface Narrative {
  /** Title from the H1 heading. */
  title: string;
  /** Blockquote narrator text (if any). */
  narrator: string;
  /** Ordered steps parsed from headings. */
  steps: NarrativeStep[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a workflow Markdown document into a structured Narrative.
 *
 * The parser splits on headings, extracts tool blocks from fenced code,
 * and preserves prose context for LLM consumption.
 */
export function parseNarrative(markdown: string): Narrative {
  const lines = markdown.split("\n");
  let title = "";
  let narrator = "";
  const steps: NarrativeStep[] = [];

  let currentStep: NarrativeStep | null = null;
  let currentProse = "";
  let inToolBlock = false;
  let toolBlockContent = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Extract title from first H1
    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }

    // Extract narrator from blockquote
    if (line.startsWith("> **Narrator**:") || line.startsWith("> *Narrator*:")) {
      narrator = line.replace(/^>\s*\*{1,2}Narrator\*{1,2}:\s*/, "").trim();
      // Consume continuation lines
      while (i + 1 < lines.length && lines[i + 1].startsWith("> ")) {
        i++;
        narrator += " " + lines[i].replace(/^>\s*/, "").trim();
      }
      continue;
    }

    // Heading — start a new step
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);
    if (headingMatch && !inToolBlock) {
      // Flush pending prose/tool blocks to current step
      if (currentStep) {
        steps.push(currentStep);
      }

      currentStep = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        prose: "",
        toolBlocks: [],
      };
      currentProse = "";
      continue;
    }

    // Tool block start
    if (line.trim() === "```tool") {
      inToolBlock = true;
      toolBlockContent = "";
      continue;
    }

    // Tool block end
    if (inToolBlock && line.trim() === "```") {
      inToolBlock = false;

      // Parse the YAML tool block
      try {
        const parsed = yaml.parse(toolBlockContent) as Record<string, unknown>;
        const toolName = Object.keys(parsed)[0];
        const params = (parsed[toolName] as Record<string, unknown>) ?? {};

        if (currentStep) {
          currentStep.toolBlocks.push({
            tool: toolName,
            params,
            precedingProse: currentProse.trim(),
          });
        }
      } catch (e) {
        console.warn(`Failed to parse tool block at line ${i}: ${e}`);
      }

      currentProse = "";
      continue;
    }

    // Accumulate tool block content
    if (inToolBlock) {
      toolBlockContent += line + "\n";
      continue;
    }

    // Accumulate prose
    currentProse += line + "\n";
    if (currentStep) {
      currentStep.prose += line + "\n";
    }
  }

  // Flush last step
  if (currentStep) {
    steps.push(currentStep);
  }

  return { title, narrator, steps };
}

/**
 * Convert a Narrative back to a simplified Markdown summary.
 *
 * Useful for generating reports or feeding context to an LLM.
 */
export function narrativeToSummary(narrative: Narrative): string {
  let md = `# ${narrative.title}\n\n`;

  if (narrative.narrator) {
    md += `> ${narrative.narrator}\n\n`;
  }

  for (const step of narrative.steps) {
    const hashes = "#".repeat(step.level);
    md += `${hashes} ${step.heading}\n\n`;
    md += `${step.toolBlocks.length} tool invocation(s)\n\n`;
  }

  return md;
}
