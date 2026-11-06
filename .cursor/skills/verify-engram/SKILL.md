---
name: verify-engram
description: Prove an Engram desktop surface with verify-cli and the Feature Map. Use when changing UI, adding a verify scenario, or deciding whether a screen works.
---

# Verify Engram

Desktop proof is one command from the repo root:

```
node scripts/verify-cli.mjs <scenario>
```

The command builds the desktop app when `apps/desktop/out/main/index.js` is missing and reuses a build that is already there. `--build` forces a rebuild; per-item criteria omit it. The process launches that build on a fresh vault and prints one JSON line. Exit 0 and `"ok": true` is a pass. A description of a click is not.

## Steps

1. Read `orchestration/features/MAP.md` and use the scenario named for the surface.
2. Run `node scripts/verify-cli.mjs --list` and confirm the name is there.
3. Run the scenario. Keep the JSON line.
4. When the map has no scenario, add `scripts/verify-scenarios/<name>.mjs` exporting `run(page, { app, paths, expect, openActivity, log })` that returns `{ ok, evidence }`. Reuse `openActivity` from `apps/desktop/e2e/navigation.ts`. Add the map row in the same change.

The Conductor launches a desktop verifier beside tests, spec, and break when a brief names a scenario. Patterns are in `orchestration/CONDUCTOR.md`. New scenarios are added by that verifier, not by an implementer.
