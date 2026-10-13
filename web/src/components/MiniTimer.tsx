import type { FC } from 'react'
import type { RestState } from '../types/app'
import { formatTime } from '../utils/workoutDisplay'

type MiniTimerProps = {
  restState: RestState
  onMaximize: () => void
}

const MiniTimer: FC<MiniTimerProps> = ({ restState, onMaximize }) => (
  <div
    className={`global-mini-timer ${restState.active && restState.minimized ? 'active' : ''}`}
    onClick={onMaximize}
  >
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61l1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42A8.962 8.962 0 0012 4c-4.97 0-9 4.03-9 9s4.02 9 9 9a8.994 8.994 0 007.03-14.61zM12 20c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
    </svg>
    <span>{formatTime(restState.remainingSec)}</span>
  </div>
)

export default MiniTimer
