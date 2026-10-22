import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { guideNote, initVault, NoteStore, readNote, writeNote, type Engine, type EngineJobInput } from 'core'

vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => undefined }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
import { guideSettled, learnFromAnswer, workGuide } from '../src/main/work-guide-learn.js'

const guide = (rule: string) => JSON.stringify({ sections: [{ heading: 'Rules', lines: [rule] }] })

async function setup(reply: (job: EngineJobInput, index: number) => string) {
  await mkdir(resolve('tmp'), { recursive: true })
  const paths = await initVault(join(await mkdtemp(resolve('tmp/work-guide-')), 'vault'), { git: false })
  const jobs: EngineJobInput[] = []
  const engine = { id: 'mock', async *run(job: EngineJobInput) { jobs.push(job); yield { type: 'result', text: reply(job, jobs.length) } } } as unknown as Engine
  const ctx = { paths, engines: [engine], store: await NoteStore.open(paths) } as unknown as Parameters<typeof learnFromAnswer>[0]
  return { ctx, paths, jobs }
}

it('starts the guide from what the person answers a comet, and every turn reads it', async () => {
  const t = await setup(() => guide('External recipients need approval'))
  expect(await workGuide(t.paths)).toBe('')
  learnFromAnswer(t.ctx, 'Which recipients need approval?', 'External recipients')
  await guideSettled(t.ctx)
  expect(t.jobs).toHaveLength(1)
  expect(t.jobs[0]).toMatchObject({ disallowTools: true })
  expect(await workGuide(t.paths)).toContain('External recipients need approval')
})

it('leaves a guide the person retired alone and keeps their edit time', async () => {
  const t = await setup(() => guide('Every send needs approval'))
  const note = guideNote('## Rules\n- old', new Date('2026-10-01T00:00:00Z'))
  await writeNote(t.paths, note)
  learnFromAnswer(t.ctx, 'Which recipients?', 'External recipients')
  await guideSettled(t.ctx)
  expect((await readNote(t.paths, 'n-work-guide')).front.updated).toBe(note.front.updated)
  note.front.status = 'superseded'; await writeNote(t.paths, note)
  learnFromAnswer(t.ctx, 'Which recipients?', 'All recipients')
  await guideSettled(t.ctx)
  expect(t.jobs).toHaveLength(1)
  expect(await workGuide(t.paths)).toBe('')
})

it('serializes learned changes so answers given together cannot overwrite one another', async () => {
  const t = await setup((_job, index) => guide(index === 1 ? 'First learned rule' : 'Both learned rules'))
  learnFromAnswer(t.ctx, 'First?', 'First rule')
  learnFromAnswer(t.ctx, 'Second?', 'Second rule')
  await guideSettled(t.ctx)
  expect(t.jobs).toHaveLength(2)
  expect(t.jobs[1]!.prompt).toContain('First learned rule')
  expect(await workGuide(t.paths)).toContain('Both learned rules')
})
