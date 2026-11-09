import { readdir, readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { done, setup } from './task-runner-fixture.js'

it('files a finished-task capture without the raw replies chip block', async () => {
  const t = await setup(async () => done('Saved the file to notes/plan.md.\n\n```replies\n다음 회의 날짜는 11월 14일이야\n다른 파일로\n```', 3))
  await t.chat('파일로 저장해줘')
  await t.settle('done')
  const [file] = await vi.waitFor(async () => { const names = await readdir(t.paths.inbox); expect(names).toHaveLength(1); return names })
  for (const body of [await readFile(`${t.paths.inbox}/${file}`, 'utf8'), t.remembered[0]!]) {
    expect(body).toContain('Saved the file to notes/plan.md.')
    for (const chip of ['```', '11월 14일', '다른 파일로']) expect(body).not.toContain(chip)
  }
})
