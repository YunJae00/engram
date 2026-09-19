import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { devEditPreview } from '../src/main/dev-edit.js'

it('previews literal edits and refuses ambiguous, binary and outside paths', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-preview-')), file = join(root, 'file.txt')
  await writeFile(file, 'one\ntwo\none\n')
  expect(await devEditPreview(root, 'Edit', { file_path: file, old_string: 'two', new_string: '$&' })).toMatchObject({ after: 'one\n$&\none\n' })
  expect(await devEditPreview(root, 'Edit', { file_path: file, old_string: 'one', new_string: 'changed' })).toBeUndefined()
  expect(await devEditPreview(root, 'Edit', { file_path: file, old_string: 'one', new_string: 'changed', replace_all: true })).toMatchObject({ after: 'changed\ntwo\nchanged\n' })
  expect(await devEditPreview(root, 'Write', { file_path: '../outside', content: 'no' })).toBeUndefined()
  expect(await devEditPreview(root, 'Write', { file_path: '.git/config', content: 'no' })).toBeUndefined()
  expect(await devEditPreview(root, 'Write', { file_path: 'new/sub/file.txt', content: 'new' })).toMatchObject({ before: '', after: 'new' })
  await writeFile(file, Buffer.from([0, 1, 2]))
  expect(await devEditPreview(root, 'Write', { file_path: file, content: 'no' })).toBeUndefined()
})
