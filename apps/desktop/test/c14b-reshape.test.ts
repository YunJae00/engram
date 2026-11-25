import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runToolSession, type AgentLoopOptions, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()

const ASK = '광합성이 뭔지 초등학생 아이에게 설명하듯 써줘'
const LAST = '식물은 햇빛을 밥처럼 먹어요. 잎에서 햇빛이랑 물, 공기를 섞어서 자기가 먹을 달콤한 양분을 만들어요. 그래서 식물한테는 햇빛이 아주 중요해요.'
const KEEPS = 'write that reply again in the asked form with every fact and every constraint of the original ask kept, and nothing about what you changed'
const WORKDIR = '/tmp/c14b-reshape' as EngineCwd
const THREAD = [{ role: 'user' as const, text: '안녕' }, { role: 'assistant' as const, text: '안녕하세요' }, { role: 'user' as const, text: ASK }, { role: 'assistant' as const, text: LAST }]

async function turn(draft: string, said: string, options: AgentLoopOptions = {}, quick?: Engine['quick']) {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, ...(quick ? { quick } : {}) } as unknown as Engine
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [] }, said, options)
  return { posted: result.answer, jobs, told: jobs.map(job => `${job.system}\n${job.prompt}\n${job.opening ?? ''}`).join('\n') }
}

describe('c14b: a reshape keeps the constraints of the ask the last reply answered', () => {
  const jargon = '잎에서 엽록체가 빛으로 물과 공기를 포도당으로 합성해요.'
  const childlike = '식물은 햇빛으로 물이랑 공기를 섞어 밥을 만들어요.'

  it('gives the model the earlier ask, and says the new form keeps it', async () => {
    const { told } = await turn(childlike, '더 짧게', { history: THREAD })
    expect(told).toContain(KEEPS)
    expect(told).toContain(ASK)
    expect(told).toContain(LAST)
  })

  it('the model reads the ask the last reply answered where the thread has it, before that reply', async () => {
    const { told } = await turn(childlike, '더 짧게', { history: THREAD })
    expect(told.indexOf(ASK)).toBeGreaterThan(-1)
    expect(told.indexOf(ASK)).toBeLessThan(told.indexOf(LAST))
    expect((await turn(childlike, '더 짧게')).told).not.toContain(ASK)
  })

  it('a shorter reply in adult jargon is posted as the model wrote it: one model call, no check and no rewrite', async () => {
    const asked: string[] = []
    const { posted, jobs } = await turn(jargon, '더 짧게', { history: THREAD }, async prompt => { asked.push(prompt); return childlike })
    expect(posted).toBe(jargon)
    expect(jobs).toHaveLength(1)
    expect(asked).toEqual([])
  })

  it('a reshape is an ordinary turn: the desk lane has no reshape of its own to fall back from', () => {
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
    expect(Object.keys(deskLane)).toContain('closingBuilds')
  })

  it('no checker is waited on: a quick voice that never answers does not hold the reply', async () => {
    const began = Date.now()
    const { posted } = await turn(childlike, '더 짧게', { history: THREAD }, () => new Promise<string>(() => undefined))
    expect(posted).toBe(childlike)
    expect(Date.now() - began).toBeLessThan(1600)
  })

  it('ipc hands the thread to the model turn and holds no reshape step', () => {
    const ipc = readFileSync(resolve(__dirname, '../src/main/ipc.ts'), 'utf8')
    expect(ipc).toContain('history: savedHistory.map((turn) => ({ role: turn.role, text: turn.text, at: turn.at, attachments: turn.attachments })) }, request.message, {')
    expect(ipc).not.toMatch(/reshape|askedBefore/i)
  })
})
