import { Fragment } from 'react'
import { MOD_LABEL } from '../i18n.js'

const places = [
  ['Comets', 'Ask a question or hand over a task.'],
  ['Cosmos', 'Find and edit what Engram remembers.'],
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
    <h2>Help</h2>
    <dl className="help-places">{places.map(([name, description]) => <div key={name}><dt>{name}</dt><dd>{description}</dd></div>)}</dl>
    <p>Press Esc or Stop to end computer control. Check important results before using or sharing them.</p>
    <h3>Keyboard shortcuts</h3>
    <table className="help-shortcuts"><tbody>{shortcuts.map(([keys, label]) => <tr key={label}><td>{label}</td><td>{keys.map((key, i) => <Fragment key={key}>{i > 0 && <span className="help-plus">+</span>}<kbd>{key}</kbd></Fragment>)}</td></tr>)}</tbody></table>
  </div>
}
