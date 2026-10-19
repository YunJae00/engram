import { ChevronDown, ChevronRight, Globe, FileText, Monitor, Search, Wrench } from 'lucide-react'
import { useState } from 'react'
import { isSaidLine, isYouLine, stepLabel, workBlocks, workLabel } from '../lib/pendingStatus.js'
import { threadT, threadWords, type ThreadLang } from '../lib/threadLang.js'
import { answerSites, SiteIcon } from './SiteIcon.js'
import { Answer } from './Answer.js'

function WorkIcon({ line }: { line: string }) {
  const tool = line.split(':', 1)[0] ?? ''
  const site = /^(open_page|read_open_page)/.test(tool) ? answerSites(line)[0] : undefined
  if (site) return <SiteIcon origin={site.origin} />
  const Icon = /^(search|find)/.test(tool) ? Search : /^(app_(read|set|press|text|do)$|read_desktop|look_desktop|desktop_|open_app|list_windows)/.test(tool) ? Monitor : /^(word_|ppt_|excel_|outlook_|.*document|.*file)/.test(tool) ? FileText : /^(open_page|read_open_page|page_|press|scroll|look)/.test(tool) ? Globe : Wrench
  return <Icon size={14} aria-hidden />
}

// What a comet said and did on the way to one answer. Its words stay in the
// thread as its own messages; its steps are one card once the turn is done,
// opened into a quiet list that reads as a record, not as more chat. While it
// works, only its words show here: what it is doing now is the typing bubble
// at the foot of the thread.
export function CometWork({ busy, lines, lang = 'en' }: { busy: boolean; lines: string[]; lang?: ThreadLang }) {
  const [open, setOpen] = useState(false)
  const shown = lines.filter(line => !/^\s*<- /.test(line))
  const blocks = workBlocks(shown)
  const said = blocks.filter(block => block.type === 'said' || block.type === 'you')
  const groups = blocks.filter(block => block.type === 'tools')
  const steps = shown.filter(line => !isSaidLine(line) && !isYouLine(line))
  const count = steps.length
  if (!said.length && (busy || !count)) return null
  const kinds = [...new Set(steps.map(line => workLabel(line, lang)))].slice(0, 2).join(' · ')
  const t = threadT(lang)
  return <div className={busy ? 'comet-work' : 'comet-work done'} data-testid={busy ? 'comet-work' : 'comet-work-done'}>
    {!busy && count > 0 && <button className="comet-work-card" data-testid="comet-work-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="comet-work-card-icon"><WorkIcon line={steps[0]!} /></span>
      <span className="comet-work-card-text"><span className="comet-work-card-title">{kinds}</span><small>{threadWords(lang).done(count)}</small></span>
      {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
    </button>}
    {!busy && open && <ol className="comet-work-steps" data-testid="bots-work-steps">
      {groups.map((block, index) => block.type === 'tools' && <li key={index}><details className="work-group">
        <summary><WorkIcon line={block.lines[0]!} /><span>{[...new Set(block.lines.map(line => workLabel(line, lang)))].slice(0, 3).join(' · ')}</span><small>{block.lines.length}</small><ChevronRight size={12} aria-hidden /></summary>
        <ol>{block.lines.map((line, at) => <li key={at} className="comet-work-line"><WorkIcon line={line} /><span>{stepLabel(t, line)}</span></li>)}</ol>
      </details></li>)}
    </ol>}
    {said.length > 0 && <ol className="comet-work-lines" data-testid="bots-work-lines">
      {said.map((block, index) => block.type === 'you'
        ? <li key={index} className="comet-work-line you"><span className="chat-user-text">{block.text}</span></li>
        : block.type === 'said' && <li key={index} className="comet-work-line said"><Answer text={block.text} compact /></li>)}
    </ol>}
  </div>
}
