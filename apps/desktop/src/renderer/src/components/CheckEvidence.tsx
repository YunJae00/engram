import { Check, ChevronRight, CircleHelp, X } from 'lucide-react'
import type { TurnEvidence } from 'core'

// How a checked answer was checked, under the answer: each requirement with
// the fact behind its verdict, what was read, and this comet's record. The
// person reads only the lines that need a look; the rest stays folded.
const MARK = { pass: Check, fail: X, unknown: CircleHelp } as const

export function CheckEvidence({ evidence }: { evidence: TurnEvidence }) {
  const findings = [...evidence.checks, { requirement: 'Claims match the sources', ...evidence.grounding }]
  const passed = findings.filter(finding => finding.status === 'pass').length
  const open = passed < findings.length
  return <details className="check-evidence" data-testid="check-evidence" open={open || undefined}>
    <summary>
      <ChevronRight size={12} aria-hidden />
      <span>{passed === findings.length ? `Checked · ${findings.length} of ${findings.length} confirmed` : `Checked · ${findings.length - passed} of ${findings.length} need a look`}</span>
      {evidence.record && evidence.record.checked > 1 && <small>{`This comet: ${evidence.record.confirmed} of ${evidence.record.checked} checked tasks confirmed`}</small>}
    </summary>
    <ol>
      {findings.map((finding, index) => {
        const Mark = MARK[finding.status]
        return <li key={index} data-status={finding.status}><Mark size={13} aria-label={finding.status} /><span><strong>{finding.requirement}</strong>{finding.basis}</span></li>
      })}
    </ol>
    {evidence.sources.length > 0 && <p>Read: {evidence.sources.join(', ')}</p>}
  </details>
}
