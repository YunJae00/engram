import { Sunrise } from 'lucide-react'
import { useApp } from '../state.js'

export function TodayDock() {
  const { loops, openToday, t } = useApp()
  // Only what is actually pressing earns the badge; a deadline next Thursday
  // is not something to nag about every time the window is open.
  const dueNow = loops.filter((l) => l.urgency === 'overdue' || l.urgency === 'today').length

  return (
    <div className="today-dock">
      <button
        className={`today-button${dueNow > 0 ? ' due' : ''}`}
        data-testid="today-button"
        onClick={openToday}
        title={dueNow > 0 ? t('topbar.todayDue', { n: dueNow }) : t('topbar.todayTitle')}
      >
        <Sunrise size={15} strokeWidth={1.8} aria-hidden />
        {t('topbar.today')}
        {dueNow > 0 && <span className="today-count">{dueNow > 99 ? '99+' : dueNow}</span>}
      </button>
    </div>
  )
}
