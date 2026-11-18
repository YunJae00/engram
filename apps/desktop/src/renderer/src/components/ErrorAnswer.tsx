import { threadT } from '../lib/threadLang.js'

export function isProviderError(text: string): boolean {
  if (!/^\[(codex|claude)\]\s*\{/i.test(text)) return false
  try { return (JSON.parse(text.slice(text.indexOf('{'))) as { type?: unknown }).type === 'error' } catch { return false }
}

const OUTAGE_WORDS = /stream (?:disconnected|closed) before|before response\.completed|\b50[0234]\b|bad gateway|service unavailable|temporarily unavailable|overloaded|internal server error|server_error/i

export function errorLine(text: string, kind: string | undefined, lang: 'en' | 'ko'): { outage: boolean; line: string } {
  const t = threadT(lang)
  if (kind === 'outage' || (!kind && OUTAGE_WORDS.test(text))) return { outage: true, line: t('outage.body') }
  let brief = text
  try {
    const envelope = JSON.parse(text.slice(text.indexOf('{'))) as { error?: { message?: unknown }; message?: unknown }
    const message = envelope.error?.message ?? envelope.message
    if (typeof message === 'string') brief = message
  } catch {}
  brief = brief.replace(/^\[(codex|claude)\]\s*/i, '').trim()
  const technical = /[{}[\]_\\]|\bat .+:\d+|\b[A-Z][a-z]+Error\b|\b[45]\d\d\b|https?:|\//.test(brief) || brief.length > 200
  const readable = !!brief && !technical && (lang === 'ko') === /[\uac00-\ud7a3]/.test(brief)
  return { outage: false, line: readable ? brief : t('error.stopped') }
}

export function ErrorAnswer({ text, kind, lang = 'en' }: { text: string; kind?: string; provider?: string; lang?: 'en' | 'ko' }) {
  const { outage, line } = errorLine(text, kind, lang)
  return <div className={`answer-error${outage ? ' outage' : ''}`} role={outage ? 'status' : 'alert'} data-testid={outage ? 'answer-outage' : undefined}><p>{line}</p></div>
}
