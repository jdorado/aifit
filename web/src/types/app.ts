export type SetState = {
  weight: string
  metric: string
  done: boolean
  skipped?: boolean
  value_source?: 'user_entered' | 'accepted_target' | 'legacy_unknown'
}

export type ActiveEntryType = 'exercise' | 'extra' | null

export type RestState = {
  active: boolean
  remainingSec: number
  totalSec: number
  minimized: boolean
  autoStartNextSet: boolean
  startTs?: number
  endTs?: number
}

export type HoldPhase = 'idle' | 'prep' | 'hold' | 'complete'

export type HoldTimerState = {
  active: boolean
  phase: HoldPhase
  prepRemainingSec: number
  remainingSec: number
  totalSec: number
  prepSec: number
  exerciseId: string | null
  setIndex: number | null
  sideIndex: number
  sideCount: number
  startTs: number | null
  prepEndTs: number | null
  holdEndTs: number | null
}

export type ChatMessage = {
  id: string
  variant: 'user' | 'ai'
  text: string
  html?: string
  thinking?: boolean
  timestamp?: number
  replyElapsedSeconds?: number
  modelLabel?: string
}

export type AuthUiState = {
  enabled: boolean
  buttonLabel: string
  buttonTitle?: string
  statusEmail?: string
  statusVisible: boolean
  errorMessage?: string
  errorTitle?: string
  loading: boolean
}

