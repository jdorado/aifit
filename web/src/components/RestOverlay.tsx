import type { FC } from 'react'
import { useI18n } from '../i18n'
import type { RestState } from '../types/app'
import { formatTime } from '../utils/workoutDisplay'

const restCircleLength = 2 * Math.PI * 45

type RestOverlayProps = {
  restState: RestState
  onAdjust: (seconds: number) => void
  onStop: () => void
  onMinimize: () => void
  onToggleAutoStart: (value: boolean) => void
}

const RestOverlay: FC<RestOverlayProps> = ({ restState, onAdjust, onStop, onMinimize, onToggleAutoStart }) => {
  const { t } = useI18n()
  const total = Math.max(1, restState.totalSec || 1)
  const percent = Math.min(1, Math.max(0, restState.remainingSec / total))
  const offset = restCircleLength - (restCircleLength * percent)
  const formatted = formatTime(restState.remainingSec)

  return (
    <div className={`rest-overlay ${restState.active && !restState.minimized ? 'active' : ''}`}>
      <button className="btn-minimize-timer" type="button" onClick={onMinimize}>{t('common.minimize')}</button>
      <div className="timer-circle">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle className="bg" cx="50" cy="50" r="45"></circle>
          <circle
            className="progress"
            cx="50"
            cy="50"
            r="45"
            style={{ strokeDasharray: String(restCircleLength), strokeDashoffset: String(offset) }}
          ></circle>
        </svg>
        <div className="timer-text">{formatted}</div>
      </div>
      <div className="timer-controls">
        <button type="button" onClick={() => onAdjust(-15)}>-15s</button>
        <button className="pause" type="button" onClick={onStop}>{t('common.stop')}</button>
        <button type="button" onClick={() => onAdjust(15)}>+15s</button>
      </div>
      <div className="rest-auto-start">
        <label>
          <input
            type="checkbox"
            checked={restState.autoStartNextSet}
            onChange={(event) => onToggleAutoStart(event.target.checked)}
          />
          <span>{t('workout.autoStartNextSet')}</span>
        </label>
      </div>
    </div>
  )
}

export default RestOverlay
