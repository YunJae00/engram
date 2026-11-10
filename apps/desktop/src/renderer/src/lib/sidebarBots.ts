import type { BotDto } from '../../../shared/types.js'

export function groupSidebarBots(bots: readonly BotDto[]): { hero: BotDto | null; listed: BotDto[]; hidden: BotDto[] } {
  const hero = bots.find(bot => bot.primary === true) ?? null
  const listed: BotDto[] = [], hidden: BotDto[] = []
  for (const bot of bots) if (bot !== hero) (bot.hidden === true ? hidden : listed).push(bot)
  return { hero, listed, hidden }
}

export function matchesSidebarSearch(bot: BotDto, search: string, bodyHits: ReadonlySet<string>): boolean {
  if (!search) return true
  return `${bot.name} ${bot.label ?? ''} ${bot.lastMessage?.text ?? ''} ${bot.purpose}`.toLocaleLowerCase().includes(search) || bodyHits.has(bot.id)
}
