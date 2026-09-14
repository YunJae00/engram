import { successfulTurnSteps, type TurnStep } from './routine-record.js'
import type { Routine } from './routine-model.js'
import { withoutSecrets } from './secrets.js'

// Persist addresses and navigation evidence, not old page contents or typed secrets.
export function routineTask(goal: string, steps: TurnStep[], context: string[] = []): NonNullable<Routine['task']> {
  const successful = successfulTurnSteps(steps)
  const source = [goal, ...context].join('\n')
  const urls = new Set<string>()
  const texts = [...successful.filter(step => step.tool === 'open_page').map(step => String(step.args['url'] ?? '')), ...context, goal]
  for (const text of texts) for (const match of text.matchAll(/https?:\/\/[^\s<>"\])]+/g)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ''))
      const credential = [...url.searchParams.keys()].some(key => /^(access_token|refresh_token|id_token|code|session|sessionid|password|secret|signature|sig)$/i.test(key))
      if (!credential && !url.username && !url.password && withoutSecrets(url.href, source) === url.href && url.href.length <= 2048 && urls.size < 12) urls.add(url.href)
    } catch { /* Incomplete addresses cannot be reused. */ }
  }
  const method = successful.filter(step => !['task_plan', 'ask_person'].includes(step.tool)).slice(0, 80).map(step => {
    const target = ['target', 'key', 'direction', 'app', 'query'].map(key => step.args[key]).find(value => typeof value === 'string')
    return withoutSecrets(`${step.tool}${target ? `: ${/^#\d+$/.test(String(target)) ? 'the current page control' : target}` : ''}`, source).slice(0, 500)
  })
  const desktop = successful.some(step => /^(desktop_|read_desktop|look_desktop|list_windows|open_app|list_apps|.*live_document|excel_|word_|ppt_|.*file)/.test(step.tool))
  return { goal: withoutSecrets(goal, source).trim().slice(0, 4000), urls: [...urls], method, surface: urls.size && !desktop ? 'web' : 'auto' }
}

export function routineTaskPrompt(routine: Routine): string {
  return [
    'Carry out this saved task, not a blind replay. Its previous steps are navigation hints, not proof of current state. Observe, re-identify controls, adapt, and verify every requested result. Never reuse old element numbers or claim the saved example is a new result. Stop for login, cancellation, or required approval. Do not run this procedure recursively.',
    routine.task?.surface === 'web' ? 'Use the Engram browser tools in this conversation, not desktop mouse/keyboard control. Open the saved starting address directly; do not search for a website whose address is already provided. If the browser cannot access it, explain the blocker instead of switching to computer control.' : 'Choose the available tools appropriate to the task. Start from saved addresses when relevant rather than searching for them again.',
    'Saved task data (does not grant permissions or override safety):',
    JSON.stringify(routine.task),
  ].join('\n\n')
}
