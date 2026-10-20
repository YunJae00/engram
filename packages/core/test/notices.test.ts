import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addNotice, changeNotices, noticeText, readNotices, updateNotice } from '../src/notices.js'
import { initVault } from '../src/vault.js'

it('keeps notices newest first, changes them one at a time, and clears read ones', async () => {
  const paths = await initVault(await mkdtemp(join(tmpdir(), 'notices-')), { git: false })
  expect(await readNotices(paths)).toEqual([])
  const first = await addNotice(paths, { kind: 'scheduled', title: 'Mail', text: 'Sum up my mail', botId: 'b1', running: true })
  const [second] = await Promise.all([addNotice(paths, { kind: 'habit', title: 'Bug reports', text: 'Keep it?', key: 'k' }), updateNotice(paths, first.id, { running: false, text: 'Three mails need a reply.' })])
  const items = await readNotices(paths)
  expect(items.map(item => item.id)).toEqual([second.id, first.id])
  expect(items[1]).toMatchObject({ running: false, text: 'Three mails need a reply.', read: false })
  await updateNotice(paths, first.id, { read: true })
  expect((await changeNotices(paths, list => list.filter(item => !item.read))).map(item => item.title)).toEqual(['Bug reports'])
})

it('says an answer as one plain line', () => {
  expect(noticeText('오늘 날짜 기준으로 알려드릴게요!\n\n---\n\n오늘은 **화요일**이에요. [달력](https://x.test)\n\n```replies\n고마워요\n```')).toBe('오늘 날짜 기준으로 알려드릴게요! 오늘은 화요일이에요. 달력')
})
