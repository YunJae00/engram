import { readFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runToolSession, WORK_REPLY_RULE, type AgentTool, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { answer, openWorld } from '../src/main/answer.js'

const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const tool = (name: string, run: (args: Record<string, unknown>) => Promise<string> = async () => ''): AgentTool => ({ name, description: name, argsSchema: { type: 'object' }, run })
async function lead(message: string, menu: AgentTool[], draft: (job: ToolSessionJob) => Promise<string> = async () => '네.', files: Record<string, string> = {}) {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'claude', desktopToolIsolation: true, quick: async () => 'NONE', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: await draft(job) } } } as unknown as Engine
  const dir = await mkdtemp(join(tmpdir(), 'c13c-')); scratch.push(dir)
  const world = await openWorld(dir, engine)
  for (const [name, text] of Object.entries(files)) { await mkdir(join(world.paths.workspace, name, '..'), { recursive: true }); await writeFile(join(world.paths.workspace, name), text) }
  const { result } = await answer(world, message, { tools: menu })
  return { job: jobs[0]!, posted: result?.answer }
}

describe('c13c: a short ask has one owner for its reply shape', () => {
  it('a short ask gets the rules, menu and call shape of any other ask, with no host note of its own', async () => {
    const menu = [tool('file_read'), tool('search_web'), tool('word_write')]
    const short = await lead('‘다음 주 월요일 휴무입니다’를 일본어 한 줄로 써줘', menu)
    const work = await lead('분리수거 요일 안내문 워드로 만들어줘', menu)
    expect(short.job.system).toBe(work.job.system)
    expect(short.job.system).toContain(WORK_REPLY_RULE)
    expect(short.job.tools.map(one => one.name)).toEqual(work.job.tools.map(one => one.name))
    for (const job of [short.job, work.job]) { expect(job.modelHint).toBeUndefined(); expect(job.effort).toBeUndefined() }
    expect(`${short.job.system}\n${short.job.prompt}\n${short.job.opening ?? ''}`).not.toContain('This is a short ask')
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/SHORT_QUESTION_NOTE|SMALL_TALK_NOTE|TOLD_NOTE|short: true/)
  })
})

describe('c13c: a reshape is the model\'s reply in the asked form, posted as written', () => {
  const LAST = 'Thank you so much for your help with the launch yesterday.'
  async function reshape(said: string, last: string, draft: string) {
    const jobs: ToolSessionJob[] = [], voiced: string[] = []
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick: async (prompt: string) => { voiced.push(prompt); return 'NO' } } as unknown as Engine
    const result = await runToolSession({ engine, workdir: '/tmp/c13c-voice' as EngineCwd, tools: [] }, said, { history: [{ role: 'user', text: '출시 도와줘서 고맙다는 영어 한 줄 써줘' }, { role: 'assistant', text: last }] })
    return { posted: result.answer, calls: jobs.length, voiced, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
  }
  it('the same text back for "shorter" is posted too: the host compares nothing and the turn is one model call', async () => {
    const { posted, calls, voiced } = await reshape('더 간단하게', LAST, LAST)
    expect(posted).toBe(LAST)
    expect(calls).toBe(1)
    expect(voiced).toEqual([])
  })
  it('a really shorter reply is posted as written', async () => {
    expect((await reshape('좀 줄여봐', LAST, 'Thanks for your help with the launch.')).posted).toBe('Thanks for your help with the launch.')
  })
  it('commentary is the model\'s to leave out: it is told so, and an explanation line it still writes is posted with the sentence', async () => {
    const last = `이렇게 쓰면 돼요. ${LAST}\n출시를 도와준 데 감사하는 뜻을 담은 문장이에요.`
    const draft = `감사 인사예요.\n${LAST}`
    const { posted, told } = await reshape('더 간단하게', last, draft)
    expect(told).toContain('no value guessed, nothing about the change')
    expect(posted).toBe(draft)
    expect((await reshape('더 간단하게', last, 'Thanks!')).posted).toBe('Thanks!')
  })
  it('a reply cut word for word out of the last reply is posted like any other, quotes and all', async () => {
    const line = '明日は休みをいただきます。'
    const last = `이렇게 보내면 돼요. "${line}" 내일 휴가라는 뜻을 공손하게 전하는 문장이에요.`
    for (const reply of [line, `"${line}"`, `이렇게 보내면 돼요. "${line}"`, '"明日休みます。"']) expect((await reshape('조금만 줄여줘', last, reply)).posted, reply).toBe(reply)
  })
  it('stack-13 (c13c r3 #1): "shorter" is measured by nobody: the last reply is in front of the model, and the desk lane holds no reshape', async () => {
    const asked = 'Thanks again for covering my shift on Friday.'
    const last = `${asked}\n금요일 근무를 대신해 줘서 고맙다는 뜻이에요.`
    const inline = `이렇게 쓰면 돼요. "${asked}" 고맙다는 뜻을 담았어요.`
    for (const before of [last, inline]) for (const reply of ['Thanks again for covering my shift on Friday!', 'Thanks for covering Friday.']) {
      const { posted, told } = await reshape('좀 줄여봐', before, reply)
      expect(posted).toBe(reply)
      expect(told).toContain(asked)
    }
    expect(existsSync(new URL('../src/main/desk-lane.ts', import.meta.url))).toBe(false)
  })
  it('a table is posted byte for byte, and so is plain text: no form is read out of the reply', async () => {
    const table = '| 내용 |\n|---|\n| 출시 도움 감사 |'
    expect((await reshape('표로 바꿔줘', LAST, table)).posted).toBe(table)
    const wrapped = JSON.stringify({ form: 'poem', reply: table })
    expect((await reshape('표로 바꿔줘', LAST, wrapped)).posted).toBe(wrapped)
    expect(ipc).not.toMatch(/reshape/i)
  })
  it('the turn asks for the asked thing only, with no commentary, and for no wrapper around it', async () => {
    const { told } = await reshape('더 간단하게', LAST, 'Thanks!')
    expect(told).toContain('A reply asked for in another form is written again in it')
    expect(told).toContain(LAST)
    expect(told).not.toContain('"form"')
  })
})

describe('c13c: notes separate a decision from an action item by meaning', () => {
  const note = ['# 보일러 점검 메모', '', '## 논의', '- 기사님 방문은 오전 쪽이 낫다는 말이 많았다.', '', '## 결정사항', '1. 점검 일정 확정 — 담당: 문가람, 기한: 12월 9일', '2. 입주민 공지 — 담당: 하지율, 기한: 12월 11일'].join('\n')
  it('a named note reaches the model as a name only: it reads the file with its own call, and the prompt holds none of the file', async () => {
    const reads: unknown[] = []
    const menu = [tool('file_read', async args => { reads.push(args['path']); return note }), tool('search_web')]
    const asked = 'fixtures/boiler-check.md 점검 메모에서 결정된 것만 추려줘'
    const { job, posted } = await lead(asked, menu, async job => { await job.tools.find(one => one.name === 'file_read')!.run({ path: 'fixtures/boiler-check.md' }); return '점검 일정을 정했어요.' }, { 'fixtures/boiler-check.md': note })
    const told = `${job.system}\n${job.prompt}\n${job.opening ?? ''}`
    expect(job.tools.map(one => one.name)).toContain('file_read')
    expect(reads).toEqual(['fixtures/boiler-check.md'])
    expect(told).toContain('fixtures/boiler-check.md')
    for (const line of ['기사님 방문은 오전 쪽이 낫다는 말이 많았다', '문가람', 'already read for you']) expect(told).not.toContain(line)
    expect(posted).toBe('점검 일정을 정했어요.')
  })
})
