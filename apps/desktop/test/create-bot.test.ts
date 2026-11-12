import { describe, expect, it } from 'vitest'
import type { BotDto } from '../src/shared/types.js'
import { canCreate, clipLabel, createFromDraft, type BotDraft, type CreateApi } from '../src/renderer/src/lib/createBot.js'

const bot = (id: string) => ({ id, name: 'Bot', createdAt: '2026-01-01T00:00:00.000Z', avatar: { character: '03-cashew' } }) as unknown as BotDto
const draft = (over: Partial<BotDraft> = {}): BotDraft => ({ name: '  Helper  ', label: ' Notes ', templateId: '', task: '', character: null, ...over })

function fakeApi(fail: { create?: boolean; update?: boolean } = {}) {
  const calls: [string, ...unknown[]][] = []
  const api: CreateApi = {
    botCreate: async input => { calls.push(['botCreate', input]); if (fail.create) throw new Error('create'); return bot('b1') },
    botCreateFromTemplate: async (id, options) => { calls.push(['botCreateFromTemplate', id, options]); return bot('b2') },
    botUpdate: async (id, patch) => { calls.push(['botUpdate', id, patch]); if (fail.update) throw new Error('update'); return { ...bot(id), ...patch } as BotDto },
  }
  return { api, calls }
}

describe('create bot dialog logic', () => {
  it('empty name blocked; an unpicked create sends no face and never saves a preview', async () => {
    for (const blank of ['', '   ', '　']) expect(canCreate(blank)).toBe(false)
    expect(canCreate(' a ')).toBe(true)
    const { api, calls } = fakeApi()
    await expect(createFromDraft(api, draft({ name: '　 ' }))).rejects.toThrow()
    expect(calls).toEqual([])
    const quiet = fakeApi()
    const made = await createFromDraft(quiet.api, draft({ label: '  ' }))
    expect(quiet.calls).toEqual([['botCreate', { name: 'Helper' }]])
    expect(made.avatar).toEqual({ character: '03-cashew' })
  })

  it('an explicit pick rides the create call; only real metadata is updated after', async () => {
    const picked = fakeApi()
    await createFromDraft(picked.api, draft({ character: '11-peanut' }))
    expect(picked.calls).toEqual([['botCreate', { name: 'Helper', character: '11-peanut' }], ['botUpdate', 'b1', { label: 'Notes' }]])
    const templated = fakeApi()
    await createFromDraft(templated.api, draft({ templateId: 'research', label: '  ' }))
    expect(templated.calls).toEqual([['botCreateFromTemplate', 'research', { name: 'Helper' }]])
    const templatedPick = fakeApi()
    await createFromDraft(templatedPick.api, draft({ templateId: 'research', label: '', character: '02-cloud' }))
    expect(templatedPick.calls).toEqual([['botCreateFromTemplate', 'research', { name: 'Helper' }], ['botUpdate', 'b2', { avatar: { character: '02-cloud' } }]])
  })

  it('update failure keeps the bot and retries only the update; create failure stops', async () => {
    const broken = fakeApi({ update: true })
    const failure = await createFromDraft(broken.api, draft()).catch((error: unknown) => error as { bot?: BotDto })
    expect(failure.bot?.id).toBe('b1')
    await createFromDraft(broken.api, draft(), failure.bot).catch(() => undefined)
    expect(broken.calls.map(call => call[0])).toEqual(['botCreate', 'botUpdate', 'botUpdate'])
    expect(broken.calls[2]).toEqual(['botUpdate', 'b1', { label: 'Notes' }])
    const noCreate = fakeApi({ create: true })
    await expect(createFromDraft(noCreate.api, draft())).rejects.toThrow('create')
    expect(noCreate.calls.map(call => call[0])).toEqual(['botCreate'])
  })

  it('label is clipped to 40 code points', () => {
    const clipped = clipLabel('😀'.repeat(41))
    expect([...clipped].length).toBe(40)
    expect(clipped).toBe('😀'.repeat(40))
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clipped)).toBe(false)
    const ascii = 'a'.repeat(40)
    expect(clipLabel(ascii)).toBe(ascii)
  })
})
