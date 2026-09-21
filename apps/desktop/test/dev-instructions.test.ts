import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { devClaudeInstructions } from '../src/main/dev-instructions.js'

it('loads bounded project instructions without interpreting settings or escaping the workspace', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-guidance-'))
  expect(await devClaudeInstructions(root)).toBe('')
  await writeFile(join(root, 'CLAUDE.md'), 'Run focused tests.')
  await mkdir(join(root, '.claude'))
  await writeFile(join(root, '.claude', 'CLAUDE.md'), 'Keep existing user edits.')
  await writeFile(join(root, '.claude', 'settings.json'), '{invalid executable settings}')
  const guidance = await devClaudeInstructions(root)
  expect(guidance).toContain('Run focused tests.')
  expect(guidance).toContain('Keep existing user edits.')
  expect(guidance).not.toContain('executable settings')
  await writeFile(join(root, 'CLAUDE.md'), 'x'.repeat(65_537))
  await expect(devClaudeInstructions(root)).rejects.toThrow('64 KB')
  const other = await mkdtemp(resolve('tmp/dev-guidance-link-'))
  await symlink(root, join(other, '.claude'), 'junction')
  await expect(devClaudeInstructions(other)).rejects.toThrow('outside this workspace')
})
