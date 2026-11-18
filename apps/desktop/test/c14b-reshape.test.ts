import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askedBefore, reshapeAsk, reshapePrompt, RESHAPE_DUE_MS } from '../src/main/desk-lane.js'

const ASK = '광합성이 뭔지 초등학생 아이에게 설명하듯 써줘'
const LAST = '식물은 햇빛을 밥처럼 먹어요. 잎에서 햇빛이랑 물, 공기를 섞어서 자기가 먹을 달콤한 양분을 만들어요. 그래서 식물한테는 햇빛이 아주 중요해요.'
const was = LAST
const voiceSaid = (reply: string): string => JSON.stringify({ form: 'shorter', was, reply })
const CHECK = 'Judge meaning only', REDO = 'You fix a message'
const none = JSON.stringify({ problems: [] })

function voice(draft: string, rewrite: string, verdicts: string[]) {
  const calls: string[] = []
  const quick = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? verdicts.shift() ?? none : prompt.includes(REDO) ? rewrite : draft }
  return { quick, calls }
}

describe('c14b: a reshape keeps the constraints of the ask the last reply answered', () => {
  const jargon = '잎에서 엽록체가 빛으로 물과 공기를 포도당으로 합성해요.'
  const childlike = '식물은 햇빛으로 물이랑 공기를 섞어 밥을 만들어요.'

  it('gives the voice the earlier ask, and says the new form keeps it', () => {
    const prompt = reshapePrompt('더 짧게', LAST, ASK)
    expect(prompt).toContain(ASK)
    expect(prompt).toContain('keeps every constraint')
    expect(reshapePrompt('더 짧게', LAST)).not.toContain('The person had asked')
  })

  it('finds the ask the last reply answered in the thread', () => {
    expect(askedBefore([{ role: 'user', text: '안녕' }, { role: 'assistant', text: '안녕하세요' }, { role: 'user', text: ASK }, { role: 'assistant', text: LAST }])).toBe(ASK)
    expect(askedBefore([{ role: 'user', text: ASK }])).toBeUndefined()
    expect(askedBefore([])).toBeUndefined()
  })

  it('a shorter reply in adult jargon is "dropped", rewritten once, and the rewrite is shown', async () => {
    const { quick, calls } = voice(voiceSaid(jargon), JSON.stringify({ replace: { 1: childlike } }), [JSON.stringify({ problems: [{ kind: 'dropped', quote: jargon, why: '아이에게 설명하듯이 아니에요' }] }), none])
    expect(await reshapeAsk('더 짧게', LAST, quick, ASK)).toBe(childlike)
    expect(calls).toHaveLength(4)
    expect(calls[1]).toContain(CHECK)
    expect(calls[1]).toContain('"earlierAsk":"광합성이 뭔지 초등학생 아이에게 설명하듯 써줘"')
    expect(calls[1]).toContain('"dropped"')
    expect(calls[2]).toContain(REDO)
  })

  it('a rewrite that still drops it is no reshape: the turn keeps its usual route', async () => {
    const dropped = JSON.stringify({ problems: [{ kind: 'dropped', quote: jargon, why: '어른 말투' }] })
    const { quick, calls } = voice(voiceSaid(jargon), voiceSaid(jargon), [dropped, dropped])
    expect(await reshapeAsk('더 짧게', LAST, quick, ASK)).toBeUndefined()
    expect(calls).toHaveLength(3)
    expect(await reshapeAsk('더 짧게', LAST, voice(voiceSaid(jargon), '', [none]).quick, ASK)).toBe(jargon)
  })

  it('a clean verdict or a late checker keeps the reply, and the whole reshape stays inside its time', async () => {
    const clean = voice(voiceSaid(childlike), '', [none])
    expect(await reshapeAsk('더 짧게', LAST, clean.quick, ASK)).toBe(childlike)
    expect(clean.calls).toHaveLength(2)
    let clock = 0
    const quick = (prompt: string): Promise<string> => { if (prompt.includes(CHECK)) return new Promise(() => undefined); clock = RESHAPE_DUE_MS - 1100; return Promise.resolve(voiceSaid(childlike)) }
    const began = Date.now()
    expect(await reshapeAsk('더 짧게', LAST, quick, ASK, () => clock)).toBe(childlike)
    expect(Date.now() - began).toBeLessThan(1600)
  })

  it('ipc passes the earlier ask from the thread to the reshape', () => {
    const ipc = readFileSync(resolve(__dirname, '../src/main/ipc.ts'), 'utf8')
    expect(ipc).toContain('askedBefore(savedHistory.filter(one => !one.progress && !one.error))')
  })
})
