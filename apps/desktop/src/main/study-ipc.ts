import { ipcMain } from 'electron'
import { changeCheckpoint } from './comet-checkpoint.js'
import { afterTurnPrompt, againMessage, changeStudies, installSkill, parseAfterTurn, readBotTranscript, readStudies, studyCandidate, studyMessage, type SkillDraft, type VaultPaths } from 'core'
import type { ChatRequestDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { checkSettled, checkStarted } from './task-notify.js'
import { dismissStudyOffers, type StudyCheck } from './study-offers.js'
import { afterChecks, answering, offeredIn, studying } from './turn-state.js'

export interface StudyIpcDeps {
  paths: VaultPaths
  // A turn is running, or a task is still finishing, in this conversation.
  busy(channel: string): boolean
  // Runs a turn the person did not type - a study, one more pass - quietly in the conversation.
  sendQuiet(request: ChatRequestDto): Promise<void>
  // Stops whatever runs in the conversation.
  stop(channel: string): void
}

export interface AfterTurnInput {
  channel: string
  botId: string
  asked: string
  answer: string
  // Words taken in while the turn worked.
  handed: string[]
  // Only execution evidence may trigger automatic rework of the main task.
  incomplete?: string
  signal: AbortSignal
  voice(prompt: string): Promise<string | null>
}

export function registerStudyIpc(deps: StudyIpcDeps) {
  ipcMain.removeHandler('study:list')
  ipcMain.removeHandler('study:answer')
  // A job not known is offered as a study; agreed, it runs as a turn of its
  // own in the same conversation, reading only, and comes back as a how-to.
  // Writing on instead of answering the card is moving on: the offer goes.
  const setOffersAside = async (botId: string): Promise<void> => {
    await dismissStudyOffers(deps.paths, botId, afterChecks)
    broadcast({ type: 'study:changed', botId })
  }
  const offerStudy = async (botId: string, input: { what: string; where: string[] }, ask: string): Promise<void> => {
    offeredIn.add(`bot-${botId}`)
    await changeStudies(deps.paths, list => [...list.filter(one => !(one.botId === botId && one.state === 'offered')), { id: `study-${Date.now().toString(36)}`, botId, ...input, ask, state: 'offered', at: new Date().toISOString() }])
    broadcast({ type: 'study:changed', botId })
  }
  const studyFound = async (botId: string, draft: SkillDraft): Promise<boolean> => {
    let found = false
    await changeStudies(deps.paths, list => list.map(one => one.botId === botId && one.state === 'studying' ? (found = true, { ...one, state: 'review' as const, findings: draft }) : one))
    if (found) broadcast({ type: 'study:changed', botId })
    return found
  }
  const studiesFor = async (botId: string) => (await readStudies(deps.paths)).filter(one => one.botId === botId && (one.state === 'offered' || one.state === 'studying' || one.state === 'review'))
  ipcMain.handle('study:list', async (_e, botId: unknown) => typeof botId === 'string' ? studiesFor(botId) : [])
  ipcMain.handle('study:answer', async (_e, id: unknown, answer: unknown): Promise<{ ask?: string }> => {
    const study = (await readStudies(deps.paths)).find(one => one.id === id)
    if (!study) throw new Error('That study is gone.')
    const channel = `bot-${study.botId}`
    if (answer === 'go' && study.state === 'offered') {
      if (deps.busy(channel)) throw new Error('This conversation is still working. Wait for it to finish first.')
      await changeStudies(deps.paths, list => list.map(one => one.id === study.id ? { ...one, state: 'studying' as const } : one))
      broadcast({ type: 'study:changed', botId: study.botId })
      studying.add(channel)
      broadcast({ type: 'comet:continue', channel, botId: study.botId })
      const history = (await readBotTranscript(deps.paths, study.botId)).map(turn => ({ role: turn.role, text: turn.text }))
      void deps.sendQuiet({ engineId: '', botId: study.botId, channel, message: studyMessage(study), history })
        .then(() => 'declined' as const, (error: unknown) => { flog('study', error); return 'offered' as const })
        .then(async (after) => {
          studying.delete(channel)
          // A study that finished without findings has said where it stopped; one cut short can be offered again.
          await changeStudies(deps.paths, list => list.map(one => one.id === study.id && one.state === 'studying' ? { ...one, state: after } : one)).catch(() => undefined)
          broadcast({ type: 'study:changed', botId: study.botId })
        })
      return {}
    }
    if ((answer === 'later' && study.state === 'offered') || (answer === 'wrong' && study.state === 'review')) {
      await changeStudies(deps.paths, list => list.map(one => one.id === study.id ? { ...one, state: 'declined' as const } : one))
      broadcast({ type: 'study:changed', botId: study.botId })
      return {}
    }
    if (answer === 'keep' && study.state === 'review' && study.findings) {
      const result = await installSkill(deps.paths, studyCandidate(study), study.findings)
      if (!result.installed) throw new Error(result.reason === 'privacy' ? 'What was learned holds an address or a key, so it was not kept.' : 'What was learned could not be kept.')
      await changeStudies(deps.paths, list => list.map(one => one.id === study.id ? { ...one, state: 'kept' as const } : one))
      broadcast({ type: 'study:changed', botId: study.botId })
      return { ask: study.ask }
    }
    throw new Error('That study is not waiting for this answer.')
  })
  // The one more pass each conversation's undone job got: the words it was
  // sent with, the request they carry on, and the turn while it runs.
  const passes = new Map<string, { message: string; ask: string; running?: Promise<void> }>()
  // The person did not ask for the pass, so it gives way the moment they write.
  const yieldPass = async (channel: string): Promise<void> => {
    const running = passes.get(channel)?.running
    if (!running) return
    passes.delete(channel)
    flog('study', 'another pass gave way to the person')
    deps.stop(channel)
    await running.catch(() => undefined)
  }
  // When a turn ends with an answer, the voice judges it once: words taken in
  // along the way that it left undone go on as the next message, and a job
  // left undone gets one more pass, then is offered another way when the
  // comet offered none. A turn the person has moved on from since never does.
  const checkAfterTurn = (input: AfterTurnInput): void => {
    const { channel, botId, answer, handed, signal, voice } = input
    const pass = passes.get(channel)
    passes.delete(channel)
    const passed = pass?.message === input.asked
    const asked = pass && passed ? pass.ask : input.asked
    if (!handed.length && !input.incomplete) return
    const checking: StudyCheck = { controller: new AbortController(), channel }
    afterChecks.add(checking)
    const wasStudying = studying.has(channel)
    let passing = false
    checkStarted(botId)
    void (async () => {
      const judged = parseAfterTurn(await voice(afterTurnPrompt(asked, handed, answer)), handed)
      signal.throwIfAborted()
      checking.controller.signal.throwIfAborted()
      if (judged.uncertain) return
      await changeCheckpoint(deps.paths, botId, state => ({ ...state, pending: state.pending.filter(text => !handed.includes(text) || judged.left.includes(text)) }))
      if (judged.left.length) { flog('aside', `${judged.left.length} of ${handed.length} handed-over words left for the next turn`); broadcast({ type: 'chat:steer-returned', channel, texts: judged.left }); return }
      if (!input.incomplete || !judged.undone || wasStudying || studying.has(channel) || offeredIn.has(channel) || checking.superseded || answering.has(channel)) return
      if (!passed && !deps.busy(channel)) {
        const message = againMessage(asked, input.incomplete)
        flog('study', `another pass after an undone turn: ${judged.undone.blocked}`)
        const history = (await readBotTranscript(deps.paths, botId)).map(turn => ({ role: turn.role, text: turn.text }))
        signal.throwIfAborted()
        checking.controller.signal.throwIfAborted()
        if (checking.superseded || deps.busy(channel)) return
        const pass: { message: string; ask: string; running?: Promise<void> } = { message, ask: asked }
        passes.set(channel, pass)
        passing = true
        broadcast({ type: 'comet:continue', channel, botId })
        pass.running = deps.sendQuiet({ engineId: '', botId, channel, message, history }).catch((error: unknown) => {
          if (passes.get(channel)?.message === message) passes.delete(channel)
          flog('study', `another pass: ${error instanceof Error ? error.message : String(error)}`)
        }).finally(() => { delete pass.running; checkSettled(botId) })
        return
      }
      flog('study', `offered after an undone turn: ${judged.undone.blocked}`)
      await offerStudy(botId, { what: judged.undone.blocked, where: [] }, asked)
    })().catch(error => flog('study', `after-check: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { afterChecks.delete(checking); if (!passing) checkSettled(botId) })
  }
  return { offerStudy, setOffersAside, studyFound, checkAfterTurn, yieldPass }
}
