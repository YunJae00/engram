import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { devCreateFile, devFiles, devReadFile, devSaveFile, devSearchFiles } from '../src/main/dev-files.js'

async function fixture() {
  await mkdir(resolve('tmp'), { recursive: true })
  const parent = await mkdtemp(resolve('tmp/dev-files-')), root = join(parent, 'workspace'), backups = join(parent, 'backups')
  await mkdir(root)
  await writeFile(join(root, 'code.ts'), 'export const value = 1\r\n')
  return { parent, root, backups }
}

it('searches nested text and filenames while excluding private files and creates without overwriting', async () => {
  const { root } = await fixture()
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'nested.ts'), 'first\nconst searchable = true')
  await writeFile(join(root, '.env'), 'searchable=private')
  expect((await devSearchFiles(root, 'searchable')).matches).toEqual([{ path: 'src/nested.ts', line: 2, text: 'const searchable = true' }])
  expect((await devSearchFiles(root, 'nested')).matches).toEqual([{ path: 'src/nested.ts' }])
  const created = await devCreateFile(root, 'src/new.ts', () => undefined)
  expect(created.text).toBe('')
  await expect(devCreateFile(root, 'code.ts', () => undefined)).rejects.toThrow()
  expect((await devReadFile(root, 'code.ts')).text).toContain('value = 1')
  for (const path of ['../escape.ts', '.env', '.git/config', 'src/.env.local']) await expect(devCreateFile(root, path, () => undefined)).rejects.toThrow()
  await expect(devCreateFile(root, 'blocked.ts', () => { throw new Error('Busy') })).rejects.toThrow('Busy')
})

it('browses and saves text with a backup, refusing stale content and binary files', async () => {
  const { root, backups } = await fixture()
  await writeFile(join(root, '.env'), 'PRIVATE=value')
  await writeFile(join(root, 'binary'), Buffer.from([0, 1]))
  await writeFile(join(root, 'invalid'), Buffer.from([255, 254]))
  await writeFile(join(root, 'large'), 'a'.repeat(500_001))
  expect((await devFiles(root, '')).entries.map(entry => entry.name)).not.toContain('.env')
  const file = await devReadFile(root, 'code.ts')
  expect(file.text).toBe('export const value = 1\r\n')
  await devSaveFile(root, file.path, file.fingerprint, 'export const value = 2\n', backups, () => undefined)
  expect(await readFile(join(root, 'code.ts'), 'utf8')).toContain('value = 2')
  const backup = JSON.parse(await readFile(join(backups, (await readdir(backups))[0]!), 'utf8'))
  expect(backup.before).toBe(file.text)
  await expect(devSaveFile(root, file.path, file.fingerprint, 'stale', backups, () => undefined)).rejects.toThrow('changed on disk')
  for (const path of ['.env', 'binary', 'invalid', 'large']) await expect(devReadFile(root, path)).rejects.toThrow()
})

it('rejects traversal and junction escapes and checks task state immediately before replacement', async () => {
  const { parent, root, backups } = await fixture()
  const outside = join(parent, 'outside'); await mkdir(outside)
  await writeFile(join(outside, 'secret'), 'private')
  await symlink(outside, join(root, 'escape'), 'junction')
  for (const path of ['../outside/secret', 'escape/secret']) await expect(devReadFile(root, path)).rejects.toThrow('inside this workspace')
  expect((await devFiles(root, '')).entries.map(entry => entry.name)).not.toContain('escape')
  const file = await devReadFile(root, 'code.ts')
  await expect(devSaveFile(root, file.path, file.fingerprint, 'changed', backups, () => { throw new Error('Workspace became busy') })).rejects.toThrow('became busy')
  expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe(file.text)
})
