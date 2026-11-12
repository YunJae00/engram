import type { AgentTool } from './agent-loop.js'
import { addBotTask, createBot, deleteBot, loadBots, type BotTask } from './bots.js'
import { EVERY_MAX, EVERY_MIN } from './schedule.js'
import { scheduleFrom, scheduleWords } from './schedule-tools.js'
import type { VaultPaths } from './vault.js'

export function teamTool(paths: VaultPaths, changed: () => void, now: () => Date = () => new Date()): AgentTool {
  return {
    name: 'new_bot',
    description: `Make a new bot in the person's team. It shows in the sidebar and is a different bot from this one. Use only when they ask for a new bot or comet. name is its short name, in their words; instructions are its role and how it works, complete enough to run alone. To keep a scheduled request on the new bot, add what (the request; defaults to instructions), time "HH:MM" (24-hour) and either days (0 Sunday to 6 Saturday; all seven for every day) or date (YYYY-MM-DD) for once; every (minutes, ${EVERY_MIN} to ${EVERY_MAX}) repeats it from that time. Something later that is not for a new bot goes to schedule. After the call, tell them the new bot's name.`,
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['name', 'instructions'],
      properties: {
        name: { type: 'string' }, instructions: { type: 'string' },
        what: { type: 'string' }, time: { type: 'string' }, date: { type: 'string' },
        days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
        every: { type: 'integer', minimum: EVERY_MIN, maximum: EVERY_MAX },
      },
    },
    async run(args) {
      const name = String(args['name'] ?? '').trim()
      if (!name || name.length > 60) throw new Error("name is the new bot's name, 1 to 60 characters.")
      const instructions = String(args['instructions'] ?? '').trim()
      if (!instructions || instructions.length > 2000) throw new Error('instructions are its role and how it works, 1 to 2000 characters.')
      const schedule = ['time', 'days', 'date', 'every'].some(k => args[k] !== undefined) ? scheduleFrom(args, now()) : undefined
      const what = String(args['what'] ?? instructions).trim().slice(0, 500) || instructions.slice(0, 500)
      const taken = (await loadBots(paths)).find(b => b.name.trim() === name)
      if (taken) throw new Error(`A bot named "${name}" already exists (id ${taken.id}); pick another name.`)
      const bot = await createBot(paths, { name, purpose: instructions })
      let task: BotTask | undefined
      if (schedule) {
        try {
          task = await addBotTask(paths, bot.id, { name: what.slice(0, 60), goal: what, schedule })
        } catch (e) {
          await deleteBot(paths, bot.id, { undoCreate: bot })
          throw e
        }
      }
      changed()
      return JSON.stringify({
        created: { id: bot.id, name: bot.name },
        ...(task && schedule ? { scheduled: { id: task.id, what: task.goal, when: scheduleWords(schedule) } } : {}),
        note: `Tell them the new bot "${bot.name}" is in the sidebar${task ? ' and its scheduled request runs there, not here.' : '.'}`,
      })
    },
  }
}
