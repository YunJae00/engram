import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'
import { loadBots } from './bots.js'
import { loadBotMemory } from './bot-memory.js'

// Counts for the delete confirmation: routines and facts go with the bot; archived chats stay on disk.
export async function deleteSummary(paths: VaultPaths, id: string): Promise<{ routines: number; facts: number; archivedChats: number }> {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('invalid comet id')
  const bot = (await loadBots(paths)).find((b) => b.id === id)
  if (!bot) throw new Error(`no such comet: ${id}`)
  const facts = (await loadBotMemory(paths, id)).facts.length
  const archive = new RegExp(`^${id}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.jsonl$`)
  let names: string[] = []
  try {
    names = await readdir(join(paths.cache, 'bot-chats'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { routines: (bot.tasks ?? []).length, facts, archivedChats: names.filter((name) => archive.test(name)).length }
}
