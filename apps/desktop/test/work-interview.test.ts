import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { guideNote, initVault, NoteStore, readNote, writeNote, type Engine, type EngineJobInput } from 'core'

const fake = vi.hoisted(() => ({
  roots: {} as Record<string, string>,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  files: vi.fn(), map: vi.fn(), broadcast: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: (name: string) => fake.roots[name] }, ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(name, handler) } }))
vi.mock('core', async original => ({ ...await original<typeof import('core')>(), findLocalFiles: fake.files, readWorkMap: fake.map }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
import { learnFromAnswer, registerWorkInterviewIpc, workGuide } from '../src/main/work-interview.js'

const questions = JSON.stringify({ questions: [{ topic: 'rules', question: 'What needs approval?', basis: 'Report.csv', options: ['Every send', 'External recipients'] }] })
const guide = (rule: string) => JSON.stringify({ sections: [{ heading: 'Rules', lines: [rule] }] })
const answers = [{ question: 'What needs approval?', answer: 'Every send' }]
const call = (name: string, ...args: unknown[]) => Promise.resolve(fake.handlers.get(`interview:${name}`)!(undefined, ...args))
const deferred = () => { let finish!: () => void; const promise = new Promise<void>(resolve => { finish = resolve }); return { promise, finish } }

beforeEach(() => {
  vi.unstubAllEnvs(); fake.handlers.clear(); fake.broadcast.mockClear()
  fake.files.mockReset().mockResolvedValue({ matches: [] }); fake.map.mockReset().mockResolvedValue(null)
})

async function setup(reply: (job: EngineJobInput, index: number) => string | Promise<string> = () => guide('Every send needs approval')) {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/work-interview-'))
  const paths = await initVault(join(root, 'vault'), { git: false })
  fake.roots = Object.fromEntries(['documents', 'desktop', 'downloads'].map(name => [name, join(root, name)]))
  const jobs: EngineJobInput[] = []
  const engine = { id: 'mock', async *run(job: EngineJobInput) { jobs.push(job); yield { type: 'result', text: await reply(job, jobs.length) } } } as unknown as Engine
  const ctx = { paths, engines: [engine], store: await NoteStore.open(paths) } as Parameters<typeof registerWorkInterviewIpc>[0]
  const onSaved = vi.fn(() => expect(ctx.store.get('n-work-guide')).not.toBeNull())
  registerWorkInterviewIpc(ctx, onSaved)
  return { root, ctx, paths, jobs, onSaved }
}

it('shares bounded file names and hostname metadata only, using the selected isolated engine', async () => {
  const t = await setup(() => questions)
  await mkdir(fake.roots['documents']!, { recursive: true })
  const file = join(fake.roots['documents']!, 'Report.csv')
  await writeFile(file, 'PRIVATE FILE CONTENT MUST STAY LOCAL')
  fake.files.mockResolvedValue({ matches: [{ path: file, name: 'Report.csv', modified: '' }] })
  fake.map.mockResolvedValue({ places: [{ host: 'work.example/path?token=SECRET', purpose: 'PRIVATE CONTENT', work: true }, { host: 'personal.example', work: false }] })
  expect(await call('questions')).toHaveLength(1)
  expect(t.jobs).toHaveLength(1)
  expect(t.jobs[0]).toMatchObject({ disallowTools: true, workdir: t.paths.workspace })
  expect(t.jobs[0]!.prompt).toContain('documents/Report.csv')
  expect(t.jobs[0]!.prompt).toContain('work.example')
  expect(t.jobs[0]!.prompt).not.toMatch(/PRIVATE|SECRET|personal.example/)
  expect(t.jobs[0]!.prompt).not.toContain(t.root)
  expect(await readFile(file, 'utf8')).toBe('PRIVATE FILE CONTENT MUST STAY LOCAL')
})

it('does not enumerate real folders from an isolated profile', async () => {
  vi.stubEnv('ENGRAM_USERDATA', 'isolated-profile')
  await setup(() => questions)
  await call('questions')
  expect(fake.files.mock.calls[0]![0]).toEqual([])
})

it('validates the IPC boundary before spending any model usage', async () => {
  const t = await setup()
  for (const invalid of [null, {}, Array(11).fill(answers[0]), [{ question: 'Q', answer: 'x'.repeat(1201) }], [{ question: 'Q', answer: 'x\0' }]]) await expect(call('save', invalid)).rejects.toThrow()
  expect(await call('save', [])).toEqual({ saved: false })
  expect(t.jobs).toHaveLength(0)
  expect(t.onSaved).not.toHaveBeenCalled()
})

it('retries parsing once but never retries a model or authentication failure', async () => {
  const t = await setup((_job, index) => index === 1 ? 'unusable prose' : questions)
  expect(await call('questions')).toHaveLength(1)
  expect(t.jobs).toHaveLength(2)
  const failed = await setup(() => { throw new Error('Authentication failed') })
  await expect(call('questions')).rejects.toThrow('Authentication failed')
  expect(failed.jobs).toHaveLength(1)
})

it.each(['questions', 'save'])('cancels %s and discards even a late successful model reply', async operation => {
  const started = deferred(), release = deferred()
  const t = await setup(async () => { started.finish(); await release.promise; return operation === 'save' ? guide('Never save this') : questions })
  const pending = call(operation, answers)
  const rejected = expect(pending).rejects.toThrow()
  await started.promise
  await call('cancel'); expect(t.jobs[0]!.signal?.aborted).toBe(true)
  release.finish(); await rejected
  expect(t.jobs).toHaveLength(1)
  await expect(readNote(t.paths, 'n-work-guide')).rejects.toThrow()
  expect(fake.broadcast).not.toHaveBeenCalled()
  expect(t.onSaved).not.toHaveBeenCalled()
})

it('writes only the canonical guide note, not the id in existing frontmatter', async () => {
  const t = await setup()
  await writeNote(t.paths, guideNote('## Rules\n- old', new Date()))
  const path = join(t.paths.notes, 'n-work-guide.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace('id: n-work-guide', 'id: n-somewhere-else'))
  expect(await call('save', answers)).toEqual({ saved: true })
  expect((await readNote(t.paths, 'n-work-guide')).front.id).toBe('n-work-guide')
  expect(t.onSaved).toHaveBeenCalledOnce()
  expect(t.ctx.store.get('n-work-guide')?.body).toContain('Every send needs approval')
  await expect(readNote(t.paths, 'n-somewhere-else')).rejects.toThrow()
})

it('preserves edits or retirement made while the model is writing', async () => {
  const started = deferred(), release = deferred()
  const t = await setup(async () => { started.finish(); await release.promise; return guide('Model rewrite') })
  await writeNote(t.paths, guideNote('## Rules\n- original', new Date()))
  const pending = call('save', answers)
  const rejected = expect(pending).rejects.toThrow('changed')
  await started.promise
  const edited = guideNote('## Rules\n- manual edit', new Date())
  edited.front.status = 'superseded'; await writeNote(t.paths, edited)
  release.finish(); await rejected
  expect((await readNote(t.paths, 'n-work-guide')).body).toContain('manual edit')
  expect(await workGuide(t.paths)).toBe('')
  expect(t.onSaved).not.toHaveBeenCalled()
})

it('learns only with a current opted-in guide and preserves its user-edit timestamp', async () => {
  const t = await setup(() => guide('Every send needs approval'))
  learnFromAnswer(t.ctx, 'Which recipients?', 'External recipients')
  await call('save', []); expect(t.jobs).toHaveLength(0)
  const note = guideNote('## Rules\n- old', new Date('2026-10-01T00:00:00Z'))
  await writeNote(t.paths, note)
  learnFromAnswer(t.ctx, 'Which recipients?', 'External recipients')
  await call('save', [])
  expect((await readNote(t.paths, 'n-work-guide')).front.updated).toBe(note.front.updated)
  expect(t.jobs).toHaveLength(1)
  note.front.status = 'superseded'; await writeNote(t.paths, note)
  learnFromAnswer(t.ctx, 'Which recipients?', 'All recipients')
  await call('save', []); expect(t.jobs).toHaveLength(1)
})

it('serializes learned changes so concurrent answers cannot overwrite one another', async () => {
  const t = await setup((_job, index) => guide(index === 1 ? 'First learned rule' : 'Both learned rules'))
  await writeNote(t.paths, guideNote('## Rules\n- old', new Date()))
  learnFromAnswer(t.ctx, 'First?', 'First rule')
  learnFromAnswer(t.ctx, 'Second?', 'Second rule')
  await call('save', [])
  expect(t.jobs).toHaveLength(2)
  expect(t.jobs[1]!.prompt).toContain('First learned rule')
})
