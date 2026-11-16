import { tIn, type Translate } from '../i18n.js'
import { KO, KO_WORDS } from './threadLangKo.js'

// The words inside a conversation - what the comet is doing, its work card,
// the queue under the composer - follow the language the person writes in,
// not the language of the app around it. A language without a table here
// reads them in English.
export type ThreadLang = 'en' | 'ko'

export function threadLang(messages: { role: string; text: string }[]): ThreadLang {
  // A conversation Engram opened itself has no words from the person yet; its own first words stand in.
  const asked = [...messages].reverse().find(message => message.role === 'user')?.text ?? messages[0]?.text ?? ''
  return /[\uac00-\ud7a3]/.test(asked) ? 'ko' : 'en'
}

// Whether words written mid-work read as Korean: some Hangul, and no run of four or more English words outside code, links (a source's title is its name) and quotes.
export function readsKorean(text: string): boolean {
  const prose = text.replace(/`[^`]*`|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|"[^"]*"|“[^”]*”/g, ' ')
  return /[\uac00-\ud7a3]/.test(text) && !/(?:[A-Za-z][A-Za-z'’-]*[\s,;:]+){3}[A-Za-z]/.test(prose)
}

export type ThreadTranslate = ((key: Parameters<Translate>[0], vars?: Parameters<Translate>[1]) => string) & { lang: ThreadLang }

export function threadT(lang: ThreadLang): ThreadTranslate {
  const translate = ((key, vars) => {
    const template = lang === 'ko' ? KO[key] : undefined
    if (!template) return tIn(lang, key, vars)
    return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template
  }) as ThreadTranslate
  translate.lang = lang
  return translate
}

// Short words the conversation shows around the comet's own messages.
const WORDS = {
  en: { workPreview: { showApp: 'Show app', runningHidden: 'Running hidden', live: 'Live', stoppedFrame: 'Stopped frame', reconnecting: 'Reconnecting…', title: 'Preview', show: 'Show preview', hide: 'Hide preview', expand: 'Expand preview', collapse: 'Collapse preview', choose: 'Choose a preview', browser: 'Browser', noSite: 'No website open', openBeside: 'Open browser beside chat', openFull: 'Open full browser', description: 'Preview only · the original app or page stays separate', working: 'Working', recorded: 'Recorded', stopped: 'Stopped', waiting: 'Needs you', lastSnapshot: 'Last snapshot', snapshotAge: (n: number) => n >= 60 ? `${Math.floor(n / 60)}m` : `${n}s`, unavailable: 'Preview unavailable', noSnapshot: 'No snapshot this turn', screenPermission: 'Screen Recording permission required. If Engram is listed, remove it with − and add it again with +.', captureUnsafe: 'Cannot capture safely', officeActivity: 'Reading in Office without a window', firstFrame: 'Connecting…', delayed: 'Refresh delayed · last snapshot' }, controlTitle: 'Allow computer control?', runOutside: 'Run this command outside the sandbox?', runCommand: 'Run this command?', allowCommands: 'Allow commands for this comet?', commandsSandboxed: 'They can read files; writes stay in the task folder and network access is blocked.', commandsOpen: 'They can read or change any accessible file and use the network; not sandboxed.', thisApp: 'this app', appGate: (app: string, control: string, sending?: string) => `${control === 'Send' ? 'Send' : `Press “${control}”`} in ${app}?${sending ? ` This sends: “${sending}”` : ' This may send or change data.'}`, controlHint: 'Allow the mouse and keyboard for this turn. Esc or Stop ends control. Clicking or typing after approval stops control; moving the mouse is okay.', approveTask: 'Allow during this task', foregroundTaken: (app: string) => `${app} brought its window forward · continuing`, computerAccessChecking: 'Checking computer access…', computerAccessUnavailable: 'Computer access is unavailable', computerAccessFallback: 'App access is unavailable in this session. Browser work remains available.', tryAgain: 'Try again', unverifiedAction: 'The latest app or file result could not be confirmed.', unfinishedWork: 'Some work remains unfinished. Tell me how you would like to continue.', officeUnread: 'I could not read the file back after writing it. Please open it and check before relying on it.', evidenceUnconfirmed: 'A requested capture, page check or upload could not be confirmed.', checksRemain: 'The result is ready, but I could not confirm part of it. Tell me how you would like to continue.', declinedStop: 'You declined a step, so I stopped here. Tell me how you would like to continue.', checkMissing: 'I could not finish checking the result. Tell me how you would like to continue.', turnLimit: 'This task reached its limit and stopped.', noAnswer: 'This turn ended without an answer.', readsUnfinished: 'A few pages could not be read to the end.', partialResult: 'Some results could not be confirmed.', resultsSoFar: 'Results so far:', budgetStop: 'This task reached its processing limit and stopped. Your progress is saved. Review the results below before continuing.', stopped: 'Task stopped', computerControls: 'Computer controls', closeComputer: 'Close computer controls', checkStatus: { pass: 'Confirmed', fail: 'Failed', unknown: 'Not verified', not_applicable: 'Does not apply' }, checkSummary: (pending: number, total: number) => pending ? `${pending} of ${total} not verified` : `${total} of ${total} confirmed`, sourceGrounding: 'Claims match the sources', sources: 'Read', done: (count: number) => `Recorded · ${count} ${count === 1 ? 'action' : 'actions'}`, total: (seconds: number) => `Total ${seconds}s`, scheduled: 'Scheduled', kept: (count: number) => `${count} scheduled`, today: 'Today', stoppedAt: (line: string) => `Stopped here. Done so far: ${line}` },
  ko: KO_WORDS,
} as const
export const threadWords = (lang: ThreadLang) => WORDS[lang]

// A Stop the person pressed names the last milestone of this turn when there was one.
export function stoppedText(messages: readonly { role: string; text: string; progress?: boolean }[], status?: string): string {
  const lang = threadLang([...messages])
  const turn = messages.slice(messages.map(m => m.role).lastIndexOf('user') + 1)
  const line = ([...turn].reverse().find(m => m.progress && m.text.trim())?.text.trim().split('\n')[0] ?? status ?? '').trim()
  return line ? threadWords(lang).stoppedAt(line.length > 80 ? `${line.slice(0, 79)}…` : line) : threadT(lang)('bubble.stopped')
}


export function displayTaskAnswer(text: string, lang: ThreadLang): string {
  // The reason under an unverified result is written for the model; the person reads a short note in their language.
  if (text.startsWith('Not verified as complete.')) text = text
    .replace('An Office write has no successful read back of all changed targets. Report incomplete or unverified work; text readback alone does not verify visual layout.', threadWords(lang).officeUnread)
    .replace('A requested evidence capture, page check or upload has not been confirmed. Report the failed or inconclusive result; do not claim completion.', threadWords(lang).evidenceUnconfirmed)
  if (text.startsWith('Not verified as complete.')) text = text.replace(/^Not verified as complete\./, threadWords(lang).partialResult).replace('Unverified response:', threadWords(lang).resultsSoFar)
  text = text.replace('The last computer or file result failed or may be stale and has not been verified.', threadWords(lang).unverifiedAction).replace('The turn ended with unfinished work; waiting for your next instruction.', threadWords(lang).unfinishedWork).replace('The report is recorded, but unresolved checks remain. Waiting for your next instruction.', threadWords(lang).checksRemain)
  // The other ways a turn stops are logged in English for the model too (qa145 S27: the decline line was shown as written).
  text = text.replace('You declined a command, so this turn stopped. Waiting for your next instruction.', threadWords(lang).declinedStop).replace('The verification turn ended without a result check.', threadWords(lang).checkMissing)
    .replace('Stopped at the task budget or fallback turn limit.', threadWords(lang).turnLimit).replace('The last batch stopped before all pages were read. Inspect the current state and continue only unfinished reads.', threadWords(lang).readsUnfinished).replace('The turn ended without an answer.', threadWords(lang).noAnswer)
  return text.replace(/^The task token budget \([\d,]+ (?:new )?tokens available for this turn\) was reached\. Work so far is preserved; inspect the current state before continuing\./, threadWords(lang).budgetStop)
}

// A command or file-read approval is worded for the model and the log: a question, then what it is about.
// The card asks the question once, in the person's language, and shows the command or path whole below it.
// A team member's role stays in front of the question.
export function commandGate(words: string, lang: ThreadLang): { title: string; body: string } {
  const w = threadWords(lang)
  const said = /^([^\n?]{1,80}: )?(Run this command outside the sandbox\?\n|Run this command\? |Allow commands for this comet\? )/.exec(words)
  if (said) {
    const role = said[1] ?? '', rest = words.slice(said[0].length)
    if (said[2]!.startsWith('Allow')) return { title: role + w.allowCommands, body: rest.includes('not sandboxed') ? w.commandsOpen : w.commandsSandboxed }
    return { title: role + (said[2]!.endsWith('\n') ? w.runOutside : w.runCommand), body: rest }
  }
  const line = words.indexOf('\n')
  return line < 0 ? { title: words, body: '' } : { title: words.slice(0, line), body: words.slice(line + 1) }
}

// The app send gate is worded in English for the model and the log; its card says it in the person's language,
// with the app's name and what is about to go out. Null for any other card.
export function appGateTitle(words: string, lang: ThreadLang): string | null {
  const said = /^Allow "(.*?)" in "(.*?)"\?/s.exec(words)
  if (!said) return null
  // A long card is cut short, so the closing sentence may be missing.
  const sending = / Sending: (.*?)(?:\. This may send or change data\.?)?$/s.exec(words)?.[1]
  // A window id is not a name anyone can read.
  const app = /^window:[\d:]+$/.test(said[2]!) ? threadWords(lang).thisApp : said[2]!
  return threadWords(lang).appGate(app, said[1]!, sending)
}
