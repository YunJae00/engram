import type { StringKey, Translate } from '../i18n.js'
import type { ModelActivity } from './modelActivity.js'

// The loop narrates a step as "tool: argument". The tool's own name is the
// evidence; this is the sentence a person reads for it. A line that is not
// shaped that way (a probe's observation dump) is shown as it came.
const STEP_LABEL: Record<string, StringKey> = {
  find_procedure: 'bots.stepFindProcedure',
  search_memory: 'bots.stepSearchMemory',
  read_note: 'bots.stepReadNote',
  search_web: 'bots.stepSearchWeb',
  open_page: 'bots.stepOpenPage',
  read_open_page: 'bots.stepReadPage',
  propose_note: 'bots.stepWriteDown',
  propose_edit: 'bots.stepWriteDown',
  propose_file: 'bots.stepWriteDown',
  ask_person: 'bots.stepAsk',
  run_procedure: 'bots.stepRun',
}

export function stepLabel(t: Translate, line: string): string {
  const match = /^([a-z_]+): ([^]*)$/.exec(line)
  const key = match ? STEP_LABEL[match[1]!] : undefined
  return key && match ? t(key, { arg: match[2]! }) : line
}

// One sentence for the wait, from the strongest evidence down: the model
// loading outranks its counters (an unload between calls reloads mid-run);
// the counters outrank the last step line (that step is over once the model
// is reading what it found); the step line outranks the generic word, which
// is only ever shown before the model has started.
export function pendingStatus(t: Translate, activity: ModelActivity, latestStep: string | undefined): string {
  if (activity.warm === 'loading') return t('bots.warming')
  const progress = activity.progress
  if (progress?.phase === 'reading')
    return t(latestStep ? 'bots.readingFound' : 'bots.readingAsk', { done: progress.done, total: progress.total ?? 0 })
  if (progress?.phase === 'writing')
    return progress.kind === 'choice' ? t('bots.choosing', { n: progress.done }) : t('bots.writing', { n: progress.words ?? 0 })
  return latestStep ? stepLabel(t, latestStep) : t('bots.thinking')
}
