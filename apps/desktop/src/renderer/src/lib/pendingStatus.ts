import type { StringKey, Translate } from '../i18n.js'

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
  press: 'bots.stepPress',
  type_text: 'bots.stepType',
  choose: 'bots.stepChoose',
  scroll: 'bots.stepScroll',
  hover: 'bots.stepHover',
  press_key: 'bots.stepKey',
  press_point: 'bots.stepPressPoint',
  reveal: 'bots.stepReveal',
  look: 'bots.stepLook',
  aside: 'bots.stepAside',
  resume: 'bots.stepResume',
}

export function stepLabel(t: Translate, line: string): string {
  if (isSaidLine(line)) return line.slice(SAID.length)
  const match = /^([a-z_]+): ([^]*)$/.exec(line)
  const key = match ? STEP_LABEL[match[1]!] : undefined
  return key && match ? t(key, { arg: match[2]! }) : line
}

// Words the comet wrote between actions, kept in the work as what it said.
const SAID = 'said: '
export function isSaidLine(line: string): boolean {
  return line.startsWith(SAID)
}

// One sentence for the wait: the last step line if there is one - that is
// what the work is actually doing - and otherwise the generic word, which is
// only ever shown before the first step lands.
export function pendingStatus(t: Translate, latestStep: string | undefined): string {
  return latestStep && !isSaidLine(latestStep) ? stepLabel(t, latestStep) : t('bots.thinking')
}
