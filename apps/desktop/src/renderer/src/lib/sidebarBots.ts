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

export type BotMenuRun =
  | { kind: 'update'; patch: { hidden?: true; primary?: true } }
  | { kind: 'layout'; change: import('../../../shared/types.js').SidebarChange['change'] }
  | { kind: 'rename' } | { kind: 'new-section' } | { kind: 'delete' }

export function botMenuItems(bot: BotDto, place: { folder: string | null; pinned: boolean }, folders: readonly { id: string; name: string }[]): { label: string; run: BotMenuRun }[] {
  if (bot.primary === true) return []
  const primary = { label: 'Make primary', run: { kind: 'update', patch: { primary: true } } } as const
  const remove = { label: 'Delete', run: { kind: 'delete' } } as const
  // Core clears hidden only on an own undefined; hidden: false is rejected.
  if (bot.hidden === true) return [{ label: 'Rename', run: { kind: 'rename' } }, { label: 'Show', run: { kind: 'update', patch: { hidden: undefined } } }, primary, remove]
  const items: { label: string; run: BotMenuRun }[] = [
    { label: 'Rename', run: { kind: 'rename' } },
    { label: place.pinned ? 'Unpin' : 'Pin', run: { kind: 'layout', change: { action: 'pin-item', id: bot.id, pinned: !place.pinned } } },
  ]
  for (const folder of folders) if (folder.id !== place.folder) items.push({ label: `Move to ${folder.name}`, run: { kind: 'layout', change: { action: 'move-item', id: bot.id, folder: folder.id } } })
  items.push({ label: 'Move to new section', run: { kind: 'new-section' } }, { label: 'Hide from sidebar', run: { kind: 'update', patch: { hidden: true } } }, primary, remove)
  return items
}
