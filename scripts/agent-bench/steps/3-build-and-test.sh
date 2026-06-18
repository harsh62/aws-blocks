#!/usr/bin/env bash
# Step 3: run `npm run build` and the task's Playwright spec against the
# running dev server. Writes test counts to $GITHUB_OUTPUT.
#
# Required env:
#   WORKSPACE     absolute path to the bench-app
#   DEV_PORT      dev server port (set by step 1)
#   TASK_DIR      absolute path to the task directory (PROMPT.md + test.spec.ts)
set -euo pipefail

: "${WORKSPACE:?WORKSPACE must be set}"
: "${DEV_PORT:?DEV_PORT must be set}"
: "${TASK_DIR:?TASK_DIR must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set (run inside GitHub Actions)}"

# Write pessimistic defaults up front, then update on success. If any step
# below fails (npm install, playwright install, the parser), the workflow
# still sees valid values and the EVIDENCE JSON in step 4 is well-formed.
{
  echo "build_succeeded=false"
  echo "tests_passed=0"
  echo "tests_failed=0"
  echo "tests_total=0"
} >> "$GITHUB_OUTPUT"

cd "$WORKSPACE"

if npm run build > /tmp/build.log 2>&1; then
  echo "build_succeeded=true" >> "$GITHUB_OUTPUT"
else
  tail -50 /tmp/build.log
fi

npm install --no-save --silent @playwright/test || { echo "::warning::playwright install failed"; exit 0; }
npx playwright install chromium > /tmp/pw-install.log 2>&1 || true

mkdir -p bench-tests
cp "$TASK_DIR/test.spec.ts" bench-tests/task.spec.ts
cat > playwright.config.ts <<EOF
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './bench-tests',
  timeout: 60_000,
  reporter: [['json', { outputFile: '/tmp/pw-results.json' }]],
  use: { baseURL: 'http://localhost:${DEV_PORT}' },
});
EOF

# Tee stdout for log visibility, but the JSON we parse comes from
# outputFile — well-formed, no warning lines mixed in.
npx playwright test 2>&1 | tee /tmp/pw.log || true

if [ -f /tmp/pw-results.json ]; then
  node -e "
    const fs = require('fs');
    const stats = JSON.parse(fs.readFileSync('/tmp/pw-results.json', 'utf-8')).stats ?? {};
    const passed = (stats.expected ?? 0) + (stats.flaky ?? 0);
    const failed = stats.unexpected ?? 0;
    const total = passed + failed + (stats.skipped ?? 0);
    console.log('tests_passed='+passed);
    console.log('tests_failed='+failed);
    console.log('tests_total='+total);
  " >> "$GITHUB_OUTPUT" || echo "::warning::pw-results.json parse failed; defaults retained"
else
  echo "::warning::Playwright produced no /tmp/pw-results.json (probably never ran); defaults retained"
fi
