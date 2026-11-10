import { createBot, deleteBot, loadBots, updateBot, type Bot, type BotPatch } from './bots.js'
import { BOT_LABEL_CHARS, botPatchError, isBotAvatar, isStringList } from './bot-fields.js'
import { withoutSecrets } from './secrets.js'
import type { VaultPaths } from './vault.js'

export interface BotTemplate {
  id: string
  name: string
  purpose: string
  label?: string
  avatar?: { body: number; face: number; accessory: number; palette: number }
  skills?: string[]
}

const TEMPLATE_ID = /^[a-z0-9-]{1,64}$/

function builtin(id: string, name: string, label: string, purpose: string, avatar: [number, number, number, number]): BotTemplate {
  const [body, face, accessory, palette] = avatar
  return Object.freeze({ id, name, label, purpose, avatar: Object.freeze({ body, face, accessory, palette }) })
}

export const BUILTIN_TEMPLATES: readonly BotTemplate[] = Object.freeze([
  builtin('morning-briefing', '아침 브리핑', '아침 브리핑', '아침마다 오늘 일정, 할 일, 새 소식을 짧게 정리해 알려 줍니다.', [0, 0, 7, 1]),
  builtin('research', '리서치', '자료 조사', '주제를 조사하고 출처와 함께 핵심을 정리합니다.', [1, 3, 4, 4]),
  builtin('mail-draft', '메일 초안', '메일 작성', '요청한 내용으로 메일 초안을 쓰고, 보내기 전에 확인을 받습니다.', [2, 0, 8, 0]),
  builtin('schedule', '일정 정리', '일정 관리', '일정과 마감을 모아 정리하고 겹치는 시간을 알려 줍니다.', [3, 5, 5, 3]),
  builtin('study-helper', '공부 도우미', '학습 도우미', '공부할 내용을 설명하고 요약과 복습 문제를 만들어 줍니다.', [4, 1, 2, 5]),
])

function copyList(list: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i] as string)
  return out
}

function clip(text: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of text) {
    if (n++ === max) break
    out += ch
  }
  return out
}

const mask = (text: string) => withoutSecrets(text, text)

export function exportTemplate(bot: Bot): BotTemplate {
  const out: BotTemplate = {
    id: typeof bot.templateId === 'string' && TEMPLATE_ID.test(bot.templateId) ? bot.templateId : 'custom',
    name: mask(bot.name),
    purpose: mask(bot.purpose),
  }
  // Masking can lengthen a label past the limit, and the export must import again.
  if (typeof bot.label === 'string') out.label = clip(mask(bot.label), BOT_LABEL_CHARS)
  const a = bot.avatar
  if (a && !('image' in a)) out.avatar = { body: a.body, face: a.face, accessory: a.accessory, palette: a.palette }
  if (bot.skills) out.skills = copyList(bot.skills)
  return out
}

// createBot's id is time plus 16 random bits; imports pick a creation time no stored id starts with.
let importQueue: Promise<unknown> = Promise.resolve()
let lastImportAt = 0

async function freeCreationTime(paths: VaultPaths): Promise<Date> {
  const taken = new Set<string>()
  for (const bot of await loadBots(paths)) {
    const match = /^bot-([0-9a-z]+)-/.exec(bot.id)
    if (match) taken.add(match[1]!)
  }
  let at = Math.max(Date.now(), lastImportAt + 1)
  while (taken.has(at.toString(36))) at++
  lastImportAt = at
  return new Date(at)
}

function validPatch(template: unknown): { name: string; purpose: string; patch: BotPatch } {
  if (typeof template !== 'object' || template === null || Array.isArray(template)) throw new Error('a template must be an object')
  const { id, name, purpose, label, avatar, skills } = template as Record<string, unknown>
  if (typeof name !== 'string' || !name.trim()) throw new Error('a template needs a name')
  if (typeof purpose !== 'string') throw new Error('a template purpose must be text')
  if (typeof id !== 'string' || !TEMPLATE_ID.test(id)) throw new Error('a template id is lowercase letters, digits and dashes')
  const patch: BotPatch = { templateId: id }
  if (label !== undefined) patch.label = label as string
  if (avatar !== undefined) {
    if (!isBotAvatar(avatar) || 'image' in avatar) throw new Error('a template avatar must be a character, not a photo')
    patch.avatar = { body: avatar.body, face: avatar.face, accessory: avatar.accessory, palette: avatar.palette }
  }
  if (skills !== undefined) {
    if (!isStringList(skills)) throw new Error('skills must be a list of text')
    patch.skills = copyList(skills)
  }
  const error = botPatchError(patch)
  if (error) throw new Error(error)
  return { name, purpose, patch }
}

export function importTemplate(paths: VaultPaths, template: unknown): Promise<Bot> {
  let checked: ReturnType<typeof validPatch>
  try { checked = validPatch(template) } catch (error) { return Promise.reject(error) }
  const run = importQueue.then(async () => {
    const bot = await createBot(paths, { name: checked.name, purpose: checked.purpose }, await freeCreationTime(paths))
    try { return await updateBot(paths, bot.id, checked.patch) } catch (cause) {
      await deleteBot(paths, bot.id).catch(() => undefined)
      throw cause
    }
  })
  importQueue = run.catch(() => undefined)
  return run
}
