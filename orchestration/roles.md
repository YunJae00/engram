# Roles

The JSON block below is the single source of configuration that `lib/ledger.mjs` `loadRoles()` parses. Keep exactly one fenced `json` block in this file.

- `areas` maps each work area to the path globs it owns. A brief names its area; its `allowedFiles` should stay inside those paths.
- `ladder[area]` lists, per attempt, which agent implements and which Claude cloud session verifies. Verifier kinds share the Claude lineage: each independently verifies the exact attempt SHA. Attempt n uses `ladder[area][n-1]`, so the rung equals the number of bounces so far. Once the ladder is exhausted the item goes to `needs_human`.
- `minutes` are the deadlines per phase. An attempt past its deadline is `stalled` and bounces.
- `maxLocalAgents` caps concurrent local processes (claude-local and codex-local).
- `verifierKinds` are the Claude cloud verifiers launched for every implemented attempt. A brief that lists `scenarios`, or whose criterion command is `node scripts/verify-cli.mjs <scenario>`, also launches `desktop`. `tests`, `spec` and `break` stay in this list.
- `codexBin`, when set, is a repo-relative or absolute path and is used only when that file exists. Launch then looks for `@openai/codex-<platform>-<arch>` under `apps/desktop/node_modules`, `node_modules`, and the pnpm store, with `codex.exe` on Windows. A missing binary throws and names every path tried. A binary for another OS is never spawned. The value below is the macOS arm64 vendor path; on any other machine it is skipped when the file is absent.

- `models` sets the CLI model id per agent family and phase. `models.claude.implement` / `verify` / `design` are passed as `claude --model` (cloud and local). `models.codex` is a string or the same three keys and is passed as `codex -m`. Omit a key to keep the agent's own default. Do not put model ids in global `~/.claude` or `~/.codex` from the orchestrator.

Hard rule: an item is hard when its area is in `hardWhen.areas`, any allowed file matches a `hardWhen.sharedFiles` entry, the brief sets `repeat: true`, or it has bounced at least once. Hard items get a `designing` phase first, and after the first FAIL both a claude implementer and a codex implementer reimplement at once; the first verified attempt wins and the other branch is deleted. Every attempt after a FAIL receives the findings of the earlier ones, and a second FAIL sends the item back to `designing`.

Shared-file lock: an item whose allowed files include a `sharedFiles` entry runs only when no other in-flight item includes that same file.

```json
{
  "workRemote": "origin",
  "baseBranch": "next",
  "mainBranch": "main",
  "branchPrefix": "orch/",
  "maxLocalAgents": 4,
  "minutes": {
    "design": 15,
    "implement": 45,
    "verify": 20,
    "integrate": 60
  },
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
        "implementer": "claude-cloud",
        "verifier": "claude-cloud"
      },
      {
        "implementer": "claude-cloud",
        "verifier": "claude-cloud"
      },
      {
        "implementer": "claude-cloud",
        "verifier": "claude-cloud"
      }
    ],
    "native": [
      {
        "implementer": "claude-cloud",
        "verifier": "claude-cloud"
      },
      {
        "implementer": "claude-cloud",
        "verifier": "claude-cloud"
      },
      {
        "implementer": "claude-cloud",
        "verifier": "claude-cloud"
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
