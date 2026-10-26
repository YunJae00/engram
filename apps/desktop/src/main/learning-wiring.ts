import { installSkill, keepHowToTool, keepInMindTool, loadBots, readBotTranscript, readSkillsLedger, searchChatsTool, skillContentHash, skillSlug, syncPersonNote, withoutSecrets, type AgentTool, type VaultPaths } from 'core'
import { broadcast } from './engine-health.js'

// The comet's own keeping: facts go to the person note every conversation
// reads, how-tos to the skill library, and earlier conversations are read in
// place. said() is what the person wrote this turn, so a secret they typed is
// never kept.
export function learningTools(paths: VaultPaths, channel: string, said: () => string): AgentTool[] {
  const botId = channel.startsWith('bot-') ? channel.slice('bot-'.length) : ''
  return [
    keepInMindTool({
      keep: async (facts) => {
        await syncPersonNote(paths, new Date(), facts.map(fact => withoutSecrets(fact, said())))
        if (botId) broadcast({ type: 'comet:remembered', channel, botId, added: facts.length, touched: 0 })
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
        turns: (await readBotTranscript(paths, bot.id).catch(() => [])).map(turn => ({ role: turn.role, text: turn.text, at: turn.at })),
      }))),
    }),
  ]
}
