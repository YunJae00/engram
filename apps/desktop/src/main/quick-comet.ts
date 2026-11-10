import { loadBots, readBotTranscript, type VaultPaths } from 'core'

export function quickCometBounds(point: { x: number; y: number }, area: { x: number; y: number; width: number; height: number }) {
  const margin = 12
  const width = Math.min(480, area.width - margin * 2)
  const height = Math.min(88, area.height - margin * 2)
  return {
    x: Math.round(Math.max(area.x + margin, Math.min(point.x + 16, area.x + area.width - width - margin))),
    y: Math.round(Math.max(area.y + margin, Math.min(point.y + 16, area.y + area.height - height - margin))),
    width, height,
  }
}

export async function quickPrimary(paths: VaultPaths, busy: (channel: string) => boolean) {
  const primaries = (await loadBots(paths)).filter(bot => bot.primary === true)
  if (primaries.length !== 1) throw new Error('No primary bot to send to. Make one bot primary first.')
  const bot = primaries[0]!
  const channel = `bot-${bot.id}`
  if (busy(channel)) throw new Error('This conversation is still working. Stop it or wait for it to finish.')
  const history = (await readBotTranscript(paths, bot.id)).filter(turn => !turn.progress).map(turn => ({ role: turn.role, text: turn.text, at: turn.at, attachments: turn.attachments }))
  return { bot, channel, history }
}
