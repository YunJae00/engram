import { constants } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { BUILTIN_TEMPLATES, exportTemplate, importTemplate, loadBots, secretsIn, type Bot, type BotTemplate, type VaultPaths } from 'core'
import type { BotDto, BotTemplateDto } from '../shared/types.js'

const TEMPLATE_KEYS = ['id', 'name', 'purpose', 'label', 'avatar', 'skills']
const MAX_BYTES = 65536
const SECRET_ERROR = 'a template file must not contain a password or key'

type Created = (bot: Bot) => Promise<void> | void

function copy(t: BotTemplate): BotTemplateDto {
  const out: BotTemplateDto = { ...t }
  if (t.avatar) out.avatar = { ...t.avatar }
  return out
}

export function templateList(): BotTemplateDto[] {
  return BUILTIN_TEMPLATES.map(copy)
}

function own(value: object, key: string | number): unknown {
  try {
    return Object.hasOwn(value, key) ? (value as Record<string | number, unknown>)[key] : undefined
  } catch {
    return undefined
  }
}

export function templateSecrets(value: unknown): string[] {
  const found: string[] = []
  const scan = (text: unknown) => {
    if (typeof text !== 'string') return
    for (const hit of secretsIn(text)) if (hit.replaceAll('•', '') !== '') found.push(hit)
  }
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return found
    for (const key of ['name', 'purpose', 'label']) scan(own(value, key))
    const skills = own(value, 'skills')
    if (!Array.isArray(skills)) return found
    const length = skills.length
    for (let i = 0; i < length; i++) scan(own(skills, i))
  } catch {
    return found
  }
  return found
}

export async function createFromTemplate(paths: VaultPaths, templateId: unknown, options: unknown, created: Created): Promise<BotDto> {
  const template = BUILTIN_TEMPLATES.find(t => t.id === templateId)
  if (!template?.avatar) throw new Error('no such template')
  const given = typeof options === 'object' && options !== null ? (options as { name?: unknown }).name : undefined
  const name = given !== undefined ? given : template.name
  const bot = await importTemplate(paths, { ...template, avatar: { ...template.avatar }, name })
  await created(bot)
  return bot
}

export async function exportTemplateTo(paths: VaultPaths, id: unknown, file: string): Promise<void> {
  const bot = typeof id === 'string' && /^[\w-]+$/.test(id) ? (await loadBots(paths)).find(b => b.id === id) : undefined
  if (!bot) throw new Error('no such comet')
  const template = exportTemplate(bot)
  if (templateSecrets(template).length) throw new Error(SECRET_ERROR)
  await writeFile(file, JSON.stringify(template, null, 2) + '\n', 'utf8')
}

async function readCapped(file: string): Promise<Uint8Array> {
  // O_NONBLOCK keeps a picked FIFO from hanging the main process at open.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('a template file must be a regular file')
    if (info.size > MAX_BYTES) throw new Error('a template file is at most 64 KB')
    const buffer = new Uint8Array(MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_BYTES) throw new Error('a template file is at most 64 KB')
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

export async function importTemplateFrom(paths: VaultPaths, file: string, created: Created): Promise<BotDto> {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readCapped(file)))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('a template must be an object')
  for (const key of Object.keys(parsed)) if (!TEMPLATE_KEYS.includes(key)) throw new Error('a template file has only id, name, purpose, label, avatar and skills')
  if (templateSecrets(parsed).length) throw new Error(SECRET_ERROR)
  const bot = await importTemplate(paths, parsed)
  await created(bot)
  return bot
}
