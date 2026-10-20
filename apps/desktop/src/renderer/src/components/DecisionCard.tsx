import type { ReactNode } from 'react'

// Everything that waits on the person - a press to allow, a question, a
// sign-in, a post to look over, an offer - reads as one kind of card: a small
// mark, a line saying what kind of thing it is, the thing itself, where, and
// the answers on the right. More, when there is more to read, sits below.
export function DecisionCard({ icon, label, title, sub, actions, children, tone = 'ask', testId, hint, role = 'region' }: {
  icon: ReactNode
  label: string
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  tone?: 'ask' | 'info'
  testId?: string
  hint?: string
  role?: 'region' | 'status'
}) {
  return (
    <section className={`decision-card ${tone}`} data-testid={testId} title={hint} role={role} aria-label={label}>
      <div className="decision-card-row">
        <span className="decision-card-icon" aria-hidden>{icon}</span>
        <span className="decision-card-text">
          <small className="decision-card-label">{label}</small>
          <span className="decision-card-title">{title}</span>
          {sub && <small className="decision-card-sub">{sub}</small>}
        </span>
        {actions && !children && <span className="decision-card-actions">{actions}</span>}
      </div>
      {children && <div className="decision-card-body">{children}</div>}
      {/* With something to read first, the answers come after it. */}
      {actions && children && <span className="decision-card-actions">{actions}</span>}
    </section>
  )
}
