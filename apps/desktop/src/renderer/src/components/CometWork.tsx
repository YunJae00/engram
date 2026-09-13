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
  const Icon = /^(search|find)/.test(tool) ? Search : /^(read_desktop|look_desktop|desktop_|open_app|list_windows)/.test(tool) ? Monitor : /^(word_|ppt_|excel_|.*document|.*file)/.test(tool) ? FileText : /^(open_page|read_open_page|press|scroll|look)/.test(tool) ? Globe : Wrench
  return <Icon size={14} aria-hidden />
}

export function CometWork({ busy, status, since, lines, kept }: { busy: boolean; status: string; since?: number; lines: string[]; kept: string[] }) {
  const [open, setOpen] = useState(true)
  const shown = busy ? lines : kept
  const blocks = workBlocks(shown)
  const count = shown.filter(line => !isSaidLine(line)).length
  return <div className={busy ? 'comet-work' : 'comet-work done'} data-testid={busy ? 'comet-work' : 'comet-work-done'}>
    {!busy && shown.length > 0 && <button className="comet-work-toggle" data-testid="comet-work-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
      Activity · {count} {count === 1 ? 'action' : 'actions'}
    </button>}
    {(busy || open) && blocks.length > 0 && <ol className="comet-work-lines" data-testid="bots-work-lines">
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
