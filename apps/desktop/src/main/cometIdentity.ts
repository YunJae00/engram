// Must match the renderer's t('bots.untitled'); the main process has no i18n.
const UNTITLED = 'New comet'

// Persisted bots may lack purpose (or carry non-strings), so read both fields defensively.
export function cometIdentity(bot: { name?: unknown; purpose?: unknown }, role: string, charterRule = ''): string {
  const name = typeof bot.name === 'string' ? bot.name.trim() : ''
  const who = name !== '' && name !== UNTITLED
    ? `You are "${name}", one of the user's comets — ${role}.`
    : `You are one of the user's comets — ${role}. You have no name yet; never call yourself by one.`
  const purpose = typeof bot.purpose === 'string' ? bot.purpose.trim() : ''
  return purpose ? `${who} Your charter: ${purpose}${charterRule ? ` ${charterRule}` : ''}` : who
}
