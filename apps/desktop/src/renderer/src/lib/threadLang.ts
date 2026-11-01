import { t as english, type Translate } from '../i18n.js'
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
    if (!template) return english(key, vars)
    return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template
  }) as ThreadTranslate
  translate.lang = lang
  return translate
}

// Short words the conversation shows around the comet's own messages.
const WORDS = {
  en: { computerAccessChecking: 'Checking computer access…', computerAccessUnavailable: 'Computer access is unavailable', computerAccessFallback: 'App access is unavailable in this session. Browser work remains available.', tryAgain: 'Try again', partialResult: 'Some results could not be confirmed.', resultsSoFar: 'Results so far:', budgetStop: 'This task reached its processing limit and stopped. Your progress is saved. Review the results below before continuing.', stopped: 'Task stopped', computerControls: 'Computer controls', closeComputer: 'Close computer controls', checkStatus: { pass: 'Confirmed', fail: 'Failed', unknown: 'Not verified' }, checkSummary: (pending: number, total: number) => pending ? `${pending} of ${total} not verified` : `${total} of ${total} confirmed`, sourceGrounding: 'Claims match the sources', sources: 'Read', preview: 'Work previews', previewCorners: ['Top right', 'Top left', 'Bottom right', 'Bottom left', 'Hidden'], done: (count: number) => `Recorded · ${count} ${count === 1 ? 'action' : 'actions'}`, total: (seconds: number) => `Total ${seconds}s`, scheduled: 'Scheduled', kept: (count: number) => `${count} scheduled` },
  ko: KO_WORDS,
} as const
export const threadWords = (lang: ThreadLang) => WORDS[lang]


export function displayTaskAnswer(text: string, lang: ThreadLang): string {
  if (text.startsWith('Not verified as complete.')) text = text.replace(/^Not verified as complete\./, threadWords(lang).partialResult).replace('Unverified response:', threadWords(lang).resultsSoFar)
  return text.replace(/^The task token budget \([\d,]+ (?:new )?tokens available for this turn\) was reached\. Work so far is preserved; inspect the current state before continuing\./, threadWords(lang).budgetStop)
}
