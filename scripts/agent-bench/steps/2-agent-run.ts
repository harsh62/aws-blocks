/**
 * Builder step: ask the agent to implement the task in $WORKSPACE.
 *
 * Inputs (env):
 *   WORKSPACE        absolute path to the scaffolded bench-app
 *   TASK_PROMPT      path to PROMPT.md
 *   OUTPUT           path to write the builder envelope JSON
 *   BENCH_MODEL      Bedrock model ID (default: us.anthropic.claude-sonnet-4-6)
 *
 * Tools: a single `shell` running bash inside WORKSPACE. The runner is the
 * sandbox; no extra isolation needed for our PR-CI threat model.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { Agent, BedrockModel, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { builderSystem } from '../prompts.ts';

const WORKSPACE = required('WORKSPACE');
const TASK_PROMPT_PATH = required('TASK_PROMPT');
const OUTPUT = required('OUTPUT');
const TEMPLATE = required('TEMPLATE');
const MODEL_ID = process.env.BENCH_MODEL ?? 'us.anthropic.claude-sonnet-4-6';

const taskPrompt = readFileSync(TASK_PROMPT_PATH, 'utf-8');

const shell = tool({
	name: 'shell',
	description: `Run a bash command. Working directory is the bench-app root (${WORKSPACE}). State persists between calls. Use this for everything: reading files, editing files (with sed/heredoc), running curl, running npm. Long-running commands (npm install, npm run build) can take minutes; stdout/stderr are captured and returned along with the exit code.`,
	inputSchema: z.object({ command: z.string().describe('Bash command to run') }),
	callback: async ({ command }) => {
		const r = spawnSync('bash', ['-lc', command], {
			cwd: WORKSPACE,
			encoding: 'utf-8',
			maxBuffer: 8 * 1024 * 1024,
			timeout: 600_000,
		});
		const stdout = (r.stdout ?? '').slice(-50_000);
		const stderr = (r.stderr ?? '').slice(-10_000);
		return `exit=${r.status ?? 'killed'}\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`;
	},
});

const agent = new Agent({
	model: new BedrockModel({
		modelId: MODEL_ID,
		region: process.env.AWS_REGION ?? 'us-east-1',
		temperature: 0,
	}),
	systemPrompt: builderSystem(TEMPLATE),
	tools: [shell],
});

const started = Date.now();
let result;
try {
	result = await agent.invoke(taskPrompt);
} catch (err) {
	const desc = describeError(err);
	process.stderr.write(`[bench] agent.invoke failed: ${desc}\n`);
	// Write a sentinel envelope so the judge step has something to read and
	// the cell still produces a usable result.json artifact.
	writeFileSync(
		OUTPUT,
		JSON.stringify(
			{
				model: MODEL_ID,
				duration_sec: Math.round((Date.now() - started) / 1000),
				tokens_in: 0,
				tokens_out: 0,
				stop_reason: 'error',
				cycle_count: 0,
				final_message: '',
				builder_error: desc,
			},
			null,
			2,
		),
	);
	process.exit(1);
}
const duration_sec = Math.round((Date.now() - started) / 1000);

const usage = result.metrics?.accumulatedUsage;
const tokensIn = usage?.inputTokens ?? 0;
const tokensOut = usage?.outputTokens ?? 0;

writeFileSync(
	OUTPUT,
	JSON.stringify(
		{
			model: MODEL_ID,
			duration_sec,
			tokens_in: tokensIn,
			tokens_out: tokensOut,
			stop_reason: result.stopReason,
			cycle_count: result.metrics?.cycleCount ?? 0,
			final_message: messageText(result.lastMessage),
		},
		null,
		2,
	),
);
process.stderr.write(
	`[bench] done: stop=${result.stopReason} tokens=${tokensIn}/${tokensOut} cycles=${result.metrics?.cycleCount ?? 0} ${duration_sec}s\n`,
);

function messageText(msg: import('@strands-agents/sdk').Message | undefined): string {
	if (!msg) return '';
	return msg.content
		.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
		.filter(Boolean)
		.join('\n');
}

function describeError(err: unknown): string {
	const e = err as { name?: string; message?: string };
	return [e?.name, e?.message].filter(Boolean).join(': ') || String(err);
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) {
		process.stderr.write(`[bench] missing env var ${name}\n`);
		process.exit(1);
	}
	return v;
}
