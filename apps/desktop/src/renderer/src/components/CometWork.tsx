import { ChevronDown, ChevronRight, Globe, FileText, Monitor, Search, Wrench } from 'lucide-react'
import { useState } from 'react'
import { Thinking } from './Thinking.js'
import { isSaidLine, stepLabel, workBlocks, workLabel } from '../lib/pendingStatus.js'
import { t } from '../i18n.js'
import { answerSites, SiteIcon } from './SiteIcon.js'
import { Answer } from './Answer.js'

function WorkIcon({ line }: { line: string }) {
  const tool = line.split(':', 1)[0] ?? ''
  const site = /^(open_page|read_open_page)/.test(tool) ? answerSites(line)[0] : undefined
  if (site) return <SiteIcon origin={site.origin} />
  const Icon = /^(search|find)/.test(tool) ? Search : /^(app_(read|set|press|text)$|read_desktop|look_desktop|desktop_|open_app|list_windows)/.test(tool) ? Monitor : /^(word_|ppt_|excel_|.*document|.*file)/.test(tool) ? FileText : /^(open_page|read_open_page|press|scroll|look)/.test(tool) ? Globe : Wrench
  return <Icon size={14} aria-hidden />
}

export function CometWork({ busy, status, since, lines, kept }: { busy: boolean; status: string; since?: number; lines: string[]; kept: string[] }) {
  // The comet's words stay in the thread; its steps show as one live line while it works and fold away behind one line after.
  const [open, setOpen] = useState(false)
  const shown = (busy ? lines : kept).filter(line => !/^\s*<- /.test(line))
  const blocks = workBlocks(shown).filter(block => block.type === 'said' || (!busy && open))
  const steps = shown.filter(line => !isSaidLine(line) && !line.startsWith('  <- '))
  const count = steps.length
  // The finished work as one card: what kind of work it was, and that it is done.
  const kinds = [...new Set(steps.map(workLabel))].slice(0, 2).join(' · ')
  return <div className={busy ? 'comet-work' : 'comet-work done'} data-testid={busy ? 'comet-work' : 'comet-work-done'}>
    {!busy && count > 0 && <button className="comet-work-card" data-testid="comet-work-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="comet-work-card-icon"><WorkIcon line={steps[0]!} /></span>
      <span className="comet-work-card-text"><span className="comet-work-card-title">{kinds}</span><small>Done · {count} {count === 1 ? 'action' : 'actions'}</small></span>
      {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
    </button>}
    {blocks.length > 0 && <ol className="comet-work-lines" data-testid="bots-work-lines">
      {blocks.map((block, index) => block.type === 'said'
        ? <li key={index} className="comet-work-line said"><Answer text={block.text} compact /></li>
        : <li key={index}><details className="work-group">
          <summary><WorkIcon line={block.lines[0]!} /><span>{[...new Set(block.lines.map(workLabel))].slice(0, 3).join(' · ')}</span><small>{block.lines.length}</small><ChevronRight size={12} aria-hidden /></summary>
          <ol>{block.lines.map((line, at) => <li key={at} className="comet-work-line"><WorkIcon line={line} /><span>{stepLabel(t, line)}</span></li>)}</ol>
        </details></li>)}
    </ol>}
    {busy && <Thinking label={status} since={since} testId="bots-thinking" />}
  </div>
}
