import { describe, expect, it, vi } from 'vitest'
import type { ChatTurnDto } from '../src/shared/types.js'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

const BOT = 'bot-earlier-1'

const history = (n: number): ChatTurnDto[] => {
  const turns: ChatTurnDto[] = []
  for (let i = 0; i < n; i++) turns.push({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, at: `t${String(i).padStart(5, '0')}` })
  return turns
}
// The newest `n` turns of an `all`-turn history, read the way core pages it.
const newest = (all: ChatTurnDto[], n: number) => all.slice(Math.max(0, all.length - n))
const pageOf = (all: ChatTurnDto[], before: number, limit: number) => all.slice(Math.max(0, all.length - before - limit), all.length - before)
const reader = (all: ChatTurnDto[]) => vi.fn((_id: string, before: number, limit: number) => Promise.resolve(pageOf(all, before, limit)))
const keyed = (store: ReturnType<typeof createCometThreads>) => {
  const { messages, older } = store.thread(BOT)
  return new Map(messages.map((m, i) => [m.text, -older + i]))
}
const deferred = () => {
  let resolve: (turns: ChatTurnDto[]) => void = () => undefined
  const promise = new Promise<ChatTurnDto[]>(done => { resolve = done })
  return { promise, resolve }
}

describe('cometThreads earlier pages', () => {
  it('prepend page keeps scroll anchor ids', async () => {
    const all = history(2000)
    const store = createCometThreads(BOT)
    store.load(BOT, newest(all, 400))
    store.begin(BOT, 'still asking')
    const before = keyed(store)
    const texts = store.thread(BOT).messages.map(m => m.text)
    const read = reader(all)
    expect(await store.loadEarlier(BOT, read)).toBe(100)
    expect(read).toHaveBeenCalledWith(BOT, 400, 100)
    const after = keyed(store)
    for (const [text, key] of before) expect(after.get(text)).toBe(key)
    const { messages, older } = store.thread(BOT)
    expect(older).toBe(100)
    expect(messages.map(m => m.text)).toEqual([...all.slice(1500, 1600).map(t => t.text), ...texts])
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true })
    const again = vi.fn(() => Promise.resolve(all.slice(1500, 1600)))
    expect(await store.loadEarlier(BOT, again)).toBe(0)
    expect(store.thread(BOT).messages).toEqual(messages)
    expect(store.thread(BOT).cursor).toBe(600)
  })

  it('cursor counts disk turns and stops on a short page', async () => {
    const all = history(560)
    all[557] = { ...all[557]!, text: 'part', progress: true }
    all[559] = { ...all[559]!, text: 'part and the rest' }
    const store = createCometThreads(BOT)
    store.load(BOT, newest(all, 400))
    expect(store.thread(BOT).messages).toHaveLength(399)
    expect(store.thread(BOT)).toMatchObject({ cursor: 400, pageDone: false })
    const read = reader(all)
    await store.loadEarlier(BOT, read)
    expect(store.thread(BOT)).toMatchObject({ cursor: 500, pageDone: false, older: 100 })
    await store.loadEarlier(BOT, read)
    expect(read).toHaveBeenLastCalledWith(BOT, 500, 100)
    expect(store.thread(BOT)).toMatchObject({ cursor: 560, pageDone: true, older: 160 })
    expect(await store.loadEarlier(BOT, read)).toBe(0)
    expect(read).toHaveBeenCalledTimes(2)
    const short = createCometThreads(BOT)
    short.load(BOT, history(300))
    const none = reader(history(300))
    expect(await short.loadEarlier(BOT, none)).toBe(0)
    expect(short.thread(BOT)).toMatchObject({ cursor: 300, pageDone: true })
    expect(none).not.toHaveBeenCalled()
  })

  it('reload after prepend keeps older pages without gaps or duplicates', async () => {
    const all = history(2000)
    const store = createCometThreads(BOT)
    store.load(BOT, newest(all, 400))
    await store.loadEarlier(BOT, reader(all))
    const before = keyed(store)
    const grown = history(2002)
    store.load(BOT, newest(grown, 400))
    const { messages, older, cursor } = store.thread(BOT)
    expect(messages.map(m => m.text)).toEqual(grown.slice(1500).map(t => t.text))
    expect(older).toBe(100)
    expect(cursor).toBe(502)
    const after = keyed(store)
    for (const [text, key] of before) expect(after.get(text)).toBe(key)
    const read = reader(grown)
    await store.loadEarlier(BOT, read)
    expect(read).toHaveBeenCalledWith(BOT, 502, 100)
    expect(store.thread(BOT).messages.map(m => m.text)).toEqual(grown.slice(1400).map(t => t.text))

    const hidden = history(502)
    hidden[100] = { role: 'assistant', text: 'part', at: 'h100', progress: true }
    hidden[101] = { role: 'assistant', text: 'part final', at: 'h101' }
    hidden[102] = { role: 'assistant', text: 'step', at: 'h102', progress: true }
    hidden[103] = { role: 'assistant', text: 'step final', at: 'h103' }
    const disk = hidden.slice(0, 500)
    const quiet = createCometThreads(BOT)
    quiet.load(BOT, newest(disk, 400))
    await quiet.loadEarlier(BOT, reader(disk))
    const paged = quiet.thread(BOT).messages
    quiet.load(BOT, newest(disk, 400))
    expect(quiet.thread(BOT)).toMatchObject({ older: 100, cursor: 500, messages: paged })
    quiet.load(BOT, newest(hidden, 400))
    expect(quiet.thread(BOT)).toMatchObject({ older: 100, cursor: 502 })
    expect(quiet.thread(BOT).messages.map(m => m.text)).toEqual([...paged.map(m => m.text), 'm500', 'm501'])

    const race = createCometThreads(BOT)
    race.load(BOT, newest(all, 400))
    const raceRead = reader(grown)
    expect(await race.loadEarlier(BOT, raceRead)).toBe(98)
    race.load(BOT, newest(grown, 400))
    expect(race.thread(BOT).cursor).toBe(500)
    await race.loadEarlier(BOT, raceRead)
    expect(raceRead).toHaveBeenLastCalledWith(BOT, 500, 100)
    expect(race.thread(BOT).messages.map(m => m.text)).toEqual(grown.slice(1402).map(t => t.text))

    const burst = history(2101)
    const late = createCometThreads(BOT)
    late.load(BOT, newest(all, 400))
    await late.loadEarlier(BOT, reader(all))
    expect(await late.loadEarlier(BOT, reader(burst))).toBe(0)
    expect(late.thread(BOT)).toMatchObject({ cursor: 500, pageLoading: false })
    late.load(BOT, newest(burst, 400))
    expect(late.thread(BOT)).toMatchObject({ cursor: 601, older: 100 })
    await late.loadEarlier(BOT, reader(burst))
    expect(late.thread(BOT).messages.map(m => m.text)).toEqual(burst.slice(1400).map(t => t.text))
  })

  it('stale page after fresh or reload is ignored', async () => {
    const all = history(2000)
    const store = createCometThreads(BOT)
    store.load(BOT, newest(all, 400))
    const first = deferred()
    const pending = store.loadEarlier(BOT, () => first.promise)
    store.fresh(BOT)
    first.resolve(all.slice(1500, 1600))
    expect(await pending).toBe(0)
    expect(store.thread(BOT)).toMatchObject({ messages: [], older: 0, pageLoading: false })

    store.load(BOT, newest(all, 400))
    await store.loadEarlier(BOT, reader(all))
    const second = deferred()
    const late = store.loadEarlier(BOT, () => second.promise)
    expect(store.thread(BOT).pageLoading).toBe(true)
    const grown = history(2002)
    store.load(BOT, newest(grown, 400))
    second.resolve(pageOf(all, 500, 100))
    expect(await late).toBe(0)
    expect(store.thread(BOT)).toMatchObject({ cursor: 502, older: 100, pageLoading: false })
    expect(store.thread(BOT).messages.map(m => m.text)).toEqual(grown.slice(1500).map(t => t.text))
  })

  it('failed page read keeps messages and does not retry by itself', async () => {
    const all = history(2000)
    const store = createCometThreads(BOT)
    store.load(BOT, newest(all, 400))
    const messages = store.thread(BOT).messages
    const read = vi.fn(() => Promise.reject(new Error('bad page cursor')))
    expect(await store.loadEarlier(BOT, read)).toBe(0)
    expect(store.thread(BOT)).toMatchObject({ cursor: 400, pageLoading: false, older: 0, pageDone: false })
    expect(store.thread(BOT).messages).toBe(messages)
    await new Promise(done => setTimeout(done, 20))
    expect(read).toHaveBeenCalledTimes(1)
    await store.loadEarlier(BOT, read)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenLastCalledWith(BOT, 400, 100)
  })
})
