export const REPORT_SCHEMA_TEXT = `{
  "id": string (the brief id),
  "status": "done" | "blocked" | "partial",
  "headSha": string, 40 lowercase hex chars, the sha of your last code commit (the commit before the report commit),
  "changedFiles": string[] (repo-relative paths you changed),
  "testsAdded": string[] (test files or test names you added),
  "commandsRun": [{ "cmd": string, "exit": integer }],
  "openQuestions": string[]
}
All keys are required. No other keys.`

const VERIFIER_STEPS = {
  tests: (brief) => [
    'Run `npm run check:quick` and save its output to a log under `orchestration/logs/`.',
    `Run every criterion command and save each output to its own log under \`orchestration/logs/\`:\n${brief.criteria.map((c) => `   - ${c.id}: \`${c.cmd}\` expect: ${c.expect}`).join('\n')}`,
    'Add one evidence entry per criterion with the exact command, the exit code and outcome in `result`, and the log path.',
    'Verdict `pass` only if every command exits as expected, `fail` if any does not, `cannot_verify` if the environment prevents running a command.',
  ],
  spec: (brief, baseBranch) => [
    `Read \`git diff ${baseBranch}...HEAD\` and \`git log ${baseBranch}..HEAD\`.`,
    'Compare the diff with the goal, every criterion, the allowed files and the out-of-scope list.',
    `The commit adding \`orchestration/reports/${brief.id}.json\` is the implementer's required report commit; it is not a violation of the allowed files.`,
    'Check for files outside the allowed files, stubs, TODOs, narrative comments, files over 400 lines, commit trailers.',
    'Add one evidence entry per criterion saying how the diff meets it or not.',
    'Every finding needs file, line, claim and a `reproCmd` that shows it. Never `fail` without a `reproCmd`.',
  ],
  break: (brief) => [
    `The commit adding \`orchestration/reports/${brief.id}.json\` is the implementer's required report commit; do not report it as a finding.`,
    'Try to break the changed code: edge inputs, empty and huge values, concurrency, restart, missing files, error paths.',
    'Scratch scripts go under `tmp/` only. Do not change tracked files.',
    'Every finding must carry a `reproCmd` that you actually ran and that failed.',
    'Verdict `fail` only when at least one such finding exists; otherwise `pass` with evidence listing what you tried.',
  ],
  desktop: (brief, baseBranch) => [
    `Run \`node scripts/verify-cli.mjs <scenario>\` for each scenario: ${(brief.scenarios ?? []).join(', ') || '(none listed)'}.`,
    `If HEAD is on \`${baseBranch}\`, also run \`npm run verify\`.`,
    'Save each output to a log under `orchestration/logs/` and add one evidence entry per command.',
    'Verdict `pass` only if every command passes; `fail` with one finding per failure; `cannot_verify` if the app cannot start here.',
  ],
}

function briefBlock(brief) {
  return [
    '## Brief (verbatim)',
    '```json',
    JSON.stringify(brief, null, 2),
    '```',
    '',
    '## Allowed files',
    ...brief.allowedFiles.map((f) => `- ${f}`),
    '',
    '## Out of scope',
    ...(brief.outOfScope.length ? brief.outOfScope.map((f) => `- ${f}`) : ['- (none)']),
  ].join('\n')
}

function numbered(steps) {
  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

export function implementerPrompt({ persona, rules, brief, branch, baseBranch, reportPath, cloud }) {
  const steps = [
    ...(cloud
      ? ['Run `pnpm install --frozen-lockfile`.', `Run \`git checkout -b ${branch}\` from \`${baseBranch}\`.`]
      : [`You are already on branch \`${branch}\` (based on \`${baseBranch}\`). Do not switch branches.`]),
    'Implement the brief, touching only the allowed files.',
    'Add tests only inside the allowed files; if no test file is allowed, do not create one.',
    'Run `npm run check:quick` until it exits 0, and run every criterion command.',
    'Commit the code. Record `git rev-parse HEAD` as headSha.',
    `Write \`${reportPath}\` matching the report schema below, with that headSha.`,
    `Run \`git add -f ${reportPath}\` and commit it as a separate last commit.`,
    `Run \`git push -u origin ${branch}\`.`,
    'End with one line: `done <id> <headSha>` or `blocked <id> <reason>`.',
  ]
  return [
    persona.trim(),
    '',
    '## Project rules',
    rules.trim(),
    '',
    briefBlock(brief),
    '',
    `## Branch\n\`${branch}\` from \`${baseBranch}\`. Never push any other branch. Never open a pull request.`,
    '',
    '## Steps',
    numbered(steps),
    '',
    `## Report schema (${reportPath})`,
    REPORT_SCHEMA_TEXT,
  ].join('\n')
}

export function verifierPrompt({ persona, kind, brief, headSha, verdictPath, schemaText, attempt = 1, baseBranch = 'next' }) {
  const steps = VERIFIER_STEPS[kind]
  if (!steps) throw new Error(`unknown verifier kind: ${kind}`)
  return [
    persona.trim(),
    '',
    briefBlock(brief),
    '',
    `## Target\nThe checkout is at headSha \`${headSha}\`. Verify that exact commit. Do not edit, commit, push or switch branches.`,
    '',
    '## Steps',
    numbered([
      `Confirm \`git rev-parse HEAD\` prints \`${headSha}\`; if not, verdict \`cannot_verify\`.`,
      ...steps(brief, baseBranch),
      `Write the verdict JSON to \`${verdictPath}\` with id \`${brief.id}\`, attempt ${attempt}, kind \`${kind}\`, headSha \`${headSha}\`.`,
      'Print the same verdict JSON as your final message, JSON only, nothing before or after it.',
    ]),
    '',
    `## Verdict schema (${verdictPath})`,
    schemaText.trim(),
  ].join('\n')
}

export function designerPrompt({ persona, rules, brief, designPath }) {
  return [
    persona.trim(),
    '',
    '## Project rules',
    rules.trim(),
    '',
    briefBlock(brief),
    '',
    '## Steps',
    numbered([
      'Read the code the brief touches.',
      'Choose one approach: files to change, shape of the change, risks, how each criterion is checked.',
      `Write the design as Markdown to \`${designPath}\`. Write nothing else, change no code, commit nothing.`,
      `End with one line: \`designed ${brief.id} ${designPath}\`.`,
    ]),
  ].join('\n')
}
