export type SetState = {
  weight: string
  metric: string
  done: boolean
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
  quickActions?: QuickActionOption[]
}

export type QuickActionOption = {
  id: string
  action: 'weight' | 'swap_similar' | 'rest_time' | 'volume_adjustment' | 'next_exercise'
  label: string
  payload: Record<string, unknown>
  applied?: boolean
}

export type Video = {
  id: string
  title: string
  thumbnail: string
  duration: string
  link: string
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

export type CoachPermissions = {
  view_progress: boolean
  edit_programs: boolean
  chat_as_coach: boolean
  view_health?: boolean
  view_diet?: boolean
  edit_diet?: boolean
}

export type CoachLink = {
  id: string
  coach_email?: string | null
  coach_owner_id?: string | null
  trainee_owner_id: string
  trainee_email?: string | null
  permissions: CoachPermissions
  status: string
  invite_token?: string | null
  invite_expires_at?: string | null
  created_at?: string | null
  updated_at?: string | null
  accepted_at?: string | null
  accepted_by_email?: string | null
}
