import { forgetFactText, installSkill, keepHowToTool, keepInMindTool, loadBotMemory, loadBots, PERSON_MEMORY, readBotTranscript, readSkillsLedger, recordFacts, searchChatsTool, skillContentHash, skillSlug, syncPersonNote, withoutSecrets, type AgentTool, type VaultPaths } from 'core'
import { replacedLines } from 'core/src/bot-memory'

export function learningTools(paths: VaultPaths, channel: string, said: () => string, kept?: (added: number) => void): AgentTool[] {
  const botId = channel.startsWith('bot-') ? channel.slice('bot-'.length) : ''
  return [
    keepInMindTool({
      keep: async (facts, scope, replaces = []) => {
        const clean = facts.map(fact => withoutSecrets(fact, said()))
        const own = scope === 'this bot' && !!botId
        const held = async (id: string): Promise<string[]> => replaces.length && id ? replacedLines((await loadBotMemory(paths, id)).facts.map(fact => fact.text), clean, replaces) : []
        const gone = await held(PERSON_MEMORY)
        for (const line of await held(botId)) await forgetFactText(paths, botId, line)
        if (own) await recordFacts(paths, botId, clean)
        if (!own || gone.length) await syncPersonNote(paths, new Date(), clean, gone)
        if (botId) kept?.(facts.length)
      },
    }),
    keepHowToTool({
      save: async (name, draft) => {
        const ledger = await readSkillsLedger(paths)
        const named = name.replace(/^engram-/, '')
        const known = ledger[named]
        const slug = skillSlug(name) || skillContentHash(name).slice(0, 12)
        return installSkill(paths, known ? { slug: named, folder: known.folder, notes: [], source: 'turn' } : { slug: `learned--${slug}`, folder: 'Learned while working', notes: [], source: 'turn' }, { ...draft, body: withoutSecrets(draft.body, said()) })
      },
    }),
    searchChatsTool({
      chats: async () => Promise.all((await loadBots(paths)).map(async bot => ({
        name: bot.name,
        turns: (await readBotTranscript(paths, bot.id).catch(() => [])).filter(turn => !turn.error).map(turn => ({ role: turn.role, text: turn.text, at: turn.at })),
      }))),
    }),
  ]
}
