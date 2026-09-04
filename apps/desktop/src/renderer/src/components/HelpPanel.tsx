import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { MessageCircle, Plus, Search, type LucideIcon } from 'lucide-react'
import { t } from '../i18n.js'
import { MOD_LABEL, type StringKey } from '../i18n.js'

// The cheatsheet — quick actions, the mental model, the legend and the
// shortcuts. It hangs from the top bar beside Settings, where a person looks
// for help. Everything routes through useApp().t so it tracks the active UI
// language, and quick actions fan out as window events so this stays a leaf.
type QuickAction = { key: StringKey; Icon: LucideIcon; event: string }
type LegendRow = { glyph: ReactNode; key: StringKey }
type Shortcut = { combo: string[]; key: StringKey }

const quickActions: QuickAction[] = [
  { key: 'help.quickChat', Icon: MessageCircle, event: 'engram:toggle-chat' },
  { key: 'help.quickCapture', Icon: Plus, event: 'engram:focus-capture' },
  { key: 'help.quickSearch', Icon: Search, event: 'engram:open-palette' },
]

const steps: StringKey[] = ['help.how1', 'help.how2', 'help.how3', 'help.how4']

const legend: LegendRow[] = [
  { glyph: <span className="fresh-dot fresh-green" />, key: 'help.legendFresh' },
  { glyph: <span className="fresh-dot fresh-amber" />, key: 'help.legendExpiring' },
  { glyph: <span className="fresh-dot fresh-red" />, key: 'help.legendStale' },
]

const shortcuts: Shortcut[] = [
  { combo: [MOD_LABEL, 'P'], key: 'help.scSearch' },
  { combo: [MOD_LABEL, 'Shift', 'P'], key: 'help.scCommands' },
  { combo: [MOD_LABEL, 'L'], key: 'help.scChat' },
  { combo: [MOD_LABEL, 'Shift', 'Space'], key: 'help.scQuick' },
  { combo: ['Esc'], key: 'help.scClose' },
]

export function HelpPanel() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // The top bar owns the door; this only listens for it being used.
  useEffect(() => {
    const toggle = () => setOpen((v) => !v)
    window.addEventListener('engram:open-help', toggle)
    return () => window.removeEventListener('engram:open-help', toggle)
  }, [])

  // Close on an outside mousedown or Escape (same pattern as WorkspaceSwitcher).
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const fire = (name: string) => {
    window.dispatchEvent(new Event(name))
    setOpen(false)
  }

  if (!open) return null

  return (
    <div className="help-dock" ref={rootRef}>
      <div className="help-panel" data-testid="help-panel">
        <div className="help-section">
          <div className="help-heading">{t('help.quickActions')}</div>
          <div className="help-quick-grid">
            {quickActions.map(({ key, Icon, event }) => (
              <button key={key} className="help-quick" onClick={() => fire(event)}>
                <Icon size={16} strokeWidth={1.8} aria-hidden />
                <span>{t(key)}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="help-section">
          <div className="help-heading">{t('help.howTitle')}</div>
          <ol className="help-steps">
            {steps.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
        </div>

        <div className="help-section">
          <div className="help-heading">{t('help.legendTitle')}</div>
          <ul className="help-legend">
            {legend.map(({ glyph, key }) => (
              <li key={key}>
                <span className="help-glyph">{glyph}</span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="help-section">
          <div className="help-heading">{t('help.shortcutsTitle')}</div>
          <table className="help-shortcuts">
            <tbody>
              {shortcuts.map(({ combo, key }) => (
                <tr key={key}>
                  <td className="help-keys">
                    {combo.map((token, i) => (
                      <Fragment key={token}>
                        {i > 0 && <span className="help-plus">+</span>}
                        <kbd>{token}</kbd>
                      </Fragment>
                    ))}
                  </td>
                  <td>{t(key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
