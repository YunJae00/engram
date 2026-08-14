import { Pin } from 'lucide-react'
import { useApp } from '../state.js'

export function RememberDock({ onOpen }: { onOpen: () => void }) {
  const { t } = useApp()

  return (
    <div className="remember-dock">
      <button className="remember-button" data-testid="remember-button" onClick={onOpen} title={t('capture.openTitle')}>
        <Pin size={15} strokeWidth={1.8} aria-hidden />
        {t('capture.submit')}
      </button>
    </div>
  )
}
