import { Fragment } from 'react'
import { MOD_LABEL } from '../i18n.js'

const places = [
  ['Comets', 'Ask a question or hand over a task. Follow the work as it happens.'],
  ['Cosmos', 'Keep useful context, decisions, and things worth remembering.'],
  ['Routines', 'Keep a successful task and reuse its steps when you need them.'],
  ['Orbit', 'Watch up to four conversations and their work, side by side.'],
]
const shortcuts = [
  [[MOD_LABEL, 'P'], 'Search Cosmos'],
  [[MOD_LABEL, 'Shift', 'P'], 'Commands'],
  [[MOD_LABEL, 'L'], 'Open Comets'],
  [[MOD_LABEL, 'B'], 'Toggle sidebar'],
  [['Esc'], 'Close a dialog or stop computer control'],
] as const

export function HelpPanel() {
  return <div className="settings-help" data-testid="help-panel">
    <h2>A small guide to Engram</h2>
    <p className="setting-hint">A place for your ideas, memories, and work.</p>
    <dl className="help-places">{places.map(([name, description]) => <div key={name}><dt>{name}</dt><dd>{description}</dd></div>)}</dl>
    <h3>Make it yours</h3>
    <p>Use the + beside Chats or Routines to create a folder. Drag a conversation or routine to move it, or use its menu to organize it with the keyboard. Removing a folder keeps everything inside.</p>
    <h3>Stay in control</h3>
    <p>Watch the work indicator to see where a comet is working. Press Esc or Stop to end computer control. Check important results before you use or share them.</p>
    <h3>Keyboard shortcuts</h3>
    <table className="help-shortcuts"><tbody>{shortcuts.map(([keys, label]) => <tr key={label}><td>{label}</td><td>{keys.map((key, i) => <Fragment key={key}>{i > 0 && <span className="help-plus">+</span>}<kbd>{key}</kbd></Fragment>)}</td></tr>)}</tbody></table>
  </div>
}
