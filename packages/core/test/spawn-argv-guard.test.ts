import { describe, expect, it } from 'vitest'
import { probeCli } from '../src/engine/spawn.js'

const onWindows = process.platform === 'win32'

describe('shell-mode argv cannot carry shell metacharacters', () => {
  it.skipIf(!onWindows)('rejects an argument that could break out of the command line', async () => {
    await expect(probeCli('whisper', ['-m', 'x & calc.exe'])).rejects.toThrow(/unsafe argv/)
  })

  it.skipIf(!onWindows)('rejects a prompt smuggled into argv', async () => {
    await expect(probeCli('whisper', ['-f', 'clip "one" & whoami'])).rejects.toThrow(/unsafe argv/)
  })

  it.skipIf(!onWindows)('rejects a newline (a second command line)', async () => {
    await expect(probeCli('whisper', ['-m', 'base\nwhoami'])).rejects.toThrow(/unsafe argv/)
  })

  it('accepts the flags the app actually sends', async () => {
    for (const args of [
      ['--version'],
      ['-m', 'ggml-base.bin', '-f', 'clip.wav', '-otxt', '-of', 'clip'],
      ['-m', 'ggml-base.bin', '--language', 'auto'],
    ]) {
      await expect(probeCli('definitely-not-a-real-binary-xyz', args, 15_000)).resolves.toBe(false)
    }
  })
})
