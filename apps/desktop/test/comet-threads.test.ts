import { describe, expect, it } from 'vitest'
import { cometChannel, cometOfChannel, createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

const BOT = 'bot-abc-1'
const channel = cometChannel(BOT)

describe('cometThreads', () => {
  it('maps a channel back to its comet', () => {
    expect(cometOfChannel(channel)).toBe(BOT)
    expect(cometOfChannel('panel')).toBeNull()
  })

  it('keeps the selection and the draft without a view', () => {
    const store = createCometThreads(null)
    store.select(BOT)
    store.setDraft(BOT, 'half a question')
    expect(store.getSnapshot().selectedId).toBe(BOT)
    expect(store.thread(BOT).draft).toBe('half a question')
  })

  it('keeps a turn in flight on top of a disk reload', () => {
    const store = createCometThreads(BOT)
    store.load(BOT, [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'older answer' }])
    const history = store.begin(BOT, 'new question')
    expect(history).toEqual([{ role: 'user', text: 'old' }, { role: 'assistant', text: 'older answer' }])
    expect(store.thread(BOT).busy).toBe(true)
    expect(store.thread(BOT).draft).toBe('')
    store.handleEvent({ type: 'chat:token', channel, text: 'par' })
    // What the tab reads back from disk while the answer is still coming.
    store.load(BOT, [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'older answer' }])
    const { messages } = store.thread(BOT)
    expect(messages.map((m) => m.text)).toEqual(['old', 'older answer', 'new question', 'par'])
    expect(messages[3]?.streaming).toBe(true)
  })

  it('lands tokens, steps and done with no listener attached', () => {
    const store = createCometThreads(BOT)
    store.begin(BOT, 'q')
    expect(store.handleEvent({ type: 'comet:step', channel, line: 'searching' })).toBe(BOT)
    expect(store.handleEvent({ type: 'chat:token', channel, text: 'a' })).toBe(BOT)
    expect(store.handleEvent({ type: 'chat:token', channel, text: 'b' })).toBe(BOT)
    expect(store.thread(BOT).workLines).toEqual(['searching'])
    expect(store.handleEvent({ type: 'chat:done', channel, text: 'ab!', offer: { kind: 'teach' } })).toBe(BOT)
    const thread = store.thread(BOT)
    expect(thread.busy).toBe(false)
    expect(thread.workLines).toEqual([])
    expect(thread.offer).toEqual({ kind: 'teach' })
    expect(thread.messages.at(-1)).toEqual({ role: 'assistant', text: 'ab!', streaming: false })
  })

  it('ignores events for a comet that is not busy and for other surfaces', () => {
    const store = createCometThreads(BOT)
    expect(store.handleEvent({ type: 'chat:token', channel, text: 'x' })).toBeNull()
    store.begin(BOT, 'q')
    expect(store.handleEvent({ type: 'chat:token', channel: 'panel', text: 'x' })).toBeNull()
    expect(store.thread(BOT).messages.at(-1)?.text).toBe('')
  })

  it('settles the seat on stop and on error', () => {
    const store = createCometThreads(BOT)
    store.begin(BOT, 'q')
    store.stop(BOT, 'Stopped.')
    expect(store.thread(BOT).busy).toBe(false)
    expect(store.thread(BOT).messages.at(-1)).toEqual({ role: 'assistant', text: 'Stopped.', streaming: false })
    store.begin(BOT, 'again')
    store.handleEvent({ type: 'chat:error', channel, message: 'no engine' })
    expect(store.thread(BOT).busy).toBe(false)
    expect(store.thread(BOT).messages.at(-1)).toEqual({ role: 'assistant', text: 'no engine', error: true })
  })

  it('adopts an answer that was already running elsewhere', () => {
    const store = createCometThreads(BOT)
    store.load(BOT, [{ role: 'user', text: 'q' }])
    store.adopt(BOT)
    expect(store.thread(BOT).busy).toBe(true)
    expect(store.thread(BOT).adopted).toBe(true)
    store.handleEvent({ type: 'chat:done', channel, text: 'late answer' })
    expect(store.thread(BOT).busy).toBe(false)
    expect(store.thread(BOT).adopted).toBe(false)
    expect(store.thread(BOT).messages.at(-1)?.text).toBe('late answer')
  })

  it('forgets a deleted comet and drops its selection', () => {
    const store = createCometThreads(BOT)
    store.setDraft(BOT, 'x')
    store.forget(BOT)
    expect(store.getSnapshot().selectedId).toBeNull()
    expect(store.thread(BOT).draft).toBe('')
  })
})

// Pressing Stop settles the thread by itself; the abort's own done event
// arrives afterwards, and disk holds nothing of the exchange. The store has
// to say so, or a reload on that event erases the question just asked.
describe('stop leaves a mark the abort echo can read', () => {
  it('marks the thread stopped, ignores the echo as news, and clears the mark once', () => {
    const store = createCometThreads('a')
    store.begin('a', 'what was decided?')
    store.stop('a', 'Stopped.')
    expect(store.thread('a').busy).toBe(false)
    expect(store.thread('a').stopped).toBe(true)
    expect(store.thread('a').startedAt).toBe(null)
    // The echo: a done for a thread that is no longer waiting is nobody's.
    expect(store.handleEvent({ type: 'chat:done', channel: 'bot-a', text: '' })).toBe(null)
    expect(store.thread('a').messages.map((m) => m.text)).toEqual(['what was decided?', 'Stopped.'])
    store.clearStopped('a')
    expect(store.thread('a').stopped).toBe(false)
  })

  it('counts completions nobody was waiting for, so an adopt in flight can stand down', () => {
    const store = createCometThreads('a')
    expect(store.thread('a').doneSeen).toBe(0)
    store.noteDone('a')
    expect(store.thread('a').doneSeen).toBe(1)
    store.begin('a', 'again')
    expect(store.thread('a').startedAt).not.toBe(null)
  })
})

describe('what the turn did stays readable', () => {
  it('keeps the steps after the answer lands, and clears them when the next turn starts', () => {
    const store = createCometThreads(BOT)
    store.begin(BOT, 'what did I do last week?')
    store.handleEvent({ type: 'comet:step', channel, line: 'open_page: https://one.example' })
    store.handleEvent({ type: 'comet:step', channel, line: 'press: #12' })
    // The answer arriving does not take the steps away with it.
    store.handleEvent({ type: 'chat:token', channel, text: 'Last week you' })
    expect(store.thread(BOT).workLines).toEqual(['open_page: https://one.example', 'press: #12'])
    store.handleEvent({ type: 'chat:done', channel, text: 'Last week you fixed bugs.' })
    const settled = store.thread(BOT)
    expect(settled.busy).toBe(false)
    expect(settled.workLines).toEqual([])
    expect(settled.keptWork).toEqual(['open_page: https://one.example', 'press: #12'])
    store.begin(BOT, 'and this week?')
    expect(store.thread(BOT).keptWork).toEqual([])
  })

  it(`keeps the whole turn's steps, not the last few`, () => {
    const store = createCometThreads(BOT)
    store.begin(BOT, 'q')
    for (let i = 0; i < 12; i++) store.handleEvent({ type: 'comet:step', channel, line: `press: #${i}` })
    expect(store.thread(BOT).workLines).toHaveLength(12)
  })
})

describe('words written before an action', () => {
  it('leave the bubble but stay in the work as what it said', () => {
    const store = createCometThreads(BOT)
    store.begin(BOT, 'q')
    store.handleEvent({ type: 'chat:token', channel, text: 'Let me check the page.' })
    store.handleEvent({ type: 'chat:token', channel, text: '', reset: true })
    const thread = store.thread(BOT)
    expect(thread.messages.at(-1)?.text).toBe('')
    expect(thread.workLines).toEqual(['said: Let me check the page.'])
    // Nothing said, nothing noted.
    store.handleEvent({ type: 'chat:token', channel, text: '', reset: true })
    expect(store.thread(BOT).workLines).toHaveLength(1)
  })
})
