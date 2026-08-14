import type { LucideIcon } from 'lucide-react'

// The one empty-state grammar every canvas tab shares (the Sky keeps its
// richer first-run starter): a faint icon, a serif invitation line, a mono hint.
// Centered in whatever container hosts it — field report: each tab had its
// own ad-hoc empty text, some not even centered.
export function EmptyState({ icon: Icon, title, hint }: {
  icon: LucideIcon
  title: string
  hint?: string
}) {
  return (
    <div className="empty-state" data-testid="empty-state">
      <Icon size={26} strokeWidth={1.5} aria-hidden />
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
    </div>
  )
}
