#!/usr/bin/env node
import { register } from 'tsx/esm/api'

register()
const { runCli } = await import('../src/cli/main.ts')
process.exitCode = await runCli(process.argv.slice(2))
