import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { CircleHelp, ClipboardCheck, Lock, MessageCircle, Plus, Search, Swords, type LucideIcon } from 'lucide-react'
import { useApp } from '../state.js'
import { typeIdentity } from '../lib/grouping.js'
import { MOD_LABEL, type StringKey } from '../i18n.js'

// Floating help affordance: a round button that opens a self-contained cheatsheet
// — quick actions, the four-step mental model, the legend and keyboard
// shortcuts. Everything routes through useApp().t so it tracks the active UI
// language. Quick actions fan out to the rest of the shell via window events
// (App.tsx listens) so this stays a leaf component. The button is draggable: it
// remembers its viewport position across sessions and the panel opens relative to
// wherever it currently sits.
type QuickAction = { key: StringKey; Icon: LucideIcon; run: () => void }
type LegendRow = { glyph: ReactNode; key: StringKey }
type Shortcut = { combo: string[]; key: StringKey }
type Pos = { x: number; y: number }

// Geometry — the 40px button matches .help-button; the default corner sits 16px
// off the window edges to share the unified floating-chrome margin.
const BUTTON_SIZE = 40
const MARGIN = 8
const DRAG_THRESHOLD = 4
const PANEL_WIDTH = 340
const PANEL_GAP = 10
const DEFAULT_RIGHT = 16
const DEFAULT_BOTTOM = 16
const POS_KEY = 'engram.help.pos'
const SEEN_KEY = 'engram.help.seen'

function clampPos(r: number, b: number): Pos {
  const maxR = Math.max(MARGIN, window.innerWidth - BUTTON_SIZE - MARGIN)
  const maxB = Math.max(MARGIN, window.innerHeight - BUTTON_SIZE - MARGIN)
  return { x: Math.min(Math.max(r, MARGIN), maxR), y: Math.min(Math.max(b, MARGIN), maxB) }
}

// Clamp a fixed-position edge so a box of `size` stays within `extent` (viewport).
function clampAxis(value: number, size: number, extent: number): number {
  return Math.min(Math.max(value, MARGIN), Math.max(MARGIN, extent - size - MARGIN))
}

function defaultPos(): Pos {
  return clampPos(DEFAULT_RIGHT, DEFAULT_BOTTOM)
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { x?: number; y?: number; r?: number; b?: number }
      if (typeof parsed?.r === 'number' && typeof parsed?.b === 'number') return clampPos(parsed.r, parsed.b)
      // Legacy top-left shape → convert to corner offsets once.
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return clampPos(
          window.innerWidth - parsed.x - BUTTON_SIZE,
          window.innerHeight - parsed.y - BUTTON_SIZE,
        )
      }
    }
  } catch {
    // Ignore malformed storage and fall back to the default corner.
  }
  return defaultPos()
}

function savePos(pos: Pos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ r: pos.x, b: pos.y }))
  } catch {
    // Persistence is best-effort; a blocked store must not break dragging.
  }
}

const steps: StringKey[] = ['help.how1', 'help.how2', 'help.how3', 'help.how4']

const legend: LegendRow[] = [
  { glyph: <span className="fresh-dot fresh-green" />, key: 'help.legendFresh' },
  { glyph: <span className="fresh-dot fresh-amber" />, key: 'help.legendExpiring' },
  { glyph: <span className="fresh-dot fresh-red" />, key: 'help.legendStale' },
  { glyph: <Swords size={12} strokeWidth={1.8} aria-hidden />, key: 'help.legendConflict' },
  { glyph: <Lock size={12} strokeWidth={1.8} aria-hidden />, key: 'help.legendPrivate' },
]

// The five load-bearing note types, shown as an icon+label set under the legend
// so the type glyphs used across rows and pages are self-explanatory.
// Glyph/label single-sourced through typeIdentity so they never drift.
const legendTypes = ['decision', 'concept', 'howto', 'troubleshooting', 'log'] as const

const shortcuts: Shortcut[] = [
  { combo: [MOD_LABEL, 'P'], key: 'help.scSearch' },
  { combo: [MOD_LABEL, 'Shift', 'P'], key: 'help.scCommands' },
  { combo: [MOD_LABEL, 'L'], key: 'help.scChat' },
  { combo: [MOD_LABEL, 'Shift', 'Space'], key: 'help.scQuick' },
  { combo: ['A/R/E'], key: 'help.scReview' },
  { combo: ['Esc'], key: 'help.scClose' },
]

export function HelpPanel() {
  const { t, openReview } = useApp()
  const [open, setOpen] = useState(false)
  // Until the panel has been opened once, the button pulses softly so a
  // first-time user finds where help lives. Persisted across sessions.
  const [unseen, setUnseen] = useState(() => {
    try {
      return localStorage.getItem(SEEN_KEY) !== '1'
    } catch {
      return false
    }
  })
  const [pos, setPos] = useState<Pos>(loadPos)
  const [grabbing, setGrabbing] = useState(false)
  const [panelH, setPanelH] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // posRef mirrors pos so pointer/resize handlers read the freshest value
  // without re-subscribing; drag identifies its interaction by pointerId.
  const posRef = useRef<Pos>(pos)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean; id: number } | null>(null)
  const suppressClickRef = useRef(false)

  const applyPos = useCallback((next: Pos) => {
    posRef.current = next
    setPos(next)
  }, [])

  // Re-clamp when the window resizes so the button can never be stranded off-screen.
  useEffect(() => {
    const onResize = () => applyPos(clampPos(posRef.current.x, posRef.current.y))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [applyPos])

  // Measure the open panel before paint so its top/left clamp against real height.
  useLayoutEffect(() => {
    if (open && panelRef.current) setPanelH(panelRef.current.offsetHeight)
  }, [open])

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

  // Drag lifecycle: capture the pointer, treat sub-threshold releases as clicks so
  // the button keeps opening the panel, and persist the position once a drag ends.
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { sx: event.clientX, sy: event.clientY, ox: posRef.current.x, oy: posRef.current.y, moved: false, id: event.pointerId }
    setGrabbing(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.sx
    const dy = event.clientY - drag.sy
    if (!drag.moved && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return
    drag.moved = true
    // Corner-relative offsets: dragging right/down SHRINKS the right/bottom gap.
    applyPos(clampPos(drag.ox - dx, drag.oy - dy))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.id) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (drag.moved) {
      suppressClickRef.current = true
      savePos(posRef.current)
    }
    dragRef.current = null
    setGrabbing(false)
  }

  const onButtonClick = () => {
    // Swallow the click synthesized after a real drag; plain clicks still toggle.
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (unseen) {
      setUnseen(false)
      try {
        localStorage.setItem(SEEN_KEY, '1')
      } catch {
        // best-effort — the pulse just returns next session
      }
    }
    setOpen((v) => !v)
  }

  // Anchor the panel to the button: right-aligned + above by default, flipping to
  // left-aligned near the left edge and below when the button sits in the top half.
  // Panel math wants top-left coordinates — derive them from the corner offsets.
  const bx = window.innerWidth - pos.x - BUTTON_SIZE
  const by = window.innerHeight - pos.y - BUTTON_SIZE
  const rightAlignedLeft = bx + BUTTON_SIZE - PANEL_WIDTH
  const left = clampAxis(rightAlignedLeft < MARGIN ? bx : rightAlignedLeft, PANEL_WIDTH, window.innerWidth)
  const openBelow = by < window.innerHeight / 2
  const top = clampAxis(openBelow ? by + BUTTON_SIZE + PANEL_GAP : by - PANEL_GAP - panelH, panelH, window.innerHeight)
  const panelStyle: CSSProperties = { position: 'fixed', left, top, right: 'auto', bottom: 'auto', width: PANEL_WIDTH }
  const buttonStyle: CSSProperties = {
    position: 'fixed',
    right: pos.x,
    bottom: pos.y,
    left: 'auto',
    top: 'auto',
    cursor: grabbing ? 'grabbing' : 'grab',
    touchAction: 'none',
  }

  const fire = (name: string) => {
    window.dispatchEvent(new Event(name))
    setOpen(false)
  }

  const quickActions: QuickAction[] = [
    { key: 'help.quickCapture', Icon: Plus, run: () => fire('engram:focus-capture') },
    { key: 'help.quickReview', Icon: ClipboardCheck, run: () => { openReview(); setOpen(false) } },
    { key: 'help.quickChat', Icon: MessageCircle, run: () => fire('engram:toggle-chat') },
    { key: 'help.quickSearch', Icon: Search, run: () => fire('engram:open-palette') },
  ]

  return (
    <div className="help-dock" ref={rootRef}>
      {open && (
        <div className="help-panel" data-testid="help-panel" ref={panelRef} style={panelStyle}>
          <div className="help-section">
            <div className="help-heading">{t('help.quickActions')}</div>
            <div className="help-quick-grid">
              {quickActions.map(({ key, Icon, run }) => (
                <button key={key} className="help-quick" onClick={run}>
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
            <div className="help-subheading">{t('help.legendTypes')}</div>
            <ul className="help-legend help-legend-types">
              {legendTypes.map((type) => {
                const identity = typeIdentity(type)
                const Glyph = identity.icon
                return (
                  <li key={type}>
                    <span className="help-glyph">
                      <Glyph size={12} strokeWidth={1.8} aria-hidden />
                    </span>
                    <span>{t(identity.labelKey)}</span>
                  </li>
                )
              })}
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
      )}

      <button
        className={`help-button${unseen ? ' pulse' : ''}`}
        data-testid="help-button"
        title={t('help.open')}
        style={buttonStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onButtonClick}
      >
        <CircleHelp size={18} strokeWidth={1.8} aria-hidden />
      </button>
    </div>
  )
}
