import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Engine, ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'
import { loadCases, runCases, runtimeInputs, summaryTable, type EvalCase } from '../src/main/runner.js'

const scratch: string[] = []
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'runner-test-')); scratch.push(dir); return dir }
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

type Script = (job: ToolSessionJob, call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<string>
const fakeEngine = (script: Script): Engine => ({
  id: 'mock',
  desktopToolIsolation: true,
  detect: async () => ({ installed: true, loggedIn: true }),
  run: async function* () { yield { type: 'result', text: '' } },
  runTools: async (job: ToolSessionJob) => ({ answer: await script(job, (name, args) => job.tools.find(tool => tool.name === name)!.run(args)) }),
}) as unknown as Engine

describe('case loading', () => {
  it('reads every case from a case file, or only the ones named, and refuses a name that is not there', async () => {
    const dir = await temp()
    const file = join(dir, 'orchard-cases.mjs')
    await writeFile(file, "export const CASES = [{ id: 'pear-count', ask: () => 'x', grade: () => ({}) }, { id: 'plum-price', ask: () => 'y', grade: () => ({}) }]\n")
    expect((await loadCases(file)).map(one => one.id)).toEqual(['pear-count', 'plum-price'])
    expect((await loadCases(file, ['plum-price'])).map(one => one.id)).toEqual(['plum-price'])
    await expect(loadCases(file, ['fig-harvest'])).rejects.toThrow('fig-harvest')
  })

  it('reads the quick eval case file the app already grades with', async () => {
    const cases = await loadCases(join(__dirname, '../scripts/eval-quick-cases.mts'))
    expect(cases.length).toBeGreaterThan(1)
    for (const one of cases) expect(typeof one.grade).toBe('function')
  })
})

describe('one world per case', () => {
  it('keeps what one case schedules out of another case running at the same time', async () => {
    const engine = fakeEngine(async (job, call) => {
      const what = job.prompt.includes('사과') ? '사과 따기' : '배 따기'
      await call('schedule', { action: 'add', what, time: '07:30', days: [1] })
      return `${what} 잡았어요.`
    })
    const graded: string[][] = []
    const crop = (id: string, ask: string): EvalCase => ({ id, ask: () => ask, grade: run => { graded.push(run.tasks.map(task => (task as { goal: string }).goal)); return { one: run.tasks.length === 1 } } })
    const out = await temp()
    const rows = await runCases([crop('apple', '매주 월요일 사과 따기 잡아줘'), crop('pear', '매주 월요일 배 따기 잡아줘')], engine, { out, workers: 2, deadlineMs: 10_000 })
    expect(rows.map(row => [row.id, row.pass])).toEqual([['apple', true], ['pear', true]])
    expect(graded.sort()).toEqual([['배 따기'], ['사과 따기']])
    expect((await readdir(out)).sort()).toEqual(['apple.json', 'pear.json', 'summary.md'])
  })

  it('gives two worlds their own vault and bot', async () => {
    const engine = fakeEngine(async () => '')
    const [a, b] = [await openWorld(await temp(), engine), await openWorld(await temp(), engine)]
    expect(a.paths.root).not.toBe(b.paths.root)
    expect(existsSync(a.paths.workspace)).toBe(true)
  })
})

describe('the trace of one case', () => {
  it('records the first line shown, each step, the final text and how it ended', async () => {
    const engine = fakeEngine(async (job, call) => {
      job.onToken?.('지금 과수원 장부 ')
      job.onToken?.('열어볼게요.\n')
      await call('open_page', { url: 'http://127.0.0.1:9/' }).catch(() => undefined)
      return '배는 40상자예요.'
    })
    const out = await temp()
    const [row] = await runCases([{ id: 'ledger', ask: () => '배 몇 상자야?', grade: run => ({ said: run.answers[0]!.includes('40상자') }) }], engine, { out, workers: 1, deadlineMs: 10_000 })
    const trace = JSON.parse(await readFile(join(out, 'ledger.json'), 'utf8'))
    expect(trace.first.text).toBe('지금 과수원 장부 열어볼게요.')
    expect(trace.first.ms).toBeGreaterThanOrEqual(0)
    expect(trace.steps.map((step: { line: string }) => step.line.split(':')[0])).toContain('open_page')
    expect(trace.final.text).toBe('배는 40상자예요.')
    expect(trace.final.ms).toBeGreaterThanOrEqual(trace.first.ms)
    expect(trace.end).toBe('done')
    expect(row).toMatchObject({ id: 'ledger', pass: true, end: 'done' })
    expect(await readFile(join(out, 'summary.md'), 'utf8')).toContain('| ledger | PASS |')
  })

  it('ends as stop when the case runs past its time', async () => {
    const engine = fakeEngine(job => new Promise((_, reject) => job.signal!.addEventListener('abort', () => reject(new Error('stopped')))))
    const out = await temp()
    const [row] = await runCases([{ id: 'slow-harvest', ask: () => '천천히 세어줘', grade: () => ({}) }], engine, { out, workers: 1, deadlineMs: 50 })
    expect(row).toMatchObject({ end: 'stop', pass: false })
    expect(JSON.parse(await readFile(join(out, 'slow-harvest.json'), 'utf8')).end).toBe('stop')
  })

  it('carries earlier turns of the same world into the next answer', async () => {
    const heard: string[] = []
    const world = await openWorld(await temp(), fakeEngine(async job => { heard.push(job.opening ?? ''); return heard.length === 1 ? '복숭아는 12개예요.' : '자두는 5개예요.' }))
    await answer(world, '복숭아 몇 개 남았어?')
    await answer(world, '자두는?')
    expect(heard[1]).toContain('복숭아는 12개예요.')
    expect(world.history.map(turn => turn.text)).toEqual(['복숭아 몇 개 남았어?', '복숭아는 12개예요.', '자두는?', '자두는 5개예요.'])
  })
})

describe('what a case is graded on', () => {
  it('grades the study offers the answer made in its own world', async () => {
    const engine = fakeEngine(async (job, call) => {
      if (job.prompt.includes('양봉')) await call('offer_study', { what: '양봉 일지 쓰는 법', where: ['농장 기록장'] })
      return '그건 아직 몰라요.'
    })
    const offered: Record<string, string[]> = {}
    const hive = (id: string, ask: string): EvalCase => ({ id, ask: () => ask, grade: run => { offered[id] = run.offers.map(one => one.what); return {} } })
    await runCases([hive('bees', '양봉 일지 정리해줘'), hive('hay', '건초 몇 단이야?')], engine, { out: await temp(), workers: 2, deadlineMs: 10_000 })
    expect(offered).toEqual({ bees: ['양봉 일지 쓰는 법'], hay: [] })
  })

  it('hands a message sent mid-work to the model and grades the answer that took it in', async () => {
    const prompts: string[] = []
    const engine = fakeEngine(async job => {
      prompts.push(job.prompt)
      if (prompts.length === 1) { await new Promise(resolve => setTimeout(resolve, 120)); return '감자는 3포대예요.' }
      return '감자 3포대, 고구마 2포대예요.'
    })
    const out = await temp()
    const [row] = await runCases([{ id: 'cellar', ask: () => '창고에 감자 몇 포대야?', aside: { afterMs: 20, text: '고구마도 같이 세어줘' }, grade: run => ({ both: run.answers[0]!.includes('고구마') }) }], engine, { out, workers: 1, deadlineMs: 10_000 })
    expect(prompts.slice(1).join('\n')).toContain('고구마도 같이 세어줘')
    expect(row).toMatchObject({ pass: true, end: 'done' })
  })

  it('still writes the trace when the case fails outside the answer', async () => {
    const out = await temp()
    const rows = await runCases([
      { id: 'broken-scale', ask: () => '무게 재줘', grade: () => { throw new Error('scale jammed') } },
      { id: 'no-question', ask: () => { throw new Error('ask lost') }, grade: () => ({}) },
    ], fakeEngine(async () => '12킬로예요.'), { out, workers: 1, deadlineMs: 10_000 })
    expect(rows.map(row => [row.id, row.pass, row.end, row.error])).toEqual([['broken-scale', false, 'done', 'scale jammed'], ['no-question', false, 'error', 'ask lost']])
    const scale = JSON.parse(await readFile(join(out, 'broken-scale.json'), 'utf8'))
    expect(scale).toMatchObject({ final: { text: '12킬로예요.' }, error: 'scale jammed' })
    expect(JSON.parse(await readFile(join(out, 'no-question.json'), 'utf8'))).toMatchObject({ end: 'error', error: 'ask lost' })
  })
})

const observed = (out: unknown) => JSON.parse(String(out).split('\n(Observation')[0]!)

describe('earlier asks and the work folder', () => {
  it('runs the earlier asks in the same world so the graded answer hears them, and grades only the last', async () => {
    const openings: string[] = []
    const engine = fakeEngine(async job => { openings.push(job.opening ?? ''); return openings.length === 1 ? '올해 모종은 상추로 할게요.' : openings.length === 2 ? '상추 말고 깻잎으로 바꿀게요.' : '깻잎이에요.' })
    const graded: string[][] = []
    const out = await temp()
    const [row] = await runCases([{ id: 'seedlings', before: ['올해 모종은 상추야', '아 상추 말고 깻잎이야'], ask: () => '올해 모종 뭐였지?', grade: run => { graded.push(run.answers); return { leaf: run.answers[0] === '깻잎이에요.' } } }], engine, { out, workers: 1, deadlineMs: 10_000 })
    expect(openings).toHaveLength(3)
    expect(openings[2]).toContain('아 상추 말고 깻잎이야')
    expect(openings[2]).toContain('상추 말고 깻잎으로 바꿀게요.')
    expect(graded).toEqual([['깻잎이에요.']])
    expect(row).toMatchObject({ pass: true })
    const trace = JSON.parse(await readFile(join(out, 'seedlings.json'), 'utf8'))
    expect(trace.before.map((one: { message: string }) => one.message)).toEqual(['올해 모종은 상추야', '아 상추 말고 깻잎이야'])
    expect(trace.message).toBe('올해 모종 뭐였지?')
  })

  it('seeds the case files where the file tools find, read and move them, and grades the folder after the run', async () => {
    const read: string[] = []
    const engine = fakeEngine(async (_job, call) => {
      const found = observed(await call('find_files', { query: '씨앗' })) as { matches: { path: string }[] }
      const path = found.matches.map(one => one.path).find(one => one.endsWith('씨앗목록.txt'))!
      read.push(String(await call('file_read', { path })))
      await call('file_move', { moves: [{ from: '창고/씨앗목록.txt', to: '정리/목록/씨앗목록.txt' }] })
      return '옮겼어요.'
    })
    const listed: string[][] = []
    await runCases([{ id: 'shed', files: { '창고/씨앗목록.txt': '호박 3봉지', '창고/농기구.md': '삽 2개' }, ask: () => '씨앗 목록 정리 폴더로 옮겨줘', grade: run => { listed.push(run.files); return {} } }], engine, { out: await temp(), workers: 1, deadlineMs: 10_000 })
    expect(read.join('')).toContain('호박 3봉지')
    expect(listed).toEqual([['정리/목록/씨앗목록.txt', '창고/농기구.md']])
  })

  it('keeps the files of two cases running side by side apart', async () => {
    const seen: Record<string, string[]> = {}
    const engine = fakeEngine(async (job, call) => {
      const found = observed(await call('find_files', { query: '일지' })) as { matches: { name: string }[] }
      seen[job.prompt.includes('오리') ? 'duck' : 'goat'] = found.matches.map(one => one.name).sort()
      return '찾았어요.'
    })
    const listed: Record<string, string[]> = {}
    const barn = (id: string, ask: string, files: Record<string, string>): EvalCase => ({ id, files, ask: () => ask, grade: run => { listed[id] = run.files; return {} } })
    await runCases([barn('duck', '오리 일지 찾아줘', { '오리일지.txt': '알 6개' }), barn('goat', '염소 일지 찾아줘', { '염소일지.txt': '젖 2리터' })], engine, { out: await temp(), workers: 2, deadlineMs: 10_000 })
    expect(seen).toEqual({ duck: ['오리일지.txt'], goat: ['염소일지.txt'] })
    expect(listed).toEqual({ duck: ['오리일지.txt'], goat: ['염소일지.txt'] })
  })
})

describe('the summary table and the runtime inputs', () => {
  it('lists the failed checks and the error of each row', () => {
    expect(summaryTable([{ id: 'fig', pass: false, checks: { ripe: false, picked: true }, firstMs: null, finalMs: 12, end: 'done', error: 'boom' }])).toContain('| fig | FAIL | - | 12 | done | ripe, boom |')
  })

  it('points at the runtime folder it is given and reports it missing when it is not there', async () => {
    const inputs = runtimeInputs(join(await temp(), 'nowhere'), { HOME: '/orchard' })
    expect(inputs.binary()).toBeNull()
    expect(inputs.env('system')).toEqual({ HOME: '/orchard' })
    expect(inputs.hasConnection('system')).toBe(false)
  })
})
