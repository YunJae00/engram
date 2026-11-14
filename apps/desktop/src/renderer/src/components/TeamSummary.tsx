import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { TeamLang } from '../i18n-team.js'
import { teamSummaryText, type TeamView } from '../lib/teamView.js'
import { SidebarDisclosure } from './SidebarDisclosure.js'
import { TeamTree } from './TeamTree.js'

export function TeamSummary({ team, lang }: { team: TeamView | undefined; lang: TeamLang }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!team?.members.length) return null
  return <section className="team-card" data-testid="team-card">
    <button type="button" className="team-summary" data-testid="team-summary" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ChevronRight size={12} aria-hidden />
      <span>{teamSummaryText(team.members, lang)}</span>
    </button>
    <SidebarDisclosure id={id} open={open}><TeamTree members={team.members} lang={lang} /></SidebarDisclosure>
  </section>
}

export function SidebarTeamLine({ team, lang }: { team: TeamView | undefined; lang: TeamLang }) {
  if (!team?.members.length) return null
  return <span className="sidebar-team-line" data-testid="sidebar-team-line"><span>{teamSummaryText(team.members, lang)}</span></span>
}
