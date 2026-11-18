import type { ReactNode } from 'react'

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
      {actions && children && <span className="decision-card-actions">{actions}</span>}
    </section>
  )
}
