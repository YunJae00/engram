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
