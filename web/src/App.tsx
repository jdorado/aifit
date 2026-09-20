import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { marked } from 'marked'
import { parseWorkout } from './utils/workoutParser'
import { formatDurationForDisplay, normalizeWorkoutTargetText } from './utils/workoutDisplay'
import type { WorkoutExercise, WorkoutExtra } from './data/testWorkout'
import { isExerciseLockedFromLogs } from './utils/workoutSafety'
import { backendWorkoutToSession, type BackendWorkoutReceipt } from './utils/backendWorkoutAdapter'
import { I18nProvider, createI18n } from './i18n'
import { normalizeLanguage, type Language } from './i18n/strings'
import TabBar from './components/TabBar'
import HealthTimelineView from './views/HealthTimelineView'
import RestOverlay from './components/RestOverlay'
import MiniTimer from './components/MiniTimer'
import VideoModal from './components/VideoModal'
import ChatView from './views/ChatView'
import WorkoutView from './views/WorkoutView'
import ProfileView from './views/ProfileView'
import TelegramLink from './components/profile/TelegramLink'
import WorkoutOverflowMenu from './components/workout/WorkoutOverflowMenu'
import ChatOverflowMenu from './components/chat/ChatOverflowMenu'
import type {
  ActiveEntryType,
  AuthUiState,
  ChatMessage,
  CoachLink,
  CoachPermissions,
  HoldTimerState,
  QuickActionOption,
  RestState,
  SetState,
  Video,
} from './types/app'
import type { WorkoutSession } from './types/workoutSession'
import type { ExerciseHistoryResponse } from './types/exerciseHistory'

const restDefaultSec = 90
const sideTransitionPrepSec = 5
const LEGACY_SESSION_CACHE_STORAGE_PREFIX = 'aifit_session_cache_v1:'
const SESSION_SAVE_DEBOUNCE_MS = 1500
const MAIN_CHAT_HISTORY_LIMIT = 40
const BACKEND_HEALTH_STALE_MS = 4 * 60 * 1000
const BACKEND_HEALTH_PING_TIMEOUT_MS = 12 * 1000
const BACKEND_KEEPALIVE_MS = 4 * 60 * 1000
const CHAT_JOB_INITIAL_POLL_MS = 900
const CHAT_JOB_POLL_MS = 2500
const CHAT_JOB_MAX_WAIT_MS = 8 * 60 * 1000
const CHAT_JOB_MAX_POLL_FAILURES = 4

type EzPreset = {
  id: string
  name: string
  cli: string
  provider?: string
  model?: string
  effort?: string
}

type EzModel = {
  cli: string
  provider?: string
  name: string
  model?: string
  efforts: string[]
}

type ModelControl = {
  presets: EzPreset[]
  selected_id: string
  models: EzModel[]
  active_session_id: string | null
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)

const providerLabel = (provider?: string) => provider === 'openrouter'
  ? 'OpenRouter'
  : provider === 'openai'
    ? 'OpenAI'
    : provider

const modelDisplayName = (model: EzModel) => {
  const provider = providerLabel(model.provider)
  const prefix = provider ? `${provider} · ` : ''
  return provider && model.name.startsWith(prefix) ? model.name.slice(prefix.length) : model.name
}

const presetLabel = (preset: EzPreset | undefined, models: EzModel[] = []) => {
  if (!preset) return undefined
  const installed = models.find((item) => (
    item.cli === preset.cli
    && item.provider === preset.provider
    && item.model === preset.model
  ))
  return installed
    ? `${modelDisplayName(installed)}${preset.effort ? ` ${titleCase(preset.effort)}` : ''}${providerLabel(installed.provider) ? ` · ${providerLabel(installed.provider)}` : ''}`
    : preset.name
}

const isProd = (process.env.NODE_ENV || '').trim() === 'production'

const getLocalRuntimeApiBaseUrl = () => {
  if (typeof window === 'undefined') return null
  const hostname = window.location.hostname
  const isLocalHost = !hostname
    || hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
  const isPrivateLan = /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || hostname.endsWith('.local')
  if (!isLocalHost && !isPrivateLan) return null
  const apiHostname = hostname && hostname !== '0.0.0.0' ? hostname : 'localhost'
  const formattedHost = apiHostname.includes(':') ? `[${apiHostname}]` : apiHostname
  return `http://${formattedHost}:8100`
}

const apiBaseOverride = (process.env.API_BASE_URL || '').trim()
const runtimeLocalApiBaseUrl = apiBaseOverride ? null : getLocalRuntimeApiBaseUrl()
const API_BASE_URL = apiBaseOverride
  ? apiBaseOverride
  : runtimeLocalApiBaseUrl
    ? runtimeLocalApiBaseUrl
    : isProd
      ? ''
      : 'http://localhost:8100'
const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => (
  fetch(input, init)
)
const isTextControlElement = (element: Element | null) => (
  element instanceof HTMLInputElement
  || element instanceof HTMLTextAreaElement
  || (element instanceof HTMLElement && element.isContentEditable)
)

type WakeLockSentinelLike = {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

type ProfileState = {
  text: string
  weeklyPlan: string
  language: Language
  fontScale: number
  activeNotes: ActiveNote[]
  dailyTasks: DailyTask[]
}

type DailyTask = {
  id: string
  title: string
  summary: string
  notes: string[]
}

type ActiveNote = {
  key: string
  text: string
  updatedAt?: string
}

type ActiveNotesPatch = {
  upsert: Array<{ key: string, text: string }>
  deleteKeys: string[]
  deleteTexts: string[]
}

type VideoCacheEntry = {
  ts: number
  videos: Video[]
  exactMatch?: boolean | null
}

type PersistedMessage = {
  variant: 'user' | 'ai'
  text: string
  timestamp?: number
  modelLabel?: string
}

type ChatRequestPayload = {
  user_id: string
  request_id: string
  message: string
  scope_id?: string
  reference_date?: string
  exercise_id?: string
}

type ChatResponsePayload = {
  reply?: unknown
  preset?: EzPreset
  workout_update?: unknown
  workout_updates?: unknown
  active_notes_patch?: unknown
  profile_update?: unknown
}

type ChatJobResponsePayload = ChatResponsePayload & {
  job_id?: unknown
  status?: unknown
  error?: unknown
}

type ChatHistoryPayloadItem = {
  role?: unknown
  content?: unknown
  timestamp?: unknown
  scope_id?: unknown
  agent_cli?: unknown
  agent_provider?: unknown
  agent_model?: unknown
  agent_reasoning_effort?: unknown
  agent_label?: unknown
}

type WeekPlanDay = {
  date: string
  label: string
  exercises: WorkoutExercise[]
  extras: WorkoutExtra[]
  isRest?: boolean
  autoFillSuppressedAt?: string
  planNotes?: string
  notes?: string
}

type WeekPlan = {
  weekStart: string
  days: WeekPlanDay[]
}

type WeekSetLogs = Record<string, Record<string, SetState[]>>
type WeekBaseCounts = Record<string, Record<string, number>>

const videoCacheTtlMs = 6 * 60 * 60 * 1000
const videoCacheMaxEntries = 40
const videoCacheStorageKey = 'aifit_video_cache_v3'

const purgeLegacySessionCaches = () => {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    keys.forEach((key) => {
      if (key?.startsWith(LEGACY_SESSION_CACHE_STORAGE_PREFIX)) {
        localStorage.removeItem(key)
      }
    })
  } catch (error) {
    console.warn('Legacy session cache cleanup failed:', error)
  }
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_FULL_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAY_LABELS_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const WEEKDAY_FULL_LABELS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
const WORKOUT_WEEK_START_DAY_INDEX = 1

const getDateId = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const parseDateId = (value: string | null | undefined) => {
  if (!value || typeof value !== 'string') return null
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!year || !month || !day) return null
  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime())) return null
  return date
}

const normalizeDateId = (value: string | null | undefined) => {
  const parsed = parseDateId(value)
  return parsed ? getDateId(parsed) : null
}

const shiftDateId = (dateId: string, offsetDays: number) => {
  const parsed = parseDateId(dateId)
  if (!parsed) return dateId
  const next = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
  next.setDate(next.getDate() + offsetDays)
  return getDateId(next)
}

const getWeekStartDate = (date: Date, weekStartDayIndex = 1) => {
  const base = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayIndex = base.getDay()
  const offset = (dayIndex - weekStartDayIndex + 7) % 7
  base.setDate(base.getDate() - offset)
  return base
}

const buildWeekDates = (weekStart: Date) => (
  Array.from({ length: 7 }, (_, index) => {
    const next = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate())
    next.setDate(weekStart.getDate() + index)
    return next
  })
)

const buildWorkoutStripDates = (todayId: string, weekStartDayIndex = 1) => {
  const today = parseDateId(todayId) ?? new Date()
  const weekStart = getWeekStartDate(today, weekStartDayIndex)
  const currentWeekDates = buildWeekDates(weekStart)
  const currentWeekFutureCount = currentWeekDates.filter((date) => getDateId(date) >= todayId).length
  const projectedDayCount = Math.max(0, 7 - currentWeekFutureCount)
  const weekEnd = currentWeekDates[currentWeekDates.length - 1]
  const projectedDates = Array.from({ length: projectedDayCount }, (_, offset) => {
    const date = new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate())
    date.setDate(weekEnd.getDate() + offset + 1)
    return date
  })
  return [...currentWeekDates, ...projectedDates]
}

const normalizeDayLabel = (value: string) => (
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
)

// Canonical rows can outlive frontend schema additions. Keep optional display
// collections safe at the hydration boundary so opening an older item cannot
// take down the whole app with `.map`/`.length` errors.
const normalizeWorkoutExercises = (value: unknown): WorkoutExercise[] => (
  Array.isArray(value)
    ? value
      .filter((item): item is WorkoutExercise => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      .map((exercise) => ({
        ...exercise,
        sets: Array.isArray(exercise.sets)
          ? exercise.sets.map((setItem) => ({
            ...setItem,
            targetReps: normalizeWorkoutTargetText(setItem?.targetReps),
            targetTime: normalizeWorkoutTargetText(setItem?.targetTime),
            targetWeight: normalizeWorkoutTargetText(setItem?.targetWeight),
          }))
          : [],
        cues: Array.isArray(exercise.cues)
          ? exercise.cues.filter((cue): cue is string => typeof cue === 'string')
          : [],
        secondaryMuscles: Array.isArray(exercise.secondaryMuscles)
          ? exercise.secondaryMuscles
          : undefined,
      }))
    : []
)

const normalizeWorkoutExtras = (value: unknown): WorkoutExtra[] => (
  Array.isArray(value)
    ? value
      .filter((item): item is WorkoutExtra => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      .map((extra) => ({
        ...extra,
        notes: Array.isArray(extra.notes)
          ? extra.notes.filter((note): note is string => typeof note === 'string')
          : [],
      }))
    : []
)

const normalizeProfileText = (value: unknown) => {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  const direct = typeof record.text === 'string' ? record.text.trim() : ''
  if (direct) return direct

  const bio = typeof record.bio === 'string' ? record.bio.trim() : ''
  const goals = typeof record.goals === 'string' ? record.goals.trim() : ''
  const medical = typeof record.medical === 'string' ? record.medical.trim() : ''
  const experience = typeof record.experience === 'string' ? record.experience.trim() : ''

  const parts: string[] = []
  if (bio) parts.push(`Bio: ${bio}`)
  if (goals) parts.push(`Goals: ${goals}`)
  if (medical) parts.push(`Medical: ${medical}`)
  if (experience) parts.push(`Experience: ${experience}`)
  return parts.join('\n').trim()
}

const normalizeWeeklyPlanText = (value: unknown) => {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const record = value as Record<string, unknown>
  const direct = typeof record.text === 'string' ? record.text.trim() : ''
  if (direct) return direct
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  if (summary) return summary
  const overview = typeof record.overview === 'string' ? record.overview.trim() : ''
  if (overview) return overview
  const plan = typeof record.plan === 'string' ? record.plan.trim() : ''
  if (plan) return plan
  return ''
}

const normalizeActiveNoteText = (value: unknown) => (
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
)

const normalizeActiveNoteKey = (value: unknown, fallbackText?: string) => {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : (fallbackText ?? '')
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return normalized || 'note'
}

const normalizeActiveNotes = (value: unknown): ActiveNote[] => {
  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/\n+/).filter(Boolean) : [])
  const notes: ActiveNote[] = []
  const seen = new Set<string>()

  rawItems.forEach((item) => {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null
    const text = normalizeActiveNoteText(record ? (record.text ?? record.note ?? record.value) : item)
    if (!text) return
    const key = normalizeActiveNoteKey(record ? (record.key ?? record.id ?? record.topic) : undefined, text)
    const dedupeKey = key || text.toLowerCase()
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    const updatedAt = typeof record?.updatedAt === 'string'
      ? record.updatedAt
      : (typeof record?.updated_at === 'string' ? record.updated_at : undefined)
    notes.push({ key, text, updatedAt })
  })

  return notes.slice(-12)
}

const getWeekdayLabel = (date: Date, language: Language = 'en') => {
  const labels = language === 'es' ? WEEKDAY_LABELS_ES : WEEKDAY_LABELS
  return labels[date.getDay()] ?? ''
}

const getWeekdayFullLabel = (date: Date, language: Language = 'en') => {
  const labels = language === 'es' ? WEEKDAY_FULL_LABELS_ES : WEEKDAY_FULL_LABELS
  return labels[date.getDay()] ?? ''
}

const getWorkoutSessionId = () => {
  const now = new Date()
  return getDateId(now)
}

const buildSetState = (exercises: WorkoutExercise[]) => {
  const logs: Record<string, SetState[]> = {}
  const baseCounts: Record<string, number> = {}

  exercises.forEach((exercise) => {
    logs[exercise.id] = exercise.sets.map(() => ({
      weight: '',
      metric: '',
      done: false,
    }))
    baseCounts[exercise.id] = exercise.sets.length
  })

  return { logs, baseCounts }
}

const buildSetLogsForExercises = (
  exercises: WorkoutExercise[],
  previousLogs?: Record<string, SetState[]>
) => {
  const logs: Record<string, SetState[]> = {}
  const baseCounts: Record<string, number> = {}

  exercises.forEach((exercise) => {
    const existingStates = Array.isArray(previousLogs?.[exercise.id])
      ? previousLogs[exercise.id]
      : []
    logs[exercise.id] = exercise.sets.map((_, index) => {
      const existing = existingStates[index]
      return existing ? {
        ...existing,
        weight: normalizeWorkoutTargetText(existing.weight) ?? '',
        metric: normalizeWorkoutTargetText(existing.metric) ?? '',
        done: Boolean(existing.done),
      } : { weight: '', metric: '', done: false }
    })
    baseCounts[exercise.id] = exercise.sets.length
  })

  return { logs, baseCounts }
}

const hasWorkoutContent = (exercises?: WorkoutExercise[], extras?: WorkoutExtra[]) => (
  Boolean((exercises?.length ?? 0) > 0 || (extras?.length ?? 0) > 0)
)

const countDoneSetsForExercises = (
  exercises: WorkoutExercise[],
  logs?: Record<string, SetState[]>
) => (
  exercises.reduce((total, exercise) => {
    const states = logs?.[exercise.id] ?? []
    return total + exercise.sets.reduce((count, _setItem, index) => (
      states[index]?.done ? count + 1 : count
    ), 0)
  }, 0)
)

const buildWeekPlanFromSingleDay = (
  dateId: string,
  exercises: WorkoutExercise[],
  extras: WorkoutExtra[],
  language: Language = 'en',
  weekStartDayIndex = 1,
  planNotes = ''
): WeekPlan => {
  const targetDate = parseDateId(dateId) ?? new Date()
  const weekStart = getWeekStartDate(targetDate, weekStartDayIndex)
  const days = buildWeekDates(weekStart).map((date) => {
    const normalizedDate = getDateId(date)
    const label = getWeekdayLabel(date, language)
    if (normalizedDate === dateId) {
      return {
        date: normalizedDate,
        label,
        exercises,
        extras,
        isRest: exercises.length === 0,
        planNotes,
        notes: '',
      }
    }
    return {
      date: normalizedDate,
      label,
      exercises: [],
      extras: [],
      isRest: true,
      notes: '',
    }
  })

  return {
    weekStart: getDateId(weekStart),
    days,
  }
}

const isDayCompleted = (day: WeekPlanDay, logsForDay?: Record<string, SetState[]>) => {
  if (day.isRest || day.exercises.length === 0) return false
  return day.exercises.every((exercise) => {
    if (exercise.status === 'skip') return true
    const states = logsForDay?.[exercise.id] ?? []
    if (exercise.sets.length === 0) return true
    return exercise.sets.every((_, index) => Boolean(states[index]?.done))
  })
}

const canHydrateSavedWorkoutAfterClear = (
  day: WeekPlanDay | null | undefined,
  savedUpdatedAt: string | null | undefined,
) => {
  if (!day?.autoFillSuppressedAt) return true
  if (!savedUpdatedAt) return false

  const parseApiTimestamp = (value: string) => {
    const trimmed = value.trim()
    const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
    return Date.parse(hasExplicitTimezone ? trimmed : `${trimmed}Z`)
  }
  const suppressedAt = parseApiTimestamp(day.autoFillSuppressedAt)
  const savedAt = parseApiTimestamp(savedUpdatedAt)
  return Number.isFinite(suppressedAt) && Number.isFinite(savedAt) && savedAt > suppressedAt
}

const isDayMarkedComplete = (day: WeekPlanDay, logsForDay?: Record<string, SetState[]>) => (
  isDayCompleted(day, logsForDay)
)

const getDoneSetIndexes = (exercise: WorkoutExercise, logsForDay?: Record<string, SetState[]>) => {
  const states = logsForDay?.[exercise.id] ?? []
  const indexes: number[] = []
  exercise.sets.forEach((_, index) => {
    if (states[index]?.done) indexes.push(index)
  })
  return indexes
}

const getUnloggedSetCount = (exercise: WorkoutExercise, logsForDay?: Record<string, SetState[]>) => {
  const states = logsForDay?.[exercise.id] ?? []
  return exercise.sets.reduce((count, _, index) => (
    states[index]?.done ? count : count + 1
  ), 0)
}

const findDayIndexByDate = (days: WeekPlanDay[], dateId: string) => (
  days.findIndex((day) => day.date === dateId)
)


const parseDurationToSeconds = (value: string | undefined) => {
  if (!value) return null
  let normalized = value.toLowerCase().replace(/\s+/g, '')
  normalized = normalized
    .replace(/seconds?|secs?/g, 's')
    .replace(/minutes?|mins?/g, 'm')

  if (normalized.includes('-')) {
    normalized = normalized.split('-').pop() || normalized
  }

  if (normalized.includes(':')) {
    const [minPart, secPart] = normalized.split(':')
    const minutes = Number(minPart)
    const seconds = Number(secPart)
    if (!Number.isNaN(minutes) && !Number.isNaN(seconds)) {
      return (minutes * 60) + seconds
    }
  }

  const combinedMatch = normalized.match(/^(?:(\d+)m)?(?:(\d+)s)?$/)
  if (combinedMatch && (combinedMatch[1] || combinedMatch[2])) {
    const minutes = Number(combinedMatch[1] || 0)
    const seconds = Number(combinedMatch[2] || 0)
    const total = (minutes * 60) + seconds
    if (total > 0) return total
  }

  const numberMatch = normalized.match(/(\d+)/)
  if (numberMatch) {
    const parsed = Number(numberMatch[1])
    return Number.isNaN(parsed) ? null : parsed
  }

  return null
}

const NULLISH_TOKENS = new Set(['null', 'none', 'n/a', 'na', 'n.a.', 'nil', 'nill', 'undefined', '-'])

const isNullishToken = (value: string) => {
  const trimmed = value.trim().toLowerCase()
  return trimmed !== '' && NULLISH_TOKENS.has(trimmed)
}

const normalizeRepValue = (value: string | null | undefined) => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed || isNullishToken(trimmed)) return ''
  if (trimmed.includes('-') || /\bto\b/i.test(trimmed)) {
    const match = trimmed.match(/(\d+)/)
    return match ? match[1] : trimmed
  }
  return trimmed
}

const normalizeWeightLabel = (value: string | undefined) => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const lowered = trimmed.toLowerCase()
  if (isNullishToken(lowered) || ['bodyweight', 'body weight', 'body-weight', 'bw'].includes(lowered)) return ''
  const normalizedKg = normalizeWeightForStorage(trimmed)
  if (normalizedKg) return `${normalizedKg}kg`
  return trimmed
}

const normalizeWeightValue = (value: string | undefined) => normalizeWeightLabel(value)

const formatWeightValue = (value: number, precision: number) => {
  const rounded = Number(value.toFixed(precision))
  if (!Number.isFinite(rounded)) return ''
  return Number.isInteger(rounded) ? String(rounded) : rounded.toString()
}

const normalizeWeightForStorage = (value: string | undefined) => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const lowered = trimmed.toLowerCase()
  if (isNullishToken(lowered) || ['bodyweight', 'body weight', 'body-weight', 'bw'].includes(lowered)) return ''

  const unitMatch = lowered.match(/(-?\d+(?:[.,]\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)\b/)
  if (unitMatch) {
    const amount = Number(unitMatch[1].replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return ''
    const unit = unitMatch[2]
    const isLb = unit.startsWith('l') || unit.startsWith('p')
    const kgValue = isLb ? amount * 0.45359237 : amount
    return formatWeightValue(kgValue, isLb ? 1 : 2)
  }

  const numberMatch = lowered.match(/-?\d+(?:[.,]\d+)?/)
  if (!numberMatch) return ''
  const amount = Number(numberMatch[0].replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0) return ''
  return formatWeightValue(amount, 2)
}

const findSetValue = (
  sets: Array<{ targetReps?: string, targetTime?: string, targetWeight?: string, isWarmup?: boolean }>,
  key: 'targetReps' | 'targetTime' | 'targetWeight',
  options?: { includeWarmup?: boolean }
) => {
  const includeWarmup = options?.includeWarmup ?? true
  let fallback = ''
  for (const set of sets) {
    const value = set[key]
    if (!value) continue
    const trimmed = value.trim()
    if (!trimmed || isNullishToken(trimmed)) continue
    if (!includeWarmup && set.isWarmup) {
      if (!fallback) fallback = trimmed
      continue
    }
    return trimmed
  }
  return includeWarmup ? '' : fallback
}

const getExerciseSideCount = (exercise: { sides?: number }) => {
  if (typeof exercise.sides !== 'number' || !Number.isFinite(exercise.sides)) return 1
  const rounded = Math.max(1, Math.round(exercise.sides))
  return rounded
}

const hasPerSideTargets = (exercise: { sides?: number, perSide?: boolean }) => {
  const sides = getExerciseSideCount(exercise)
  return sides > 1 && exercise.perSide !== false
}

const resolveTimeMode = (exercise: {
  metric?: 'reps' | 'time'
  sides?: number
  perSide?: boolean
  timeMode?: 'per_side' | 'total'
}) => {
  const sides = getExerciseSideCount(exercise)
  if (exercise.metric !== 'time' || sides <= 1) return null
  if (exercise.timeMode === 'per_side' || exercise.timeMode === 'total') {
    return exercise.timeMode
  }
  return hasPerSideTargets(exercise) ? 'per_side' : 'total'
}

const hasPerSideMetricTargets = (exercise: {
  metric?: 'reps' | 'time'
  sides?: number
  perSide?: boolean
  timeMode?: 'per_side' | 'total'
}) => {
  const sides = getExerciseSideCount(exercise)
  if (sides <= 1) return false
  if (exercise.metric === 'time') return resolveTimeMode(exercise) !== 'total'
  return exercise.perSide !== false
}

const getTimedSideCount = (exercise: {
  metric?: 'reps' | 'time'
  sides?: number
  perSide?: boolean
  timeMode?: 'per_side' | 'total'
}) => (
  resolveTimeMode(exercise) === 'per_side' ? getExerciseSideCount(exercise) : 1
)

const resolveWeightMode = (exercise: { sides?: number, perSide?: boolean, weightMode?: 'per_side' | 'total' }) => {
  const sides = getExerciseSideCount(exercise)
  if (sides <= 1) return null
  if (exercise.weightMode === 'per_side' || exercise.weightMode === 'total') {
    return exercise.weightMode
  }
  return hasPerSideTargets(exercise) ? 'per_side' : 'total'
}

const formatMetricTargetForDisplay = (
  value: string,
  exercise: { metric?: 'reps' | 'time', sides?: number, perSide?: boolean, timeMode?: 'per_side' | 'total' }
) => {
  if (!value || value === '-') return value
  const displayValue = exercise.metric === 'time' ? formatDurationForDisplay(value) : value
  return hasPerSideMetricTargets(exercise) ? `${displayValue}/side` : displayValue
}

const formatWeightTargetForDisplay = (
  value: string,
  exercise: { sides?: number, perSide?: boolean, weightMode?: 'per_side' | 'total' }
) => {
  if (!value) return value
  const weightMode = resolveWeightMode(exercise)
  if (!weightMode) return value
  return weightMode === 'per_side' ? `${value} per side` : `${value} total`
}

const updateExerciseSummary = (exercise: {
  status?: 'skip'
  metric: 'reps' | 'time'
  sets: Array<{ targetReps?: string, targetTime?: string, targetWeight?: string, isWarmup?: boolean }>
  summary: string
  sides?: number
  perSide?: boolean
  weightMode?: 'per_side' | 'total'
}) => {
  if (exercise.status === 'skip') return
  const workingSets = exercise.sets.filter((set) => !set.isWarmup)
  const setCount = workingSets.length || exercise.sets.length
  if (!setCount) {
    exercise.summary = '0 sets'
    return
  }
  const metricTarget = exercise.metric === 'time'
    ? findSetValue(exercise.sets, 'targetTime', { includeWarmup: false })
    : normalizeRepValue(findSetValue(exercise.sets, 'targetReps', { includeWarmup: false }))
  const weightTarget = normalizeWeightValue(findSetValue(exercise.sets, 'targetWeight', { includeWarmup: false }))
  const metricDisplay = formatMetricTargetForDisplay(metricTarget || '-', exercise)
  const weightDisplay = formatWeightTargetForDisplay(weightTarget, exercise)
  const base = `${setCount} sets x ${metricDisplay}`
  exercise.summary = weightDisplay ? `${base} - ${weightDisplay}` : base
}

const normalizeCircuitsAfterExerciseRemoval = (exercises: WorkoutExercise[], removedExercises: WorkoutExercise[]) => {
  const affectedCircuitNames = new Set(
    removedExercises
      .map((exercise) => exercise.circuit?.name)
      .filter((name): name is string => Boolean(name))
  )
  if (affectedCircuitNames.size === 0) return exercises

  const orderById = new Map<string, { order: number; totalExercises: number }>()

  affectedCircuitNames.forEach((circuitName) => {
    const circuitItems = exercises
      .filter((exercise) => exercise.circuit?.name === circuitName)
      .sort((a, b) => {
        const orderA = a.circuit?.order ?? exercises.indexOf(a)
        const orderB = b.circuit?.order ?? exercises.indexOf(b)
        return orderA - orderB
      })

    circuitItems.forEach((exercise, index) => {
      orderById.set(exercise.id, {
        order: index + 1,
        totalExercises: circuitItems.length,
      })
    })
  })

  return exercises.map((exercise) => {
    const nextCircuitMeta = orderById.get(exercise.id)
    if (!nextCircuitMeta || !exercise.circuit) return exercise
    return {
      ...exercise,
      circuit: {
        ...exercise.circuit,
        order: nextCircuitMeta.order,
        totalExercises: nextCircuitMeta.totalExercises,
      },
    }
  })
}

const decodePrivyJwt = (token: string) => {
  const parts = token.split('.')
  if (parts.length < 2) return { sub: null, exp: null }
  try {
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')
    const parsed = JSON.parse(atob(payload)) as { sub?: unknown; exp?: unknown }
    return {
      sub: typeof parsed.sub === 'string' && parsed.sub.trim() ? parsed.sub : null,
      exp: typeof parsed.exp === 'number' ? parsed.exp : null,
    }
  } catch {
    return { sub: null, exp: null }
  }
}

const readPrivyUserId = (user: unknown): string | null => {
  if (!user || typeof user !== 'object') return null
  const record = user as Record<string, unknown>
  const candidates = [
    record.id,
    record.userId,
    record.user_id,
    record.sub,
    record.uid,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return null
}

const getInitialLanguage = () => {
  const browserLanguage = normalizeLanguage(typeof navigator !== 'undefined' ? navigator.language : null)
  return browserLanguage ?? 'en'
}

const FONT_SCALE_PRESETS = [1, 1.05, 1.1, 1.15, 1.2] as const

const normalizeFontScale = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(parsed)) return FONT_SCALE_PRESETS[0]
  let closest: number = FONT_SCALE_PRESETS[0]
  let smallestDelta = Math.abs(parsed - closest)
  for (const preset of FONT_SCALE_PRESETS) {
    const delta = Math.abs(parsed - preset)
    if (delta < smallestDelta) {
      smallestDelta = delta
      closest = preset
    }
  }
  return closest
}

const getInitialFontScale = () => FONT_SCALE_PRESETS[0]

const App = () => {
  const todayId = useMemo(() => getWorkoutSessionId(), [])
  const initialLanguage = useMemo(() => getInitialLanguage(), [])
  const weekStartDayIndex = WORKOUT_WEEK_START_DAY_INDEX
  const initialWorkout = useMemo(() => {
    return parseWorkout([])
  }, [])
  const initialSetState = useMemo(
    () => buildSetState(initialWorkout.exercises),
    [initialWorkout.exercises]
  )
  const initialWeekPlan = useMemo(() => (
    buildWeekPlanFromSingleDay(
      todayId,
      initialWorkout.exercises,
      initialWorkout.extras || [],
      initialLanguage,
      weekStartDayIndex
    )
  ), [initialLanguage, initialWorkout.exercises, initialWorkout.extras, todayId, weekStartDayIndex])
  const initialSelectedDayIndex = useMemo(() => {
    const index = findDayIndexByDate(initialWeekPlan.days, todayId)
    return index >= 0 ? index : 0
  }, [initialWeekPlan.days, todayId])
  const initialDay = initialWeekPlan.days[initialSelectedDayIndex] ?? initialWeekPlan.days[0]

  const [weekPlan, setWeekPlan] = useState<WeekPlan>(initialWeekPlan)
  const [selectedDayIndex, setSelectedDayIndex] = useState(initialSelectedDayIndex)
  const selectedDayIndexRef = useRef(initialSelectedDayIndex)

  const weekSetLogsRef = useRef<WeekSetLogs>({
    [(initialDay?.date ?? todayId)]: initialSetState.logs,
  })
  const weekBaseCountsRef = useRef<WeekBaseCounts>({
    [(initialDay?.date ?? todayId)]: initialSetState.baseCounts,
  })

  const workoutExercisesRef = useRef<WorkoutExercise[]>(initialDay?.exercises ?? [])
  const workoutExtrasRef = useRef<WorkoutExtra[]>(initialDay?.extras ?? [])
  const setLogsRef = useRef<Record<string, SetState[]>>(initialSetState.logs)
  const baseSetCountsRef = useRef<Record<string, number>>(initialSetState.baseCounts)
  const [dataVersion, setDataVersion] = useState(0)
  const [activeView, setActiveView] = useState<'home' | 'workout' | 'diet' | 'health' | 'profile'>('workout')
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
  const [activeEntryType, setActiveEntryType] = useState<ActiveEntryType>(null)
  const activeEntryRef = useRef<{ id: string | null, type: ActiveEntryType }>({ id: null, type: null })
  const [editingSet, setEditingSet] = useState<{ exerciseId: string, index: number } | null>(null)
  const [editingSetSnapshot, setEditingSetSnapshot] = useState<{
    weight: string
    metric: string
    value_source?: SetState['value_source']
  } | null>(null)
  const [isBackendHealthy, setIsBackendHealthy] = useState(true)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [serverSessionLoadSettledKey, setServerSessionLoadSettledKey] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [modelControl, setModelControl] = useState<ModelControl | null>(null)
  const [modelSelectionPending, setModelSelectionPending] = useState(false)
  const [coachMessagesByScope, setCoachMessagesByScope] = useState<Record<string, ChatMessage[]>>({})
  const [exerciseHistory, setExerciseHistory] = useState<ExerciseHistoryResponse | null>(null)
  const [exerciseHistoryLoading, setExerciseHistoryLoading] = useState(false)
  const [exerciseHistoryError, setExerciseHistoryError] = useState<string | null>(null)
  const exerciseHistoryCacheRef = useRef<Map<string, ExerciseHistoryResponse>>(new Map())
  const [chatInput, setChatInput] = useState('')
  const [copyingLastWeek] = useState(false)
  const copyingLastWeekRef = useRef(false)
  const [showChatScrollToBottom, setShowChatScrollToBottom] = useState(false)
  const [restState, setRestState] = useState<RestState>({
    active: false,
    remainingSec: 0,
    totalSec: 0,
    minimized: false,
    autoStartNextSet: true,
    startTs: undefined,
    endTs: undefined,
  })
  const [holdTimer, setHoldTimer] = useState<HoldTimerState>({
    active: false,
    phase: 'idle',
    prepRemainingSec: 0,
    remainingSec: 0,
    totalSec: 0,
    prepSec: 0,
    exerciseId: null,
    setIndex: null,
    sideIndex: 0,
    sideCount: 1,
    startTs: null,
    prepEndTs: null,
    holdEndTs: null,
  })
  const [videos, setVideos] = useState<Video[]>([])
  const [videoLoading, setVideoLoading] = useState(false)
  const [videoExactMatch, setVideoExactMatch] = useState<boolean | null>(null)
  const [videoOwnerKey, setVideoOwnerKey] = useState<string | null>(null)
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null)
  const [profile, setProfile] = useState<ProfileState>(() => ({
    text: '',
    weeklyPlan: '',
    language: initialLanguage,
    fontScale: getInitialFontScale(),
    activeNotes: [],
    dailyTasks: [],
  }))
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState('')
  const [privyAuthError, setPrivyAuthError] = useState<string | null>(null)
  const [coachLinks, setCoachLinks] = useState<CoachLink[]>([])
  const [coachLinksLoading] = useState(false)
  const [coachLinksError, setCoachLinksError] = useState<string | null>(null)
  const [coachActionMessage, setCoachActionMessage] = useState<string | null>(null)
  const [coachLatestInviteToken] = useState<string | null>(null)
  const [coachActAsOwnerId, setCoachActAsOwnerId] = useState<string | null>(null)
  const [privySubjectId, setPrivySubjectId] = useState<string | null>(null)
  const privyAuth = usePrivy()
  const {
    ready: privyReady,
    authenticated: privyAuthenticated,
    user: privyUser,
    login: privyLogin,
    logout: privyLogout,
    getAccessToken: getPrivyAccessToken,
  } = privyAuth
  const pendingPrivyUserId = readPrivyUserId(privyUser)
  const expectedSignedInUserId = pendingPrivyUserId || privySubjectId || currentUserEmail
  const canQuerySavedWorkoutSessions = (
    privyReady
    && privyAuthenticated
    && Boolean(currentUserId)
    && (
      Boolean(coachActAsOwnerId)
      || Boolean(expectedSignedInUserId && currentUserId === expectedSignedInUserId)
    )
  )
  const i18n = useMemo(() => createI18n(profile.language), [profile.language])
  const { t } = i18n
  const activeCoachLink = useMemo(() => {
    if (!coachActAsOwnerId) return null
    const normalizedActAs = coachActAsOwnerId.toLowerCase()
    return coachLinks.find((link) => (
      link.status === 'active'
      && (
        link.trainee_owner_id === coachActAsOwnerId
        || (link.trainee_email || '').toLowerCase() === normalizedActAs
      )
    )) ?? null
  }, [coachActAsOwnerId, coachLinks])
  const activeCoachContextLabel = activeCoachLink?.trainee_email
    || (coachActAsOwnerId?.includes('@') ? coachActAsOwnerId : t('coach.traineeLabel'))
  const coachChatEnabled = (
    !coachActAsOwnerId
    || (
      activeCoachLink?.permissions.view_progress === true
      && (
        activeCoachLink.permissions.chat_as_coach === true
        || activeCoachLink.permissions.edit_programs === true
      )
    )
  )
  const selectedModelPreset = modelControl?.presets.find((preset) => preset.id === modelControl.selected_id)
  const selectedModelLabel = presetLabel(selectedModelPreset, modelControl?.models)
  const modelOptions = (modelControl?.models ?? []).flatMap((model) => {
    const efforts = model.efforts.length > 0 ? model.efforts : [undefined]
    return efforts.map((effort) => ({
      value: JSON.stringify([model.cli, model.provider ?? null, model.model ?? null, effort ?? null]),
      label: `${modelDisplayName(model)}${effort ? ` ${titleCase(effort)}` : ''}${providerLabel(model.provider) ? ` · ${providerLabel(model.provider)}` : ''}`,
      cli: model.cli,
      provider: model.provider,
      model: model.model,
      effort,
    }))
  })
  const modelOptionKeys = new Set(modelOptions.map((option) => option.value))
  for (const preset of modelControl?.presets ?? []) {
    if (!preset.model || !preset.effort) continue
    const value = JSON.stringify([preset.cli, preset.provider ?? null, preset.model, preset.effort])
    if (modelOptionKeys.has(value)) continue
    modelOptionKeys.add(value)
    modelOptions.push({
      value,
      label: presetLabel(preset, modelControl?.models) ?? preset.name,
      cli: preset.cli,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort,
    })
  }
  const selectedModelValue = selectedModelPreset
    ? JSON.stringify([selectedModelPreset.cli, selectedModelPreset.provider ?? null, selectedModelPreset.model ?? null, selectedModelPreset.effort ?? null])
    : ''
  const chatBodyRef = useRef<HTMLDivElement>(null)
  const chatBottomFrameRef = useRef<number | null>(null)
  const chatBottomTimeoutRef = useRef<number | null>(null)
  const layoutViewportHeightRef = useRef(0)
  const prevPrivyAuthenticatedRef = useRef(privyAuthenticated)
  const workoutSaveTimeoutRef = useRef<number | null>(null)
  const workoutRevisionByOwnerDateRef = useRef<Record<string, string>>({})
  const pendingWorkoutDatesRef = useRef(new Set<string>())
  const pendingWorkoutPlanDatesRef = useRef(new Set<string>())
  const workoutWriteVersionByDateRef = useRef<Record<string, number>>({})
  const sessionLoadKeyRef = useRef<string | null>(null)
  const sessionReadyRef = useRef(false)
  const sessionHydrationInProgressRef = useRef(false)
  const privyAccessTokenRef = useRef<{ token: string; expiresAtMs: number; sub: string | null } | null>(null)
  const backendHealthLastOkRef = useRef(0)
  const backendHealthPingRef = useRef<Promise<boolean> | null>(null)
  const currentWorkoutSessionIdRef = useRef('')
  const restTimerIdRef = useRef<number | null>(null)
  const lastVisibilityStateRef = useRef<DocumentVisibilityState>(document.visibilityState)
  const savedWorkoutHydrationInFlightKeyRef = useRef<string | null>(null)
  const savedWorkoutHydrationAttemptedKeysRef = useRef(new Set<string>())
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const wakeLockWantedRef = useRef(false)
  const holdTimerIdRef = useRef<number | null>(null)
  const holdCompletionHandledRef = useRef(false)
  const videoCacheRef = useRef(new Map<string, VideoCacheEntry>())
  const videoRequestIdRef = useRef(0)
  const didAutoSelectTodayRef = useRef(false)

  const warmBackend = useCallback(async (options: { force?: boolean } = {}) => {
    const now = Date.now()
    if (!options.force && backendHealthLastOkRef.current && now - backendHealthLastOkRef.current < BACKEND_HEALTH_STALE_MS) {
      return true
    }
    if (backendHealthPingRef.current) {
      return backendHealthPingRef.current
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      controller.abort()
    }, BACKEND_HEALTH_PING_TIMEOUT_MS)

    const request = apiFetch(`${API_BASE_URL}/health?warm=${now}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => {
        const healthy = response.ok
        setIsBackendHealthy(healthy)
        if (healthy) {
          backendHealthLastOkRef.current = Date.now()
        } else {
          setSessionLoading(false)
        }
        return healthy
      })
      .catch((error) => {
        setIsBackendHealthy(false)
        setSessionLoading(false)
        if (error instanceof DOMException && error.name === 'AbortError') {
          console.warn('Backend health warmup timed out.')
        } else {
          console.warn('Backend offline, working in local mode.')
        }
        return false
      })
      .finally(() => {
        window.clearTimeout(timeoutId)
        backendHealthPingRef.current = null
      })

    backendHealthPingRef.current = request
    return request
  }, [])

  const updateChatScrollButton = useCallback(() => {
    const node = chatBodyRef.current
    if (!node) {
      setShowChatScrollToBottom(false)
      return
    }

    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    const canScroll = node.scrollHeight > node.clientHeight + 24
    setShowChatScrollToBottom(canScroll && distanceFromBottom > 96)
  }, [])

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = chatBodyRef.current
    if (!node) return

    node.scrollTo({
      top: node.scrollHeight,
      behavior,
    })
    setShowChatScrollToBottom(false)
  }, [])

  const clearPendingChatBottomSync = useCallback(() => {
    if (chatBottomFrameRef.current !== null) {
      window.cancelAnimationFrame(chatBottomFrameRef.current)
      chatBottomFrameRef.current = null
    }
    if (chatBottomTimeoutRef.current !== null) {
      window.clearTimeout(chatBottomTimeoutRef.current)
      chatBottomTimeoutRef.current = null
    }
  }, [])

  const syncChatBottomSoon = useCallback((behavior: ScrollBehavior = 'auto') => {
    clearPendingChatBottomSync()
    scrollChatToBottom(behavior)

    chatBottomFrameRef.current = window.requestAnimationFrame(() => {
      chatBottomFrameRef.current = null
      scrollChatToBottom('auto')
      updateChatScrollButton()
    })

    chatBottomTimeoutRef.current = window.setTimeout(() => {
      chatBottomTimeoutRef.current = null
      scrollChatToBottom('auto')
      updateChatScrollButton()
    }, 320)
  }, [clearPendingChatBottomSync, scrollChatToBottom, updateChatScrollButton])

  const syncKeyboardInset = useCallback(() => {
    const visualViewport = window.visualViewport
    const activeElement = document.activeElement
    const isTextControl = isTextControlElement(activeElement)
    const currentLayoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight)

    if (!layoutViewportHeightRef.current) {
      layoutViewportHeightRef.current = currentLayoutHeight
    }

    const measuredViewportInset = visualViewport
      ? Math.max(
        0,
        layoutViewportHeightRef.current - visualViewport.height - visualViewport.offsetTop,
      )
      : 0
    // iOS can briefly move focus away from the textarea while its keyboard and
    // accessory bar remain visible. Keep the keyboard geometry until the visual
    // viewport expands again so the sheet does not jump behind the keyboard.
    const keyboardVisible = Boolean(visualViewport) && (isTextControl || measuredViewportInset > 120)

    if (!keyboardVisible) {
      layoutViewportHeightRef.current = currentLayoutHeight
    }

    // Both chats share the actual visible rectangle. Never guess the height of
    // iOS keyboard accessories or subtract the keyboard again inside the chat.
    const viewportHeight = visualViewport?.height ?? window.innerHeight
    const viewportTop = visualViewport?.offsetTop ?? 0
    const root = document.documentElement
    root.dataset.keyboardOpen = String(keyboardVisible && measuredViewportInset > 120)
    root.style.setProperty('--chat-viewport-height', `${viewportHeight}px`)
    root.style.setProperty('--visual-viewport-offset-top', `${viewportTop}px`)
  }, [])

  const resetAppViewportScroll = useCallback(() => {
    syncKeyboardInset()
    const activeElement = document.activeElement

    // Let iOS keep its focused field aligned with the visual viewport. Forcing the
    // layout viewport back to zero here makes Safari and the app fight each other.
    if (isTextControlElement(activeElement) || document.documentElement.dataset.keyboardOpen === 'true') return

    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0

    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0)
    }
  }, [syncKeyboardInset])

  const dismissKeyboard = useCallback(() => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) {
      activeElement.blur()
    }
  }, [])

  const handleActiveViewChange = useCallback((view: 'home' | 'workout' | 'diet' | 'health' | 'profile') => {
    dismissKeyboard()
    setActiveView(view)
    resetAppViewportScroll()
    requestAnimationFrame(resetAppViewportScroll)
    window.setTimeout(resetAppViewportScroll, 250)
  }, [dismissKeyboard, resetAppViewportScroll])

  const isPlanEditableDate = useCallback((dateId?: string | null) => {
    if (!dateId) return false
    return true
  }, [])

  const markLocalEdit = useCallback(() => undefined, [])

  const bumpData = useCallback(() => {
    markLocalEdit()
    setDataVersion((value) => value + 1)
  }, [markLocalEdit])

  const selectedDay = useMemo(() => (
    weekPlan.days[selectedDayIndex] ?? weekPlan.days[0]
  ), [selectedDayIndex, weekPlan.days])

  const selectedDayLabel = useMemo(() => {
    const parsed = selectedDay?.date ? parseDateId(selectedDay.date) : null
    return parsed
      ? getWeekdayFullLabel(parsed, profile.language)
      : (selectedDay?.label ?? t('workout.sectionWorkout'))
  }, [profile.language, selectedDay?.date, selectedDay?.label, t])

  const displayedWorkoutExtras = useMemo(() => ([
    ...workoutExtrasRef.current,
    ...profile.dailyTasks.map((task) => ({
      id: `daily-task-${task.id}`,
      name: task.title,
      section: 'Rehab — Today outside gym',
      summary: task.summary,
      notes: task.notes,
      category: 'rehab' as const,
      isReadOnly: true,
    })),
  ]), [profile.dailyTasks, selectedDay?.date])

  // The public v1 API currently supports canonical reads and generation, but
  // does not expose a browser contract for arbitrary plan/set rewrites. Keep
  // those UI mutations disabled instead of routing them through the removed
  // flat session adapter.
  const canGenerateWorkoutSelectedDay = useMemo(() => (
    isPlanEditableDate(selectedDay?.date ?? todayId)
  ), [isPlanEditableDate, selectedDay?.date, todayId])

  const canEditPlanSelectedDay = false
  const canLlmEditPlanSelectedDay = false
  const canLogSelectedDay = false

  const hasWeekWorkouts = useMemo(() => (
    weekPlan.days.some((day) => day.exercises.length > 0 || day.extras.length > 0)
  ), [weekPlan.days])

  const weekDaySummaries = useMemo(() => {
    const sourceByDate = new Map<string, { day: WeekPlanDay, index: number }>()
    weekPlan.days.forEach((day, index) => {
      sourceByDate.set(day.date, { day, index })
    })

    return buildWorkoutStripDates(todayId, weekStartDayIndex).map((date) => {
      const dateId = getDateId(date)
      const source = sourceByDate.get(dateId)
      const day = source?.day
      const logsForDay = day ? weekSetLogsRef.current[dateId] : undefined
      const isPast = dateId < todayId
      const isFuture = dateId > todayId
      return {
        index: source?.index ?? -1,
        date: dateId,
        label: getWeekdayLabel(date, profile.language),
        isToday: dateId === todayId,
        isPast,
        isFuture,
        isSelected: selectedDay?.date === dateId,
        isCompleted: day ? isDayMarkedComplete(day, logsForDay) : false,
        isRest: day ? (day.isRest ?? day.exercises.length === 0) : true,
        isProjected: !day,
        isSelectable: true,
      }
    })
  }, [dataVersion, profile.language, selectedDay?.date, todayId, weekPlan.days, weekStartDayIndex])

  const syncDayRefs = useCallback((plan: WeekPlan, index: number) => {
    const day = plan.days[index] ?? plan.days[0]
    if (!day) return

    workoutExercisesRef.current = day.exercises
    workoutExtrasRef.current = day.extras

    if (!weekSetLogsRef.current[day.date] || !weekBaseCountsRef.current[day.date]) {
      const { logs, baseCounts } = buildSetLogsForExercises(day.exercises, weekSetLogsRef.current[day.date])
      weekSetLogsRef.current[day.date] = logs
      weekBaseCountsRef.current[day.date] = baseCounts
    }

    setLogsRef.current = weekSetLogsRef.current[day.date]
    baseSetCountsRef.current = weekBaseCountsRef.current[day.date] ?? {}
    currentWorkoutSessionIdRef.current = day.date
  }, [])

  const getExercise = useCallback((id: string) => (
    workoutExercisesRef.current.find((exercise) => exercise.id === id)
  ), [])

  const getCircuitItems = useCallback((circuitName: string) => (
    workoutExercisesRef.current
      .map((exercise, index) => ({ exercise, index }))
      .filter((item) => item.exercise.circuit?.name === circuitName)
      .sort((a, b) => {
        const orderA = a.exercise.circuit?.order ?? a.index
        const orderB = b.exercise.circuit?.order ?? b.index
        return orderA - orderB
      })
  ), [])

  const ensureExerciseStateList = useCallback((exercise: WorkoutExercise) => {
    if (!setLogsRef.current[exercise.id]) {
      setLogsRef.current[exercise.id] = exercise.sets.map(() => ({ weight: '', metric: '', done: false }))
    }

    const stateList = setLogsRef.current[exercise.id]
    while (stateList.length < exercise.sets.length) {
      stateList.push({ weight: '', metric: '', done: false })
    }
    if (stateList.length > exercise.sets.length) {
      stateList.splice(exercise.sets.length)
    }

    return stateList
  }, [])

  const getNextPendingCircuitExercise = useCallback((circuitName: string): WorkoutExercise | null => {
    let nextExercise: WorkoutExercise | null = null
    let nextRoundIndex = Number.POSITIVE_INFINITY
    let nextOrder = Number.POSITIVE_INFINITY

    getCircuitItems(circuitName).forEach(({ exercise }, order) => {
      const stateList = setLogsRef.current[exercise.id] ?? []
      const nextSetIndex = exercise.sets.findIndex((_, index) => !stateList[index]?.done)
      if (nextSetIndex === -1) return

      const nextSet = exercise.sets[nextSetIndex]
      const roundIndex = nextSet?.isWarmup
        ? -1
        : exercise.sets.slice(0, nextSetIndex + 1).reduce((count, setItem) => (
          setItem?.isWarmup ? count : count + 1
        ), 0) - 1

      if (
        !nextExercise
        || roundIndex < nextRoundIndex
        || (roundIndex === nextRoundIndex && order < nextOrder)
      ) {
        nextExercise = exercise
        nextRoundIndex = roundIndex
        nextOrder = order
      }
    })

    return nextExercise
  }, [getCircuitItems])

  const releaseWakeLock = useCallback(async () => {
    const lock = wakeLockRef.current
    wakeLockRef.current = null
    if (!lock || lock.released) return
    try {
      await lock.release()
    } catch {
      // Ignore release races when the OS already dropped the lock.
    }
  }, [])

  const requestWakeLock = useCallback(async () => {
    if (!wakeLockWantedRef.current) return
    if (document.visibilityState !== 'visible') return
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
    }
    if (!nav.wakeLock) return
    if (wakeLockRef.current && !wakeLockRef.current.released) return
    try {
      const lock = await nav.wakeLock.request('screen')
      if (!wakeLockWantedRef.current) {
        await lock.release().catch(() => undefined)
        return
      }
      wakeLockRef.current = lock
      lock.addEventListener('release', () => {
        if (wakeLockRef.current === lock) {
          wakeLockRef.current = null
        }
      })
    } catch (err) {
      // Common when the page is hidden, battery saver is on, or the browser denies it.
      console.warn('Screen wake lock request failed:', err)
    }
  }, [])

  const syncWakeLock = useCallback((wanted: boolean) => {
    wakeLockWantedRef.current = wanted
    if (wanted) {
      void requestWakeLock()
      return
    }
    void releaseWakeLock()
  }, [releaseWakeLock, requestWakeLock])

  const triggerRestVibration = useCallback(() => {
    if ('vibrate' in navigator) {
      navigator.vibrate([200, 80, 200])
    }
  }, [])

  const triggerRestAlert = useCallback(() => {
    triggerRestVibration()
  }, [triggerRestVibration])

  const stopRest = useCallback(() => {
    setRestState({
      active: false,
      remainingSec: 0,
      totalSec: 0,
      minimized: false,
      autoStartNextSet: true,
      startTs: undefined,
      endTs: undefined,
    })
    if (restTimerIdRef.current) {
      window.clearInterval(restTimerIdRef.current)
      restTimerIdRef.current = null
    }
  }, [])

  const completeRest = useCallback((options?: { silent?: boolean }) => {
    const isVisible = document.visibilityState === 'visible'
    if (options?.silent) {
      // Rest already elapsed while away — clear state without replaying cues.
      stopRest()
      return
    }
    if (isVisible) {
      triggerRestAlert()
    }
    stopRest()
  }, [stopRest, triggerRestAlert])

  const startRest = useCallback((duration: number) => {
    const total = duration > 0 ? duration : 60
    const startTs = Date.now()
    const endTs = startTs + (total * 1000)

    setRestState({
      active: true,
      remainingSec: total,
      totalSec: total,
      minimized: false,
      autoStartNextSet: true,
      startTs,
      endTs,
    })

    if (restTimerIdRef.current) {
      window.clearInterval(restTimerIdRef.current)
    }

    restTimerIdRef.current = window.setInterval(() => {
      setRestState((prev) => {
        if (!prev.active || !prev.endTs) return prev
        const remainingMs = prev.endTs - Date.now()
        const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000))
        if (remainingSec === prev.remainingSec) return prev
        return { ...prev, remainingSec }
      })
    }, 250)
  }, [])

  const adjustRestTime = useCallback((seconds: number) => {
    setRestState((prev) => {
      if (!prev.active) return prev
      const now = Date.now()
      const newTotal = Math.max(1, prev.totalSec + seconds)
      const newEndTs = prev.endTs ? prev.endTs + (seconds * 1000) : prev.endTs
      const newRemaining = newEndTs ? Math.max(0, Math.ceil((newEndTs - now) / 1000)) : prev.remainingSec
      return {
        ...prev,
        remainingSec: newRemaining,
        totalSec: newTotal,
        endTs: newEndTs,
      }
    })
  }, [])

  const minimizeRest = useCallback(() => {
    setRestState((prev) => ({
      ...prev,
      minimized: prev.active ? true : prev.minimized,
    }))
  }, [])

  const maximizeRest = useCallback(() => {
    setRestState((prev) => ({
      ...prev,
      minimized: false,
    }))
  }, [])

  const clearHoldTimerInterval = useCallback(() => {
    if (!holdTimerIdRef.current) return
    window.clearInterval(holdTimerIdRef.current)
    holdTimerIdRef.current = null
  }, [])

  const updateHoldTimerFromNow = useCallback((timer: HoldTimerState, now: number): HoldTimerState => {
    if (!timer.active || !timer.holdEndTs) return timer

    if (timer.prepEndTs && now < timer.prepEndTs) {
      return {
        ...timer,
        phase: 'prep',
        prepRemainingSec: Math.max(0, Math.ceil((timer.prepEndTs - now) / 1000)),
        remainingSec: timer.totalSec,
      }
    }

    if (now < timer.holdEndTs) {
      return {
        ...timer,
        phase: 'hold',
        prepRemainingSec: 0,
        remainingSec: Math.max(0, Math.ceil((timer.holdEndTs - now) / 1000)),
      }
    }

    return {
      ...timer,
      phase: 'complete',
      active: false,
      prepRemainingSec: 0,
      remainingSec: 0,
    }
  }, [])

  const stopHoldTimer = useCallback(() => {
    clearHoldTimerInterval()
    setHoldTimer((prev) => ({
      ...prev,
      active: false,
      phase: 'idle',
      prepRemainingSec: prev.prepSec,
      remainingSec: prev.totalSec,
      sideIndex: 0,
      sideCount: 1,
      startTs: null,
      prepEndTs: null,
      holdEndTs: null,
    }))
  }, [clearHoldTimerInterval])

  const resetHoldTimer = useCallback(() => {
    clearHoldTimerInterval()
    setHoldTimer({
      active: false,
      phase: 'idle',
      prepRemainingSec: 0,
      remainingSec: 0,
      totalSec: 0,
      prepSec: 0,
      exerciseId: null,
      setIndex: null,
      sideIndex: 0,
      sideCount: 1,
      startTs: null,
      prepEndTs: null,
      holdEndTs: null,
    })
  }, [clearHoldTimerInterval])

  const startHoldTimer = useCallback((
    exerciseId: string,
    setIndex: number,
    totalSec: number,
    prepSec: number,
    options?: { sideIndex?: number, sideCount?: number },
  ) => {
    clearHoldTimerInterval()
    const total = Math.max(1, Math.floor(totalSec))
    const prep = Math.max(0, Math.floor(prepSec))
    const sideCount = Math.max(1, Math.floor(options?.sideCount ?? 1))
    const sideIndex = Math.min(sideCount - 1, Math.max(0, Math.floor(options?.sideIndex ?? 0)))
    const startTs = Date.now()
    const prepEndTs = startTs + (prep * 1000)
    const holdEndTs = prepEndTs + (total * 1000)

    setHoldTimer({
      active: true,
      phase: prep > 0 ? 'prep' : 'hold',
      prepRemainingSec: prep,
      remainingSec: total,
      totalSec: total,
      prepSec: prep,
      exerciseId,
      setIndex,
      sideIndex,
      sideCount,
      startTs,
      prepEndTs,
      holdEndTs,
    })

    holdTimerIdRef.current = window.setInterval(() => {
      setHoldTimer((prev) => updateHoldTimerFromNow(prev, Date.now()))
    }, 1000)
  }, [clearHoldTimerInterval, updateHoldTimerFromNow])

  const setRestAutoStart = useCallback((value: boolean) => {
    setRestState((prev) => ({
      ...prev,
      autoStartNextSet: value,
    }))
  }, [])

  const autoStartNextHoldSet = useCallback(() => {
    if (holdTimer.active) return
    if (activeEntryType !== 'exercise' || !activeEntryId) return
    const exercise = getExercise(activeEntryId)
    if (!exercise) return
    if (exercise.metric !== 'time' || exercise.timer?.enabled !== true) return
    const stateList = setLogsRef.current[exercise.id] ?? []
    const nextIndex = stateList.findIndex((set) => !set.done)
    if (nextIndex === -1) return
    const targetSet = exercise.sets[nextIndex]
    const holdTargetSec = parseDurationToSeconds(targetSet?.targetTime) ?? 60
    const holdPrepSec = exercise.timer?.prepSec ?? 3
    const sideCount = getTimedSideCount(exercise)
    startHoldTimer(exercise.id, nextIndex, holdTargetSec, holdPrepSec, { sideIndex: 0, sideCount })
  }, [activeEntryId, activeEntryType, getExercise, holdTimer.active, startHoldTimer])

  const initializeSetState = useCallback((dateId?: string, exercisesOverride?: WorkoutExercise[]) => {
    const targetDate = dateId ?? selectedDay?.date ?? todayId
    const exercises = exercisesOverride ?? workoutExercisesRef.current
    const { logs, baseCounts } = buildSetLogsForExercises(exercises)
    weekSetLogsRef.current[targetDate] = logs
    weekBaseCountsRef.current[targetDate] = baseCounts
    setLogsRef.current = logs
    baseSetCountsRef.current = baseCounts
    bumpData()
  }, [bumpData, selectedDay?.date, todayId])

  const ensureWorkoutSession = useCallback((dateId?: string) => {
    const targetDate = dateId ?? selectedDay?.date ?? todayId
    currentWorkoutSessionIdRef.current = targetDate

    if (!weekSetLogsRef.current[targetDate]) {
      initializeSetState(targetDate, workoutExercisesRef.current)
      return true
    }

    setLogsRef.current = weekSetLogsRef.current[targetDate]
    baseSetCountsRef.current = weekBaseCountsRef.current[targetDate] ?? {}
    return false
  }, [initializeSetState, selectedDay?.date, todayId])

  const hideWorkoutDetail = useCallback(() => {
    activeEntryRef.current = { id: null, type: null }
    setActiveEntryId(null)
    setActiveEntryType(null)
    resetHoldTimer()
    setEditingSet(null)
    setEditingSetSnapshot(null)
  }, [resetHoldTimer])

  const showWorkoutDetail = useCallback((id: string, type: ActiveEntryType) => {
    if (!type) return
    activeEntryRef.current = { id, type }
    setActiveEntryId(id)
    setActiveEntryType(type)
  }, [])

  const applyWeekPlan = useCallback((plan: WeekPlan, options?: {
    selectedDate?: string
    selectedIndex?: number
    logsByDay?: WeekSetLogs
    baseCountsByDay?: WeekBaseCounts
    preferToday?: boolean
    preserveActiveEntry?: boolean
  }) => {
    let activePlan = plan
    let nextLogs = options?.logsByDay ? { ...options.logsByDay } : { ...weekSetLogsRef.current }
    let nextBaseCounts = options?.baseCountsByDay
      ? { ...options.baseCountsByDay }
      : { ...weekBaseCountsRef.current }

    let todayIndex = findDayIndexByDate(activePlan.days, todayId)
    if (options?.preferToday && todayIndex < 0) {
      const today = new Date()
      const weekStart = getWeekStartDate(today, weekStartDayIndex)
      // A new calendar week starts empty until its canonical plan is generated.
      const rebasedDays = buildWeekDates(weekStart).map((date) => ({
        date: getDateId(date),
        label: getWeekdayLabel(date, profile.language),
        exercises: [],
        extras: [],
        isRest: true,
        planNotes: '',
        notes: '',
      }))
      activePlan = {
        weekStart: getDateId(weekStart),
        days: rebasedDays,
      }
      nextLogs = {}
      nextBaseCounts = {}
      todayIndex = findDayIndexByDate(activePlan.days, todayId)
    }

    activePlan.days.forEach((day) => {
      if (!nextLogs[day.date]) {
        const { logs, baseCounts } = buildSetLogsForExercises(day.exercises)
        nextLogs[day.date] = logs
        nextBaseCounts[day.date] = baseCounts
      }
    })

    const preferredIndex = typeof options?.selectedIndex === 'number'
      ? options.selectedIndex
      : (options?.selectedDate ? findDayIndexByDate(activePlan.days, options.selectedDate) : -1)
    const preferToday = options?.preferToday && todayIndex >= 0
    const safeIndex = preferToday
      ? todayIndex
      : (preferredIndex >= 0 ? preferredIndex : (todayIndex >= 0 ? todayIndex : 0))

    weekSetLogsRef.current = nextLogs
    weekBaseCountsRef.current = nextBaseCounts
    selectedDayIndexRef.current = safeIndex
    setSelectedDayIndex(safeIndex)
    setWeekPlan(activePlan)
    syncDayRefs(activePlan, safeIndex)
    const nextSelectedDay = activePlan.days[safeIndex]
    // Selection is navigation state; it must not restart account hydration.
    const activeEntry = activeEntryRef.current
    const activeEntryStillExists = Boolean(
      options?.preserveActiveEntry
      && activeEntry.id
      && (
        (activeEntry.type === 'exercise'
          && nextSelectedDay?.exercises.some((exercise) => exercise.id === activeEntry.id))
        || (activeEntry.type === 'extra'
          && nextSelectedDay?.extras.some((extra) => extra.id === activeEntry.id))
      )
    )
    if (!activeEntryStillExists) {
      hideWorkoutDetail()
    }
    bumpData()
  }, [bumpData, hideWorkoutDetail, profile.language, syncDayRefs, todayId, weekStartDayIndex])

  const handleSelectDay = useCallback((index: number, dateId?: string) => {
    const normalizedDateId = normalizeDateId(dateId)
    const existingIndex = normalizedDateId ? findDayIndexByDate(weekPlan.days, normalizedDateId) : -1
    if (normalizedDateId) {
      didAutoSelectTodayRef.current = true
    }

    if (index < 0 && normalizedDateId) {
      if (existingIndex >= 0) {
        if (existingIndex === selectedDayIndexRef.current) return
        selectedDayIndexRef.current = existingIndex
        setSelectedDayIndex(existingIndex)
        syncDayRefs(weekPlan, existingIndex)
        hideWorkoutDetail()
        bumpData()
        return
      }

      const parsedDate = parseDateId(normalizedDateId)
      if (!parsedDate) return

      const buildProjectedDay = (targetDateId: string): WeekPlanDay | null => {
        const targetDate = parseDateId(targetDateId)
        if (!targetDate) return null
        const sourceDay = weekPlan.days.find((day) => {
          const parsedSourceDate = parseDateId(day.date)
          return parsedSourceDate?.getDay() === targetDate.getDay()
        })
        return {
          date: targetDateId,
          label: getWeekdayLabel(targetDate, profile.language),
          exercises: [],
          extras: [],
          isRest: sourceDay?.isRest ?? (sourceDay ? sourceDay.exercises.length === 0 : true),
          planNotes: '',
          notes: '',
        }
      }

      const existingDates = new Set(weekPlan.days.map((day) => day.date))
      const previousDate = weekPlan.days
        .map((day) => day.date)
        .filter((date) => date < normalizedDateId)
        .sort()
        .pop()
      const missingDays: WeekPlanDay[] = []
      let cursorDate = previousDate ? shiftDateId(previousDate, 1) : normalizedDateId
      while (cursorDate <= normalizedDateId) {
        if (!existingDates.has(cursorDate)) {
          const projectedDay = buildProjectedDay(cursorDate)
          if (projectedDay) {
            missingDays.push(projectedDay)
          }
        }
        const nextCursorDate = shiftDateId(cursorDate, 1)
        if (nextCursorDate === cursorDate) break
        cursorDate = nextCursorDate
      }
      if (missingDays.length === 0) return

      const nextLogs: WeekSetLogs = { ...weekSetLogsRef.current }
      const nextBaseCounts: WeekBaseCounts = { ...weekBaseCountsRef.current }
      missingDays.forEach((day) => {
        const { logs, baseCounts } = buildSetLogsForExercises(day.exercises)
        nextLogs[day.date] = logs
        nextBaseCounts[day.date] = baseCounts
      })
      const nextPlan: WeekPlan = {
        ...weekPlan,
        days: [...weekPlan.days, ...missingDays].sort((a, b) => a.date.localeCompare(b.date)),
      }

      applyWeekPlan(nextPlan, {
        selectedDate: normalizedDateId,
        logsByDay: nextLogs,
        baseCountsByDay: nextBaseCounts,
      })
      return
    }

    const targetIndex = existingIndex >= 0 ? existingIndex : index
    if (targetIndex === selectedDayIndexRef.current) return
    const safeIndex = Math.max(0, Math.min(targetIndex, weekPlan.days.length - 1))
    selectedDayIndexRef.current = safeIndex
    setSelectedDayIndex(safeIndex)
    syncDayRefs(weekPlan, safeIndex)
    hideWorkoutDetail()
    bumpData()
  }, [applyWeekPlan, bumpData, hideWorkoutDetail, profile.language, syncDayRefs, weekPlan])

  const mergeBackendChatHistory = useCallback(async (items: ChatHistoryPayloadItem[]) => {
    const cleaned = items
      .map((item): PersistedMessage | null => {
        if (!item || (item.role !== 'user' && item.role !== 'ai')) return null
        if (typeof item.content !== 'string' || !item.content.trim()) return null
        const parsedTimestamp = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN
        return {
          variant: item.role,
          text: item.content,
          timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now(),
          modelLabel: item.role === 'ai' && typeof item.agent_label === 'string'
            ? item.agent_label
            : undefined,
        }
      })
      .filter((item): item is PersistedMessage => Boolean(item))
      .slice(-MAIN_CHAT_HISTORY_LIMIT)
    if (cleaned.length === 0) return

    const hydrated = await Promise.all(cleaned.map(async (message, index) => ({
      id: `backend-${message.timestamp ?? Date.now()}-${index}`,
      variant: message.variant,
      text: message.text,
      html: message.variant === 'ai' ? await marked.parse(message.text) : undefined,
      timestamp: message.timestamp,
      modelLabel: message.modelLabel,
    })))
    setMessages((previous) => {
      const merged = [...previous]
      hydrated.forEach((incoming) => {
        const duplicate = merged.some((existing) => (
          existing.variant === incoming.variant
          && existing.text === incoming.text
          && Math.abs((existing.timestamp ?? 0) - (incoming.timestamp ?? 0)) < 2 * 60 * 1000
        ))
        if (!duplicate) merged.push(incoming)
      })
      return merged
        .filter((message) => !message.thinking && Boolean(message.text))
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
        .slice(-MAIN_CHAT_HISTORY_LIMIT)
    })
  }, [])

  const persistWorkoutSessionForDay = async (_entry: {
    dateId: string
    sessionId?: string | null
    label?: string | null
    exercises: WorkoutExercise[]
    extras: WorkoutExtra[]
    setLogs: Record<string, SetState[]>
    notes?: string
    dayOverride?: WeekPlanDay
    planMutation?: boolean
  }) => {
    // The public API deliberately exposes typed workout mutations only. The
    // legacy flat session write had no canonical equivalent and is disabled
    // until each UI mutation is mapped to a typed v1 operation.
    return false
  }

  const persistWorkoutSession = async (_planMutation = false) => false

  const scheduleWorkoutSave = useCallback((planMutation = false) => {
    pendingWorkoutDatesRef.current.add(selectedDay?.date ?? todayId)
    if (planMutation) {
      pendingWorkoutPlanDatesRef.current.add(selectedDay?.date ?? todayId)
    }
    if (workoutSaveTimeoutRef.current) {
      window.clearTimeout(workoutSaveTimeoutRef.current)
    }
    workoutSaveTimeoutRef.current = window.setTimeout(() => {
      persistWorkoutSession()
      workoutSaveTimeoutRef.current = null
    }, SESSION_SAVE_DEBOUNCE_MS)
  }, [persistWorkoutSession, selectedDay?.date, todayId])

  const logNextSet = useCallback((targetExerciseId?: string) => {
    if (!canLogSelectedDay) return
    const exerciseId = targetExerciseId ?? activeEntryId
    if (!exerciseId) return
    if (!targetExerciseId && activeEntryType !== 'exercise') return
    const selectedExercise = getExercise(exerciseId)
    if (!selectedExercise || selectedExercise.status === 'skip') return
    let exercise: WorkoutExercise = selectedExercise

    setEditingSet(null)
    setEditingSetSnapshot(null)
    resetHoldTimer()

    let stateList = ensureExerciseStateList(exercise)
    let nextIndex = exercise.sets.findIndex((_, index) => !stateList[index]?.done)
    if (nextIndex === -1 && exercise.circuit?.name) {
      const pendingExercise = getNextPendingCircuitExercise(exercise.circuit.name)
      if (pendingExercise && pendingExercise.id !== exercise.id) {
        exercise = pendingExercise
        stateList = ensureExerciseStateList(exercise)
        nextIndex = exercise.sets.findIndex((_, index) => !stateList[index]?.done)
        showWorkoutDetail(exercise.id, 'exercise')
      }
    }
    if (nextIndex === -1) return

    const itemState = stateList[nextIndex]
    const targetSet = exercise.sets[nextIndex]
    itemState.weight = normalizeWorkoutTargetText(itemState.weight) ?? ''
    itemState.metric = normalizeWorkoutTargetText(itemState.metric) ?? ''
    const targetWeight = normalizeWorkoutTargetText(targetSet?.targetWeight) ?? ''
    const targetMetric = normalizeWorkoutTargetText(
      exercise.metric === 'time' ? targetSet?.targetTime : targetSet?.targetReps
    ) ?? ''

    if (!itemState.weight && targetWeight) {
      itemState.weight = targetWeight
      itemState.value_source = 'accepted_target'
    } else if (itemState.weight && !itemState.value_source) {
      itemState.value_source = 'legacy_unknown'
    }
    if (!itemState.metric) {
      itemState.metric = targetMetric
    }

    if (itemState.weight) {
      itemState.weight = normalizeWeightLabel(itemState.weight)
    }
    if (exercise.metric === 'reps') {
      itemState.metric = normalizeRepValue(itemState.metric)
    }
    itemState.done = true
    bumpData()
    void persistWorkoutSession()

    const circuitName = exercise.circuit?.name
    const isWarmupSet = targetSet?.isWarmup === true
    if (circuitName && isWarmupSet) {
      const isLastSet = nextIndex === stateList.length - 1
      if (isLastSet) {
        hideWorkoutDetail()
      }
      return
    }

    if (circuitName) {
      const circuitItems = getCircuitItems(circuitName)
      const circuitExercises = circuitItems.map((item) => item.exercise)
      if (circuitExercises.length) {
        const getWorkSetIndex = (sets: Array<{ isWarmup?: boolean }>, workIndex: number) => {
          let count = 0
          for (let i = 0; i < sets.length; i++) {
            if (sets[i]?.isWarmup) continue
            if (count === workIndex) return i
            count += 1
          }
          return -1
        }

        const getWorkSetCount = (sets: Array<{ isWarmup?: boolean }>) => (
          sets.reduce((count, setItem) => (setItem?.isWarmup ? count : count + 1), 0)
        )

        const roundIndex = exercise.sets.slice(0, nextIndex + 1).reduce((count, setItem) => (
          setItem?.isWarmup ? count : count + 1
        ), 0) - 1
        const currentIndex = Math.max(0, circuitExercises.findIndex((item) => item.id === exercise.id))
        const totalRounds = exercise.circuit?.rounds ?? getWorkSetCount(exercise.sets)
        const restAfterSec = exercise.circuit?.restAfterSec

        const findUndoneInRound = (startIndex: number) => {
          for (let i = startIndex; i < circuitExercises.length; i++) {
            const candidate = circuitExercises[i]
            const workSetIndex = getWorkSetIndex(candidate.sets, roundIndex)
            if (workSetIndex === -1) continue
            const candidateStates = setLogsRef.current[candidate.id]
            if (!candidateStates?.[workSetIndex]?.done) return candidate
          }
          return null
        }

        let nextExercise = findUndoneInRound(currentIndex + 1)
        if (!nextExercise) {
          nextExercise = findUndoneInRound(0)
        }

        if (nextExercise) {
          showWorkoutDetail(nextExercise.id, 'exercise')
          return
        }

        const nextRoundIndex = roundIndex + 1
        if (totalRounds && nextRoundIndex < totalRounds) {
          const firstExercise = circuitExercises[0]
          if (firstExercise) {
            showWorkoutDetail(firstExercise.id, 'exercise')
          }
          const restDuration = typeof restAfterSec === 'number'
            ? restAfterSec
            : typeof exercise.restSec === 'number'
              ? exercise.restSec
              : restDefaultSec
          if (restDuration > 0) {
            startRest(restDuration)
          }
          return
        }

        hideWorkoutDetail()
        return
      }
    }

    const isLastSet = nextIndex === stateList.length - 1
    if (isLastSet) {
      hideWorkoutDetail()
    } else {
      startRest(exercise.restSec ?? restDefaultSec)
    }
  }, [
    activeEntryId,
    activeEntryType,
    bumpData,
    ensureExerciseStateList,
    getCircuitItems,
    getExercise,
    getNextPendingCircuitExercise,
    hideWorkoutDetail,
    persistWorkoutSession,
    resetHoldTimer,
    startRest,
    canLogSelectedDay,
  ])

  const logHoldTimerSet = useCallback(() => {
    if (!holdTimer.exerciseId || holdTimer.setIndex === null) return
    if (activeEntryType !== 'exercise' || activeEntryId !== holdTimer.exerciseId) return

    const exercise = getExercise(holdTimer.exerciseId)
    if (!exercise) return
    const stateList = setLogsRef.current[holdTimer.exerciseId]
    const setItem = stateList?.[holdTimer.setIndex]
    if (!setItem) return

    const elapsedSec = Math.max(0, holdTimer.totalSec - holdTimer.remainingSec)
    if (elapsedSec > 0) {
      setItem.metric = `${elapsedSec}s`
    }

    const timedSideCount = getTimedSideCount(exercise)
    const sideCount = Math.max(1, holdTimer.sideCount || timedSideCount)
    const sideIndex = Math.min(sideCount - 1, Math.max(0, holdTimer.sideIndex))
    if (sideCount > 1 && sideIndex < sideCount - 1) {
      startHoldTimer(holdTimer.exerciseId, holdTimer.setIndex, holdTimer.totalSec, sideTransitionPrepSec, {
        sideIndex: sideIndex + 1,
        sideCount,
      })
      return
    }

    stopHoldTimer()
    logNextSet()
  }, [activeEntryId, activeEntryType, getExercise, holdTimer, logNextSet, startHoldTimer, stopHoldTimer])

  const addNewSet = useCallback(() => {
    if (!canEditPlanSelectedDay) return
    if (activeEntryType !== 'exercise' || !activeEntryId) return
    const exercise = getExercise(activeEntryId)
    if (!exercise) return

    const lastSet = [...exercise.sets].reverse().find((set) => !set.isWarmup) ?? exercise.sets[exercise.sets.length - 1]
    const isTime = exercise.metric === 'time'
    const newSet = {
      targetReps: isTime ? undefined : (lastSet?.targetReps ?? '10'),
      targetTime: isTime ? (lastSet?.targetTime ?? '60s') : undefined,
      targetWeight: lastSet?.targetWeight ?? '',
    }

    exercise.sets.push(newSet)
    if (!setLogsRef.current[exercise.id]) {
      setLogsRef.current[exercise.id] = []
    }
    setLogsRef.current[exercise.id].push({ weight: '', metric: '', done: false })
    updateExerciseSummary(exercise)
    bumpData()
    void persistWorkoutSession(true)
  }, [activeEntryId, activeEntryType, bumpData, canEditPlanSelectedDay, getExercise, persistWorkoutSession])

  const deleteSetAtIndex = useCallback((exerciseId: string, index: number) => {
    const exercise = getExercise(exerciseId)
    if (!exercise) return
    const stateList = setLogsRef.current[exercise.id]
    if (!stateList?.length) return
    const baseSetCount = baseSetCountsRef.current[exercise.id] ?? exercise.sets.length
    const setItem = stateList[index]
    let planMutation = false

    if (index >= baseSetCount) {
      if (!canEditPlanSelectedDay) return
      exercise.sets.splice(index, 1)
      stateList.splice(index, 1)
      planMutation = true
    } else {
      if (setItem?.done) {
        if (!canLogSelectedDay && !canEditPlanSelectedDay) return
        stateList[index].done = false
        stateList[index].weight = ''
        stateList[index].metric = ''
        delete stateList[index].value_source
      } else {
        if (!canEditPlanSelectedDay) return
        exercise.sets.splice(index, 1)
        stateList.splice(index, 1)
        baseSetCountsRef.current[exercise.id] = Math.max(0, baseSetCount - 1)
        planMutation = true
      }
    }

    setEditingSet(null)
    setEditingSetSnapshot(null)
    resetHoldTimer()
    stopRest()
    updateExerciseSummary(exercise)
    bumpData()
    void persistWorkoutSession(planMutation)
  }, [bumpData, canEditPlanSelectedDay, canLogSelectedDay, getExercise, persistWorkoutSession, resetHoldTimer, stopRest])

  const removePlanEntriesFromSelectedDay = useCallback((options: {
    shouldRemoveExercise?: (exercise: WorkoutExercise) => boolean
    shouldRemoveExtra?: (extra: WorkoutExtra) => boolean
  }) => {
    if (!canEditPlanSelectedDay) return
    const dayIndex = selectedDayIndexRef.current
    const day = weekPlan.days[dayIndex] ?? weekPlan.days[0]
    if (!day) return

    const removedExercises = day.exercises.filter((exercise) => (
      options.shouldRemoveExercise?.(exercise) ?? false
    ))
    const removedExtras = day.extras.filter((extra) => (
      options.shouldRemoveExtra?.(extra) ?? false
    ))
    if (removedExercises.length === 0 && removedExtras.length === 0) return

    const removedExerciseIds = new Set(removedExercises.map((exercise) => exercise.id))
    const removedExtraIds = new Set(removedExtras.map((extra) => extra.id))
    const nextExercises = normalizeCircuitsAfterExerciseRemoval(
      day.exercises.filter((exercise) => !removedExerciseIds.has(exercise.id)),
      removedExercises,
    )
    const nextExtras = day.extras.filter((extra) => !removedExtraIds.has(extra.id))
    const nextDay: WeekPlanDay = {
      ...day,
      exercises: nextExercises,
      extras: nextExtras,
      isRest: nextExercises.length === 0 && nextExtras.length === 0,
      autoFillSuppressedAt: nextExercises.length === 0 && nextExtras.length === 0
        ? new Date().toISOString()
        : undefined,
    }
    const nextDays = weekPlan.days.map((item, index) => (index === dayIndex ? nextDay : item))
    const nextPlan: WeekPlan = { ...weekPlan, days: nextDays }

    const previousLogs = weekSetLogsRef.current[day.date]
    const previousBaseCounts = weekBaseCountsRef.current[day.date]
    const { logs } = buildSetLogsForExercises(nextExercises, previousLogs)
    const baseCounts: Record<string, number> = {}
    nextExercises.forEach((exercise) => {
      baseCounts[exercise.id] = previousBaseCounts?.[exercise.id] ?? exercise.sets.length
    })

    weekSetLogsRef.current[day.date] = logs
    weekBaseCountsRef.current[day.date] = baseCounts
    setLogsRef.current = logs
    baseSetCountsRef.current = baseCounts

    workoutExercisesRef.current = nextExercises
    workoutExtrasRef.current = nextExtras

    const activeEntryWasRemoved = activeEntryType === 'exercise'
      ? Boolean(activeEntryId && removedExerciseIds.has(activeEntryId))
      : Boolean(activeEntryId && removedExtraIds.has(activeEntryId))

    if (activeEntryWasRemoved) {
      hideWorkoutDetail()
    }

    setWeekPlan(nextPlan)
    syncDayRefs(nextPlan, dayIndex)
    bumpData()
    void persistWorkoutSessionForDay({
      dateId: day.date,
      sessionId: day.date,
      label: nextDay.label,
      exercises: nextExercises,
      extras: nextExtras,
      setLogs: logs,
      dayOverride: nextDay,
      planMutation: true,
    })
  }, [activeEntryId, activeEntryType, bumpData, canEditPlanSelectedDay, hideWorkoutDetail, persistWorkoutSessionForDay, syncDayRefs, weekPlan])

  const removeExerciseFromPlan = useCallback((exerciseId: string) => {
    removePlanEntriesFromSelectedDay({
      shouldRemoveExercise: (exercise) => exercise.id === exerciseId,
    })
  }, [removePlanEntriesFromSelectedDay])

  const removeExtraFromPlan = useCallback((extraId: string) => {
    removePlanEntriesFromSelectedDay({
      shouldRemoveExtra: (extra) => extra.id === extraId,
    })
  }, [removePlanEntriesFromSelectedDay])

  const removeCircuitFromPlan = useCallback((circuitName: string) => {
    removePlanEntriesFromSelectedDay({
      shouldRemoveExercise: (exercise) => exercise.circuit?.name === circuitName,
    })
  }, [removePlanEntriesFromSelectedDay])

  const removeSectionFromPlan = useCallback((sectionLabel: string) => {
    const sectionKey = normalizeDayLabel(sectionLabel)
    removePlanEntriesFromSelectedDay({
      shouldRemoveExercise: (exercise) => normalizeDayLabel(exercise.section) === sectionKey,
      shouldRemoveExtra: (extra) => normalizeDayLabel(extra.section) === sectionKey,
    })
  }, [removePlanEntriesFromSelectedDay])

  const updateSetField = useCallback(
    (exerciseId: string, index: number, field: 'weight' | 'metric', value: string, propagate: boolean) => {
      if (!canLogSelectedDay) return
      const exercise = getExercise(exerciseId)
      if (!exercise) return
      const stateList = ensureExerciseStateList(exercise)
      const setItem = stateList[index]
      if (!setItem) return

      if (field === 'weight') {
        setItem.weight = value
        setItem.value_source = value.trim() ? 'user_entered' : undefined
        if (propagate) {
          for (let i = index; i < stateList.length; i++) {
            if (stateList[i]?.done) continue
            stateList[i].weight = value
            stateList[i].value_source = value.trim() ? 'user_entered' : undefined
            const targetSet = exercise.sets[i]
            if (canEditPlanSelectedDay && targetSet) targetSet.targetWeight = value
          }
        }
      } else {
        setItem.metric = value
        if (propagate) {
          for (let i = index; i < stateList.length; i++) {
            if (stateList[i]?.done) continue
            stateList[i].metric = value
            const targetSet = exercise.sets[i]
            if (!targetSet) continue
            if (canEditPlanSelectedDay) {
              if (exercise.metric === 'time') {
                targetSet.targetTime = value
              } else {
                targetSet.targetReps = value
              }
            }
          }
        }
      }

      if (propagate && canEditPlanSelectedDay) updateExerciseSummary(exercise)
      bumpData()
      scheduleWorkoutSave(propagate && canEditPlanSelectedDay)
    },
    [bumpData, canEditPlanSelectedDay, canLogSelectedDay, ensureExerciseStateList, getExercise, scheduleWorkoutSave]
  )


  const addMessage = useCallback(async (message: string, variant: 'user' | 'ai') => {
    const timestamp = Date.now()
    const id = `${timestamp}-${Math.random()}`
    if (variant === 'ai') {
      const html = await marked.parse(message)
      setMessages((prev) => ([
        ...prev,
        { id, variant, text: message, html, timestamp },
      ]))
    } else {
      setMessages((prev) => ([
        ...prev,
        { id, variant, text: message, timestamp },
      ]))
    }
    return id
  }, [])

  const updateCoachMessages = useCallback((scopeId: string, updater: (items: ChatMessage[]) => ChatMessage[]) => {
    setCoachMessagesByScope((prev) => {
      const existing = prev[scopeId] ?? []
      const next = updater(existing)
      if (next === existing) return prev
      return { ...prev, [scopeId]: next }
    })
  }, [])

  const addCoachMessage = useCallback(async (
    scopeId: string,
    message: string,
    variant: 'user' | 'ai',
    quickActions?: QuickActionOption[],
  ) => {
    const timestamp = Date.now()
    const html = variant === 'ai' ? await marked.parse(message) : undefined
    const entry: ChatMessage = {
      id: `${timestamp}-${Math.random()}`,
      variant,
      text: message,
      html,
      timestamp,
      quickActions,
    }
    updateCoachMessages(scopeId, (items) => ([
      ...items,
      entry,
    ]))
    return entry.id
  }, [updateCoachMessages])

  const addCoachThinkingMessage = useCallback((scopeId: string, modelLabel?: string) => {
    const timestamp = Date.now()
    const id = `${timestamp}-${Math.random()}`
    updateCoachMessages(scopeId, (items) => ([
      ...items,
      { id, variant: 'ai', text: '', thinking: true, timestamp, modelLabel },
    ]))
    return id
  }, [updateCoachMessages])

  const updateCoachMessage = useCallback(async (scopeId: string, id: string, content: string, modelLabel?: string) => {
    const completedAt = Date.now()
    const html = await marked.parse(content)
    updateCoachMessages(scopeId, (items) => items.map((message) => (
      message.id === id
        ? {
            ...message,
            thinking: false,
            text: content,
            html,
            timestamp: completedAt,
            modelLabel: modelLabel ?? message.modelLabel,
            replyElapsedSeconds: Math.max(
              1,
              Math.ceil((completedAt - (message.timestamp ?? completedAt)) / 1000),
            ),
          }
        : message
    )))
  }, [updateCoachMessages])

  const removeCoachMessage = useCallback((scopeId: string, id: string) => {
    updateCoachMessages(scopeId, (items) => items.filter((message) => message.id !== id))
  }, [updateCoachMessages])

  const getCoachScopeId = useCallback((exerciseId: string) => {
    const sessionId = currentWorkoutSessionIdRef.current || getWorkoutSessionId()
    return `coach:${sessionId}:${exerciseId}`
  }, [])

  const applyActiveNotesPatch = useCallback((patch: ActiveNotesPatch) => {
    if (patch.upsert.length === 0 && patch.deleteKeys.length === 0 && patch.deleteTexts.length === 0) {
      return false
    }

    markLocalEdit()
    const updatedAt = new Date().toISOString()
    setProfile((prev) => {
      const nextByKey = new Map<string, ActiveNote>()
      normalizeActiveNotes(prev.activeNotes).forEach((note) => {
        nextByKey.set(note.key, note)
      })

      patch.deleteKeys.forEach((key) => {
        nextByKey.delete(normalizeActiveNoteKey(key))
      })
      if (patch.deleteTexts.length > 0) {
        const deleteTexts = new Set(patch.deleteTexts)
        Array.from(nextByKey.entries()).forEach(([key, note]) => {
          if (deleteTexts.has(note.text.toLowerCase())) {
            nextByKey.delete(key)
          }
        })
      }

      patch.upsert.forEach((note) => {
        const key = normalizeActiveNoteKey(note.key, note.text)
        nextByKey.set(key, {
          key,
          text: note.text,
          updatedAt,
        })
      })

      return {
        ...prev,
        activeNotes: Array.from(nextByKey.values()).slice(-12),
      }
    })
    return true
  }, [markLocalEdit])

  const applyActiveNotesPatchPayload = useCallback((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const patchRecord = value as Record<string, unknown>
    const rawUpsert = Array.isArray(patchRecord.upsert) ? patchRecord.upsert : []
    const upsert = rawUpsert.flatMap((item) => {
      const record = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null
      const text = normalizeActiveNoteText(record ? (record.text ?? record.note ?? record.value) : item)
      if (!text) return []
      return [{
        key: normalizeActiveNoteKey(record ? (record.key ?? record.id ?? record.topic) : undefined, text),
        text,
      }]
    })

    const rawDelete = patchRecord.delete ?? patchRecord.delete_keys ?? patchRecord.deleteKeys ?? []
    const deleteItems = Array.isArray(rawDelete) ? rawDelete : [rawDelete]
    const deleteKeys: string[] = []
    const deleteTexts: string[] = []
    deleteItems.forEach((item) => {
      if (typeof item !== 'string') return
      const text = normalizeActiveNoteText(item)
      if (!text) return
      deleteKeys.push(normalizeActiveNoteKey(text))
      deleteTexts.push(text.toLowerCase())
    })

    if (upsert.length === 0 && deleteKeys.length === 0 && deleteTexts.length === 0) return false
    return applyActiveNotesPatch({ upsert, deleteKeys, deleteTexts })
  }, [applyActiveNotesPatch])

  const applyAgentProfileUpdatePayload = useCallback((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    setProfile((prev) => ({
      ...prev,
      text: normalizeProfileText(record.text),
      weeklyPlan: normalizeWeeklyPlanText(record.weekly_plan ?? record.weeklyPlan),
      activeNotes: normalizeActiveNotes(record.active_notes ?? record.activeNotes),
    }))
    return true
  }, [])

  const handleCoachReply = useCallback(async (
    reply: string,
    scopeId: string,
    _exerciseId: string,
    messageId?: string | null,
    modelLabel?: string,
  ) => {
    const displayMessage = reply.trim()

    if (messageId) {
      if (displayMessage) {
        await updateCoachMessage(scopeId, messageId, displayMessage, modelLabel)
      } else {
        removeCoachMessage(scopeId, messageId)
      }
      return
    }

    if (displayMessage) {
      addCoachMessage(scopeId, displayMessage, 'ai')
    }
  }, [
    addCoachMessage,
    removeCoachMessage,
    updateCoachMessage,
  ])

  const addThinkingMessage = useCallback((modelLabel?: string) => {
    const timestamp = Date.now()
    const id = `${timestamp}-${Math.random()}`
    setMessages((prev) => ([
      ...prev,
      { id, variant: 'ai', text: '', thinking: true, timestamp, modelLabel },
    ]))
    return id
  }, [])

  const updateMessage = useCallback(async (id: string, content: string, modelLabel?: string) => {
    const completedAt = Date.now()
    const html = await marked.parse(content)
    setMessages((prev) => prev.map((message) => (
      message.id === id
        ? {
            ...message,
            thinking: false,
            text: content,
            html,
            timestamp: completedAt,
            modelLabel: modelLabel ?? message.modelLabel,
            replyElapsedSeconds: Math.max(
              1,
              Math.ceil((completedAt - (message.timestamp ?? completedAt)) / 1000),
            ),
          }
        : message
    )))
  }, [])

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== id))
  }, [])

  const getPrivyAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    if (!privyReady || !privyAuthenticated) {
      privyAccessTokenRef.current = null
      return {}
    }
    const cached = privyAccessTokenRef.current
    if (cached && cached.expiresAtMs > Date.now() + 60_000) {
      if (cached.sub && cached.sub !== privySubjectId) {
        setPrivySubjectId(cached.sub)
      }
      return { Authorization: `Bearer ${cached.token}` }
    }
    try {
      const token = await getPrivyAccessToken()
      if (token) {
        const { sub, exp } = decodePrivyJwt(token)
        if (sub) {
          setPrivySubjectId(sub)
        }
        privyAccessTokenRef.current = {
          token,
          expiresAtMs: exp ? exp * 1000 : Date.now(),
          sub,
        }
      }
      return token ? { Authorization: `Bearer ${token}` } : {}
    } catch (error) {
      console.warn('Failed to fetch Privy access token:', error)
      return {}
    }
  }, [getPrivyAccessToken, privyAuthenticated, privyReady, privySubjectId])

  const fetchBackendChatHistory = useCallback(async (userId: string) => {
    if (!isBackendHealthy || !userId) return
    const headers = await getPrivyAuthHeaders()
    const params = new URLSearchParams({
      user_id: userId,
      limit: String(MAIN_CHAT_HISTORY_LIMIT),
    })
    const response = await apiFetch(`${API_BASE_URL}/chat/history?${params.toString()}`, { headers })
    if (response.status === 404 || response.status === 405) return
    if (!response.ok) throw new Error(`Failed to load chat history (${response.status})`)
    await mergeBackendChatHistory(await response.json() as ChatHistoryPayloadItem[])
  }, [getPrivyAuthHeaders, isBackendHealthy, mergeBackendChatHistory])

  const refreshModelControl = useCallback(async () => {
    if (!privyReady || !privyAuthenticated) {
      setModelControl(null)
      return
    }
    const response = await apiFetch(`${API_BASE_URL}/chat/models`, {
      headers: await getPrivyAuthHeaders(),
    })
    if (!response.ok) throw new Error(`Failed to load Ez models (${response.status})`)
    setModelControl(await response.json() as ModelControl)
  }, [getPrivyAuthHeaders, privyAuthenticated, privyReady])

  const handleModelSelection = useCallback(async (value: string) => {
    const option = modelOptions.find((item) => item.value === value)
    if (!option || !modelControl || modelSelectionPending) return
    setModelSelectionPending(true)
    try {
      const response = await apiFetch(`${API_BASE_URL}/chat/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() },
        body: JSON.stringify({
          expected_session: modelControl.active_session_id,
          cli: option.cli,
          provider: option.provider,
          model: option.model,
          effort: option.effort,
        }),
      })
      if (!response.ok) throw new Error(`Failed to select Ez model (${response.status})`)
      setModelControl(await response.json() as ModelControl)
      setMessages([])
      setChatInput('')
    } catch (error) {
      console.error('Ez model selection failed:', error)
      await refreshModelControl().catch(() => undefined)
    } finally {
      setModelSelectionPending(false)
    }
  }, [getPrivyAuthHeaders, modelControl, modelOptions, modelSelectionPending, refreshModelControl])

  const setCoachActAs = useCallback((ownerId: string | null) => {
    void ownerId
    setMessages([])
    setCoachMessagesByScope({})
    setChatInput('')
    setCoachActAsOwnerId(null)
    setCoachActionMessage('Coach collaboration is not available in the public release.')
  }, [])

  const handleCoachInvite = useCallback(async (permissions: CoachPermissions) => {
    void permissions
    setCoachActionMessage('Coach collaboration is not available in the public release.')
  }, [])

  const handleCoachAcceptInvite = useCallback(async (token: string) => {
    void token
    setCoachActionMessage('Coach collaboration is not available in the public release.')
  }, [])

  const handleCoachRevoke = useCallback(async (linkId: string) => {
    void linkId
    setCoachActionMessage('Coach collaboration is not available in the public release.')
  }, [])

  const handleCoachUpdatePermissions = useCallback(async (
    linkId: string,
    permissions: CoachPermissions,
  ) => {
    void linkId
    void permissions
    setCoachActionMessage('Coach collaboration is not available in the public release.')
  }, [])

  const updateExerciseNotes = useCallback((exerciseId: string, value: string) => {
    if (!canEditPlanSelectedDay) return
    const exercise = getExercise(exerciseId)
    if (!exercise) return
    exercise.notes = value
    bumpData()
    scheduleWorkoutSave(true)
  }, [bumpData, canEditPlanSelectedDay, getExercise, scheduleWorkoutSave])

  const updateDayNotes = useCallback((value: string) => {
    if (!canEditPlanSelectedDay) return
    const targetDate = selectedDay?.date ?? todayId
    if (selectedDay) {
      selectedDay.notes = value
    }
    setWeekPlan((prev) => ({
      ...prev,
      days: prev.days.map((day) => (
        day.date === targetDate
          ? { ...day, notes: value }
          : day
      )),
    }))
    bumpData()
    scheduleWorkoutSave()
  }, [bumpData, canEditPlanSelectedDay, scheduleWorkoutSave, selectedDay, selectedDay?.date, todayId])

  const handleClearWorkoutDay = useCallback(() => {
    if (!canEditPlanSelectedDay) return
    const dayIndex = selectedDayIndexRef.current
    const day = weekPlan.days[dayIndex] ?? selectedDay
    const targetDate = day?.date ?? selectedDay?.date ?? todayId
    const logsForDay = weekSetLogsRef.current[targetDate] ?? setLogsRef.current
    const loggedExerciseEntries = (day?.exercises ?? [])
      .map((exercise) => ({
        exercise,
        doneSetIndexes: getDoneSetIndexes(exercise, logsForDay),
      }))
      .filter((entry) => entry.doneSetIndexes.length > 0)
    const hasLoggedExercises = loggedExerciseEntries.length > 0
    const unloggedSetCount = loggedExerciseEntries.reduce((count, entry) => (
      count + Math.max(0, entry.exercise.sets.length - entry.doneSetIndexes.length)
    ), 0)
    const unloggedItemCount = hasLoggedExercises
      ? ((day?.exercises.length ?? 0) - loggedExerciseEntries.length) + unloggedSetCount + (day?.extras.length ?? 0)
      : 0
    if (hasLoggedExercises && unloggedItemCount <= 0) return

    const confirmLabel = hasLoggedExercises
      ? t('workout.clearUnloggedConfirm', { label: selectedDayLabel })
      : t('workout.clearConfirm', { label: selectedDayLabel })
    if (!window.confirm(confirmLabel)) return

    const nextExtras: WorkoutExtra[] = []
    const nextLogs: Record<string, SetState[]> = {}
    const nextBaseCounts: Record<string, number> = {}
    const nextExercises = hasLoggedExercises
      ? loggedExerciseEntries.map(({ exercise, doneSetIndexes }) => {
        const states = logsForDay[exercise.id] ?? []
        const nextExercise: WorkoutExercise = {
          ...exercise,
          sets: doneSetIndexes.map((setIndex) => ({ ...exercise.sets[setIndex] })),
        }
        nextLogs[exercise.id] = doneSetIndexes.map((setIndex) => ({
          weight: states[setIndex]?.weight ?? '',
          metric: states[setIndex]?.metric ?? '',
          done: true,
        }))
        nextBaseCounts[exercise.id] = nextExercise.sets.length
        updateExerciseSummary(nextExercise)
        return nextExercise
      })
      : []
    const clearTimestamp = new Date().toISOString()
    const nextDay: WeekPlanDay = {
      ...(day ?? {
        date: targetDate,
        label: selectedDayLabel,
        exercises: [],
        extras: [],
      }),
      exercises: nextExercises,
      extras: nextExtras,
      isRest: nextExercises.length === 0,
      autoFillSuppressedAt: hasLoggedExercises ? undefined : clearTimestamp,
      planNotes: '',
      notes: hasLoggedExercises ? (day?.notes ?? '') : '',
    }
    const nextPlan: WeekPlan = {
      ...weekPlan,
      days: weekPlan.days.map((item) => (
        item.date === targetDate ? nextDay : item
      )),
    }

    weekSetLogsRef.current[targetDate] = nextLogs
    weekBaseCountsRef.current[targetDate] = nextBaseCounts
    workoutExercisesRef.current = nextExercises
    workoutExtrasRef.current = nextExtras
    setLogsRef.current = nextLogs
    baseSetCountsRef.current = nextBaseCounts
    if (
      !hasLoggedExercises
      || activeEntryType === 'extra'
      || (activeEntryType === 'exercise' && activeEntryId && !nextExercises.some((exercise) => exercise.id === activeEntryId))
    ) {
      hideWorkoutDetail()
    }
    setWeekPlan(nextPlan)
    bumpData()
    void persistWorkoutSessionForDay({
      dateId: targetDate,
      sessionId: targetDate,
      label: nextDay.label,
      exercises: nextExercises,
      extras: nextExtras,
      setLogs: nextLogs,
      dayOverride: nextDay,
      planMutation: true,
    })
  }, [
    activeEntryId,
    activeEntryType,
    bumpData,
    canEditPlanSelectedDay,
    hideWorkoutDetail,
    persistWorkoutSessionForDay,
    selectedDay?.date,
    selectedDay,
    selectedDayLabel,
    t,
    todayId,
    weekPlan,
  ])

  const handleAiReply = useCallback(async (reply: string, messageId?: string | null, modelLabel?: string) => {
    const displayMessage = reply.trim()

    if (messageId) {
      if (displayMessage) {
        await updateMessage(messageId, displayMessage, modelLabel)
      } else {
        removeMessage(messageId)
      }
      return
    }

    if (displayMessage) {
      addMessage(displayMessage, 'ai')
    }
  }, [addMessage, removeMessage, updateMessage])

  const fetchChatJobResult = useCallback(async (payload: ChatRequestPayload): Promise<ChatResponsePayload> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(await getPrivyAuthHeaders()),
    }

    let enqueueResponse: Response | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        enqueueResponse = await apiFetch(`${API_BASE_URL}/chat/async`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
      } catch (error) {
        if (attempt === 0) continue
        throw error
      }
      if (enqueueResponse.status < 500 || attempt > 0) break
    }
    if (!enqueueResponse) throw new Error('Chat submission outcome is unknown')

    if (enqueueResponse.status === 404 || enqueueResponse.status === 405) {
      throw new Error('Async chat endpoint unavailable. Restart the backend so /chat/async is available.')
    }
    if (!enqueueResponse.ok) {
      throw new Error(`Chat enqueue failed (${enqueueResponse.status})`)
    }

    const queued = (await enqueueResponse.json()) as ChatJobResponsePayload
    const jobId = typeof queued.job_id === 'string' ? queued.job_id : ''
    if (!jobId) return queued
    if (queued.status === 'complete') return queued
    if (queued.status === 'failed') {
      throw new Error(typeof queued.error === 'string' ? queued.error : 'Chat job failed')
    }

    const params = new URLSearchParams({ user_id: payload.user_id })

    const startedAt = Date.now()
    let delayMs = CHAT_JOB_INITIAL_POLL_MS
    let pollFailures = 0
    while (Date.now() - startedAt < CHAT_JOB_MAX_WAIT_MS) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs))
      delayMs = CHAT_JOB_POLL_MS

      let pollResponse: Response
      try {
        // Chat jobs can outlive the short-lived Privy token used to enqueue
        // them. Do not reuse the initial headers or a completed reply becomes
        // invisible to the user when its final poll is rejected with 401.
        const pollHeaders = await getPrivyAuthHeaders()
        pollResponse = await apiFetch(
          `${API_BASE_URL}/chat/jobs/${encodeURIComponent(jobId)}?${params.toString()}`,
          { headers: pollHeaders }
        )
      } catch (error) {
        pollFailures += 1
        if (pollFailures <= CHAT_JOB_MAX_POLL_FAILURES) continue
        throw error
      }

      if (!pollResponse.ok) {
        pollFailures += 1
        if (pollFailures <= CHAT_JOB_MAX_POLL_FAILURES && pollResponse.status >= 500) continue
        throw new Error(`Chat job poll failed (${pollResponse.status})`)
      }

      pollFailures = 0
      const statusData = (await pollResponse.json()) as ChatJobResponsePayload
      if (statusData.status === 'complete') return statusData
      if (statusData.status === 'failed') {
        throw new Error(typeof statusData.error === 'string' ? statusData.error : 'Chat job failed')
      }
      if (statusData.status === 'cancelled') throw new Error('Chat request was cancelled')
    }

    throw new Error('Chat job timed out')
  }, [getPrivyAuthHeaders])

  const fetchWorkoutSessionsByDates = useCallback(async (dateIds: string[]): Promise<WorkoutSession[]> => {
    if (!currentUserId || !canQuerySavedWorkoutSessions || dateIds.length === 0) return []
    const sortedDates = [...dateIds].sort()
    const headers = await getPrivyAuthHeaders()

    const params = new URLSearchParams({
      start: sortedDates[0],
      end: sortedDates[sortedDates.length - 1],
    })
    const response = await apiFetch(`${API_BASE_URL}/v1/workouts?${params.toString()}`, { headers })
    if (!response.ok) {
      throw new Error(`Failed to load workout sessions (${response.status})`)
    }
    const requestedDates = new Set(dateIds)
    const workouts = await response.json() as Array<NonNullable<BackendWorkoutReceipt['workout']>>
    const sessions = workouts
      .filter((workout) => requestedDates.has(workout.date))
      .map((workout) => backendWorkoutToSession(workout, currentUserId))
    sessions.forEach((session) => {
      if (!session.revision) return
      const revisionKey = `${currentUserId}:${session.date}`
      workoutRevisionByOwnerDateRef.current[revisionKey] = session.revision
    })
    return sessions
  }, [
    canQuerySavedWorkoutSessions,
    currentUserId,
    getPrivyAuthHeaders,
    privyAuthenticated,
    privyReady,
  ])

  const handleRequestExerciseHistory = useCallback(async (exercise: WorkoutExercise) => {
    void exercise
    setExerciseHistory(null)
    setExerciseHistoryLoading(false)
    setExerciseHistoryError('Exercise history is not available until the canonical exercise projection is connected.')
  }, [
  ])

  const applySavedWorkoutSessionsToWeek = useCallback((
    sessions: WorkoutSession[],
    options: { preserveSelectedDate?: boolean, preserveActiveEntry?: boolean } = {},
  ) => {
    if (sessions.length === 0) return false

    let nextDays = weekPlan.days
    const nextLogs: WeekSetLogs = { ...weekSetLogsRef.current }
    const nextBaseCounts: WeekBaseCounts = { ...weekBaseCountsRef.current }
    const appliedDates: string[] = []
    const ownerId = coachActAsOwnerId ?? currentUserId

    sessions.forEach((session) => {
      const targetDate = normalizeDateId(session.date) ?? normalizeDateId(session.session_id)
      if (!targetDate || pendingWorkoutDatesRef.current.has(targetDate)) return
      const exercises = normalizeWorkoutExercises(session.workout?.exercises)
      const extras = normalizeWorkoutExtras(session.workout?.extras)
      exercises.forEach((exercise) => {
        if (!exercise.summary) updateExerciseSummary(exercise)
      })

      const existingDayIndex = findDayIndexByDate(nextDays, targetDate)
      const existingDay = existingDayIndex >= 0 ? nextDays[existingDayIndex] : null
      if (!canHydrateSavedWorkoutAfterClear(existingDay, session.updated_at)) return
      const parsedDate = parseDateId(targetDate)
      const label = parsedDate
        ? getWeekdayLabel(parsedDate, profile.language)
        : (session.label || existingDay?.label || targetDate)
      const notes = typeof session.notes === 'string' ? session.notes : ''
      const savedHasContent = hasWorkoutContent(exercises, extras)
      const nextDay: WeekPlanDay = {
        ...(existingDay ?? {
          date: targetDate,
          label,
          exercises: [],
          extras: [],
          isRest: true,
          planNotes: '',
          notes: '',
        }),
        date: targetDate,
        label,
        exercises,
        extras,
        isRest: exercises.length === 0 && extras.length === 0,
        autoFillSuppressedAt: savedHasContent
          ? undefined
          : (session.auto_fill_suppressed_at || session.updated_at),
        planNotes: notes || existingDay?.planNotes || '',
        notes: existingDay?.notes ?? '',
      }
      nextDays = existingDayIndex >= 0
        ? nextDays.map((day, index) => (index === existingDayIndex ? nextDay : day))
        : [...nextDays, nextDay].sort((a, b) => a.date.localeCompare(b.date))

      const storedLogs = session.workout?.set_logs ?? {}
      const { logs, baseCounts } = buildSetLogsForExercises(exercises, storedLogs)
      nextLogs[targetDate] = logs
      nextBaseCounts[targetDate] = baseCounts
      if (session.revision) {
        workoutRevisionByOwnerDateRef.current[`${ownerId}:${targetDate}`] = session.revision
      }
      appliedDates.push(targetDate)
    })

    if (appliedDates.length === 0) return false
    exerciseHistoryCacheRef.current.clear()
    const selectedDate = options.preserveSelectedDate
      ? (selectedDay?.date ?? todayId)
      : appliedDates[appliedDates.length - 1]
    const previousHydrationState = sessionHydrationInProgressRef.current
    sessionHydrationInProgressRef.current = true
    try {
      applyWeekPlan(
        {
          weekStart: weekPlan.weekStart || appliedDates[0],
          days: nextDays,
        },
        {
          selectedDate,
          logsByDay: nextLogs,
          baseCountsByDay: nextBaseCounts,
          preferToday: selectedDate === todayId,
          preserveActiveEntry: options.preserveActiveEntry,
        }
      )
    } finally {
      sessionHydrationInProgressRef.current = previousHydrationState
    }
    return true
  }, [
    applyWeekPlan,
    coachActAsOwnerId,
    currentUserId,
    profile.language,
    selectedDay?.date,
    todayId,
    weekPlan,
  ])

  const applySavedWorkoutSessionToWeek = useCallback((session: WorkoutSession) => (
    applySavedWorkoutSessionsToWeek([session])
  ), [applySavedWorkoutSessionsToWeek])

  const handleCopyLastWeek = async () => {
    if (!canEditPlanSelectedDay || copyingLastWeekRef.current) return
    window.alert('Copying a workout is not available in the public canonical API yet.')
  }

  useEffect(() => {
    if (!currentUserId) return
    if (!canQuerySavedWorkoutSessions) return
    if (!isBackendHealthy) return
    if (sessionLoading || !sessionReadyRef.current) return

    const actAsKey = coachActAsOwnerId ? `:act-as:${coachActAsOwnerId}` : ''
    const sessionKey = `auth:${currentUserId}${actAsKey}:sub=${privySubjectId ?? ''}:uid=${pendingPrivyUserId ?? ''}:online=${isBackendHealthy ? '1' : '0'}`
    if (serverSessionLoadSettledKey !== sessionKey) return

    const visibleDates = buildWorkoutStripDates(todayId, weekStartDayIndex)
      .map((date) => getDateId(date))
    if (visibleDates.length === 0) return

    const key = `${sessionKey}:${visibleDates.join(',')}`
    if (savedWorkoutHydrationAttemptedKeysRef.current.has(key)) return
    if (savedWorkoutHydrationInFlightKeyRef.current === key) return

    let cancelled = false
    savedWorkoutHydrationInFlightKeyRef.current = key

    fetchWorkoutSessionsByDates(visibleDates)
      .then((sessions) => {
        if (cancelled || savedWorkoutHydrationInFlightKeyRef.current !== key) return
        savedWorkoutHydrationAttemptedKeysRef.current.add(key)

        let nextDays = weekPlan.days
        const nextLogs: WeekSetLogs = { ...weekSetLogsRef.current }
        const nextBaseCounts: WeekBaseCounts = { ...weekBaseCountsRef.current }
        let changed = false

        sessions.forEach((session) => {
          const targetDate = normalizeDateId(session.date) ?? normalizeDateId(session.session_id)
          if (!targetDate) return
          if (pendingWorkoutDatesRef.current.has(targetDate)) return
          const savedExercises = normalizeWorkoutExercises(session.workout?.exercises)
          const savedExtras = normalizeWorkoutExtras(session.workout?.extras)
          const savedLogs = session.workout?.set_logs ?? {}
          const savedHasContent = hasWorkoutContent(savedExercises, savedExtras)

          const existingDayIndex = findDayIndexByDate(nextDays, targetDate)
          const existingDay = existingDayIndex >= 0 ? nextDays[existingDayIndex] : null
          if (!canHydrateSavedWorkoutAfterClear(existingDay, session.updated_at)) return
          const currentDoneSets = countDoneSetsForExercises(existingDay?.exercises ?? [], nextLogs[targetDate])
          const savedDoneSets = countDoneSetsForExercises(savedExercises, savedLogs)
          const existingHasContent = hasWorkoutContent(existingDay?.exercises, existingDay?.extras)
          const isPastOrToday = targetDate <= todayId
          const shouldApplySavedDay = isPastOrToday
            || savedDoneSets > currentDoneSets
            || (!existingHasContent && targetDate >= todayId)
          if (!shouldApplySavedDay) return

          savedExercises.forEach((exercise) => {
            if (!exercise.summary) updateExerciseSummary(exercise)
          })

          const parsedDate = parseDateId(targetDate)
          const label = parsedDate
            ? getWeekdayLabel(parsedDate, profile.language)
            : (session.label || existingDay?.label || targetDate)
          const notes = typeof session.notes === 'string' ? session.notes : ''
          const nextDay: WeekPlanDay = {
            ...(existingDay ?? {
              date: targetDate,
              label,
              exercises: [],
              extras: [],
              isRest: true,
              planNotes: '',
              notes: '',
            }),
            date: targetDate,
            label,
            exercises: savedExercises,
            extras: savedExtras,
            isRest: savedExercises.length === 0 && savedExtras.length === 0,
            autoFillSuppressedAt: savedHasContent
              ? undefined
              : (session.auto_fill_suppressed_at || session.updated_at),
            planNotes: notes || existingDay?.planNotes || '',
            notes: existingDay?.notes ?? '',
          }
          nextDays = existingDayIndex >= 0
            ? nextDays.map((day, index) => (index === existingDayIndex ? nextDay : day))
            : [...nextDays, nextDay].sort((a, b) => a.date.localeCompare(b.date))

          const { logs, baseCounts } = buildSetLogsForExercises(savedExercises, savedLogs)
          nextLogs[targetDate] = logs
          nextBaseCounts[targetDate] = baseCounts
          changed = true
        })

        if (!changed) return

        const previousHydrationState = sessionHydrationInProgressRef.current
        sessionHydrationInProgressRef.current = true
        try {
          applyWeekPlan(
            {
              weekStart: weekPlan.weekStart || nextDays[0]?.date || todayId,
              days: nextDays,
            },
            {
              selectedDate: selectedDay?.date ?? todayId,
              logsByDay: nextLogs,
              baseCountsByDay: nextBaseCounts,
              preserveActiveEntry: true,
            }
          )
        } finally {
          sessionHydrationInProgressRef.current = previousHydrationState
        }
      })
      .catch((error) => {
        console.warn('Saved workout hydration failed:', error)
      })
      .finally(() => {
        if (savedWorkoutHydrationInFlightKeyRef.current === key) {
          savedWorkoutHydrationInFlightKeyRef.current = null
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    applyWeekPlan,
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    currentUserId,
    fetchWorkoutSessionsByDates,
    isBackendHealthy,
    pendingPrivyUserId,
    privyAuthenticated,
    privySubjectId,
    profile.language,
    selectedDay?.date,
    serverSessionLoadSettledKey,
    sessionLoading,
    todayId,
    weekPlan.days,
    weekPlan.weekStart,
    weekStartDayIndex,
  ])

  const applyChatWorkoutUpdates = useCallback(async (value: unknown) => {
    const values = Array.isArray(value) ? value : [value]
    const sessions: WorkoutSession[] = []
    const fallbackDates: string[] = []

    values.forEach((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return
      const update = candidate as Record<string, unknown>
      const saved = update.saved_session
      if (
        saved
        && typeof saved === 'object'
        && !Array.isArray(saved)
        && typeof (saved as Record<string, unknown>).date === 'string'
        && typeof (saved as Record<string, unknown>).updated_at === 'string'
        && (saved as Record<string, unknown>).workout
      ) {
        sessions.push(saved as WorkoutSession)
        return
      }

      const targetDate = typeof update.target_date === 'string'
        ? normalizeDateId(update.target_date)
        : null
      if (targetDate) fallbackDates.push(targetDate)
    })

    if (fallbackDates.length > 0) {
      sessions.push(...await fetchWorkoutSessionsByDates(fallbackDates))
    }
    return applySavedWorkoutSessionsToWeek(sessions, {
      preserveSelectedDate: true,
      preserveActiveEntry: true,
    })
  }, [
    applySavedWorkoutSessionsToWeek,
    fetchWorkoutSessionsByDates,
  ])

  const refreshVisibleWorkoutSessions = useCallback(async () => {
    if (!canQuerySavedWorkoutSessions) return false
    const visibleDates = buildWorkoutStripDates(todayId, weekStartDayIndex)
      .map((date) => getDateId(date))
    const sessions = await fetchWorkoutSessionsByDates(visibleDates)
    await applySavedWorkoutSessionsToWeek(sessions, {
      preserveSelectedDate: true,
      preserveActiveEntry: true,
    })
    return true
  }, [
    applySavedWorkoutSessionsToWeek,
    canQuerySavedWorkoutSessions,
    fetchWorkoutSessionsByDates,
    todayId,
    weekStartDayIndex,
  ])

  const handleRefreshSession = useCallback(async () => {
    if (!currentUserId || !canQuerySavedWorkoutSessions) return false
    try {
      await Promise.all([
        fetchBackendChatHistory(currentUserId),
        refreshVisibleWorkoutSessions(),
      ])
      return true
    } catch (error) {
      console.warn('Canonical refresh failed:', error)
      return false
    }
  }, [canQuerySavedWorkoutSessions, currentUserId, fetchBackendChatHistory, refreshVisibleWorkoutSessions])

  const fetchChatReply = useCallback(async (
    payload: ChatRequestPayload,
    messageId?: string | null,
  ) => {
    let data: ChatResponsePayload
    try {
      data = await fetchChatJobResult(payload)
    } catch (error) {
      if (messageId) removeMessage(messageId)
      throw error
    }
    if (!data) {
      if (messageId) removeMessage(messageId)
      throw new Error('Empty chat response')
    }

    applyAgentProfileUpdatePayload(data?.profile_update)
    applyActiveNotesPatchPayload(data?.active_notes_patch)
    const reply = typeof data?.reply === 'string' ? data.reply : String(data?.reply ?? '')
    await handleAiReply(reply, messageId, presetLabel(data.preset, modelControl?.models))
    const workoutUpdates = Array.isArray(data?.workout_updates)
      ? data.workout_updates
      : []
    if (workoutUpdates.length > 0) {
      await applyChatWorkoutUpdates(workoutUpdates)
    } else if (data?.workout_update) {
      await applyChatWorkoutUpdates(data.workout_update)
    } else {
      // A completed chat reply is authoritative. Workout APIs arrive in a later
      // migration stage, so their absence must not replace a valid reply with a
      // misleading "backend unreachable" message.
      try {
        await refreshVisibleWorkoutSessions()
      } catch {
        // The next supported workout refresh will reconcile this view.
      }
    }
  }, [
    applyActiveNotesPatchPayload,
    applyAgentProfileUpdatePayload,
    applyChatWorkoutUpdates,
    fetchChatJobResult,
    handleAiReply,
    modelControl?.models,
    refreshVisibleWorkoutSessions,
    removeMessage,
  ])

  const fetchCoachReply = useCallback(async (
    payload: ChatRequestPayload,
    scopeId: string,
    exerciseId: string,
    messageId?: string | null,
  ) => {
    let data: ChatResponsePayload
    try {
      data = await fetchChatJobResult(payload)
    } catch (error) {
      if (messageId) removeCoachMessage(scopeId, messageId)
      throw error
    }
    if (!data) {
      if (messageId) removeCoachMessage(scopeId, messageId)
      throw new Error('Empty coach chat response')
    }

    applyAgentProfileUpdatePayload(data?.profile_update)
    applyActiveNotesPatchPayload(data?.active_notes_patch)
    const reply = typeof data?.reply === 'string' ? data.reply : String(data?.reply ?? '')
    await handleCoachReply(reply, scopeId, exerciseId, messageId, presetLabel(data.preset, modelControl?.models))
    const workoutUpdates = Array.isArray(data?.workout_updates)
      ? data.workout_updates
      : []
    if (workoutUpdates.length > 0) {
      await applyChatWorkoutUpdates(workoutUpdates)
    } else if (data?.workout_update) {
      await applyChatWorkoutUpdates(data.workout_update)
    } else {
      try {
        await refreshVisibleWorkoutSessions()
      } catch {
        // Chat remains usable while workout APIs are intentionally unsupported.
      }
    }
  }, [
    applyActiveNotesPatchPayload,
    applyAgentProfileUpdatePayload,
    applyChatWorkoutUpdates,
    fetchChatJobResult,
    handleCoachReply,
    modelControl?.models,
    refreshVisibleWorkoutSessions,
    removeCoachMessage,
  ])

  const handleSend = useCallback(async (messageOverride?: string) => {
    const value = (messageOverride ?? chatInput).trim()
    if (!value || !coachChatEnabled) return
    setChatInput('')
    await addMessage(value, 'user')
    const statusId = addThinkingMessage(selectedModelLabel)

    try {
      const payload = {
        user_id: currentUserId,
        request_id: crypto.randomUUID(),
        message: value,
        reference_date: selectedDay?.date ?? todayId,
      }

      await fetchChatReply(payload, statusId)
    } catch (error) {
      removeMessage(statusId)
      console.error('Chat Error:', error)
      const message = error instanceof Error && error.message.includes('Async chat endpoint unavailable')
        ? 'Backend needs a restart for async chat. /chat/async is not available yet.'
        : t('messages.networkError')
      await addMessage(message, 'ai')
    }
  }, [
    addMessage,
    addThinkingMessage,
    chatInput,
    coachChatEnabled,
    currentUserId,
    fetchChatReply,
    removeMessage,
    selectedDay?.date,
    selectedModelLabel,
    t,
    todayId,
  ])

  const handleFastGenerateDayWorkout = useCallback(async (mode: 'recommended' | 'jev') => {
    if (!canGenerateWorkoutSelectedDay || !canQuerySavedWorkoutSessions || !isBackendHealthy) return
    const targetDate = selectedDay?.date ?? todayId
    if (pendingWorkoutDatesRef.current.has(targetDate)) return
    pendingWorkoutDatesRef.current.add(targetDate)
    try {
      const headers = { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() }
      const response = await apiFetch(`${API_BASE_URL}/v1/workouts/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          date: targetDate,
          source: mode === 'jev' ? 'jev' : 'default',
          request_id: crypto.randomUUID(),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string | { message?: string } } | null
        const detail = typeof body?.detail === 'string' ? body.detail : body?.detail?.message
        throw new Error(detail || `Fast workout generation failed (${response.status})`)
      }
      const responseBody = await response.json() as unknown
      let saved: WorkoutSession | null = null
      const receipt = responseBody as BackendWorkoutReceipt
      if (receipt.workout) saved = backendWorkoutToSession(receipt.workout, currentUserId)
      if (!saved) throw new Error('Workout generation returned no workout record')
      // The response is authoritative for this request. Clear the in-flight
      // guard before hydration, otherwise applySavedWorkoutSessionsToWeek
      // treats the just-created record as a competing write and drops it.
      pendingWorkoutDatesRef.current.delete(targetDate)
      applySavedWorkoutSessionToWeek(saved)
      exerciseHistoryCacheRef.current.clear()
    } catch (error) {
      console.warn('Fast workout generation failed:', error)
      window.alert(error instanceof Error ? error.message : t('workout.fastGenerateFailed'))
    } finally {
      pendingWorkoutDatesRef.current.delete(targetDate)
    }
  }, [
    applySavedWorkoutSessionToWeek,
    canGenerateWorkoutSelectedDay,
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    currentUserId,
    getPrivyAuthHeaders,
    isBackendHealthy,
    selectedDay?.date,
    t,
    todayId,
  ])

  const handleGenerateDayWorkout = useCallback(() => {
    void handleFastGenerateDayWorkout('recommended')
  }, [handleFastGenerateDayWorkout])

  const handleVaryDayWorkout = useCallback(() => {
    void handleFastGenerateDayWorkout('jev')
  }, [handleFastGenerateDayWorkout])

  const handleGenerateDayWorkoutWithCoach = useCallback(() => {
    if (!canLlmEditPlanSelectedDay || !coachChatEnabled) return

    const targetDate = selectedDay?.date ?? todayId
    const prompt = t('workout.generateChatPrompt', {
      date: targetDate,
      label: selectedDayLabel,
    })
    handleActiveViewChange('home')
    void handleSend(prompt)
  }, [
    canLlmEditPlanSelectedDay,
    coachChatEnabled,
    handleActiveViewChange,
    handleSend,
    selectedDay?.date,
    selectedDayLabel,
    t,
    todayId,
  ])

  const handleCoachSend = useCallback(async (exerciseId: string, message: string) => {
    const trimmed = message.trim()
    if (!trimmed || !coachChatEnabled) return

    ensureWorkoutSession()
    const scopeId = getCoachScopeId(exerciseId)
    addCoachMessage(scopeId, trimmed, 'user')
    const thinkingId = addCoachThinkingMessage(scopeId, selectedModelLabel)

    const exercise = getExercise(exerciseId)
    if (!exercise) {
      removeCoachMessage(scopeId, thinkingId)
      addCoachMessage(scopeId, t('messages.exerciseNotFound'), 'ai')
      return
    }

    const payload = {
      user_id: currentUserId,
      request_id: crypto.randomUUID(),
      message: trimmed,
      scope_id: scopeId,
      reference_date: selectedDay?.date ?? todayId,
      exercise_id: exercise.id,
    }

    try {
      await fetchCoachReply(payload, scopeId, exerciseId, thinkingId)
    } catch (error) {
      console.error('Coach Chat Error:', error)
      removeCoachMessage(scopeId, thinkingId)
      const responseMessage = error instanceof Error && error.message.includes('Async chat endpoint unavailable')
        ? 'Backend needs a restart for async chat. /chat/async is not available yet.'
        : t('messages.coachNetworkError')
      addCoachMessage(scopeId, responseMessage, 'ai')
    }
  }, [
    addCoachMessage,
    addCoachThinkingMessage,
    coachChatEnabled,
    currentUserId,
    ensureWorkoutSession,
    fetchCoachReply,
    getCoachScopeId,
    getExercise,
    removeCoachMessage,
    selectedDay?.date,
    selectedModelLabel,
    t,
    todayId,
  ])

  const handleSuggestWeight = useCallback(async (exercise: WorkoutExercise) => {
    void exercise
    addMessage('Weight suggestions are not available until a canonical history decision API is connected.', 'ai')
  }, [
    addMessage,
  ])

  const handleQuickExerciseDecision = useCallback(async (
    action: 'last_time' | 'swap_similar' | 'progress_or_deload' | 'rest_time' | 'volume_adjustment' | 'next_exercise',
    exercise: WorkoutExercise,
  ) => {
    void action
    void exercise
    addMessage('Exercise decisions are not available until a canonical decision API is connected.', 'ai')
  }, [
    addMessage,
  ])

  const handleClearChat = useCallback(async () => {
    if (!coachChatEnabled) return

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(await getPrivyAuthHeaders()),
      }
      const response = await apiFetch(`${API_BASE_URL}/chat/clear`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_id: currentUserId,
          expected_session: modelControl?.active_session_id ?? null,
        }),
      })
      if (!response.ok) {
        throw new Error(`Failed to clear chat (${response.status})`)
      }
      setModelControl(await response.json() as ModelControl)
      setMessages([])
      setChatInput('')
    } catch (error) {
      console.warn('New chat failed:', error)
    }
  }, [coachChatEnabled, currentUserId, getPrivyAuthHeaders, modelControl?.active_session_id])

  const setUserEmail = useCallback((email: string | null, userIdOverride?: string | null) => {
    const normalized = email && email.includes('@') ? email.trim().toLowerCase() : null
    setCurrentUserEmail(normalized)

    if (normalized) {
      setPrivyAuthError(null)
    }

    setCurrentUserId(userIdOverride ?? normalized ?? '')
  }, [])

  const resetProfileForSignOut = useCallback(() => {
    setProfile((prev) => ({
      ...prev,
      text: '',
      weeklyPlan: '',
      activeNotes: [],
      dailyTasks: [],
    }))
  }, [])

  const extractEmailFromUser = useCallback((user: unknown): string | null => {
    if (!user || typeof user !== 'object') return null

    const record = user as Record<string, unknown>
    const rawEmail = record.email

    const normalizeEmail = (value: string | null) => (
      value && value.includes('@') ? value.trim().toLowerCase() : null
    )

    if (typeof rawEmail === 'string' && rawEmail.includes('@')) return normalizeEmail(rawEmail)

    if (rawEmail && typeof rawEmail === 'object') {
      const address = (rawEmail as { address?: unknown }).address
      if (typeof address === 'string' && address.includes('@')) return normalizeEmail(address)
    }

    const linkedAccounts = record.linkedAccounts ?? record.linked_accounts
    if (!Array.isArray(linkedAccounts)) return null

    const accounts = linkedAccounts.filter((account): account is {
      type?: string
      email?: string
      address?: string
      subject?: string
      handle?: string
    } => (
      typeof account === 'object' && account !== null
    ))

    const readEmail = (account: {
      email?: string
      address?: string
      subject?: string
      handle?: string
    }) => {
      const candidate = account.email ?? account.address ?? account.subject ?? account.handle
      return typeof candidate === 'string' ? normalizeEmail(candidate) : null
    }

    const preferredTypes = ['google', 'email', 'oauth']
    for (const account of accounts) {
      const accountType = typeof account.type === 'string' ? account.type.toLowerCase() : ''
      if (!preferredTypes.some((type) => accountType.includes(type))) continue
      const email = readEmail(account)
      if (email) return email
    }

    for (const account of accounts) {
      const email = readEmail(account)
      if (email) return email
    }

    return null
  }, [])

  const extractPrivyUserId = useCallback(readPrivyUserId, [])

  const privyUserId = useMemo(() => extractPrivyUserId(privyUser), [extractPrivyUserId, privyUser])

  const ownerIdCandidates = useMemo(() => {
    const set = new Set<string>()
    if (currentUserEmail) set.add(currentUserEmail)
    if (privySubjectId) set.add(privySubjectId)
    if (privyUserId) set.add(privyUserId)
    if (currentUserId) set.add(currentUserId)
    return Array.from(set)
  }, [currentUserEmail, currentUserId, privySubjectId, privyUserId])

  useEffect(() => {
    if (!privyReady) return

    const wasAuthenticated = prevPrivyAuthenticatedRef.current
    prevPrivyAuthenticatedRef.current = privyAuthenticated
    if (wasAuthenticated && !privyAuthenticated) {
      resetProfileForSignOut()
    }

    if (!privyAuthenticated) {
      privyAccessTokenRef.current = null
      setUserEmail(null)
      if (privyAuthError) {
        setPrivyAuthError(null)
      }
      return
    }

    const email = extractEmailFromUser(privyUser)
    const preferredUserId = privyUserId || privySubjectId || email
    setUserEmail(email, preferredUserId)

    if (!email) {
      setPrivyAuthError(t('auth.signedInNoEmail'))
    } else if (privyAuthError) {
      setPrivyAuthError(null)
    }
  }, [
    extractEmailFromUser,
    privyAuthenticated,
    privyAuthError,
    privyReady,
    privyUser,
    resetProfileForSignOut,
    setUserEmail,
    privySubjectId,
    privyUserId,
    t,
  ])

  useEffect(() => {
    if (!privyReady || !privyAuthenticated || privySubjectId) return
    getPrivyAuthHeaders().catch(() => undefined)
  }, [getPrivyAuthHeaders, privyAuthenticated, privyReady, privySubjectId])

  useEffect(() => {
    if (!privyReady || !privyAuthenticated || !isBackendHealthy) return
    let cancelled = false
    const provision = async () => {
      try {
        const headers = await getPrivyAuthHeaders()
        if (!headers.Authorization || cancelled) return
        const response = await apiFetch(`${API_BASE_URL}/account`, { headers })
        if (!cancelled && !response.ok) {
          console.warn('Account provision failed:', response.status)
          setPrivyAuthError(t('auth.signInFailed'))
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Account provision failed:', error)
          setPrivyAuthError(t('auth.signInFailed'))
        }
      }
    }
    void provision()
    return () => {
      cancelled = true
    }
  }, [getPrivyAuthHeaders, isBackendHealthy, privyAuthenticated, privyReady, t])

  useEffect(() => {
    if (!isBackendHealthy || !privyReady || !privyAuthenticated) {
      setModelControl(null)
      return
    }
    const load = () => {
      refreshModelControl().catch((error) => console.warn('Ez model controls unavailable:', error))
    }
    load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [isBackendHealthy, privyAuthenticated, privyReady, refreshModelControl])

  const handleAuthClick = useCallback(async () => {
    if (!privyReady) return

    setPrivyAuthError(null)

    try {
      if (privyAuthenticated) {
        await privyLogout()
        privyAccessTokenRef.current = null
        setUserEmail(null)
      } else {
        await privyLogin()
      }
    } catch (error) {
      console.error('Privy auth failed:', error)
      setPrivyAuthError(error instanceof Error ? error.message : t('auth.signInFailed'))
    }
  }, [privyAuthenticated, privyLogin, privyLogout, privyReady, setUserEmail, t])

  const authState = useMemo<AuthUiState>(() => {
    if (!privyReady) {
      return {
        enabled: true,
        buttonLabel: t('auth.loading'),
        statusVisible: false,
        loading: true,
      }
    }

    if (privyAuthError) {
      const trimmedError = privyAuthError.trim()
      return {
        enabled: true,
        buttonLabel: t('auth.retry'),
        statusVisible: false,
        errorMessage: trimmedError.length > 44 ? t('auth.signInFailed') : trimmedError,
        errorTitle: privyAuthError,
        buttonTitle: privyAuthError,
        loading: false,
      }
    }

    if (privyAuthenticated) {
      return {
        enabled: true,
        buttonLabel: t('auth.signOut'),
        statusEmail: currentUserEmail || undefined,
        statusVisible: Boolean(currentUserEmail),
        loading: false,
      }
    }

    return {
      enabled: true,
      buttonLabel: t('auth.signIn'),
      statusVisible: false,
      loading: false,
    }
  }, [currentUserEmail, privyAuthenticated, privyAuthError, privyReady, t])

  const showHeaderAuthButton = useMemo(
    () => authState.enabled && !privyAuthenticated,
    [authState.enabled, privyAuthenticated]
  )

  useEffect(() => {
    if (!privyAuthenticated) {
      setCoachActAs(null)
      setCoachLinks([])
      setCoachLinksError(null)
      setCoachActionMessage(null)
      setPrivySubjectId(null)
      return
    }
  }, [privyAuthenticated, setCoachActAs])

  useEffect(() => {
    if (!coachActAsOwnerId) return
    const coachEmail = currentUserEmail?.toLowerCase() ?? null
    const coachOwnerIdSet = new Set(ownerIdCandidates)
    const normalizedActAs = coachActAsOwnerId.toLowerCase()
    const valid = coachLinks.some((link) => {
      if (link.status !== 'active' || !link.permissions.view_progress) return false
      const traineeEmail = (link.trainee_email || '').toLowerCase()
      if (link.trainee_owner_id !== coachActAsOwnerId && traineeEmail !== normalizedActAs) return false
      if (link.coach_owner_id && coachOwnerIdSet.has(link.coach_owner_id)) return true
      if (coachEmail && link.coach_email?.toLowerCase() === coachEmail) return true
      return false
    })
    if (!valid) {
      setCoachActAs(null)
    }
  }, [coachActAsOwnerId, coachLinks, currentUserEmail, ownerIdCandidates, setCoachActAs])

  const normalizeVideoQuery = useCallback((query: string, limit: number) => (
    `${limit}:${query.trim().toLowerCase()}`
  ), [])

  const persistVideoCache = useCallback(() => {
    try {
      const entries = Array.from(videoCacheRef.current.entries())
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, videoCacheMaxEntries)

      const payload: Record<string, VideoCacheEntry> = {}
      entries.forEach(([key, value]) => {
        payload[key] = value
      })

      localStorage.setItem(videoCacheStorageKey, JSON.stringify(payload))
    } catch (err) {
      console.warn('Video cache save failed:', err)
    }
  }, [])

  const loadVideoCache = useCallback(() => {
    try {
      const raw = localStorage.getItem(videoCacheStorageKey)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, VideoCacheEntry>
      Object.entries(parsed).forEach(([key, entry]) => {
        if (!entry || typeof entry.ts !== 'number' || !Array.isArray(entry.videos)) return
        videoCacheRef.current.set(key, entry)
      })
    } catch (err) {
      console.warn('Video cache load failed:', err)
    }
  }, [])

  const getCachedVideos = useCallback((query: string, limit: number) => {
    const key = normalizeVideoQuery(query, limit)
    const entry = videoCacheRef.current.get(key)
    if (!entry) return null

    if (Date.now() - entry.ts > videoCacheTtlMs) {
      videoCacheRef.current.delete(key)
      persistVideoCache()
      return null
    }

    return entry
  }, [normalizeVideoQuery, persistVideoCache])

  const fetchVideos = useCallback(async ({
    query,
    exerciseName,
    entryName,
    entryType,
    limit = 5,
    force = false,
  }: {
    query: string
    exerciseName?: string
    entryName?: string
    entryType?: 'exercise' | 'extra'
    limit?: number
    force?: boolean
  }) => {
    if (!query) return
    void exerciseName
    const requestId = videoRequestIdRef.current + 1
    videoRequestIdRef.current = requestId
    const isStale = () => videoRequestIdRef.current !== requestId
    if (entryName && entryType) {
      setVideoOwnerKey(`${entryType}:${entryName}`)
    } else {
      setVideoOwnerKey(null)
    }
    setVideoExactMatch(null)
    if (!force) {
      const cachedEntry = getCachedVideos(query, limit)
      if (cachedEntry) {
        if (isStale()) return
        setVideos(cachedEntry.videos)
        setVideoExactMatch(cachedEntry.exactMatch ?? null)
        setVideoLoading(false)
        return
      }
    } else {
      const key = normalizeVideoQuery(query, limit)
      if (videoCacheRef.current.delete(key)) {
        persistVideoCache()
      }
    }

    setVideos([])
    setVideoExactMatch(null)
    setVideoLoading(false)
  }, [getCachedVideos, normalizeVideoQuery, persistVideoCache])

  useEffect(() => {
    if (restState.active && restState.endTs) {
      if (restState.remainingSec <= 0) {
        const shouldAutoStart = restState.autoStartNextSet
        completeRest()
        if (shouldAutoStart && document.visibilityState === 'visible') {
          autoStartNextHoldSet()
        }
        return
      }
    }
  }, [autoStartNextHoldSet, completeRest, restState])

  useEffect(() => {
    if (!holdTimer.active && holdTimer.phase === 'complete') {
      if (!holdCompletionHandledRef.current) {
        holdCompletionHandledRef.current = true
        logHoldTimerSet()
      }
    } else {
      holdCompletionHandledRef.current = false
    }
  }, [holdTimer, logHoldTimerSet])

  useEffect(() => {
    if (activeEntryType !== 'exercise' || !activeEntryId) {
      resetHoldTimer()
      return
    }
    const exercise = getExercise(activeEntryId)
    if (!exercise) return
    const stateList = setLogsRef.current[exercise.id] ?? []
    const nextIndex = stateList.findIndex((set) => !set.done)
    const holdTimerEnabled = exercise.metric === 'time' && exercise.timer?.enabled === true

    if (!holdTimerEnabled || nextIndex === -1) {
      if (holdTimer.exerciseId) resetHoldTimer()
      return
    }

    const targetSet = exercise.sets[nextIndex]
    const holdTargetSec = parseDurationToSeconds(targetSet?.targetTime) ?? 60
    const holdPrepSec = exercise.timer?.prepSec ?? 3
    const holdSideCount = getTimedSideCount(exercise)

    setHoldTimer((prev) => {
      if (prev.active) return prev
      if (
        prev.exerciseId === exercise.id
        && prev.setIndex === nextIndex
        && prev.totalSec === holdTargetSec
        && prev.prepSec === holdPrepSec
        && prev.sideCount === holdSideCount
        && prev.phase !== 'complete'
      ) {
        return prev
      }
      return {
        active: false,
        phase: 'idle',
        prepRemainingSec: Math.max(0, Math.floor(holdPrepSec)),
        remainingSec: Math.max(1, Math.floor(holdTargetSec)),
        totalSec: Math.max(1, Math.floor(holdTargetSec)),
        prepSec: Math.max(0, Math.floor(holdPrepSec)),
        exerciseId: exercise.id,
        setIndex: nextIndex,
        sideIndex: 0,
        sideCount: holdSideCount,
        startTs: null,
        prepEndTs: null,
        holdEndTs: null,
      }
    })
  }, [activeEntryId, activeEntryType, dataVersion, getExercise, holdTimer.exerciseId, holdTimer.prepSec, holdTimer.setIndex, holdTimer.totalSec, resetHoldTimer])

  useEffect(() => {
    const handleVisibility = () => {
      const previous = lastVisibilityStateRef.current
      lastVisibilityStateRef.current = document.visibilityState
      if (document.visibilityState !== 'visible') {
        if (restTimerIdRef.current) {
          window.clearInterval(restTimerIdRef.current)
          restTimerIdRef.current = null
        }
        return
      }

      // Screen wake locks are released by iOS when the page hides; reacquire if a timer is live.
      if (wakeLockWantedRef.current) {
        void requestWakeLock()
      }

      if (restState.active) {
        if (previous !== 'visible' && restState.endTs && Date.now() >= restState.endTs) {
          // Rest finished while backgrounded: clear without replaying the alert.
          completeRest({ silent: true })
          return
        }

        setRestState((prev) => {
          if (!prev.active || !prev.endTs) return prev
          const remainingMs = prev.endTs - Date.now()
          const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000))
          if (remainingSec === prev.remainingSec) return prev
          return { ...prev, remainingSec }
        })

        if (!restTimerIdRef.current) {
          restTimerIdRef.current = window.setInterval(() => {
            setRestState((prev) => {
              if (!prev.active || !prev.endTs) return prev
              const remainingMs = prev.endTs - Date.now()
              const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000))
              if (remainingSec === prev.remainingSec) return prev
              return { ...prev, remainingSec }
            })
          }, 250)
        }
      }
      if (holdTimer.active) {
        setHoldTimer((prev) => updateHoldTimerFromNow(prev, Date.now()))
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [completeRest, holdTimer.active, requestWakeLock, restState.active, restState.endTs, updateHoldTimerFromNow])

  useEffect(() => {
    const wanted = restState.active || holdTimer.active
    syncWakeLock(wanted)
  }, [holdTimer.active, restState.active, syncWakeLock])

  useEffect(() => () => {
    wakeLockWantedRef.current = false
    void releaseWakeLock()
  }, [releaseWakeLock])

  useEffect(() => {
    void warmBackend({ force: true })
  }, [warmBackend])

  useEffect(() => {
    const warmIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void warmBackend()
      }
    }
    const warmAfterFocus = () => {
      if (document.visibilityState === 'visible') {
        void warmBackend({ force: true })
      }
    }

    const keepAliveId = window.setInterval(warmIfVisible, BACKEND_KEEPALIVE_MS)
    window.addEventListener('focus', warmAfterFocus)
    document.addEventListener('visibilitychange', warmAfterFocus)

    return () => {
      window.clearInterval(keepAliveId)
      window.removeEventListener('focus', warmAfterFocus)
      document.removeEventListener('visibilitychange', warmAfterFocus)
    }
  }, [warmBackend])

  useEffect(() => {
    if (!privyReady || !privyAuthenticated) {
      sessionReadyRef.current = false
      setSessionLoading(true)
      return
    }
    const preferredUserId = privyUserId || privySubjectId || currentUserEmail || null
    if (!preferredUserId || !currentUserId) {
      sessionReadyRef.current = false
      setSessionLoading(true)
      return
    }
    if (preferredUserId && currentUserId !== preferredUserId && !coachActAsOwnerId) {
      setSessionLoading(true)
      return
    }

    const actAsKey = coachActAsOwnerId ? `:act-as:${coachActAsOwnerId}` : ''
    const authKey = `auth:${currentUserId}${actAsKey}:sub=${privySubjectId ?? ''}:uid=${privyUserId ?? ''}:online=${isBackendHealthy ? '1' : '0'}`
    if (sessionLoadKeyRef.current === authKey) return
    sessionLoadKeyRef.current = authKey
    pendingWorkoutDatesRef.current = new Set()
    pendingWorkoutPlanDatesRef.current = new Set()
    workoutWriteVersionByDateRef.current = {}
    sessionReadyRef.current = true
    setServerSessionLoadSettledKey(authKey)
    setSessionLoading(false)
    fetchBackendChatHistory(currentUserId).catch((error) => {
      console.warn('Chat history load failed:', error)
    })
  }, [
    coachActAsOwnerId,
    currentUserEmail,
    currentUserId,
    fetchBackendChatHistory,
    isBackendHealthy,
    privyAuthenticated,
    privyReady,
    privySubjectId,
    privyUserId,
  ])

  useEffect(() => {
    purgeLegacySessionCaches()
  }, [])

  useEffect(() => {
    loadVideoCache()
  }, [loadVideoCache])

  useEffect(() => {
    document.documentElement.lang = profile.language
  }, [profile.language])

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', profile.fontScale.toString())
  }, [profile.fontScale])

  useEffect(() => {
    if (didAutoSelectTodayRef.current) return
    const todayIndex = findDayIndexByDate(weekPlan.days, todayId)
    if (todayIndex >= 0 && todayIndex !== selectedDayIndexRef.current) {
      handleSelectDay(todayIndex)
    }
    if (sessionReadyRef.current) {
      didAutoSelectTodayRef.current = true
    }
  }, [handleSelectDay, todayId, weekPlan.days])

  useEffect(() => {
    ensureWorkoutSession()
  }, [ensureWorkoutSession])

  useEffect(() => {
    let keyboardFrame = 0

    const syncKeyboardSoon = () => {
      if (keyboardFrame) {
        window.cancelAnimationFrame(keyboardFrame)
      }
      keyboardFrame = window.requestAnimationFrame(() => {
        keyboardFrame = 0
        syncKeyboardInset()
      })
    }
    const syncKeyboardSettled = () => {
      syncKeyboardSoon()
      window.setTimeout(syncKeyboardSoon, 80)
      window.setTimeout(syncKeyboardSoon, 260)
    }

    const resetSoon = () => {
      resetAppViewportScroll()
      requestAnimationFrame(resetAppViewportScroll)
    }
    const resetAfterOrientationChange = () => {
      layoutViewportHeightRef.current = 0
      resetSoon()
    }
    resetSoon()
    window.addEventListener('scroll', resetSoon, { passive: true })
    window.addEventListener('orientationchange', resetAfterOrientationChange)
    window.addEventListener('resize', syncKeyboardSoon)
    window.addEventListener('pageshow', syncKeyboardSoon)
    window.addEventListener('focusin', syncKeyboardSettled)
    window.addEventListener('focusout', syncKeyboardSettled)
    window.visualViewport?.addEventListener('resize', syncKeyboardSoon)
    window.visualViewport?.addEventListener('scroll', syncKeyboardSoon)

    return () => {
      if (keyboardFrame) {
        window.cancelAnimationFrame(keyboardFrame)
      }
      window.removeEventListener('scroll', resetSoon)
      window.removeEventListener('orientationchange', resetAfterOrientationChange)
      window.removeEventListener('resize', syncKeyboardSoon)
      window.removeEventListener('pageshow', syncKeyboardSoon)
      window.removeEventListener('focusin', syncKeyboardSettled)
      window.removeEventListener('focusout', syncKeyboardSettled)
      window.visualViewport?.removeEventListener('resize', syncKeyboardSoon)
      window.visualViewport?.removeEventListener('scroll', syncKeyboardSoon)
    }
  }, [resetAppViewportScroll, syncKeyboardInset])

  useEffect(() => {
    resetAppViewportScroll()
    requestAnimationFrame(resetAppViewportScroll)
  }, [activeView, activeEntryId, resetAppViewportScroll])

  useLayoutEffect(() => {
    if (activeView !== 'home') return
    syncChatBottomSoon('auto')
  }, [activeView, messages, showHeaderAuthButton, syncChatBottomSoon])

  useEffect(() => clearPendingChatBottomSync, [clearPendingChatBottomSync])

  useEffect(() => {
    if (!isProd) return
    if (!('serviceWorker' in navigator)) return

    let disposed = false

    const registerServiceWorker = async () => {
      try {
        await navigator.serviceWorker.register('/sw.js', {
          updateViaCache: 'none',
        })
        if (disposed) return
      } catch {
        // Keep the web app usable if service workers are unavailable or disabled.
      }
    }

    if (document.readyState === 'complete') {
      void registerServiceWorker()
    } else {
      window.addEventListener('load', registerServiceWorker, { once: true })
    }

    return () => {
      disposed = true
      window.removeEventListener('load', registerServiceWorker)
    }
  }, [isProd])

  const handleSelectEntry = useCallback((id: string, type: ActiveEntryType) => {
    showWorkoutDetail(id, type)
  }, [showWorkoutDetail])

  const handleApplyQuickAction = useCallback(async (
    messageId: string,
    option: QuickActionOption,
    exercise: WorkoutExercise,
  ) => {
    const scopeId = getCoachScopeId(exercise.id)
    if (option.action === 'next_exercise') {
      const targetId = String(option.payload.choice ?? '')
      if (!targetId || !getExercise(targetId)) return
      showWorkoutDetail(targetId, 'exercise')
    } else {
      if (!canEditPlanSelectedDay) return
      const current = getExercise(exercise.id)
      if (!current) return
      if (
        option.action === 'volume_adjustment'
        && isExerciseLockedFromLogs(current.id, setLogsRef.current)
      ) return
      let replacementId: string | null = null

      if (option.action === 'weight') {
        const load = String(option.payload.load ?? '').trim()
        if (!load) return
        current.sets.forEach((set) => {
          if (!set.isWarmup) set.targetWeight = load
        })
      } else if (option.action === 'rest_time') {
        const seconds = Number(option.payload.seconds)
        if (!Number.isFinite(seconds) || seconds <= 0) return
        current.restSec = seconds
      } else if (option.action === 'volume_adjustment') {
        const nextCount = Number(option.payload.sets)
        const target = String(option.payload.target ?? '').trim()
        if (!Number.isInteger(nextCount) || nextCount < 1 || nextCount > 6) return
        const warmups = current.sets.filter((set) => set.isWarmup)
        const workSets = current.sets.filter((set) => !set.isWarmup)
        const source = workSets[workSets.length - 1]
        if (!source) return
        const metricKey = current.metric === 'time' ? 'targetTime' : 'targetReps'
        const nextWorkSets = Array.from({ length: nextCount }, (_, index) => ({
          ...(workSets[index] ?? source),
          [metricKey]: target || (workSets[index] ?? source)[metricKey],
        }))
        current.sets = [...warmups, ...nextWorkSets]
        const existingLogs = setLogsRef.current[current.id] ?? []
        setLogsRef.current[current.id] = current.sets.map((_, index) => (
          existingLogs[index] ?? { weight: '', metric: '', done: false }
        ))
        baseSetCountsRef.current[current.id] = current.sets.length
      } else if (option.action === 'swap_similar') {
        const name = String(option.payload.name ?? '').trim()
        if (!name) return
        const suggestedLoad = String(option.payload.suggested_load ?? '').trim()
        const applyIdentity = (target: WorkoutExercise, usePlanPrescription: boolean) => {
          const planned = option.payload.exercise && typeof option.payload.exercise === 'object' && !Array.isArray(option.payload.exercise)
            ? option.payload.exercise as Partial<WorkoutExercise>
            : null
          target.name = name
          target.standardName = planned?.standardName ?? name
          target.exerciseKey = String(option.payload.choice ?? '') || undefined
          target.movementFamilyKey = planned?.movementFamilyKey ?? (String(option.payload.movement_family ?? '') || undefined)
          target.equipment = planned?.equipment ?? ((String(option.payload.equipment ?? '') || undefined) as WorkoutExercise['equipment'])
          target.weightMode = planned?.weightMode ?? ((String(option.payload.load_basis ?? '') || undefined) as WorkoutExercise['weightMode'])
          target.primaryMuscle = planned?.primaryMuscle ?? ((String(option.payload.primary_muscle ?? '') || undefined) as WorkoutExercise['primaryMuscle'])
          target.secondaryMuscles = planned?.secondaryMuscles ?? (Array.isArray(option.payload.secondary_muscles)
            ? option.payload.secondary_muscles as WorkoutExercise['secondaryMuscles']
            : undefined)
          target.catalogMatchQuality = 'catalog_key'
          if (usePlanPrescription && planned) {
            if (Array.isArray(planned.sets) && planned.sets.length > 0) target.sets = planned.sets.map((set) => ({ ...set }))
            if (Array.isArray(planned.cues)) target.cues = [...planned.cues]
            if (planned.restSec) target.restSec = planned.restSec
            if (planned.metric) target.metric = planned.metric
            if (planned.section) target.section = planned.section
          }
          target.sets.forEach((set) => {
            if (!set.isWarmup) set.targetWeight = suggestedLoad
          })
        }
        const currentLogs = setLogsRef.current[current.id] ?? []
        const completedIndexes = current.sets
          .map((_, index) => index)
          .filter((index) => currentLogs[index]?.done)
        if (completedIndexes.length > 0) {
          const remainingSets = current.sets.filter((_, index) => !currentLogs[index]?.done)
          if (remainingSets.length === 0) return
          const nextId = `${current.id}-swap-${Date.now()}`
          const replacement: WorkoutExercise = {
            ...current,
            id: nextId,
            sets: remainingSets.map((set) => ({ ...set })),
            cues: [],
            notes: undefined,
          }
          applyIdentity(replacement, false)
          current.sets = completedIndexes.map((index) => ({ ...current.sets[index] }))
          setLogsRef.current[current.id] = completedIndexes.map((index) => ({ ...currentLogs[index] }))
          baseSetCountsRef.current[current.id] = current.sets.length
          const currentIndex = workoutExercisesRef.current.findIndex((item) => item.id === current.id)
          workoutExercisesRef.current.splice(currentIndex + 1, 0, replacement)
          setLogsRef.current[nextId] = replacement.sets.map(() => ({ weight: '', metric: '', done: false }))
          baseSetCountsRef.current[nextId] = replacement.sets.length
          replacementId = nextId
          updateExerciseSummary(replacement)
        } else {
          applyIdentity(current, true)
        }
      }

      updateExerciseSummary(current)
      const targetDate = selectedDay?.date ?? todayId
      const currentDay = weekPlan.days.find((day) => day.date === targetDate)
      const nextExercises = [...workoutExercisesRef.current]
      const nextExtras = [...workoutExtrasRef.current]
      const nextLogs = { ...setLogsRef.current }
      const nextBaseCounts = { ...baseSetCountsRef.current }
      const nextDay: WeekPlanDay = {
        ...(currentDay ?? {
          date: targetDate,
          label: selectedDayLabel,
          exercises: [],
          extras: [],
        }),
        exercises: nextExercises,
        extras: nextExtras,
        isRest: nextExercises.length === 0,
      }
      const nextPlan: WeekPlan = {
        ...weekPlan,
        days: weekPlan.days.map((day) => day.date === targetDate ? nextDay : day),
      }
      workoutExercisesRef.current = nextExercises
      workoutExtrasRef.current = nextExtras
      setLogsRef.current = nextLogs
      baseSetCountsRef.current = nextBaseCounts
      weekSetLogsRef.current[targetDate] = nextLogs
      weekBaseCountsRef.current[targetDate] = nextBaseCounts
      setWeekPlan(nextPlan)
      bumpData()
      const saved = await persistWorkoutSessionForDay({
        dateId: targetDate,
        sessionId: targetDate,
        label: nextDay.label,
        exercises: nextExercises,
        extras: nextExtras,
        setLogs: nextLogs,
        notes: nextDay.notes,
        dayOverride: nextDay,
        planMutation: true,
      })
      if (!saved) return
      if (replacementId) showWorkoutDetail(replacementId, 'exercise')
    }

    updateCoachMessages(scopeId, (items) => items.map((message) => (
      message.id === messageId
        ? {
            ...message,
            quickActions: message.quickActions?.map((candidate) => ({
              ...candidate,
              applied: candidate.id === option.id,
            })),
          }
        : message
    )))
    await addCoachMessage(scopeId, `Applied: ${option.label}`, 'ai')
  }, [
    addCoachMessage,
    bumpData,
    canEditPlanSelectedDay,
    getCoachScopeId,
    getExercise,
    persistWorkoutSessionForDay,
    selectedDay?.date,
    selectedDayLabel,
    showWorkoutDetail,
    todayId,
    updateCoachMessages,
    weekPlan,
  ])

  const handleProfileChange = useCallback((field: 'text' | 'weeklyPlan' | 'activeNotes' | 'language' | 'fontScale', value: string) => {
    markLocalEdit()
    if (field === 'language') {
      const normalized = normalizeLanguage(value) ?? 'en'
      setProfile((prev) => ({
        ...prev,
        language: normalized,
      }))
      return
    }
    if (field === 'fontScale') {
      const normalized = normalizeFontScale(value)
      setProfile((prev) => ({
        ...prev,
        fontScale: normalized,
      }))
      return
    }
    if (field === 'activeNotes') {
      setProfile((prev) => ({
        ...prev,
        activeNotes: normalizeActiveNotes(value),
      }))
      return
    }
    setProfile((prev) => ({
      ...prev,
      [field]: value,
    }))
  }, [markLocalEdit])

  const activeCoachMessages = activeEntryType === 'exercise' && activeEntryId
    ? (coachMessagesByScope[getCoachScopeId(activeEntryId)] ?? [])
    : []
  const selectedDayHasWorkoutItems = workoutExercisesRef.current.length > 0 || workoutExtrasRef.current.length > 0
  const selectedDayHasLoggedExercises = workoutExercisesRef.current.some((exercise) => (
    isExerciseLockedFromLogs(exercise.id, setLogsRef.current)
  ))
  const selectedDayHasUnloggedItems = workoutExercisesRef.current.some((exercise) => (
    !isExerciseLockedFromLogs(exercise.id, setLogsRef.current)
    || getUnloggedSetCount(exercise, setLogsRef.current) > 0
  )) || workoutExtrasRef.current.length > 0
  const selectedDayHasText = Boolean((selectedDay?.planNotes ?? '').trim() || (selectedDay?.notes ?? '').trim())
  const workoutClearMode = selectedDayHasLoggedExercises ? 'unlogged' : 'day'
  const canClearWorkout = selectedDayHasLoggedExercises
    ? selectedDayHasUnloggedItems
    : (selectedDayHasWorkoutItems || selectedDayHasText)

  return (
    <I18nProvider value={i18n}>
      <div className={`shell shell--${activeView}${coachActAsOwnerId ? ' shell--coach-view' : ''}`}>
        <div className="shell-aura shell-aura-primary" aria-hidden="true" />
        <div className="shell-aura shell-aura-secondary" aria-hidden="true" />
        <div className="content">
          <ChatView
            active={activeView === 'home'}
            messages={messages}
            inputValue={chatInput}
            inputDisabled={!coachChatEnabled}
            modelOptions={modelOptions}
            showModelLabels
            selectedModel={selectedModelValue}
            modelSelectionDisabled={modelSelectionPending || messages.some((message) => message.thinking)}
            onModelChange={handleModelSelection}
            onInputChange={setChatInput}
            onSend={handleSend}
            onClearChat={handleClearChat}
            onRefresh={handleRefreshSession}
            onAuthClick={handleAuthClick}
            showAuthButton={showHeaderAuthButton}
            authButtonLabel={authState.buttonLabel}
            authButtonTitle={authState.buttonTitle}
            authButtonLoading={authState.loading}
            chatBodyRef={chatBodyRef}
            showScrollToBottom={showChatScrollToBottom}
            onChatScroll={updateChatScrollButton}
            onScrollToBottom={() => scrollChatToBottom()}
          />
          <WorkoutView
            active={activeView === 'workout'}
            canLogDay={canLogSelectedDay}
            canEditPlan={canEditPlanSelectedDay}
            coachChatEnabled={coachChatEnabled}
            weekDays={weekDaySummaries}
            selectedDayLabel={selectedDayLabel}
            hasWeekWorkouts={hasWeekWorkouts}
            loading={sessionLoading}
            exercises={workoutExercisesRef.current}
            extras={displayedWorkoutExtras}
            setLogs={setLogsRef.current}
            planNotes={selectedDay?.planNotes ?? ''}
            dayNotes={selectedDay?.notes ?? ''}
            activeEntryId={activeEntryId}
            activeEntryType={activeEntryType}
            editingSet={editingSet}
            restState={restState}
            holdTimer={holdTimer}
            videos={videos}
            videoLoading={videoLoading}
            videoExactMatch={videoExactMatch}
            videoOffline={!isBackendHealthy}
            videoOwnerKey={videoOwnerKey}
            coachMessages={activeCoachMessages}
            showModelLabels
            exerciseHistory={exerciseHistory}
            exerciseHistoryLoading={exerciseHistoryLoading}
            exerciseHistoryError={exerciseHistoryError}
            onSelectEntry={handleSelectEntry}
            onSelectDay={handleSelectDay}
            onBack={hideWorkoutDetail}
            onLogSet={logNextSet}
            onAddSet={addNewSet}
            onDeleteSet={deleteSetAtIndex}
            onStartEditingSet={(exerciseId, index) => {
              const stateList = setLogsRef.current[exerciseId]
              const setItem = stateList?.[index]
              if (!setItem) return
              setEditingSet({ exerciseId, index })
              setEditingSetSnapshot({
                weight: setItem.weight,
                metric: setItem.metric,
                value_source: setItem.value_source,
              })
            }}
            onSaveEditingSet={() => {
              if (editingSet) {
                const exercise = getExercise(editingSet.exerciseId)
                const stateList = setLogsRef.current[editingSet.exerciseId]
                const setItem = stateList?.[editingSet.index]
                if (setItem) {
                  setItem.weight = normalizeWeightLabel(setItem.weight)
                  if (exercise?.metric === 'reps') {
                    setItem.metric = normalizeRepValue(setItem.metric)
                  }
                }
              }
              setEditingSet(null)
              setEditingSetSnapshot(null)
              bumpData()
            }}
            onCancelEditingSet={() => {
              if (editingSet && editingSetSnapshot) {
                const stateList = setLogsRef.current[editingSet.exerciseId]
                const setItem = stateList?.[editingSet.index]
                if (setItem) {
                  setItem.weight = editingSetSnapshot.weight
                  setItem.metric = editingSetSnapshot.metric
                  setItem.value_source = editingSetSnapshot.value_source
                }
              }
              setEditingSet(null)
              setEditingSetSnapshot(null)
              bumpData()
            }}
            onUpdateSetField={updateSetField}
            onStartHoldTimer={startHoldTimer}
            onLogHoldTimerSet={logHoldTimerSet}
            onOpenVideo={setActiveVideoId}
            onRequestVideos={fetchVideos}
            onCoachSend={handleCoachSend}
            onSuggestWeight={handleSuggestWeight}
            onQuickDecision={handleQuickExerciseDecision}
            onApplyQuickAction={handleApplyQuickAction}
            onRequestExerciseHistory={handleRequestExerciseHistory}
            onRemoveExercise={removeExerciseFromPlan}
            onRemoveExtra={removeExtraFromPlan}
            onRemoveCircuit={removeCircuitFromPlan}
            onRemoveSection={removeSectionFromPlan}
            onUpdateDayNotes={updateDayNotes}
            onUpdateExerciseNotes={updateExerciseNotes}
          />
          <HealthTimelineView
            key={currentUserId}
            kind={activeView === 'diet' ? 'diet' : 'health'}
            active={activeView === 'diet' || activeView === 'health'}
            weekDays={weekDaySummaries}
            selectedDayLabel={selectedDayLabel}
            onSelectDay={handleSelectDay}
            onChat={() => handleActiveViewChange('home')}
            apiBase={API_BASE_URL}
            userId={currentUserId}
            enabled={canQuerySavedWorkoutSessions}
            canEdit
            getAuthHeaders={getPrivyAuthHeaders}
          />
          <ProfileView
            telegramControl={privyAuthenticated && !coachActAsOwnerId ? <TelegramLink apiBase={API_BASE_URL} getHeaders={getPrivyAuthHeaders} /> : undefined}
            active={activeView === 'profile'}
            text={profile.text}
            weeklyPlan={profile.weeklyPlan}
            activeNotes={normalizeActiveNotes(profile.activeNotes).map((note) => note.text).join('\n')}
            language={profile.language}
            fontScale={profile.fontScale}
            onChange={handleProfileChange}
            onAuthClick={handleAuthClick}
            authState={authState}
            coachLinks={coachLinks}
            coachLinksLoading={coachLinksLoading}
            coachLinksError={coachLinksError}
            coachActionMessage={coachActionMessage}
            coachLatestInviteToken={coachLatestInviteToken}
            coachActAsOwnerId={coachActAsOwnerId}
            viewerOwnerIdCandidates={ownerIdCandidates}
            onCoachActAs={setCoachActAs}
            onCoachInvite={handleCoachInvite}
            onCoachAcceptInvite={handleCoachAcceptInvite}
            onCoachUpdatePermissions={handleCoachUpdatePermissions}
            onCoachRevoke={handleCoachRevoke}
          />
        </div>

        <TabBar
          activeView={activeView}
          onChange={handleActiveViewChange}
          coachModeActive={Boolean(coachActAsOwnerId)}
          coachContextLabel={coachActAsOwnerId ? activeCoachContextLabel : ''}
          leadingControl={activeView !== 'workout' && activeView !== 'profile' ? (
            <ChatOverflowMenu
              onRefresh={() => {
                if (activeView === 'diet' || activeView === 'health') window.dispatchEvent(new Event('aifit-channel-change'))
                return handleRefreshSession()
              }}
            />
          ) : (
            <WorkoutOverflowMenu
              canEditPlan={canEditPlanSelectedDay}
              canClearWorkout={canClearWorkout}
              canCopyLastWeek={canEditPlanSelectedDay && canQuerySavedWorkoutSessions && isBackendHealthy && !copyingLastWeek}
              copyingLastWeek={copyingLastWeek}
              onCopyLastWeek={handleCopyLastWeek}
              canGeneratePlan={canGenerateWorkoutSelectedDay && canQuerySavedWorkoutSessions && isBackendHealthy}
              canGenerateWithCoach={canLlmEditPlanSelectedDay && coachChatEnabled}
              clearMode={workoutClearMode}
              onGenerateWorkout={handleGenerateDayWorkout}
              onVaryWorkout={handleVaryDayWorkout}
              onGenerateWithCoach={handleGenerateDayWorkoutWithCoach}
              onRefresh={handleRefreshSession}
              onClearWorkout={handleClearWorkoutDay}
            />
          )}
        />
        <RestOverlay
          restState={restState}
          onAdjust={adjustRestTime}
          onStop={stopRest}
          onMinimize={minimizeRest}
          onToggleAutoStart={setRestAutoStart}
        />
        <MiniTimer restState={restState} onMaximize={maximizeRest} />
        <VideoModal activeVideoId={activeVideoId} onClose={() => setActiveVideoId(null)} />
      </div>
    </I18nProvider>
  )
}

export default App
