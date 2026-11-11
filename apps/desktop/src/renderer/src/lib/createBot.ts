import type { BotDto, BotTemplateDto, EngramApi } from '../../../shared/types.js'
import { avatarSpec } from './botAvatar.js'

export type Character = { body: number; face: number; accessory: number; palette: number }
export type BotDraft = { name: string; label: string; templateId: string; task: string; avatar: Character }
export type CreateApi = Pick<EngramApi, 'botCreate' | 'botCreateFromTemplate' | 'botUpdate'>

const LABEL_CHARS = 40

export function previewCharacter(id: string, accessory = 0): Character {
  const spec = avatarSpec(id)
  if (spec.kind !== 'drawn' || typeof spec.body !== 'number' || typeof spec.palette !== 'number') throw new Error('a new bot always gets a drawn character')
  return { body: spec.body, face: spec.face, accessory, palette: spec.palette }
}

export function canCreate(name: string): boolean {
  return name.trim() !== ''
}

export function clipLabel(text: string): string {
  let out = '', count = 0
  for (const char of text) {
    if (count++ === LABEL_CHARS) break
    out += char
  }
  return out
}

export function templatePrefill(template: Pick<BotTemplateDto, 'name' | 'label' | 'avatar'>): { name: string; label: string; accessory: number } {
  return { name: template.name, label: template.label ?? '', accessory: template.avatar?.accessory ?? 0 }
}

export class CreateBotError extends Error {
  constructor(readonly bot: BotDto, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

export async function createFromDraft(api: CreateApi, draft: BotDraft, existing?: BotDto): Promise<BotDto> {
  if (!canCreate(draft.name)) throw new Error('a bot needs a name')
  const name = draft.name.trim()
  const bot = existing ?? (draft.templateId ? await api.botCreateFromTemplate(draft.templateId, { name }) : await api.botCreate({ name }))
  const { body, face, accessory, palette } = draft.avatar
  try {
    return await api.botUpdate(bot.id, { avatar: { body, face, accessory, palette }, label: clipLabel(draft.label.trim()) || undefined })
  } catch (error) {
    throw new CreateBotError(bot, error)
  }
}
