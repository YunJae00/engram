import { expect, it } from 'vitest'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { changeStudies, initVault, readStudies } from 'core'
import { dismissStudyOffers, type StudyCheck } from '../src/main/study-offers.js'

it('invalidates only the old offer check, without losing message recovery or another chat', async () => {
  const tmp = join(process.cwd(), 'tmp')
  await mkdir(tmp, { recursive: true })
  const paths = await initVault(await mkdtemp(join(tmp, 'study-offers-')), { git: false })
  const old: StudyCheck = { channel: 'bot-first', controller: new AbortController() }
  const other: StudyCheck = { channel: 'bot-second', controller: new AbortController() }
  const pending = changeStudies(paths, list => [...list, ...['first', 'second'].map(botId => ({ id: botId, botId, state: 'offered' as const, what: 'Learn the job', where: [], ask: 'Read records', at: new Date().toISOString() }))])
  const dismissed = dismissStudyOffers(paths, 'first', [old, other])
  expect(old.superseded).toBe(true)
  expect(other.superseded).toBeUndefined()
  expect(old.controller.signal.aborted).toBe(false)
  await pending
  await dismissed
  expect((await readStudies(paths)).map(study => study.state)).toEqual(['declined', 'offered'])
  // The old result stays superseded even after the new conversation finishes.
  expect(old.superseded).toBe(true)
})
