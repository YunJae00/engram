import type { AgentTool, VaultPaths } from 'core'
import { loadBots, updateBot } from 'core/src/bots'

export function teammateSettingsTool(paths: VaultPaths, selfId: string, changed: () => void): AgentTool {
  return {
    name: 'teammate_settings',
    description: 'Change a teammate\'s standing instructions or notifications when the person asks ("앞으로 보고서는 금요일 정오까지 써", "알림 꺼줘", "지민 알림은 중요한 것만"). who = the teammate\'s name; leave it out for yourself. instructions = the complete new standing instructions, replacing the old ones (fold the old ones in when the person only adds something). notify = "all", "attention" (only when the person is needed) or "off". Do it at once with no confirmation, then say what changed in one short sentence.',
    argsSchema: { type: 'object', additionalProperties: false, properties: { who: { type: 'string' }, instructions: { type: 'string' }, notify: { type: 'string', enum: ['all', 'attention', 'off'] } } },
    async run(args) {
      const who = typeof args['who'] === 'string' ? args['who'].trim() : ''
      const bot = (await loadBots(paths)).find(one => who ? one.name.trim() === who : one.id === selfId)
      if (!bot) throw new Error(`No teammate is called "${who}".`)
      const instructions = typeof args['instructions'] === 'string' ? args['instructions'].trim() : ''
      const notify = args['notify'] as 'all' | 'attention' | 'off' | undefined
      if (!instructions && notify === undefined) throw new Error('Give instructions, notify, or both.')
      const saved = await updateBot(paths, bot.id, { ...(instructions ? { purpose: instructions } : {}), ...(notify !== undefined ? { notify } : {}) })
      changed()
      return JSON.stringify({ teammate: saved.name, ...(instructions ? { instructions: saved.purpose } : {}), ...(notify !== undefined ? { notify: saved.notify } : {}) })
    },
  }
}
