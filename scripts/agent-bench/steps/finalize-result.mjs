// Run as the last step of every cell with `if: always()`. Derives the
// cell's overall `status` from each step's GitHub outcome and stamps it
// onto result.json so the summary table can show a precise failed_at.
import { readFileSync, writeFileSync } from 'node:fs';

const RESULT_PATH = process.env.RESULT_PATH ?? '/tmp/result.json';

// Each input is a GitHub step outcome ('success' | 'failure' | 'cancelled' | 'skipped' | '').
// Order matters: this is the pipeline order. The first non-success step is
// where we failed; later steps' outcomes are typically 'skipped' as a result.
const ORDERED_STEPS = [
	{ key: '0-oidc', outcome: process.env.OUTCOME_OIDC ?? '' },
	{ key: '1-init', outcome: process.env.OUTCOME_INIT ?? '' },
	{ key: '2-agent', outcome: process.env.OUTCOME_AGENT ?? '' },
	{ key: '3-build-test', outcome: process.env.OUTCOME_TESTS ?? '' },
	{ key: '4-judge', outcome: process.env.OUTCOME_JUDGE ?? '' },
];

let status = 'scored';
let failedAt = null;
for (const { key, outcome } of ORDERED_STEPS) {
	if (outcome === '' || outcome === 'skipped') {
		// Step never ran — typically because an earlier step failed and
		// the upstream failure is what we already recorded. Stop scanning.
		break;
	}
	if (outcome === 'cancelled') {
		status = 'cancelled';
		failedAt = key;
		break;
	}
	if (outcome !== 'success') {
		status = 'error';
		failedAt = key;
		break;
	}
}

let r;
try {
	r = JSON.parse(readFileSync(RESULT_PATH, 'utf-8'));
} catch (err) {
	// Baseline never written (e.g., 0-init-result itself failed).
	// Reconstruct a minimal envelope so the cell still appears in the table.
	r = {
		template: process.env.TEMPLATE ?? '',
		task: process.env.TASK ?? '',
		pr_number: process.env.PR_NUMBER ?? '',
		run_id: process.env.GITHUB_RUN_ID ?? '',
		git_sha: process.env.GITHUB_SHA ?? '',
		notes: [`finalize-result couldn't read ${RESULT_PATH}: ${err?.message ?? err}`],
	};
}

r.status = status;
if (failedAt) r.failed_at = failedAt;
writeFileSync(RESULT_PATH, JSON.stringify(r, null, 2));
process.stderr.write(`[finalize-result] status=${status}${failedAt ? ` failed_at=${failedAt}` : ''}\n`);
