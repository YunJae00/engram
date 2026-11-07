# Roles

The JSON block below is the single source of configuration that `lib/ledger.mjs` `loadRoles()` parses. Keep exactly one fenced `json` block in this file.

- `areas` maps each work area to the path globs it owns. A brief names its area; its `allowedFiles` should stay inside those paths.
- `ladder[area]` lists, per attempt, which agent implements and which agent verifies. Implementers are `claude-local` (`claude -p` on the orchestration host, using its claude.ai login; `CLAUDE_CODE_OAUTH_TOKEN` stays unset). Verifiers are the local Codex agent, `codex-local`, for every rung. Each verifier kind independently verifies the exact attempt SHA. Attempt n uses `ladder[area][n-1]`, so the rung equals the number of bounces so far. Once the ladder is exhausted the item goes to `needs_human`.
- `minutes` are the deadlines per role, counted from each launch. `implement` covers one implementer session; `verify` is a number or one entry per verifier kind (`tests`, `spec`, `desktop`, `break`, with `default` for any other). A role with no entry gets the built-in default: design 15, implement 40, verify 20, integrate 60.
- `timeoutRelaunches` (default 1) is how many fresh sessions replace a role that passes its deadline without a result. An implementer relaunch is a new attempt on `orch/<id>-<n>`. A cloud verifier relaunch pushes to `orch/verdicts/<id>-<n>-<kind>-r<try>`, and a late push to the old branch is never read. A local verifier relaunch is a new worktree at the same commit; the previous worktree is dropped, so a late file from the timed-out process is never read. Once the relaunches are spent, the attempt's outcome is `timeout`: an implementation bounces to the next rung, a verifier records `cannot_verify` and the item goes to `needs_human`. A verifier's timeout relaunch and its `cannot_verify` retry share the same budget of `1 + timeoutRelaunches` launches.
- `maxLocalAgents` caps concurrent local processes (claude-local and codex-local). Local implementers and Codex verifiers count against this cap; cloud implementers do not. 3 keeps one local implementer plus its verifiers from overloading a single host.
- `verifierKinds` are launched for every implemented attempt and run as the ladder's verifier (`codex-local`). A brief that lists `scenarios`, or whose criterion command is `node scripts/verify-cli.mjs <scenario>`, also launches `desktop`. `tests`, `spec` and `break` stay in this list. On Linux, those prompts tell the local verifier to run Electron and desktop scenarios under `xvfb-run -a`.
- `codexBin`, when set, is a repo-relative or absolute path and is used only when that file exists. Launch then looks for `@openai/codex-<platform>-<arch>` under `apps/desktop/node_modules`, `node_modules`, and the pnpm store, with `codex.exe` on Windows. If none of those files exist, it uses the first `codex` on `PATH` (`codex.exe`, `codex.cmd`, then `codex` on Windows). A missing binary throws and names every path tried, including each PATH entry. A binary for another OS is never spawned. The value below is the macOS arm64 vendor path; on any other machine it is skipped when the file is absent.

- `models` sets the CLI model id per agent family and phase. `models.claude.implement` / `verify` / `design` are passed as `claude --model` (cloud and local). `models.codex` is a string or the same three keys and is passed as `codex -m`. Omit a key to keep the agent's own default. Do not put model ids in global `~/.claude` or `~/.codex` from the orchestrator.

Hard rule: an item is hard when its area is in `hardWhen.areas`, any allowed file matches a `hardWhen.sharedFiles` entry, the brief sets `repeat: true`, or it has bounced at least once. Hard items get a `designing` phase first, and after the first FAIL two implementers from the ladder are launched at once; the first verified attempt wins and the other branch is deleted. Every attempt after a FAIL receives the findings of the earlier ones, and a second FAIL sends the item back to `designing`. After the ladder is exhausted the item is `needs_human`. Each of those attempts is still verified by `codex-local`.

Shared-file lock: an item whose allowed files include a `sharedFiles` entry runs only when no other in-flight item includes that same file.

```json
{
  "workRemote": "origin",
  "baseBranch": "next",
  "mainBranch": "main",
  "branchPrefix": "orch/",
  "maxLocalAgents": 3,
  "minutes": {
    "design": 15,
    "implement": 40,
    "verify": {
      "tests": 20,
      "spec": 20,
      "desktop": 20,
      "break": 20
    },
    "integrate": 60
  },
  "timeoutRelaunches": 1,
  "areas": {
    "ts": {
      "paths": [
        "apps/desktop/src/**",
        "apps/desktop/e2e/**",
        "apps/desktop/test/**",
        "packages/**",
        "scripts/**"
      ]
    },
    "native": {
      "paths": [
        "apps/desktop/native/**"
      ]
    }
  },
  "ladder": {
    "ts": [
      {
        "implementer": "claude-local",
        "verifier": "codex-local"
      },
      {
        "implementer": "claude-local",
        "verifier": "codex-local"
      },
      {
        "implementer": "claude-local",
        "verifier": "codex-local"
      }
    ],
    "native": [
      {
        "implementer": "claude-local",
        "verifier": "codex-local"
      },
      {
        "implementer": "claude-local",
        "verifier": "codex-local"
      },
      {
        "implementer": "claude-local",
        "verifier": "codex-local"
      }
    ]
  },
  "hardWhen": {
    "areas": [
      "native"
    ],
    "sharedFiles": [
      "apps/desktop/src/main/ipc.ts",
      "apps/desktop/src/main/index.ts",
      "apps/desktop/src/main/task-runner.ts",
      "apps/desktop/src/preload/index.ts",
      "apps/desktop/src/renderer/src/App.tsx"
    ]
  },
  "verifierKinds": [
    "tests",
    "spec",
    "break"
  ],
  "models": {
    "claude": {
      "implement": "claude-opus-5-5",
      "verify": "claude-sonnet-5-5",
      "design": "claude-sonnet-5-5"
    },
    "codex": "gpt-6-sol"
  },
  "codexBin": "apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
}
```

Test scope: per item, the `tests` verifier runs `npm run check:quick`, with `ENGRAM_CHECK_BASE=<baseBranch>` (typecheck, lint, unit tests related to the changed files), and every criterion except whole-suite commands (`pnpm run test`, `npm run verify`, `test:e2e`, `check`, `verify:release`; see `isFullSuite` in `lib/prompt.mjs`). Those are recorded as `deferred to integration` and run once at integration before release: `npm run verify` plus every scenario on the merged branch, then CI (`npm run check` on macOS and Windows).
