import { isUntitledBotName } from 'core'

export const LEAD_ROLE = 'a colleague who gets the task done'

export function cometIdentity(bot: { name?: unknown; purpose?: unknown }, role: string, charterRule = ''): string {
  const name = typeof bot.name === 'string' ? bot.name.trim() : ''
  const who = name !== '' && !isUntitledBotName(name)
    ? `You are "${name}", one of the user's comets — ${role}.`
    : `You are one of the user's comets — ${role}. You have no name yet; never call yourself by one.`
  const purpose = typeof bot.purpose === 'string' ? bot.purpose.trim() : ''
  return purpose ? `${who} Your charter: ${purpose}${charterRule ? ` ${charterRule}` : ''}` : who
}
