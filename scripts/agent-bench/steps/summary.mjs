// Step "Render summary": read every bench-result-*/result.json downloaded as
// artifacts, render a markdown table to $GITHUB_STEP_SUMMARY.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_DIR = process.env.RESULTS_DIR ?? 'results';

const dirs = readdirSync(RESULTS_DIR).filter((d) => d.startsWith('bench-result-'));
const rows = dirs.map((d) => {
	try {
		return JSON.parse(readFileSync(join(RESULTS_DIR, d, 'result.json'), 'utf-8'));
	} catch {
		return { template: d.replace('bench-result-', ''), error: 'unreadable' };
	}
});

const out = [
	'## Bench results',
	'',
	'| Template | Status | Build | Tests | Judge | Stop reason |',
	'|----------|--------|-------|-------|-------|-------------|',
];
for (const r of rows.sort((a, b) => (a.template ?? '').localeCompare(b.template ?? ''))) {
	if (r.error) {
		out.push(`| ${r.template} | (artifact ${r.error}) | — | — | — | — |`);
		continue;
	}
	const statusIcon = r.status === 'scored' ? '✅' : r.status === 'cancelled' ? '⏹️' : '❌';
	const status = r.failed_at ? `${statusIcon} ${r.status} at ${r.failed_at}` : `${statusIcon} ${r.status ?? 'unknown'}`;
	const t = r.tests_total ? `${r.tests_passed}/${r.tests_total}` : '—';
	const build = r.build_succeeded ? '✅' : '❌';
	out.push(`| ${r.template} | ${status} | ${build} | ${t} | ${r.judge_score ?? '—'} | ${r.stop_reason || '—'} |`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n');
} else {
	process.stdout.write(out.join('\n') + '\n');
}
