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

export type ThreadTranslate = ((key: Parameters<Translate>[0] | 'aside.unapplied', vars?: Parameters<Translate>[1]) => string) & { lang: ThreadLang }

export function threadT(lang: ThreadLang): ThreadTranslate {
  const translate = ((key, vars) => {
    if (key === 'aside.unapplied') return lang === 'ko' ? KO[key]! : 'These messages are saved in the conversation.'
    const template = lang === 'ko' ? KO[key] : undefined
    if (!template) return tIn(lang, key, vars)
    return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template
  }) as ThreadTranslate
  translate.lang = lang
  return translate
}

// Short words the conversation shows around the comet's own messages.
const WORDS = {
  en: { workPreview: { showApp: 'Show app', runningHidden: 'Running hidden', live: 'Live', stoppedFrame: 'Stopped frame', reconnecting: 'Reconnecting…', title: 'Preview', show: 'Show preview', hide: 'Hide preview', expand: 'Expand preview', collapse: 'Collapse preview', choose: 'Choose a preview', browser: 'Browser', noSite: 'No website open', openBeside: 'Open browser beside chat', openFull: 'Open full browser', description: 'Preview only · the original app or page stays separate', working: 'Working', recorded: 'Recorded', stopped: 'Stopped', waiting: 'Needs you', lastSnapshot: 'Last snapshot', snapshotAge: (n: number) => n >= 60 ? `${Math.floor(n / 60)}m` : `${n}s`, unavailable: 'Preview unavailable', noSnapshot: 'No snapshot this turn', screenPermission: 'Screen Recording permission required. If Engram is listed, remove it with − and add it again with +.', captureUnsafe: 'Cannot capture safely', officeActivity: 'Reading in Office without a window', firstFrame: 'Connecting…', delayed: 'Refresh delayed · last snapshot' }, controlTitle: 'Allow computer control?', thisApp: 'this app', appGate: (app: string, control: string, sending?: string) => `${control === 'Send' ? 'Send' : `Press “${control}”`} in ${app}?${sending ? ` This sends: “${sending}”` : ' This may send or change data.'}`, controlHint: 'Allow the mouse and keyboard for this turn. Esc or Stop ends control. Clicking or typing after approval stops control; moving the mouse is okay.', approveTask: 'Allow during this task', foregroundTaken: (app: string) => `${app} brought its window forward · continuing`, computerAccessChecking: 'Checking computer access…', computerAccessUnavailable: 'Computer access is unavailable', computerAccessFallback: 'App access is unavailable in this session. Browser work remains available.', tryAgain: 'Try again', unverifiedAction: 'The latest app or file result could not be confirmed.', unfinishedWork: 'Some work remains unfinished. Tell me how you would like to continue.', officeUnread: 'I could not read the file back after writing it. Please open it and check before relying on it.', evidenceUnconfirmed: 'A requested capture, page check or upload could not be confirmed.', checksRemain: 'The result is ready, but I could not confirm part of it. Tell me how you would like to continue.', partialResult: 'Some results could not be confirmed.', resultsSoFar: 'Results so far:', budgetStop: 'This task reached its processing limit and stopped. Your progress is saved. Review the results below before continuing.', stopped: 'Task stopped', computerControls: 'Computer controls', closeComputer: 'Close computer controls', checkStatus: { pass: 'Confirmed', fail: 'Failed', unknown: 'Not verified' }, checkSummary: (pending: number, total: number) => pending ? `${pending} of ${total} not verified` : `${total} of ${total} confirmed`, sourceGrounding: 'Claims match the sources', sources: 'Read', done: (count: number) => `Recorded · ${count} ${count === 1 ? 'action' : 'actions'}`, total: (seconds: number) => `Total ${seconds}s`, scheduled: 'Scheduled', kept: (count: number) => `${count} scheduled`, today: 'Today', stoppedAt: (line: string) => `Stopped here. Done so far: ${line}` },
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
  return text.replace(/^The task token budget \([\d,]+ (?:new )?tokens available for this turn\) was reached\. Work so far is preserved; inspect the current state before continuing\./, threadWords(lang).budgetStop)
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
