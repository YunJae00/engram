import process from 'node:process'
import { briefScenarios } from './loop.mjs'

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

const DESKTOP_BUILD = 'If `apps/desktop/out/main/index.js` is missing, `node scripts/verify-cli.mjs <scenario>` builds the desktop app and later runs reuse that build. Do not append `--build`. A missing build is not `cannot_verify`.'
const CLOUD_DESKTOP = 'You are in a Linux cloud container with no host display. Install `xvfb` with the system package manager if needed. Run Electron-related commands with `xvfb-run -a` (including any command in an `npm run check:quick && ...` chain), while preserving the exact `node scripts/verify-cli.mjs <scenario>` invocation inside it. Never report a missing X server as `cannot_verify` before trying Xvfb. Run desktop scenarios serially in your own session.'
const LINUX_DESKTOP = 'This machine is Linux and has no host display. Run Electron-related commands under `xvfb-run -a` (including any command in an `npm run check:quick && ...` chain), while preserving the exact `node scripts/verify-cli.mjs <scenario>` invocation inside it. Never report a missing X server as `cannot_verify` before trying Xvfb. Run desktop scenarios serially in your own session.'

export const verifierLinuxDesktop = (cloud, platform = process.platform) => !cloud && platform === 'linux'
const timeBudget = (minutes, late) => (minutes ? [`You have ${minutes} minutes from launch. ${late} Anything pushed after that is ignored and a fresh session takes over.`] : [])
const verifyCliCriterion = (brief) => (brief.criteria ?? []).some((c) => /(?:^|\s)scripts\/verify-cli\.mjs\s+[a-z0-9-]+/.test(c.cmd ?? ''))

const VERIFIER_STEPS = {
  tests: (brief, baseBranch, cloud) => [
    'Run `npm run check:quick` and save its output to a log under `orchestration/logs/`.',
    `Run every criterion command and save each output to its own log under \`orchestration/logs/\`:\n${brief.criteria.map((c) => `   - ${c.id}: \`${c.cmd}\` expect: ${c.expect}`).join('\n')}`,
    ...(verifyCliCriterion(brief) ? [DESKTOP_BUILD, ...(cloud ? [CLOUD_DESKTOP] : [])] : []),
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
    'The tests and desktop verifiers already run `npm run check:quick`, every criterion and every scenario. Do not rerun them; run only commands that attack the changed code.',
    ...(briefScenarios(brief).length ? [DESKTOP_BUILD] : []),
    'Try to break the changed code: edge inputs, empty and huge values, concurrency, restart, missing files, error paths.',
    'Scratch scripts go under `tmp/` only. Do not change tracked files.',
    'Every finding must carry a `reproCmd` that you actually ran and that failed.',
    'Verdict `fail` only when at least one such finding exists; otherwise `pass` with evidence listing what you tried.',
  ],
  desktop: (brief, baseBranch) => {
    const commands = briefScenarios(brief).map((name) => `node scripts/verify-cli.mjs ${name}`)
    if (commands.length === 0) {
      return [
        'This brief names no verify-cli scenario in `scenarios` or in a criterion command.',
        'Verdict `cannot_verify`. A desktop pass needs one evidence entry per `node scripts/verify-cli.mjs <scenario>` with exit 0 and a JSON line `"ok": true`. Do not pass on an empty list.',
      ]
    }
    return [
      'Read `orchestration/features/MAP.md` for how each scenario reaches its surface. The proof is the command output, not the map.',
      DESKTOP_BUILD,
      ...commands.map((cmd) => `Run \`${cmd}\` and save the output under \`orchestration/logs/\`. That scenario passes only when the process exits 0 and the JSON line has \`"ok": true\`.`),
      `If HEAD is on \`${baseBranch}\`, also run \`npm run verify\`.`,
      'Add one evidence entry per command with the exact command, the exit code and outcome in `result`, and the log path.',
      'Verdict `pass` only if every command passes; `fail` with one finding per failure (each finding needs a `reproCmd`); `cannot_verify` if the app cannot start here.',
    ]
  },
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

function findingsBlock(findings) {
  if (findings.length === 0) return []
  return [
    '',
    '## Previous findings',
    'Earlier attempts at this item failed verification on these points. Each one must hold in your work; do not repeat the approach that produced them.',
    ...findings.map((f) => `- ${f.where}: ${f.claim}\n  repro: \`${f.reproCmd}\``),
  ]
}

export function implementerPrompt({ persona, rules, brief, branch, baseBranch, reportPath, cloud, findings = [], minutes }) {
  const steps = [
    ...timeBudget(minutes, 'If the work cannot be done by then, push the report with status `partial` or `blocked` before the deadline.'),
    ...(cloud
      ? ['Run `pnpm install --frozen-lockfile`.', `Run \`git checkout -b ${branch}\` from \`${baseBranch}\`.`]
      : [`You are already on branch \`${branch}\` (based on \`${baseBranch}\`). Do not switch branches.`]),
    'Implement the brief, touching only the allowed files.',
    'Add tests only inside the allowed files; if no test file is allowed, do not create one.',
    'Run `npm run check:quick` until it exits 0, and run every criterion command.',
    ...(verifyCliCriterion(brief) ? [DESKTOP_BUILD, ...(cloud ? [CLOUD_DESKTOP] : [])] : []),
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
    ...findingsBlock(findings),
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

export function verifierPrompt({ persona, kind, brief, headSha, verdictPath, schemaText, attempt = 1, baseBranch = 'next', cloud = false, linux = false, verdictBranch = '', minutes }) {
  const steps = VERIFIER_STEPS[kind]
  if (!steps) throw new Error(`unknown verifier kind: ${kind}`)
  const desktopNote = cloud ? CLOUD_DESKTOP : linux ? LINUX_DESKTOP : null
  const localTarget = 'The checkout is already at headSha. Do not edit tracked implementation files, commit, push, or switch branches. Write the verdict JSON at the path in the steps.'
  return [
    persona.trim(),
    '',
    briefBlock(brief),
    '',
    `## Target\nVerify exact commit \`${headSha}\`. ${cloud ? `Start from \`${baseBranch}\`, fetch the implementation branch, and check out that commit detached. Do not modify the implementation branch. Return only your verdict as one commit on a new branch \`${verdictBranch}\` created from \`${headSha}\`.` : localTarget}`,
    '',
    '## Steps',
    numbered([
      ...timeBudget(minutes, cloud
        ? 'If you cannot finish by then, write and push a `cannot_verify` verdict that says what blocked you before the deadline.'
        : 'If you cannot finish by then, write a `cannot_verify` verdict that says what blocked you before the deadline.'),
      `Confirm \`git rev-parse HEAD\` prints \`${headSha}\`; if not, verdict \`cannot_verify\`.`,
      ...steps(brief, baseBranch),
      ...(desktopNote && briefScenarios(brief).length ? [desktopNote] : []),
      `Write the verdict JSON to \`${verdictPath}\` with id \`${brief.id}\`, attempt ${attempt}, kind \`${kind}\`, headSha \`${headSha}\`.`,
      ...(cloud ? [`Run \`git add -f ${verdictPath}\`, commit only the verdict, and push it to \`origin ${verdictBranch}\`. Never push any other branch and never open a pull request.`] : []),
      'Print the same verdict JSON as your final message, JSON only, nothing before or after it.',
    ]),
    '',
    `## Verdict schema (${verdictPath})`,
    schemaText.trim(),
  ].join('\n')
}

export function designerPrompt({ persona, rules, brief, designPath, findings = [], rejectedDesign = null }) {
  return [
    persona.trim(),
    '',
    '## Project rules',
    rules.trim(),
    '',
    briefBlock(brief),
    ...findingsBlock(findings),
    ...(rejectedDesign ? ['', '## Rejected design', 'Attempts that followed this design failed. Do not propose it again.', rejectedDesign.trim()] : []),
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
