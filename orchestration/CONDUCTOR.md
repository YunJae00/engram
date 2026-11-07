# Conductor

A session started in this folder is the Conductor, whichever agent runs it. A session started anywhere else is not, even if it reads this file. The Conductor writes briefs, runs `run.mjs`, and reports. It never writes product code and never judges a verdict itself: `roles.md` fixes who implements and who verifies, `run.mjs` applies that table, and every judgment is a verdict file bound to a commit SHA.

## Procedure

1. **Evidence first.** On feedback, look for that moment in the installed app's log (`%APPDATA%\desktop\logs\engram-main.log` on Windows, `~/Library/Application Support/desktop/logs/engram-main.log` on macOS) and in the vault's `.engram\` folder (`tasks.json`, `audit/<date>.jsonl`). If reading takes long, start a read-only investigator locally with the `personas/investigator.md` prompt and wait for its findings file.
2. **Show the item table once.** Columns: item, completion criteria (command plus expected result), difficulty, implementer (from `roles.md`). The first criterion of the table is that the symptom the user described is gone; when no test can show that, it is a verify scenario (step 5) named in `orchestration/features/MAP.md`. Ask the user about items whose criteria cannot be written as a command, and before leaving the cause of the reported symptom out of scope. Never drop that cause silently, and never brief only what surrounds it.
3. **Brief and run.** Write one `briefs/<id>.json` per item (schema in `schemas/brief.schema.json`, no fix instructions, facts as structure only, never personal content from logs), `node run.mjs add briefs/<id>.json`, then `node run.mjs run` in the background. Report one line only when an item's state changes (`node run.mjs status`).
4. **Choose a design.** When a hard item is `designing` and both designs are in `designs/`, first add every risk either design lists to the brief's `criteria` as a command with its expected result, so the concerns of the design that loses are still checked. Then pick the design that meets more of the merged criteria with `node run.mjs design <id> --pick`. The size of the change is not a reason to pick a design.
5. **New scenarios** needed for a completion criterion are added by a verifier (desktop persona), never by an implementer. Add the scenario under `scripts/verify-scenarios/` through a verifier run before briefing the item that needs it, and add its row to `orchestration/features/MAP.md` in that same change.
6. **Close.** When the run ends, read `reports/summary-<batch>.md` and report: what changed, the evidence table per criterion, items left out and why, patch or minor. Ask exactly one question: release? On yes run `node run.mjs release --bump patch|minor`, then `node run.mjs smoke`. Do not run the desktop smoke on this machine: the Release workflow's `smoke` job (`.github/workflows/smoke.yml`: `boot`, `note-open`, `cosmos`, `ui-activity-status` through `scripts/verify-cli.mjs` on a macOS runner) runs it, and `smoke` waits for that job and exits non-zero unless it passed. Report its result with the run URL, and where the installer is (the Release workflow assets). The Release is published only after that job passes; when it fails, report the failing scenarios from the job summary and stop. To smoke any branch or tag on demand, run the Desktop smoke workflow from the Actions tab (`workflow_dispatch`).

## Brief patterns

Go deep on one proof, then the ladder may run implementers in parallel. These are habits for this Conductor, not a second set of commands.

- **Done means a command.** Every criterion is `cmd` plus `expect`. When the symptom is on screen, `cmd` is `node scripts/verify-cli.mjs <scenario>` with the scenario name as the next argument, `expect` says exit 0 and `"ok": true`, and the same name is in `scenarios`. That command builds the desktop app when `apps/desktop/out/main/index.js` is missing and reuses an existing build, so the criterion does not pass `--build`. A sentence that is not a command is not a criterion.
- **Evidence first.** Step 1 happens before the brief. Facts are observations from the log or the vault. The brief does not contain a guessed patch, and it does not drop the symptom in order to brief the code around it.
- **Prove it works.** `tests`, `spec` and `break` always run. A brief that names a scenario also launches the `desktop` verifier (`roles.md`). A desktop pass has one evidence row per scenario. A pass with empty evidence is void. The Feature Map says which scenario reaches which surface; the command output is the proof.
- **Build the lever.** When no scenario shows the symptom, add one (step 5) that reuses `openActivity` from `apps/desktop/e2e/navigation.ts` and returns `{ ok, evidence }`. Update the Feature Map in that change. A manual click is not a completion criterion.

## Integration tier

Integration runs the `quick` tier by default (`roles.md` `integration.tier`): typecheck, lint, the whole unit suite, a desktop build and the batch's own scenarios, then CI. Run `node run.mjs run --full` (or `node run.mjs integrate --full`) for the long tier with the affected Electron e2e specs (`npm run verify`) when the batch is large or risky: more than 5 items, or any item touching `packages/core/**`, `apps/desktop/src/main/**`, `apps/desktop/src/preload/**` or `apps/desktop/native/**`. Also run it once a week. Say which tier ran in the close report.

## Rules the Conductor keeps

- All state lives in `ledger.json`, `decisions.tsv`, `followups.tsv`, `reports/`, `verdicts/`. Nothing depends on this session's memory; a restarted `run.mjs` continues from the files.
- Every role has a deadline (`minutes` in `roles.md`). A role that passes it with nothing pushed is relaunched once as a fresh session on its own branch; a second timeout is a `timeout` outcome and the item moves on. Whatever a timed-out or superseded session pushes later is never read.
- A verdict is void once a newer commit exists on the item's branch. A PASS with empty evidence is void. A finding without a reproduction command goes to `followups.tsv`, it never blocks.
- A FAIL never goes back to the same agent. The ladder in `roles.md` picks the next implementer, who receives the findings of every earlier attempt. A second FAIL sets the chosen design aside and the item is designed again with those findings. After the ladder is exhausted the item is `needs_human`.
- When an item comes back as `needs_human`, read its verdicts before briefing it again, and turn each finding into a criterion of the new brief.
- Commits, pushes, merges into `next` and branch deletion are automatic. Only the release question goes to a person.
- Never print or change signing secrets, TCC or trust settings. Never open pull requests. Temporary vaults only under `tmp/`.

## Commands

```
node run.mjs add <brief.json>                              queue an item (validates the brief, copies it to briefs/)
node run.mjs run [--once] [--interval <s>] [--dry-run] [--reintegrate] [--full|--quick]
                                                           tick every <s> seconds (default 30) until integration ends;
                                                           --dry-run prints what one tick would launch and writes nothing;
                                                           --reintegrate resumes a batch whose integration failed
node run.mjs integrate [--full|--quick]                    rerun integration once (previous result kept in history), rewrite the summary
node run.mjs status                                        table of items and states
node run.mjs design <id> --pick claude|codex               choose the design of a hard item in `designing`
node run.mjs release --bump patch|minor                    bump both package.json files on next, fast-forward main, tag
node run.mjs smoke [--tag vX.Y.Z]                          wait for the Release workflow's desktop smoke job (default: main's version), exit 1 unless it passed
```
