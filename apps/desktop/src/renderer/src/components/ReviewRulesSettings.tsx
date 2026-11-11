import { useEffect, useRef, useState } from 'react'
import type { ReviewRule } from 'core'
import { api, apiErrorText } from '../api.js'
import { t, type StringKey } from '../i18n.js'

type Kind = ReviewRule['kind']

const MAX = 20
const KINDS: { kind: Kind; titleKey: StringKey }[] = [
  { kind: 'ask-first', titleKey: 'settingsUi.askFirst' },
  { kind: 'allow', titleKey: 'settingsUi.allowAuto' },
]

function hostFrom(typed: string): string {
  const value = typed.trim()
  if (!value) throw new Error(t('settingsUi.typeSite'))
  let url: URL
  try {
    url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`)
  } catch {
    throw new Error(t('settingsUi.notSiteAddress', { value }))
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) throw new Error(t('settingsUi.notWebSite', { value }))
  return url.hostname.toLowerCase()
}

// Sites where a bot's form submit always waits for the person, or never does.
export function ReviewRulesSettings() {
  const [rules, setRules] = useState<ReviewRule[] | null>(null)
  const [typed, setTyped] = useState<Record<Kind, string>>({ 'ask-first': '', allow: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState<Kind | null>(null)
  const busyRef = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    api.reviewRulesList()
      .then((list) => { if (alive.current) setRules(list) })
      .catch((e: unknown) => { if (alive.current) setError(apiErrorText((e as Error).message)) })
    return () => { alive.current = false }
  }, [])

  const mutate = async (call: () => Promise<ReviewRule[]>, done?: () => void) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const list = await call()
      if (!alive.current) return
      setRules(list)
      setError('')
      done?.()
    } catch (e) {
      if (alive.current) setError(apiErrorText((e as Error).message))
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  const add = (kind: Kind) => {
    let target: string
    try {
      target = hostFrom(typed[kind])
    } catch (e) {
      setError((e as Error).message)
      return
    }
    void mutate(() => api.reviewRuleAdd({ kind, target }), () => setTyped((t) => ({ ...t, [kind]: '' })))
  }

  return <section className="settings-section" aria-label={t('settingsUi.autoReview')} data-testid="review-rules">
    <h3 className="settings-section-title">{t('settingsUi.autoReview')}</h3>
    <div className="settings-card">
    {error && <p role="alert" className="settings-item-description" style={{ padding: '8px 16px', margin: 0, overflowWrap: 'anywhere' }}>{error}</p>}
    {KINDS.map(({ kind, titleKey }) => {
      const title = t(titleKey)
      const mine = rules?.filter((r) => r.kind === kind) ?? []
      const full = mine.length >= MAX
      return <div key={kind} className="settings-item" data-testid={`review-rules-${kind}`}>
        <div className="settings-item-row">
          <span className="settings-item-text">
            <h4 className="settings-item-title" style={{ margin: 0 }}>{title}</h4>
            <small className="settings-item-description">{rules ? `${mine.length}/${MAX}` : t('settingsUi.loading')}</small>
          </span>
        </div>
        <ul aria-label={title} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {mine.map((rule) => <li key={rule.target} data-testid="review-rule-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{rule.target}</span>
            <button type="button" className="secondary" aria-label={t('settingsUi.removeTarget', { target: rule.target })} disabled={busy}
              onClick={() => void mutate(() => api.reviewRuleRemove({ kind, target: rule.target }))}>{t('settingsUi.remove')}</button>
          </li>)}
        </ul>
        <form style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 4 }} onSubmit={(e) => { e.preventDefault(); add(kind) }}>
          <input type="text" data-testid={`review-rule-input-${kind}`} aria-label={t('settingsUi.siteFor', { title })} placeholder="example.com"
            // The global input:focus rule drops the outline; keep the shared focus ring visible here.
            style={{ flex: 1, minWidth: 0, ...(focused === kind ? { outline: '2px solid var(--focus-ring)', outlineOffset: 2 } : {}) }}
            onFocus={() => setFocused(kind)} onBlur={() => setFocused(null)} value={typed[kind]} onChange={(e) => setTyped((t) => ({ ...t, [kind]: e.target.value }))} />
          <button type="submit" className="secondary" data-testid={`review-rule-add-${kind}`}
            disabled={busy || !rules || full || !typed[kind].trim()}>{t('settingsUi.add')}</button>
        </form>
      </div>
    })}
    </div>
    <p className="settings-section-note">{t('settingsUi.reviewNote')}</p>
  </section>
}
