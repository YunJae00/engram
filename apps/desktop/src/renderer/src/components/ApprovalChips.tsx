import { X } from 'lucide-react'
import type { ApprovalRuleDto } from '../../../shared/types.js'
import { t } from '../i18n.js'

// The standing approvals one routine carries, each a chip the person can
// take back with one press.
export function ApprovalChips({ rules, onForget }: { rules: ApprovalRuleDto[]; onForget: (fingerprint: string) => void }) {
  if (rules.length === 0) return null
  return (
    <span className="routine-approvals">
      {rules.map((rule) => (
        <span key={rule.fingerprint} className="routine-approval" data-testid={`routine-approval-${rule.fingerprint}`}>
          {t('routines.approvalChip', { host: rule.host })}
          <button
            className="routine-approval-x"
            data-testid={`routine-approval-forget-${rule.fingerprint}`}
            aria-label={t('routines.approvalForget')}
            title={t('routines.approvalForget')}
            onClick={() => onForget(rule.fingerprint)}
          >
            <X size={10} aria-hidden />
          </button>
        </span>
      ))}
    </span>
  )
}
