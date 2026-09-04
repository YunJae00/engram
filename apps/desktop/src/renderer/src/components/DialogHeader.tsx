import { X } from 'lucide-react'
import type { ReactNode } from 'react'

interface DialogHeaderProps {
  children: ReactNode
  closeLabel: string
  icon?: ReactNode
  disabled?: boolean
  onClose(): void
}

export function DialogHeader({ children, closeLabel, icon, disabled = false, onClose }: DialogHeaderProps) {
  return (
    <div className="dialog-head">
      <div className="brief-title dialog-title">
        {icon}
        {children}
      </div>
      <button className="dialog-close" aria-label={closeLabel} disabled={disabled} onClick={onClose}>
        <X size={16} strokeWidth={1.8} aria-hidden />
      </button>
    </div>
  )
}
