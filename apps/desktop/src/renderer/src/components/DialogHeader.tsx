import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface DialogHeaderProps {
  children: ReactNode
  closeLabel: string
  icon?: ReactNode
  disabled?: boolean
  actions?: ReactNode
  onClose(): void
}

export function DialogHeader({ children, closeLabel, icon, actions, disabled = false, onClose }: DialogHeaderProps) {
  return (
    <div className="dialog-head">
      <div className="brief-title dialog-title">
        {icon}
        {children}
      </div>
      <div className="dialog-head-actions">{actions}<button className="dialog-close" aria-label={closeLabel} disabled={disabled} onClick={onClose}>
        <X size={16} strokeWidth={1.8} aria-hidden />
      </button></div>
    </div>
  )
}
