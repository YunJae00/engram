import { ipcMain } from 'electron'
import { addRoutine, changeRoutineLearning, collectResult, engineCwd, learnRoutineTurn, loadBots, parseRoutineLearningDraft, readRoutineLearning, routineLearningPrompt, routineTask, startRoutineLearning, withoutSecrets, type RoutineLearning, type TurnStep } from 'core'
import type { VaultContext } from './vault.js'
import type { RoutineLearningDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import { chatEngine } from './ai-selection.js'

export function registerRoutineLearning(ctx: VaultContext, busy: (botId: string) => boolean) {
  const pending = new Set<string>()
  const dto = (state: RoutineLearning | null, botId: string): RoutineLearningDto | null => state ? {
    id: state.id, phase: state.phase, preparing: pending.has(botId), turns: state.requests.length, incomplete: state.incomplete, limited: state.limited,
    draft: state.draft ?? { name: 'New routine', goal: '', does: '' },
    urls: state.task.urls, method: state.task.method, checks: state.task.checks ?? [],
  } : null
  const changed = (botId: string) => broadcast({ type: 'routine:learning', botId })
  const exists = async (botId: string) => {
    if (typeof botId !== 'string' || !(await loadBots(ctx.paths)).some(bot => bot.id === botId)) throw new Error('That conversation no longer exists.')
  }
  const read = async (botId: string) => { await exists(botId); return dto(await readRoutineLearning(ctx.paths, botId), botId) }
  const action = async (botId: string, operation: 'start' | 'finish' | 'discard' | 'save', input?: { id: string; name: string; goal: string }) => {
    await exists(botId)
    if (!['start', 'finish', 'discard', 'save'].includes(operation)) throw new Error('Unknown routine action.')
    if (pending.has(botId) || (operation !== 'discard' && busy(botId))) throw new Error('Wait for this conversation to finish, or stop it first.')
    pending.add(botId)
    try {
      if (operation === 'start') await startRoutineLearning(ctx.paths, botId)
      else if (operation === 'discard') await changeRoutineLearning(ctx.paths, botId, () => null)
      else {
        const state = await readRoutineLearning(ctx.paths, botId)
        if (!state) throw new Error('Start the Routine skill in this conversation first.')
        if (operation === 'finish') {
          if (!state.requests.length) throw new Error('Complete some work in this chat before preparing a routine.')
          await changeRoutineLearning(ctx.paths, botId, current => current?.id === state.id ? { ...current, phase: 'review' } : current)
          changed(botId)
          const engine = await chatEngine(`bot-${botId}`, ctx.engines)
          if (!engine) throw new Error('Connect an AI to organize this draft, or write its instructions yourself.')
          const raw = await collectResult(engine, { prompt: routineLearningPrompt(state), workdir: engineCwd(ctx.paths), disallowTools: true, timeoutMs: 45_000, modelHint: 'fast', maxTokens: 1800 })
          const proposal = parseRoutineLearningDraft(raw)
          const source = state.requests.join('\n')
          const draft = { name: withoutSecrets(proposal.name, source), goal: routineTask(proposal.goal, [], state.requests).goal, does: withoutSecrets(proposal.does, source) }
          await changeRoutineLearning(ctx.paths, botId, current => current?.id === state.id ? { ...current, phase: 'review', draft } : current)
        } else {
          if (state.phase !== 'review' || input?.id !== state.id || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60 || typeof input.goal !== 'string' || input.goal.length > 4000) throw new Error('Review this draft and provide a name and standalone instructions.')
          const clean = routineTask(input.goal, [], state.requests)
          await addRoutine(ctx.paths, { id: `rt-${state.id}`, name: withoutSecrets(input.name, state.requests.join('\n')), steps: [], task: { ...state.task, goal: clean.goal, urls: [...new Set([...state.task.urls, ...clean.urls])].slice(0, 12) } })
          await changeRoutineLearning(ctx.paths, botId, current => current?.id === state.id ? null : current)
          broadcast({ type: 'vault:changed' })
        }
      }
      const next = await read(botId)
      return next ? { ...next, preparing: false } : null
    } finally { pending.delete(botId); changed(botId) }
  }
  ipcMain.handle('routine:learning', (_event, botId: string) => read(botId))
  ipcMain.handle('routine:learningAction', (_event, botId, operation, input) => action(botId, operation, input))
  return {
    action,
    pending: (botId: string) => pending.has(botId),
    active: async (botId: string) => {
      try {
        const state = await readRoutineLearning(ctx.paths, botId)
        return state?.phase === 'recording' ? state.id : undefined
      } catch { broadcast({ type: 'routine:learning', botId, error: 'The routine draft could not be read. This turn will not be collected.' }); return undefined }
    },
    async record(botId: string, id: string | undefined, message: string, steps: TurnStep[], complete: boolean) {
      if (!id) return
      try { await learnRoutineTurn(ctx.paths, botId, id, message, steps, complete); changed(botId) }
      catch { broadcast({ type: 'routine:learning', botId, error: 'This turn could not be added to the routine draft. The chat result is unchanged; review for missing work before saving.' }) }
    },
    async discard(botId: string) { await changeRoutineLearning(ctx.paths, botId, () => null); changed(botId) },
  }
}
