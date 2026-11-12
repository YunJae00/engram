import type { BotDto, EngramApi } from '../../../shared/types.js'
import type { CharacterId } from './botAvatar.js'

// character null means the person did not pick: the main process assigns from the real id.
export type BotDraft = { name: string; label: string; templateId: string; task: string; character: CharacterId | null }
export type CreateApi = Pick<EngramApi, 'botCreate' | 'botCreateFromTemplate' | 'botUpdate'>

const LABEL_CHARS = 40

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

export class CreateBotError extends Error {
  constructor(readonly bot: BotDto, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

export async function createFromDraft(api: CreateApi, draft: BotDraft, existing?: BotDto): Promise<BotDto> {
  if (!canCreate(draft.name)) throw new Error('a bot needs a name')
  const name = draft.name.trim()
  const character = draft.character
  const bot = existing ?? (draft.templateId
    ? await api.botCreateFromTemplate(draft.templateId, { name })
    : await api.botCreate(character ? { name, character } : { name }))
  const patch: Parameters<CreateApi['botUpdate']>[1] = {}
  const label = clipLabel(draft.label.trim())
  if (label) patch.label = label
  // The template route has no pick parameter, so an explicit pick is saved right after it.
  if (draft.templateId && character) patch.avatar = { character }
  if (Object.keys(patch).length === 0) return bot
  try {
    return await api.botUpdate(bot.id, patch)
  } catch (error) {
    throw new CreateBotError(bot, error)
  }
}
