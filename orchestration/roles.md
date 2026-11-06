# Roles

The JSON block below is the single source of configuration that `lib/ledger.mjs` `loadRoles()` parses. Keep exactly one fenced `json` block in this file.

- `areas` maps each work area to the path globs it owns. A brief names its area; its `allowedFiles` should stay inside those paths.
- `ladder[area]` lists, per attempt, which agent implements and which agent lineage verifies. Attempt n uses `ladder[area][n-1]`, so the rung equals the number of bounces so far. Once the ladder is exhausted the item goes to `needs_human`.
- `minutes` are the deadlines per phase. An attempt past its deadline is `stalled` and bounces.
- `maxLocalAgents` caps concurrent local processes (claude-local and codex-local).
- `verifierKinds` are the verifiers launched for every implemented attempt.

Hard rule: an item is hard when its area is in `hardWhen.areas`, any allowed file matches a `hardWhen.sharedFiles` entry, the brief sets `repeat: true`, or it has bounced at least once. Hard items get a `designing` phase first, and after the first FAIL both a claude implementer and a codex implementer reimplement at once; the first verified attempt wins and the other branch is deleted.

Shared-file lock: an item whose allowed files include a `sharedFiles` entry runs only when no other in-flight item includes that same file.

```json
{
  "workRemote": "origin",
  "baseBranch": "next",
  "mainBranch": "main",
  "branchPrefix": "orch/",
  "maxLocalAgents": 4,
  "minutes": { "design": 15, "implement": 45, "verify": 20, "integrate": 60 },
  "areas": {
    "ts":     { "paths": ["apps/desktop/src/**", "apps/desktop/e2e/**", "apps/desktop/test/**", "packages/**", "scripts/**"] },
    "native": { "paths": ["apps/desktop/native/**"] }
  },
  "ladder": {
    "ts":     [ { "implementer": "claude-cloud", "verifier": "codex-local" },
                { "implementer": "claude-cloud", "verifier": "codex-local" },
                { "implementer": "codex-local",  "verifier": "claude-local" } ],
    "native": [ { "implementer": "claude-local", "verifier": "codex-local" },
                { "implementer": "claude-local", "verifier": "codex-local" },
                { "implementer": "codex-local",  "verifier": "claude-local" } ]
  },
  "hardWhen": { "areas": ["native"], "sharedFiles": ["apps/desktop/src/main/ipc.ts", "apps/desktop/src/main/index.ts", "apps/desktop/src/main/task-runner.ts", "apps/desktop/src/preload/index.ts", "apps/desktop/src/renderer/src/App.tsx"] },
  "verifierKinds": ["tests", "spec", "break"],
  "codexBin": "apps/desktop/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
}
```
