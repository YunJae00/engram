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
  en: { done: (count: number) => `Done · ${count} ${count === 1 ? 'action' : 'actions'}`, total: (seconds: number) => `Total ${seconds}s`, scheduled: 'Scheduled', kept: (count: number) => `${count} scheduled` },
  ko: KO_WORDS,
} as const
export const threadWords = (lang: ThreadLang) => WORDS[lang]
