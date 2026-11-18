import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { askedBefore, reshapeAsk, reshapePrompt, RESHAPE_DUE_MS } from '../src/main/desk-lane.js'

// c14b (cause W, reshape path): the voice that rewrites its last reply now reads the ask that reply answered, and its rewrite is checked for
// meaning against both: a constraint of that ask (audience, register, format, language) the new form drops is a problem ("dropped").
// Wordings are not the harness's: an explanation for a child, made shorter.
const ASK = '광합성이 뭔지 초등학생 아이에게 설명하듯 써줘'
const LAST = '식물은 햇빛을 밥처럼 먹어요. 잎에서 햇빛이랑 물, 공기를 섞어서 자기가 먹을 달콤한 양분을 만들어요. 그래서 식물한테는 햇빛이 아주 중요해요.'
const was = LAST
const voiceSaid = (reply: string): string => JSON.stringify({ form: 'shorter', was, reply })
// c18b: the one fix after a check is a scoped repair (core repairedWrite), answered as replacements of numbered units.
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
    // With no earlier ask, the prompt is as before.
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
    // The checker reads the earlier ask and the earlier reply as data.
    expect(calls[1]).toContain(CHECK)
    expect(calls[1]).toContain('"earlierAsk":"광합성이 뭔지 초등학생 아이에게 설명하듯 써줘"')
    expect(calls[1]).toContain('"dropped"')
    expect(calls[2]).toContain(REDO)
  })

  it('a rewrite that still drops it is no reshape: the turn keeps its usual route', async () => {
    const dropped = JSON.stringify({ problems: [{ kind: 'dropped', quote: jargon, why: '어른 말투' }] })
    const { quick, calls } = voice(voiceSaid(jargon), voiceSaid(jargon), [dropped, dropped])
    expect(await reshapeAsk('더 짧게', LAST, quick, ASK)).toBeUndefined()
    // c18b: voice, check, a repair that is no repair (not the JSON asked for): no second check.
    expect(calls).toHaveLength(3)
    // The same draft with a clean verdict is a valid shorter reply: the check alone turned it away.
    expect(await reshapeAsk('더 짧게', LAST, voice(voiceSaid(jargon), '', [none]).quick, ASK)).toBe(jargon)
  })

  it('a clean verdict or a late checker keeps the reply, and the whole reshape stays inside its time', async () => {
    const clean = voice(voiceSaid(childlike), '', [none])
    expect(await reshapeAsk('더 짧게', LAST, clean.quick, ASK)).toBe(childlike)
    expect(clean.calls).toHaveLength(2)
    // The checker never answers: the reply stands, at the reshape's own deadline (fake clock: the voice took most of it).
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
