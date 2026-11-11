import { describe, expect, it } from 'vitest'
import type { BotDto } from '../src/shared/types.js'
import { avatarSpec } from '../src/renderer/src/lib/botAvatar.js'
import { canCreate, clipLabel, createFromDraft, previewCharacter, templatePrefill, type BotDraft, type CreateApi } from '../src/renderer/src/lib/createBot.js'

const bot = (id: string) => ({ id, name: 'Bot', createdAt: '2026-01-01T00:00:00.000Z' }) as unknown as BotDto
const avatar = { body: 1, face: 2, accessory: 4, palette: 3 }
const draft = (over: Partial<BotDraft> = {}): BotDraft => ({ name: '  Helper  ', label: ' Notes ', templateId: '', task: '', avatar, ...over })

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
  it("empty name blocked; template prefill sets accessory; preview uses new id's avatar", async () => {
    for (const blank of ['', '   ', '　']) expect(canCreate(blank)).toBe(false)
    expect(canCreate(' a ')).toBe(true)
    const { api, calls } = fakeApi()
    await expect(createFromDraft(api, draft({ name: '　 ' }))).rejects.toThrow()
    expect(calls).toEqual([])
    const shapes = [['morning-briefing', 7], ['research', 4], ['mail-draft', 8], ['schedule', 5], ['study-helper', 2]] as const
    for (const [id, accessory] of shapes) {
      expect(templatePrefill({ name: id, label: `${id} label`, avatar: { body: 0, face: 1, accessory, palette: 2 } })).toEqual({ name: id, label: `${id} label`, accessory })
    }
    expect(templatePrefill({ name: 'Plain' })).toEqual({ name: 'Plain', label: '', accessory: 0 })
    const id = 'new-6f1c2a8e-0000-4000-8000-000000000000'
    const spec = avatarSpec(id)
    expect(previewCharacter(id)).toEqual(spec.kind === 'drawn' ? { body: spec.body, face: spec.face, accessory: 0, palette: spec.palette } : null)
    expect(previewCharacter(id, 4)).toEqual({ ...previewCharacter(id), accessory: 4 })
  })

  it('create then update in order; update failure keeps the bot and retries only the update', async () => {
    const plain = fakeApi()
    await createFromDraft(plain.api, draft())
    expect(plain.calls).toEqual([['botCreate', { name: 'Helper' }], ['botUpdate', 'b1', { avatar, label: 'Notes' }]])
    expect(Object.keys(plain.calls[1]![2] as object).sort()).toEqual(['avatar', 'label'])
    const templated = fakeApi()
    await createFromDraft(templated.api, draft({ templateId: 'research', label: '  ' }))
    expect(templated.calls).toEqual([['botCreateFromTemplate', 'research', { name: 'Helper' }], ['botUpdate', 'b2', { avatar, label: undefined }]])
    const broken = fakeApi({ update: true })
    const failure = await createFromDraft(broken.api, draft()).catch((error: unknown) => error as { bot?: BotDto })
    expect(failure.bot?.id).toBe('b1')
    await createFromDraft(broken.api, draft(), failure.bot).catch(() => undefined)
    expect(broken.calls.map(call => call[0])).toEqual(['botCreate', 'botUpdate', 'botUpdate'])
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
