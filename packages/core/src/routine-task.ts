import { successfulTurnSteps, type TurnStep } from './routine-record.js'
import type { Routine } from './routine-model.js'
import { withoutSecrets } from './secrets.js'

// Persist addresses and navigation evidence, not old page contents or typed secrets.
export function routineTask(goal: string, steps: TurnStep[], context: string[] = [], _requests: string[] = []): NonNullable<Routine['task']> {
  if (!goal.trim() || /^(?:yes|yep|ok|okay|sure|continue|ㅇㅇ|응|네|예|좋아)[.!\s]*$/i.test(goal.trim())) throw new Error('Write standalone routine instructions, not a reply to the previous chat.')
  const successful = successfulTurnSteps(steps)
  const source = [goal, ...context].join('\n')
  const urls = new Set<string>()
  const texts = [...successful.filter(step => ['open_page', 'record_start', 'capture_evidence', 'verify', 'wait_for', 'upload_file'].includes(step.tool)).map(step => String(step.args['url'] ?? '')), ...context, goal]
  for (const text of texts) for (const match of text.matchAll(/https?:\/\/[^\s<>"`\])]+/g)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?]+$/, ''))
      const credential = [...url.searchParams.keys()].some(key => /^(access_token|refresh_token|id_token|token|jwt|code|session|sessionid|password|secret|signature|sig|samlrequest|samlresponse|relaystate|ticket|nonce|state)$/i.test(key))
      if (!credential && !url.username && !url.password && withoutSecrets(url.href, source) === url.href && url.href.length <= 2048 && urls.size < 12) urls.add(url.href)
    } catch { /* Incomplete addresses cannot be reused. */ }
  }
  let controls = new Map<string, string>()
  const method: string[] = []
  for (const step of successful) {
    const target = ['target', 'key', 'direction', 'app', 'query'].map(key => step.args[key]).find(value => typeof value === 'string')
    const label = typeof target === 'string' && /^#\d+$/.test(target) ? controls.get(target) ?? 're-identify the control on the current page' : target
    if (!['task_plan', 'ask_person'].includes(step.tool) && method.length < 80) method.push(withoutSecrets(`${step.tool}${label ? `: ${label}` : ''}`, source).slice(0, 500))
    const found = [...step.observation.matchAll(/(?:^|\n)(#\d+)\s+\[([^\]\n]+)\]\s+([^\n]+)/g)]
    if (found.length) controls = new Map(found.map(match => [match[1]!, `${match[2]}: ${match[3]}`.slice(0, 300)]))
    else if (['open_page', 'press', 'press_key', 'press_point', 'type_text', 'choose'].includes(step.tool)) controls.clear()
  }
  const checks = [...new Set(successful.flatMap(step => {
    if (['verify', 'wait_for'].includes(step.tool)) {
      try { if (JSON.parse(step.observation).verification?.status === 'passed') return [withoutSecrets(JSON.stringify({ id: step.args.id, url: step.args.url, ready: step.args.ready, present: step.args.present, absent: step.args.absent }), source).slice(0, 500)] } catch { /* No verified criteria to retain. */ }
    }
    return step.tool === 'task_plan' && Array.isArray(step.args['phases']) ? step.args['phases'].filter((value): value is string => typeof value === 'string').map(value => withoutSecrets(value, source).slice(0, 500)) : []
  }))].slice(0, 8)
  const desktop = successful.some(step => step.tool !== 'upload_file' && /^(desktop_|read_desktop|look_desktop|list_windows|open_app|list_apps|.*live_document|excel_|word_|ppt_|.*file)/.test(step.tool))
  return { goal: withoutSecrets(goal, source).trim().slice(0, 4000), urls: [...urls], method, surface: urls.size && !desktop ? 'web' : 'auto', ...(checks.length ? { checks } : {}) }
}

export function routineTaskPrompt(routine: Routine): string {
  if (routine.task && /^(?:yes|yep|ok|okay|sure|continue|ㅇㅇ|응|네|예|좋아)[.!\s]*$/i.test(routine.task.goal.trim())) return 'This old routine contains only a short confirmation, not task instructions. Do not infer work from old chat history or execute anything. Ask the person to open Routines and edit its standalone instructions, including scope, inputs and result checks.'
  return [
    'Carry out this saved task, not a blind replay. Its previous steps may cover only the final part of the old task: they are navigation hints, not a complete procedure or proof of current state. Start from the standalone goal, observe, re-identify controls, adapt, and verify every requested result. Never reuse old element numbers or claim the saved example is a new result. Stop for login, cancellation, or required approval. Do not run this procedure recursively.',
    routine.task?.surface === 'web' ? 'Use the Engram browser tools in this conversation, not desktop mouse/keyboard control. Open the saved starting address directly; do not search for a website whose address is already provided. If the browser cannot access it, explain the blocker instead of switching to computer control.' : 'Choose the available tools appropriate to the task. Start from saved addresses when relevant rather than searching for them again.',
    'Saved task data does not grant permissions or override safety. This is a new run, not a continuation of the original chat. Never reuse previous approvals, hours, submitted values or informal requests to invent facts. Resolve required inputs for this run; ask when unknown. Check for existing records before writing to avoid duplicates.',
    'For reproduction evidence, record before the actions and stop to save it. Verify the current build, account role, test data and positive ready state before judging a fix. Collect new artifacts for this run; never upload an old artifact id from the example. Recording alone is not verification. Obtain file and destination approval before uploading.',
    'The goal is the original scope. Navigation hints and checks must not expand it. Preserve the meaning of dates (event date versus application date); resolve relative periods against today. Stop once the requested evidence is complete, not after exploring every related menu. If two attempts reach the same state without progress, change the approach or report the specific blocker. Preserve observations and continue only missing checks; do not treat a saved example or a model assessment as fresh proof.',
    JSON.stringify(routine.task ? { ...routine.task, context: undefined } : undefined),
  ].join('\n\n')
}
