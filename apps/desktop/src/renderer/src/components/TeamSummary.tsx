import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { teamT, type TeamLang } from '../i18n-team.js'
import { memberChip, teamForest, teamSummaryText, teamWorking, type TeamView } from '../lib/teamView.js'
import { SidebarDisclosure } from './SidebarDisclosure.js'
import { TeamTree } from './TeamTree.js'

export function TeamSummary({ team, lang }: { team: TeamView | undefined; lang: TeamLang }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!team || !teamWorking(team.members)) return null
  return <section className="team-card" data-testid="team-card">
    <button type="button" className="team-summary" data-testid="team-summary" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ChevronRight size={12} aria-hidden />
      <span>{teamSummaryText(team.members, lang)}</span>
    </button>
    <SidebarDisclosure id={id} open={open}><TeamTree members={team.members} lang={lang} /></SidebarDisclosure>
  </section>
}

export function SidebarTeamLine({ team, lang }: { team: TeamView | undefined; lang: TeamLang }) {
  if (!team || !teamWorking(team.members)) return null
  return <span className="sidebar-team-line" data-testid="sidebar-team-line"><span>{teamSummaryText(team.members, lang)}</span></span>
}

export function SidebarTeam({ team, lang }: { team: TeamView | undefined; lang: TeamLang }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!team || !teamWorking(team.members)) return null
  return <div className="sidebar-team" data-testid="sidebar-team">
    <button type="button" className="team-summary" data-testid="sidebar-team-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ChevronRight size={12} aria-hidden />
      <span>{teamSummaryText(team.members, lang)}</span>
    </button>
    <SidebarDisclosure id={id} open={open}>
      <ul className="team-tree" aria-label={teamT(lang, 'treeLabel')}>{teamForest(team.members).map(({ member }) => { const chip = memberChip(member.state); return (
        <li key={member.id} className="team-member-row" data-testid="sidebar-team-lead" data-state={member.state}><span className="team-member-role">{member.role}</span><span className="team-chip" data-chip={chip}>{teamT(lang, chip)}</span></li>
      ) })}</ul>
    </SidebarDisclosure>
  </div>
}
