/**
 * Judge step: grade the agent's implementation on the source code only.
 *
 * Fairness moves:
 *   - Different model from the builder by default (Opus 4.8 vs builder's
 *     Sonnet 4.6) to limit same-model self-evaluation bias.
 *   - temperature=0 to cut LLM stochasticity.
 *   - Evidence (build/test/scaffold pass-fail) is NOT shown to the judge —
 *     it would anchor the qualitative dimensions. The orchestrator applies
 *     those signals as deterministic hard caps after the model returns.
 *
 * Inputs (env):
 *   WORKSPACE         absolute path to the implemented bench-app (read-only at this point)
 *   TASK_PROMPT       path to PROMPT.md
 *   BUILDER_RESULT    path to the builder's output JSON
 *   EVIDENCE          JSON of objective signals — used by the orchestrator for caps; never sent to the judge
 *   OUTPUT            path to write the merged result envelope
 *   BENCH_JUDGE_MODEL judge model ID (default us.anthropic.claude-opus-4-8)
 */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent, BedrockModel, StructuredOutputError, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { JUDGE_RUBRIC, JUDGE_SYSTEM } from '../prompts.ts';

const MAX_BYTES = 64 * 1024;

const WORKSPACE = required('WORKSPACE');
const TASK_PROMPT_PATH = required('TASK_PROMPT');
const BUILDER_RESULT = required('BUILDER_RESULT');
const EVIDENCE = parseJsonEnv('EVIDENCE');
const OUTPUT = required('OUTPUT');
const MODEL_ID = process.env.BENCH_JUDGE_MODEL ?? 'us.anthropic.claude-opus-4-8';

// Equal-weighted dimensions. Listing them in one place keeps the cap logic
// and the average computation honest. (We deliberately avoid weights — they
// invite anchoring bias and are hard to justify scientifically.)
const DIMENSIONS = [
	'functional_completeness',
	'selector_contract',
	'realtime_quality',
	'persistence',
	'code_quality',
] as const;
type Dimension = (typeof DIMENSIONS)[number];

const SCORE_SCHEMA = z.object({
	functional_completeness: z.number().min(0).max(10),
	selector_contract: z.number().min(0).max(10),
	realtime_quality: z.number().min(0).max(10),
	persistence: z.number().min(0).max(10),
	code_quality: z.number().min(0).max(10),
	explanation: z.string(),
});
type Scores = z.infer<typeof SCORE_SCHEMA>;

interface CapApplied {
	dimension: Dimension;
	cap: number;
	reason: string;
}

const taskPrompt = readFileSync(TASK_PROMPT_PATH, 'utf-8');
let builderResult: Record<string, unknown> = {};
try {
	builderResult = JSON.parse(readFileSync(BUILDER_RESULT, 'utf-8')) as Record<string, unknown>;
} catch (err) {
	process.stderr.write(`[judge] BUILDER_RESULT (${BUILDER_RESULT}) unreadable: ${describeError(err)}\n`);
	// Continue with empty; we still want to produce a graded result.
}

// Real-path containment defeats symlink escapes. `resolve()` is purely
// lexical, so a symlink inside WORKSPACE pointing to /etc/passwd would
// pass the prefix check and `readFileSync` would follow it.
const WORKSPACE_REAL = realpathSync(WORKSPACE);
function safeAbs(rel: string): string | null {
	const lexical = resolve(WORKSPACE_REAL, rel);
	let real: string;
	try {
		real = realpathSync(lexical);
	} catch {
		// File doesn't exist — its lexical path can't escape, so safe.
		real = lexical;
	}
	return real === WORKSPACE_REAL || real.startsWith(WORKSPACE_REAL + '/') ? real : null;
}

const view = tool({
	name: 'view',
	description: `Read a file inside the workspace. Path is relative to ${WORKSPACE_REAL}. Returns file contents (utf-8) up to ${MAX_BYTES} bytes.`,
	inputSchema: z.object({ path: z.string().describe('Workspace-relative file path') }),
	callback: async ({ path }) => {
		const abs = safeAbs(path);
		if (!abs) return 'error: path escapes workspace';
		try {
			const size = statSync(abs).size;
			if (size > MAX_BYTES) return `error: file too large (${size} bytes > ${MAX_BYTES})`;
			return readFileSync(abs, 'utf-8');
		} catch (err) {
			return `error: ${describeError(err)}`;
		}
	},
});

const list = tool({
	name: 'list',
	description: `List entries in a directory inside the workspace. Path is relative to ${WORKSPACE_REAL}. Use "." for the workspace root. Returns one entry per line, suffixed with / for directories.`,
	inputSchema: z.object({ path: z.string().describe('Workspace-relative directory path') }),
	callback: async ({ path }) => {
		const abs = safeAbs(path);
		if (!abs) return 'error: path escapes workspace';
		try {
			const entries = readdirSync(abs, { withFileTypes: true });
			return entries
				.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
				.sort()
				.join('\n');
		} catch (err) {
			return `error: ${describeError(err)}`;
		}
	},
});

const agent = new Agent({
	model: new BedrockModel({
		modelId: MODEL_ID,
		region: process.env.AWS_REGION ?? 'us-east-1',
		temperature: 0,
	}),
	systemPrompt: JUDGE_SYSTEM,
	tools: [view, list],
});

// Evidence is intentionally omitted — the orchestrator applies the
// objective hard caps (build/test/scaffold) after the model returns.
const userText = `<rubric>\n${JUDGE_RUBRIC}\n</rubric>\n\n<task>\n${taskPrompt}\n</task>\n\nInspect the workspace and score it.`;

const started = Date.now();
let result;
try {
	// structuredOutputSchema is the recommended Strands pattern (per
	// strandsagents.com/docs/.../structured-output/). The schema is
	// converted into a tool spec internally; the validated object lands
	// on result.structuredOutput. On validation failure Strands throws
	// StructuredOutputError, which we record distinctly.
	result = await agent.invoke(userText, { structuredOutputSchema: SCORE_SCHEMA });
} catch (err) {
	const isValidation = err instanceof StructuredOutputError;
	process.stderr.write(
		`[judge] agent.invoke failed (${isValidation ? 'schema validation' : 'other'}): ${describeError(err)}\n`,
	);
	mergeAndWrite({}, {
		judge_error: describeError(err),
		judge_error_type: isValidation ? 'schema_validation' : 'invoke_failed',
	});
	process.exit(1);
}
const judge_duration_sec = Math.round((Date.now() - started) / 1000);

const scores = result.structuredOutput as Scores | undefined;
if (!scores) {
	process.stderr.write(
		`[judge] WARNING: structured output missing. stop=${result.stopReason}. The cell will land with null scores.\n`,
	);
}

// Apply hard caps mechanically. Raw scores kept alongside the capped scores
// so we can audit how often caps fire.
const rawScores: Partial<Record<Dimension, number>> = scores
	? Object.fromEntries(DIMENSIONS.map((d) => [d, scores[d]]))
	: {};
const { capped, applied } = applyHardCaps(rawScores, EVIDENCE);
const overall = DIMENSIONS.every((d) => typeof capped[d] === 'number')
	? Math.round((DIMENSIONS.reduce((acc, d) => acc + (capped[d] ?? 0), 0) / DIMENSIONS.length) * 100) / 100
	: null;

const usage = result.metrics?.accumulatedUsage;
mergeAndWrite(builderResult, {
	...EVIDENCE,
	judge_score: overall,
	judge_dimensions_raw: rawScores,
	judge_dimensions: capped,
	judge_caps_applied: applied,
	judge_explanation: scores?.explanation ?? '',
	judge_stop_reason: result.stopReason,
	judge_duration_sec,
	judge_tokens_in: usage?.inputTokens ?? 0,
	judge_tokens_out: usage?.outputTokens ?? 0,
	judge_model: MODEL_ID,
});
process.stderr.write(
	`[judge] done: score=${overall ?? 'null'} caps=${applied.length} stop=${result.stopReason} ${judge_duration_sec}s\n`,
);

function applyHardCaps(
	raw: Partial<Record<Dimension, number>>,
	ev: Record<string, unknown>,
): { capped: Partial<Record<Dimension, number>>; applied: CapApplied[] } {
	const capped: Partial<Record<Dimension, number>> = { ...raw };
	const applied: CapApplied[] = [];
	const cap = (dim: Dimension, ceiling: number, reason: string) => {
		const cur = typeof capped[dim] === 'number' ? capped[dim]! : 0;
		if (cur > ceiling) {
			capped[dim] = ceiling;
			applied.push({ dimension: dim, cap: ceiling, reason });
		}
	};

	const scaffolded = ev.scaffolded === true;
	const buildOk = ev.build_succeeded === true;
	const devOk = ev.dev_server_started === true;
	const tt = typeof ev.tests_total === 'number' ? ev.tests_total : 0;
	const tp = typeof ev.tests_passed === 'number' ? ev.tests_passed : 0;

	if (!scaffolded) {
		for (const d of DIMENSIONS) cap(d, 1, 'scaffold failed');
	}
	if (!buildOk) cap('functional_completeness', 3, 'build failed');
	if (!devOk) {
		cap('functional_completeness', 2, 'dev server not started');
		cap('selector_contract', 2, 'dev server not started');
	}
	if (tt > 0) {
		if (tp === 0) cap('functional_completeness', 4, 'all tests failed');
		else if (2 * tp < tt) cap('functional_completeness', 6, 'fewer than half of tests passed');
	}
	return { capped, applied };
}

function mergeAndWrite(builder: Record<string, unknown>, judge: Record<string, unknown>): void {
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(OUTPUT, 'utf-8')) as Record<string, unknown>;
	} catch {
		// baseline missing — proceed with empty
	}
	writeFileSync(OUTPUT, JSON.stringify({ ...existing, ...builder, ...judge }, null, 2));
}

function describeError(err: unknown): string {
	const e = err as { name?: string; message?: string };
	return [e?.name, e?.message].filter(Boolean).join(': ') || String(err);
}

function parseJsonEnv(name: string): Record<string, unknown> {
	const raw = required(name);
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		process.stderr.write(`[judge] env var ${name} is malformed JSON: ${describeError(err)}\n`);
		process.stderr.write(`[judge]   raw: ${raw.slice(0, 500)}\n`);
		process.exit(1);
	}
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`[judge] missing env var ${name}\n`);
		process.exit(1);
	}
	return v;
}
