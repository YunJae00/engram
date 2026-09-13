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
  const work: Record<string, string> = { ppt_build: 'Creating a presentation in PowerPoint', ppt_read: 'Checking the presentation', ppt_edit: 'Updating the open presentation', word_write: 'Creating a document in Word', word_read: 'Checking the document', word_edit: 'Updating the open document', excel_write: 'Updating the workbook in Excel', excel_read: 'Checking the workbook', excel_workbooks: 'Finding the workbook' }
  if (match && work[match[1]!]) return work[match[1]!]!
  const key = match ? STEP_LABEL[match[1]!] : undefined
  return key && match ? t(key, { arg: match[2]! }) : line
}

// Words the comet wrote between actions, kept in the work as what it said.
const SAID = 'said: '
export function isSaidLine(line: string): boolean {
  return line.startsWith(SAID)
}

export function workBlocks(lines: string[]): ({ type: 'said'; text: string } | { type: 'tools'; lines: string[] })[] {
  const blocks: ReturnType<typeof workBlocks> = []
  for (const line of lines) {
    if (isSaidLine(line)) blocks.push({ type: 'said', text: line.slice(SAID.length) })
    else {
      const last = blocks.at(-1)
      if (last?.type === 'tools') last.lines.push(line)
      else blocks.push({ type: 'tools', lines: [line] })
    }
  }
  return blocks
}

export function workLabel(line: string): string {
  const tool = line.split(':', 1)[0] ?? ''
  if (/^(search_web|open_page|read_open_page|look|press|type_text|choose|scroll|hover|press_key|press_point|reveal)$/.test(tool)) return 'Browsing the web'
  if (/^(desktop_|read_desktop|look_desktop|list_windows|open_app|list_apps)/.test(tool)) return 'Using the computer'
  if (/^(excel_|word_|ppt_|.*live_document)/.test(tool)) return 'Working with documents'
  if (/^(search_memory|read_note|find_procedure|open_skill)/.test(tool)) return 'Using your memory'
  if (/^(task_plan|work_capabilities)$/.test(tool)) return 'Planning the work'
  if (/file|artifact/.test(tool)) return 'Working with files'
  return tool.includes(' ') || !/^[a-z_]+$/.test(tool) ? line : tool.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())
}

// One sentence for the wait: the last step line if there is one - that is
// what the work is actually doing - and otherwise the generic word, which is
// only ever shown before the first step lands.
export function pendingStatus(t: Translate, latestStep: string | undefined): string {
  return latestStep && !isSaidLine(latestStep) ? stepLabel(t, latestStep) : t('bots.thinking')
}
