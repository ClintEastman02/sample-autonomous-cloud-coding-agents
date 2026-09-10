#!/usr/bin/env node
// Guards the silent-success-masking suppression footgun (#790).
//
// `focus-metavariable: $RET` in .semgrep/silent-success-masking.yaml anchors each
// finding on the `return` statement, so a `nosemgrep: <rule> -- ...` token only
// binds when it sits ON that return line or the line IMMEDIATELY above it. A
// multi-line justification whose token drifts higher silently STOPS suppressing
// (or, worse, looks suppressed while the finding is live). This check asserts
// every masking suppression token is placed where semgrep will honour it, so the
// drift that mis-bound agent/src/observability.py cannot recur unnoticed.
//
// Run: node scripts/check-masking-suppression-placement.mjs  (wired into
// `security:sast:masking` and `:masking:range`).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TOKEN = /nosemgrep:[^\n]*\bsilent-success-masking\b/;
// The rule anchors on a return; re-throwing (`raise`/`throw`) is the ok path but
// is accepted here too so the guard never fights a legitimate placement.
const ANCHOR = /\b(return|raise|throw)\b/;
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|py)$/;

// Tracked source files only; the .semgrep/ fixtures use `ok:`/`ruleid:` markers,
// not `nosemgrep:`, so excluding them is belt-and-suspenders.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && SOURCE_EXT.test(f) && !f.startsWith('.semgrep/'));

const violations = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!TOKEN.test(line)) return;
    const onTokenLine = ANCHOR.test(line); // inline `return x; // nosemgrep: ...`
    const onNextLine = i + 1 < lines.length && ANCHOR.test(lines[i + 1]);
    if (!onTokenLine && !onNextLine) {
      violations.push({ file, line: i + 1, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(
    `\n✖ ${violations.length} silent-success-masking suppression(s) mis-placed — the token must sit on the flagged \`return\` line or the line directly above it, or it does not bind:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n      ${v.text}`);
  }
  console.error(
    '\nMove the `# nosemgrep:`/`// nosemgrep:` line directly above the `return`, with any prose above that. See .semgrep/silent-success-masking.yaml (PLACEMENT FOOTGUN).\n',
  );
  process.exit(1);
}

console.log('✓ all silent-success-masking suppressions are correctly placed');
