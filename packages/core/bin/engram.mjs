#!/usr/bin/env node
// Dev launcher: runs the TypeScript CLI through tsx. M8 replaces this with a
// bundled build — user-facing behaviour must stay identical.
import { register } from 'tsx/esm/api'

register()
const { runCli } = await import('../src/cli/main.ts')
process.exitCode = await runCli(process.argv.slice(2))
