# Agent Bench

Per-PR LLM-agent benchmark. For each shipped template, a builder agent
implements the task in PROMPT.md, the build runs, Playwright grades the result,
and a judge agent scores against the rubric.

## Architecture

Five steps per cell, all on the GitHub runner:

1. **Init** — build the local registry, scaffold a fresh app, start dev server
2. **Agent run** — Strands + Bedrock; the agent has one tool (`shell`)
3. **Build and test** — `npm run build` + Playwright spec
4. **Judge** — Strands + Bedrock; the agent has one tool (`view`, read-only)
5. **Upload result** — JSON artifact + S3 archive (best-effort)

No microVM, no S3 transport between runner and sandbox. The runner is the
sandbox; Bedrock provides the model.

## Files

`steps/` mirrors the workflow 1:1 — `ls` shows the pipeline.

| File | Purpose |
|------|---------|
| `prompts.ts` | Builder + judge system prompts and rubric (shared) |
| `steps/0-init-result.mjs` | Write a baseline `result.json` so failed cells still produce an artifact |
| `steps/1-init-bench-app.sh` | Build packages, pack the local registry, scaffold the app, start the dev server |
| `steps/2-agent-run.ts` | Builder agent (Strands + Bedrock); `shell` tool only |
| `steps/3-build-and-test.sh` | `npm run build` + Playwright spec, write counts to `$GITHUB_OUTPUT` |
| `steps/4-judge.ts` | Judge agent (Strands + Bedrock); `view` tool, read-only |
| `steps/finalize-result.mjs` | Run with `if: always()`; stamps `status` + `failed_at` from per-step outcomes |
| `steps/summary.mjs` | Render markdown table to `$GITHUB_STEP_SUMMARY` |
| `package.json` | Workspace metadata; `private: true` |

Failure handling: every cell starts with `0-init-result.mjs` writing a
pessimistic baseline. Each successful step augments it. `finalize-result.mjs`
runs with `if: always()` and stamps `status: scored` (all steps green) or
`status: error, failed_at: <step>` (something failed). `5-upload-result`
also runs with `if: always()`, so the cell always shows up in the summary
table — never silently missing.

## Local development

Each step is runnable directly with the right env. Example for the builder:

```bash
# After scaffolding a bench-app and starting its dev server:
WORKSPACE=/tmp/bench-app \
TASK_PROMPT=tasks/realtime-todos/PROMPT.md \
OUTPUT=/tmp/builder-result.json \
  npx tsx scripts/agent-bench/steps/2-agent-run.ts
```
