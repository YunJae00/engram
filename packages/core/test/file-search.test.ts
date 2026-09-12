import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findLocalFiles } from '../src/file-search.js'
import { tmpVaultRoot } from './helpers.js'

it('searches redirected roots by name without entering private or linked folders', async () => {
  const root = await tmpVaultRoot('file-search')
  const docs = join(root, 'Redirected Documents'), privateDir = join(docs, 'private')
  const outside = join(root, 'outside')
  await mkdir(privateDir, { recursive: true }); await mkdir(outside)
  await writeFile(join(docs, '팀 예산.xlsx'), 'not read')
  await writeFile(join(docs, '.팀 예산.md'), 'hidden')
  await writeFile(join(privateDir, '팀 예산.xlsx'), 'private')
  await writeFile(join(outside, '팀 예산.xlsx'), 'outside')
  await symlink(outside, join(docs, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await findLocalFiles([docs, docs], privateDir, '팀 예산')
  expect(result.matches.map(file => file.name)).toEqual(['팀 예산.xlsx'])
  expect(result.limited).toBe(false)
  expect(await findLocalFiles([privateDir], privateDir, '예산')).toEqual({ matches: [], limited: false })
  await expect(findLocalFiles([docs], join(root, 'missing-private'), '예산')).rejects.toThrow()
})

it('reports bounded results and supports cancellation instead of claiming an exhaustive miss', async () => {
  const root = await tmpVaultRoot('file-search-bounds')
  const privateDir = join(root, 'private'); await mkdir(privateDir)
  await Promise.all(Array.from({ length: 45 }, (_, i) => writeFile(join(root, `budget-${i}.txt`), 'x')))
  const result = await findLocalFiles([root], privateDir, 'budget')
  expect(result.matches).toHaveLength(20)
  expect(result.limited).toBe(true)
  const stopped = new AbortController(); stopped.abort()
  await expect(findLocalFiles([root], privateDir, 'budget', stopped.signal)).rejects.toThrow()
  const missing = await findLocalFiles([join(root, 'missing')], privateDir, 'budget')
  expect(missing).toEqual({ matches: [], limited: true })
})
