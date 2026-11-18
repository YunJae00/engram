import type { LucideIcon } from 'lucide-react'

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
