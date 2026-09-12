import { ChevronDown, ChevronRight, Globe, FileText, Monitor, Search, Wrench, MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { Thinking } from './Thinking.js'
import { isSaidLine, stepLabel } from '../lib/pendingStatus.js'
import { t } from '../i18n.js'

// What the comet is doing, while it does it: every step of the turn in the
// order it happened. It stays put while the answer is written above it -
// watching the work is how a person knows to step in - and folds into one
// line once the turn is over. The page it is working on is not here: that
// sits below the conversation, where it never covers a word of it.

export function CometWork({ busy, status, since, lines, kept }: { busy: boolean; status: string; since?: number; lines: string[]; kept: string[] }) {
  const [open, setOpen] = useState(false)
  const shown = busy ? lines : kept
  return (
    <div className={busy ? 'comet-work' : 'comet-work done'} data-testid={busy ? 'comet-work' : 'comet-work-done'}>
      {busy && <Thinking label={status} since={since} testId="bots-thinking" />}
      {!busy && kept.length > 0 && (
        <button className="comet-work-toggle" data-testid="comet-work-toggle" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {t('bots.workDone', { n: kept.length })}
        </button>
      )}
      {(busy || open) && shown.length > 0 && (
        <ol className="comet-work-lines" data-testid="bots-work-lines">
          {shown.map((line, i) => (
            // Keyed by place alone: the list only ever grows during a turn,
            // so a line keeps its node and nothing re-enters on each step.
            <li key={i} className={`comet-work-line${isSaidLine(line) ? ' said' : ''}${busy && i === shown.length - 1 ? ' current' : ''}`}>
              {(() => {
                const tool = line.split(':', 1)[0] ?? ''
                const Icon = isSaidLine(line) ? MessageCircle : /^(search|find)/.test(tool) ? Search : /^(read_desktop|look_desktop|desktop_|open_app|list_windows)/.test(tool) ? Monitor : /^(word_|ppt_|excel_|.*document|.*file)/.test(tool) ? FileText : /^(open_page|read_open_page|search_web|press|scroll|look)/.test(tool) ? Globe : Wrench
                return <Icon size={14} aria-hidden />
              })()}
              <span>{stepLabel(t, line)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
