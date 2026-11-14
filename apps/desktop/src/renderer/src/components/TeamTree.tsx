import { teamT, type TeamLang } from '../i18n-team.js'
import { memberChip, memberResult, teamForest, type TeamMemberView, type TeamNode } from '../lib/teamView.js'

function Member({ node, lang }: { node: TeamNode; lang: TeamLang }) {
  const { member, children } = node
  const chip = memberChip(member.state)
  const result = memberResult(member)
  return <li className="team-member" data-member-id={member.id} data-state={member.state} data-dim={member.state === 'released' || undefined}>
    <div className="team-member-in">
      <div className="team-member-body">
        <div className="team-member-row"><span className="team-member-role">{member.role}</span><span className="team-chip" data-chip={chip}>{teamT(lang, chip)}</span></div>
        {result && <div className="team-member-result" title={result}>{result}</div>}
      </div>
    </div>
    {children.length > 0 && <ul>{children.map(child => <Member key={child.member.id} node={child} lang={lang} />)}</ul>}
  </li>
}

export function TeamTree({ members, lang }: { members: TeamMemberView[]; lang: TeamLang }) {
  if (!members.length) return null
  return <ul className="team-tree" aria-label={teamT(lang, 'treeLabel')}>{teamForest(members).map(node => <Member key={node.member.id} node={node} lang={lang} />)}</ul>
}
