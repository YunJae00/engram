import type { StringKey, Translate } from '../i18n.js'
import { GROUP_KO, WORK_KO } from './threadLangKo.js'

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

// The runtime's own tools and the file tools name a path or a pattern; the
// person reads what is being done with it.
const WORK: Record<string, string | ((arg: string) => string)> = {
  ppt_build: 'Creating a presentation in PowerPoint', ppt_read: 'Checking the presentation', ppt_edit: 'Updating the open presentation',
  word_write: 'Creating a document in Word', word_read: 'Checking the document', word_edit: 'Updating the open document',
  excel_write: 'Updating the workbook in Excel', excel_read: 'Checking the workbook', excel_workbooks: 'Finding the workbook',
  outlook_mail: 'Looking through your mail', outlook_read: 'Reading a mail', outlook_draft: 'Drafting a mail', outlook_calendar: 'Checking your calendar', schedule: 'Keeping it for later',
  Read: arg => `Reading ${fileName(arg)}`, NotebookRead: arg => `Reading ${fileName(arg)}`,
  Glob: arg => `Looking for files (${arg})`, Grep: arg => `Searching files for “${arg}”`, LS: 'Listing a folder',
  Write: arg => `Writing ${fileName(arg)}`, Edit: arg => `Editing ${fileName(arg)}`, MultiEdit: arg => `Editing ${fileName(arg)}`, NotebookEdit: arg => `Editing ${fileName(arg)}`,
  Bash: arg => `Running a command (${arg.slice(0, 60)})`, PowerShell: arg => `Running a command (${arg.slice(0, 60)})`, Shell: arg => `Running a command (${arg.slice(0, 60)})`,
  file_read: arg => `Reading ${fileName(arg)}`, file_read_workbook: arg => `Reading the workbook ${fileName(arg)}`, file_read_package: arg => `Reading the document ${fileName(arg)}`,
  file_create_copy: arg => `Saving ${fileName(arg)}`, file_create_workbook: arg => `Saving ${fileName(arg)}`, file_edit_package: arg => `Updating ${fileName(arg)}`,
  find_files: arg => `Finding files named like “${arg}”`, open_skill: 'Reading a how-to it was shown',
  look_in_parallel: 'Looking into several things at once',
  outage: arg => `${arg} is not answering on its side; sending again shortly`,
  page_do: 'Working through the page', app_do: 'Working in the app', task_plan: 'Planning the steps', report_result_check: 'Reporting the check',
  artifact_read: arg => `Reading ${fileName(arg)}`,
}
// Lines the host writes about the turn rather than a tool call.
const SPOKEN = /^(note|verification|switch|aside|resume): /
const fileName = (arg: string): string => {
  if (arg.trim() === 'saved file') return 'a saved file'
  return arg.trim().split(/[\\/]/).pop() || 'a file'
}

export function stepLabel(t: Translate, line: string): string {
  if (isSaidLine(line)) return line.slice(SAID.length)
  const match = /^([A-Za-z_]+): ([^]*)$/.exec(line)
  if (!match) return line
  const work = ((t as { lang?: string }).lang === 'ko' && WORK_KO[match[1]!]) || WORK[match[1]!]
  if (work) return typeof work === 'function' ? work(match[2]!) : work
  const key = STEP_LABEL[match[1]!]
  if (key) return t(key, { arg: match[2]! })
  if (SPOKEN.test(line)) return match[2]!.trim() || line
  return line
}

// Words the comet wrote between actions, kept in the work as what it said.
const SAID = 'said: '
export function isSaidLine(line: string): boolean {
  return line.startsWith(SAID)
}
// Words the person sent while the work was going, kept in the work where they were said.
const YOU = 'you: '
export function isYouLine(line: string): boolean {
  return line.startsWith(YOU)
}

export function workBlocks(lines: string[]): ({ type: 'said' | 'you'; text: string } | { type: 'tools'; lines: string[] })[] {
  const blocks: ReturnType<typeof workBlocks> = []
  for (const line of lines) {
    if (isSaidLine(line)) blocks.push({ type: 'said', text: line.slice(SAID.length) })
    else if (isYouLine(line)) blocks.push({ type: 'you', text: line.slice(YOU.length) })
    else {
      const last = blocks.at(-1)
      if (last?.type === 'tools') last.lines.push(line)
      else blocks.push({ type: 'tools', lines: [line] })
    }
  }
  return blocks
}

export function workLabel(line: string, lang: 'en' | 'ko' = 'en'): string {
  const label = englishWorkLabel(line)
  return lang === 'ko' ? GROUP_KO[label] ?? label : label
}

function englishWorkLabel(line: string): string {
  const tool = line.split(':', 1)[0] ?? ''
  if (/^(search_web|open_page|read_open_page|read_pages|page_steps|page_do|look|look_in_parallel|press|type_text|choose|scroll|hover|press_key|press_point|reveal)$/.test(tool)) return 'Browsing the web'
  if (/^app_(read|set|press|text|do)$/.test(tool)) return 'Working with an app'
  if (/^(desktop_|read_desktop|look_desktop|list_windows|open_app|list_apps)/.test(tool)) return 'Using the computer'
  if (/^outlook_(mail|read|draft)$/.test(tool)) return 'Checking your mail'
  if (tool === 'outlook_calendar') return 'Checking your calendar'
  if (/^(excel_|word_|ppt_|.*live_document)/.test(tool)) return 'Working with documents'
  if (/^(search_memory|read_note|find_procedure|open_skill)/.test(tool)) return 'Using your memory'
  if (tool === 'task_plan') return 'Planning the work'
  if (/^(Bash|PowerShell|Shell)$/.test(tool)) return 'Running commands'
  if (/^(report_result_check|verification|note)$/.test(tool)) return 'Checking the result'
  if (/^(Read|Glob|Grep|LS|Write|Edit|MultiEdit|NotebookRead|NotebookEdit)$/.test(tool) || /file|artifact/.test(tool)) return 'Working with files'
  return tool.includes(' ') || !/^[a-z_]+$/.test(tool) ? line : tool.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())
}

// One sentence for the wait: the last step line if there is one - that is
// what the work is actually doing - and otherwise the generic word, which is
// only ever shown before the first step lands.
export function pendingStatus(t: Translate, latestStep: string | undefined): string {
  return latestStep && !isSaidLine(latestStep) && !isYouLine(latestStep) ? stepLabel(t, latestStep) : t('bots.thinking')
}
