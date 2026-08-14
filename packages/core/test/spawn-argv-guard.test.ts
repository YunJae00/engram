import { describe, expect, it } from 'vitest'
import { probeCli } from '../src/engine/spawn.js'

const onWindows = process.platform === 'win32'

describe('shell-mode argv cannot carry shell metacharacters', () => {
  it.skipIf(!onWindows)('rejects an argument that could break out of the command line', async () => {
    await expect(probeCli('claude', ['--model', 'x & calc.exe'])).rejects.toThrow(/unsafe argv/)
  })

  it.skipIf(!onWindows)('rejects a prompt smuggled into argv', async () => {
    await expect(probeCli('claude', ['-p', 'summarize "this" & whoami'])).rejects.toThrow(/unsafe argv/)
  })

  it.skipIf(!onWindows)('rejects a newline (a second command line)', async () => {
    await expect(probeCli('claude', ['--model', 'haiku\nwhoami'])).rejects.toThrow(/unsafe argv/)
  })

  // The real argv the adapter uses must keep working — a guard that blocks the
  // product is not a fix. These are the exact shapes claude.ts passes.
  it('accepts the flags and model aliases the adapter actually sends', async () => {
    for (const args of [
      ['auth', 'status'],
      ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
      ['--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task'],
      ['--model', 'haiku'],
      ['--model', 'sonnet'],
      ['--version'],
    ]) {
      // resolves false (no such CLI in CI) rather than throwing on the guard
      await expect(probeCli('definitely-not-a-real-binary-xyz', args, 2_000)).resolves.toBe(false)
    }
  })
})
