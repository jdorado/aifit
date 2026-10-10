import type { CSSProperties, FC } from 'react'
import { useI18n } from '../i18n'
import type { RestState } from '../types/app'
import { formatTime } from '../utils/workoutDisplay'

type MiniTimerProps = {
  restState: RestState
  onMaximize: () => void
}

const MiniTimer: FC<MiniTimerProps> = ({ restState, onMaximize }) => {
  const { t } = useI18n()
  const active = restState.active && restState.minimized
  const total = Math.max(1, restState.totalSec || 1)
  const progress = Math.min(1, Math.max(0, restState.remainingSec / total))
  return (
    <button
      type="button"
      className={`global-mini-timer ${active ? 'active' : ''}`}
      style={{ '--rest-progress': progress } as CSSProperties}
      aria-label={`${t('workout.restLabel')} ${formatTime(restState.remainingSec)}`}
      tabIndex={active ? 0 : -1}
      aria-hidden={active ? undefined : true}
      onClick={onMaximize}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="13.5" r="7.5" />
        <path d="M12 9.5v4l2.5 1.5M9.5 2.5h5" />
      </svg>
      <span className="global-mini-timer-label">{t('workout.restLabel')}</span>
      <span className="global-mini-timer-time">{formatTime(restState.remainingSec)}</span>
    </button>
  )
}

export default MiniTimer
