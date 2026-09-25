import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { marked } from 'marked'
import { formatDurationForDisplay, normalizeWorkoutTargetText } from './utils/workoutDisplay'
import type { WorkoutExercise, WorkoutExtra, WorkoutFeedbackPreset } from './data/testWorkout'
import { circuitGroupKey } from './data/testWorkout'
import { getNextCircuitSet } from './utils/circuitProgress'
import { backendWorkoutToSession, type BackendWorkout, type BackendWorkoutReceipt } from './utils/backendWorkoutAdapter'
import { fetchSwapCandidates, needsCoachSwap, readApiError, swapErrorKey, SwapCandidatesError, type SwapCandidate, type SwapCandidates } from './utils/swapCandidates'
import { fetchWorkoutHistory } from './utils/workoutHistory'
import { I18nProvider, createI18n } from './i18n'
import { normalizeLanguage, type Language } from './i18n/strings'
import TabBar from './components/TabBar'
import RestOverlay from './components/RestOverlay'
import MiniTimer from './components/MiniTimer'
import ChatView from './views/ChatView'
import WorkoutView from './views/WorkoutView'
import ProfileView, { type CoachActAsTarget, type CoachPermissions } from './views/ProfileView'
import TelegramLink from './components/profile/TelegramLink'
import WorkoutOverflowMenu from './components/workout/WorkoutOverflowMenu'
import WorkoutHistorySheet from './components/workout/WorkoutHistorySheet'
import ChatOverflowMenu from './components/chat/ChatOverflowMenu'
import type {
  ActiveEntryType,
  AuthUiState,
  ChatMessage,
  HoldTimerState,
  RestState,
  SetState,
} from './types/app'
import type { WorkoutSession } from './types/workoutSession'

const restDefaultSec = 90
const sideTransitionPrepSec = 5
const LEGACY_SESSION_CACHE_STORAGE_PREFIX = 'aifit_session_cache_v1:'
const MAIN_CHAT_HISTORY_LIMIT = 40
const BACKEND_HEALTH_STALE_MS = 4 * 60 * 1000
const BACKEND_HEALTH_PING_TIMEOUT_MS = 12 * 1000
const CHAT_JOB_POLL_MS = 2500
const CHAT_JOB_MAX_WAIT_MS = 8 * 60 * 1000

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
  const name = provider && model.name.startsWith(prefix) ? model.name.slice(prefix.length) : model.name
  const idSuffix = model.model ? ` · ${model.model}` : ''
  return idSuffix && name.endsWith(idSuffix) ? name.slice(0, -idSuffix.length) : name
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

type ModelOption = {
  value: string
  label: string
  cli: string
  provider?: string
  model?: string
  effort?: string
}

const MINI_CHAT_SCOPE = 'owner-minichat'

const buildModelOptions = (control: ModelControl | null): ModelOption[] => {
  const options = (control?.models ?? []).flatMap((model) => {
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
  const optionKeys = new Set(options.map((option) => option.value))
  for (const preset of control?.presets ?? []) {
    if (!preset.model || !preset.effort) continue
    const value = JSON.stringify([preset.cli, preset.provider ?? null, preset.model, preset.effort])
    if (optionKeys.has(value)) continue
    optionKeys.add(value)
    options.push({
      value,
      label: presetLabel(preset, control?.models) ?? preset.name,
      cli: preset.cli,
      provider: preset.provider,
      model: preset.model,
      effort: preset.effort,
    })
  }
  return options
}

const selectedModelValueFor = (control: ModelControl | null): string => {
  const preset = control?.presets.find((item) => item.id === control.selected_id)
  return preset
    ? JSON.stringify([preset.cli, preset.provider ?? null, preset.model ?? null, preset.effort ?? null])
    : ''
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
  language: Language
  fontScale: number
}

type SetSyncRevert = {
  weight: string
  metric: string
  done: boolean
  skipped?: boolean
  value_source?: SetState['value_source']
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
  scope?: string
  scope_id?: string
  reference_date?: string
  exercise_id?: string
  workout_id?: string
  exercise_instance_id?: string
  expected_revision?: string
  act_as_link_id?: string
}

type ChatResponsePayload = {
  reply?: unknown
  preset?: EzPreset
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

const buildSetLogsForExercises = (
  exercises: WorkoutExercise[],
  previousLogs?: Record<string, SetState[]>
) => {
  const logs: Record<string, SetState[]> = {}

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
  })

  return logs
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

const parseActualLoad = (value: string | undefined): { value: number; unit: 'kg' | 'lb' } | null => {
  const trimmed = (value ?? '').trim().toLowerCase()
  const match = trimmed.match(/^(-?\d+(?:[.,]\d+)?)\s*(kg|lb)?$/)
  if (!match) return null
  const amount = Number(match[1].replace(',', '.'))
  if (!Number.isFinite(amount) || amount < 0) return null
  return { value: amount, unit: match[2] === 'lb' ? 'lb' : 'kg' }
}

const parseActualMetric = (exercise: WorkoutExercise, value: string | undefined) => {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  if (exercise.metric === 'time') {
    const seconds = parseDurationToSeconds(trimmed)
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
    return { duration_seconds: Math.round(seconds) }
  }
  const reps = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(reps) || reps < 0) return null
  return { reps }
}

type BackendSetTarget = {
  reps?: { min: number; max: number }
  duration_seconds?: { min: number; max: number }
  load?: { value: number; unit: 'kg' | 'lb' }
}

const parseTargetRange = (value: unknown): { min: number; max: number } | null => {
  const text = normalizeWorkoutTargetText(value)
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  const parts = trimmed.split('-').map((part) => part.trim()).filter(Boolean)
  const first = Number(parts[0])
  const second = parts.length > 1 ? Number(parts[1]) : first
  if (!Number.isFinite(first) || first < 0) return null
  if (!Number.isFinite(second) || second < first) return null
  return { min: first, max: second }
}

// Compose the full target PATCH body from the edited field plus the row's
// existing target. Exactly one of reps / duration_seconds, optional load.
const composeSetTarget = (
  exercise: WorkoutExercise,
  set: WorkoutExercise['sets'][number] | undefined,
  field: 'weight' | 'metric',
  value: string,
): BackendSetTarget | null => {
  if (field === 'metric') {
    const load = parseActualLoad(normalizeWorkoutTargetText(set?.targetWeight))
    if (exercise.metric === 'time') {
      const seconds = parseDurationToSeconds(value)
      if (seconds === null || seconds < 0) return null
      return {
        duration_seconds: { min: Math.round(seconds), max: Math.round(seconds) },
        ...(load ? { load } : {}),
      }
    }
    const reps = Number.parseInt(value.trim(), 10)
    if (!Number.isFinite(reps) || reps < 0) return null
    return {
      reps: { min: reps, max: reps },
      ...(load ? { load } : {}),
    }
  }
  const metricRange = parseTargetRange(exercise.metric === 'time' ? set?.targetTime : set?.targetReps)
  if (!metricRange) return null
  const load = value.trim() ? parseActualLoad(value) : null
  if (value.trim() && !load) return null
  return {
    ...(exercise.metric === 'time'
      ? { duration_seconds: metricRange }
      : { reps: metricRange }),
    ...(load ? { load } : {}),
  }
}

// Optimistic local propagation matching `apply_to_remaining: true`: the edited
// field's value replaces the target of this set and every later unlogged set.
const applyTargetEditToSets = (
  exercise: WorkoutExercise,
  stateList: SetState[],
  index: number,
  field: 'weight' | 'metric',
  value: string,
) => {
  for (let i = index; i < exercise.sets.length; i++) {
    if (stateList[i]?.done) continue
    const targetSet = exercise.sets[i]
    if (!targetSet) continue
    if (field === 'metric') {
      if (exercise.metric === 'time') targetSet.targetTime = value
      else targetSet.targetReps = value
    } else {
      targetSet.targetWeight = value
    }
  }
}

type TargetEditSnapshotEntry = { index: number; reps?: string; time?: string; weight?: string }

const captureTargetEditSnapshot = (
  exercise: WorkoutExercise,
  stateList: SetState[],
  index: number,
): TargetEditSnapshotEntry[] => {
  const snapshot: TargetEditSnapshotEntry[] = []
  for (let i = index; i < exercise.sets.length; i++) {
    if (stateList[i]?.done) continue
    const targetSet = exercise.sets[i]
    snapshot.push({ index: i, reps: targetSet?.targetReps, time: targetSet?.targetTime, weight: targetSet?.targetWeight })
  }
  return snapshot
}

const restoreTargetEditSnapshot = (
  exercise: WorkoutExercise,
  field: 'weight' | 'metric',
  snapshot: TargetEditSnapshotEntry[],
) => {
  snapshot.forEach((entry) => {
    const targetSet = exercise.sets[entry.index]
    if (!targetSet) return
    if (field === 'metric') {
      if (exercise.metric === 'time') targetSet.targetTime = entry.time
      else targetSet.targetReps = entry.reps
    } else {
      targetSet.targetWeight = entry.weight
    }
  })
}

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
    return { exercises: [], extras: [] }
  }, [])
  const initialSetLogs = useMemo(
    () => buildSetLogsForExercises(initialWorkout.exercises),
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
    [(initialDay?.date ?? todayId)]: initialSetLogs,
  })

  const workoutExercisesRef = useRef<WorkoutExercise[]>(initialDay?.exercises ?? [])
  const workoutExtrasRef = useRef<WorkoutExtra[]>(initialDay?.extras ?? [])
  const setLogsRef = useRef<Record<string, SetState[]>>(initialSetLogs)
  const [dataVersion, setDataVersion] = useState(0)
  const [logPending, setLogPending] = useState(false)
  const logPendingRef = useRef(false)
  const [activeView, setActiveView] = useState<'home' | 'workout' | 'profile'>('workout')
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
  const [activeEntryType, setActiveEntryType] = useState<ActiveEntryType>(null)
  const activeEntryRef = useRef<{ id: string | null, type: ActiveEntryType }>({ id: null, type: null })
  const [editingSet, setEditingSet] = useState<{ exerciseId: string, index: number } | null>(null)
  const [dayNoteSaving, setDayNoteSaving] = useState(false)
  const [exerciseFeedbackSaving, setExerciseFeedbackSaving] = useState(false)
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
  const [miniModelControl, setMiniModelControl] = useState<ModelControl | null>(null)
  const [miniModelSelectionPending, setMiniModelSelectionPending] = useState(false)
  const [coachMessagesByScope, setCoachMessagesByScope] = useState<Record<string, ChatMessage[]>>({})
  const [swapOpen, setSwapOpen] = useState(false)
  const [swapLoading, setSwapLoading] = useState(false)
  const [swapError, setSwapError] = useState<string | null>(null)
  const [swapCandidates, setSwapCandidates] = useState<SwapCandidate[]>([])
  const [swappingCandidateId, setSwappingCandidateId] = useState<string | null>(null)
  const [workoutHistoryOpen, setWorkoutHistoryOpen] = useState(false)
  const [workoutHistoryLoading, setWorkoutHistoryLoading] = useState(false)
  const [workoutHistoryError, setWorkoutHistoryError] = useState<string | null>(null)
  const [workoutHistoryItems, setWorkoutHistoryItems] = useState<BackendWorkout[]>([])
  const workoutHistoryRequestRef = useRef(0)
  const swapResponseRef = useRef<SwapCandidates | null>(null)
  const swapExerciseIdRef = useRef<string | null>(null)
  const [chatInput, setChatInput] = useState('')
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
  const [profile, setProfile] = useState<ProfileState>(() => ({
    language: initialLanguage,
    fontScale: getInitialFontScale(),
  }))
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState('')
  const [privyAuthError, setPrivyAuthError] = useState<string | null>(null)
  const [coachActAsLinkId, setCoachActAsLinkId] = useState<string | null>(null)
  const [coachActAsLabel, setCoachActAsLabel] = useState('')
  const [coachActAsPermissions, setCoachActAsPermissions] = useState<CoachPermissions | null>(null)
  const coachActAsOwnerId = coachActAsLinkId
  const coachCanEditPrograms = !coachActAsLinkId || coachActAsPermissions?.edit_programs === true
  const coachActAsLinkIdRef = useRef<string | null>(null)
  coachActAsLinkIdRef.current = coachActAsLinkId
  // Canonical /v1 calls carry the act-as link as a query parameter; the server
  // re-checks the stored link on every request, so no trust is cached here.
  const withCoachActAs = useCallback((url: string) => {
    const linkId = coachActAsLinkIdRef.current
    if (!linkId) return url
    return `${url}${url.includes('?') ? '&' : '?'}act_as_link_id=${encodeURIComponent(linkId)}`
  }, [])
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
  // Coach chat in the trainee's context follows the legacy rule: the link
  // must carry view_progress, and edit_programs implies coach chat
  // (chat_as_coach has no new-schema equivalent). The home tab stays the
  // coach's own and remains unavailable in coach mode.
  const coachChatEnabled = !coachActAsLinkId
    || (coachActAsPermissions?.view_progress === true && coachActAsPermissions?.edit_programs === true)
  const selectedModelPreset = modelControl?.presets.find((preset) => preset.id === modelControl.selected_id)
  const selectedModelLabel = presetLabel(selectedModelPreset, modelControl?.models)
  const modelOptions = useMemo(() => buildModelOptions(modelControl), [modelControl])
  const selectedModelValue = useMemo(() => selectedModelValueFor(modelControl), [modelControl])
  const miniSelectedModelPreset = miniModelControl?.presets.find((preset) => preset.id === miniModelControl.selected_id)
  const miniSelectedModelLabel = presetLabel(miniSelectedModelPreset, miniModelControl?.models)
  const miniModelOptions = useMemo(() => buildModelOptions(miniModelControl), [miniModelControl])
  const miniSelectedModelValue = useMemo(() => selectedModelValueFor(miniModelControl), [miniModelControl])
  const chatBodyRef = useRef<HTMLDivElement>(null)
  const chatBottomFrameRef = useRef<number | null>(null)
  const chatBottomTimeoutRef = useRef<number | null>(null)
  const layoutViewportHeightRef = useRef(0)
  const workoutRevisionByOwnerDateRef = useRef<Record<string, string>>({})
  const workoutIdByOwnerDateRef = useRef<Record<string, string>>({})
  const syncedSetKeysRef = useRef(new Map<string, string>())
  const pendingSetSyncsByDateRef = useRef<Record<string, number>>({})
  // In-flight target edits keyed by `${workoutId}:${setId}`. Logging a set
  // awaits its own pending target edit so the two writes cannot race into a
  // stale_revision.
  const pendingTargetEditsRef = useRef(new Map<string, Promise<boolean>>())
  const syncLoggedSetRef = useRef<((exerciseId: string, index: number, previous?: SetSyncRevert | null) => Promise<boolean>) | null>(null)
  const pendingWorkoutDatesRef = useRef(new Set<string>())
  const [structuralEditPending, setStructuralEditPending] = useState(false)
  // Delete tombstones: date -> server timestamp of a clear that removed the
  // record. Any fetched session at or before that time is pre-delete state
  // and must never resurrect the day, no matter which stale closure applies
  // it. Sessions created after the clear carry a newer server timestamp and
  // pass through untouched.
  const clearedWorkoutAtRef = useRef<Record<string, string>>({})
  // Latest applied plan for same-tick merges. React state read inside a
  // callback created before a re-render is stale, so a saved-session merge
  // that follows a clear in the same tick would rebuild the week from the
  // pre-clear day and write it back. Every plan written to state is mirrored
  // here so merges always start from the plan the user is looking at.
  const weekPlanRef = useRef<WeekPlan>(weekPlan)
  const sessionLoadKeyRef = useRef<string | null>(null)
  const sessionReadyRef = useRef(false)
  const sessionHydrationInProgressRef = useRef(false)
  const privyAccessTokenRef = useRef<{ token: string; expiresAtMs: number; sub: string | null } | null>(null)
  const backendHealthLastOkRef = useRef(0)
  const backendHealthPingRef = useRef<Promise<boolean> | null>(null)
  const currentWorkoutSessionIdRef = useRef('')
  const restTimerIdRef = useRef<number | null>(null)
  const restEntryRef = useRef<typeof activeEntryRef.current | null>(null)
  const lastVisibilityStateRef = useRef<DocumentVisibilityState>(document.visibilityState)
  const savedWorkoutHydrationInFlightKeyRef = useRef<string | null>(null)
  const savedWorkoutHydrationAttemptedKeysRef = useRef(new Set<string>())
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const wakeLockWantedRef = useRef(false)
  const holdTimerIdRef = useRef<number | null>(null)
  const holdCompletionHandledRef = useRef(false)
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

  const handleActiveViewChange = useCallback((view: 'home' | 'workout' | 'profile') => {
    if (view === 'home' && coachActAsLinkId && !coachChatEnabled) return
    dismissKeyboard()
    setActiveView(view)
    resetAppViewportScroll()
    requestAnimationFrame(resetAppViewportScroll)
    window.setTimeout(resetAppViewportScroll, 250)
  }, [coachActAsLinkId, coachChatEnabled, dismissKeyboard, resetAppViewportScroll])

  const isPlanEditableDate = useCallback((dateId?: string | null) => {
    if (!dateId) return false
    return true
  }, [])

  const bumpData = useCallback(() => {
    setDataVersion((value) => value + 1)
  }, [])

  const selectedDay = useMemo(() => (
    weekPlan.days[selectedDayIndex] ?? weekPlan.days[0]
  ), [selectedDayIndex, weekPlan.days])

  const selectedDayLabel = useMemo(() => {
    const parsed = selectedDay?.date ? parseDateId(selectedDay.date) : null
    return parsed
      ? getWeekdayFullLabel(parsed, profile.language)
      : (selectedDay?.label ?? t('workout.sectionWorkout'))
  }, [profile.language, selectedDay?.date, selectedDay?.label, t])

  const displayedWorkoutExtras = useMemo(
    () => workoutExtrasRef.current,
    [dataVersion, selectedDay?.date]
  )

  // The public v1 API supports canonical reads, generation, and per-set
  // actual logging. Arbitrary plan/set rewrites have no browser contract.
  const canGenerateWorkoutSelectedDay = useMemo(() => (
    isPlanEditableDate(selectedDay?.date ?? todayId) && coachCanEditPrograms
  ), [coachCanEditPrograms, isPlanEditableDate, selectedDay?.date, todayId])

  // Plan edits (add/remove set, edit target, remove exercise/circuit/section)
  // use the same editable-date rule as generation and never enable in the
  // read-only coach view.
  const canEditPlanSelectedDay = useMemo(() => (
    isPlanEditableDate(selectedDay?.date ?? todayId) && coachCanEditPrograms
  ), [coachCanEditPrograms, isPlanEditableDate, selectedDay?.date, todayId])

  const canLogSelectedDay = useMemo(() => {
    if (!canQuerySavedWorkoutSessions || !coachCanEditPrograms) return false
    const ownerId = coachActAsOwnerId ?? currentUserId
    const key = `${ownerId}:${selectedDay?.date ?? todayId}`
    return Boolean(workoutIdByOwnerDateRef.current[key] && workoutRevisionByOwnerDateRef.current[key])
  }, [canQuerySavedWorkoutSessions, coachActAsOwnerId, coachCanEditPrograms, currentUserId, selectedDay?.date, todayId, dataVersion])

  // Clear day acts on a canonical workout and is offered while something
  // unlogged remains to remove; fully logged history has nothing to clear.
  const canClearSelectedDay = useMemo(() => {
    if (!canQuerySavedWorkoutSessions || !coachCanEditPrograms) return false
    const targetDate = selectedDay?.date ?? todayId
    const ownerId = coachActAsOwnerId ?? currentUserId
    if (!workoutIdByOwnerDateRef.current[`${ownerId}:${targetDate}`]) return false
    const day = selectedDay
    if (!day) return false
    const logsForDay = weekSetLogsRef.current[targetDate] ?? {}
    const hasLogged = day.exercises.some((exercise) => (
      (logsForDay[exercise.id] ?? []).some((set) => set.done)
    ))
    const hasUnlogged = day.exercises.some((exercise) => {
      const states = logsForDay[exercise.id] ?? []
      return exercise.sets.some((_, index) => !states[index]?.done)
    }) || day.extras.length > 0
    return hasLogged ? hasUnlogged : (day.exercises.length > 0 || day.extras.length > 0)
  }, [canQuerySavedWorkoutSessions, coachActAsOwnerId, coachCanEditPrograms, currentUserId, dataVersion, selectedDay, todayId])

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

    if (!weekSetLogsRef.current[day.date]) {
      weekSetLogsRef.current[day.date] = buildSetLogsForExercises(day.exercises, weekSetLogsRef.current[day.date])
    }

    setLogsRef.current = weekSetLogsRef.current[day.date]
    currentWorkoutSessionIdRef.current = day.date
  }, [])

  const getExercise = useCallback((id: string) => (
    workoutExercisesRef.current.find((exercise) => exercise.id === id)
  ), [])

  const getCircuitItems = useCallback((circuitKey: string) => (
    workoutExercisesRef.current
      .map((exercise, index) => ({ exercise, index }))
      .filter((item) => circuitGroupKey(item.exercise.circuit) === circuitKey)
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

  const getNextPendingCircuitExercise = useCallback((circuitKey: string): WorkoutExercise | null => {
    return getNextCircuitSet(
      getCircuitItems(circuitKey).map(({ exercise }) => exercise), setLogsRef.current,
    )?.exercise ?? null
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
    restEntryRef.current = null
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
    restEntryRef.current = activeEntryRef.current
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
    const logs = buildSetLogsForExercises(exercises)
    weekSetLogsRef.current[targetDate] = logs
    setLogsRef.current = logs
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
    preferToday?: boolean
    preserveActiveEntry?: boolean
  }) => {
    let activePlan = plan
    let nextLogs = options?.logsByDay ? { ...options.logsByDay } : { ...weekSetLogsRef.current }
    const previousDay = weekPlanRef.current.days[selectedDayIndexRef.current]
    const previousLogs = previousDay ? weekSetLogsRef.current[previousDay.date] : undefined
    const activeEntry = activeEntryRef.current
    const previousExercise = activeEntry.type === 'exercise'
      ? previousDay?.exercises.find((exercise) => exercise.id === activeEntry.id)
      : null

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
      todayIndex = findDayIndexByDate(activePlan.days, todayId)
    }

    activePlan.days.forEach((day) => {
      if (!nextLogs[day.date]) {
        nextLogs[day.date] = buildSetLogsForExercises(day.exercises)
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
    selectedDayIndexRef.current = safeIndex
    setSelectedDayIndex(safeIndex)
    weekPlanRef.current = activePlan
    setWeekPlan(activePlan)
    syncDayRefs(activePlan, safeIndex)
    const nextSelectedDay = activePlan.days[safeIndex]
    // Selection is navigation state; it must not restart account hydration.
    const sameExercise = nextSelectedDay?.exercises.find((exercise) => exercise.id === activeEntry.id)
    const oldHadOpenSets = previousExercise?.sets.some((_, index) => (
      !previousLogs?.[previousExercise.id]?.[index]?.done
      && !previousLogs?.[previousExercise.id]?.[index]?.skipped
    ))
    const oldNowHasOpenSets = sameExercise?.sets.some((_, index) => (
      !nextLogs[nextSelectedDay?.date ?? '']?.[sameExercise.id]?.[index]?.done
      && !nextLogs[nextSelectedDay?.date ?? '']?.[sameExercise.id]?.[index]?.skipped
    ))
    const slotReplacement = previousExercise?.slotId && (!sameExercise || (oldHadOpenSets && !oldNowHasOpenSets))
      ? nextSelectedDay?.exercises.find((exercise) => (
        exercise.slotId === previousExercise.slotId
        && exercise.id !== activeEntry.id
        && nextLogs[nextSelectedDay.date]?.[exercise.id]?.some((set) => !set.done && !set.skipped)
      ))
      : null
    const selectedExercise = slotReplacement ?? sameExercise
      ?? (previousExercise?.slotId
        ? nextSelectedDay?.exercises.find((exercise) => exercise.slotId === previousExercise.slotId)
        : null)
    if (options?.preserveActiveEntry && activeEntry.type === 'exercise' && selectedExercise) {
      if (selectedExercise.id !== activeEntry.id) {
        activeEntryRef.current = { id: selectedExercise.id, type: 'exercise' }
        setActiveEntryId(selectedExercise.id)
      }
    } else if (!(options?.preserveActiveEntry && activeEntry.type === 'extra'
      && nextSelectedDay?.extras.some((extra) => extra.id === activeEntry.id))) {
      hideWorkoutDetail()
    }
    bumpData()
  }, [bumpData, hideWorkoutDetail, profile.language, syncDayRefs, todayId, weekStartDayIndex])

  // Mirror every plan that reaches state (including functional writers) so
  // same-tick saved-session merges never rebuild from an older week.
  useEffect(() => {
    weekPlanRef.current = weekPlan
  }, [weekPlan])

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
      missingDays.forEach((day) => {
        nextLogs[day.date] = buildSetLogsForExercises(day.exercises)
      })
      const nextPlan: WeekPlan = {
        ...weekPlan,
        days: [...weekPlan.days, ...missingDays].sort((a, b) => a.date.localeCompare(b.date)),
      }

      applyWeekPlan(nextPlan, {
        selectedDate: normalizedDateId,
        logsByDay: nextLogs,
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

  const logNextSet = useCallback(async (targetExerciseId?: string) => {
    if (!canLogSelectedDay || logPendingRef.current) return
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
      const pendingExercise = getNextPendingCircuitExercise(circuitGroupKey(exercise.circuit) ?? exercise.circuit.name)
      if (pendingExercise && pendingExercise.id !== exercise.id) {
        exercise = pendingExercise
        stateList = ensureExerciseStateList(exercise)
        nextIndex = exercise.sets.findIndex((_, index) => !stateList[index]?.done)
        showWorkoutDetail(exercise.id, 'exercise')
      }
    }
    if (nextIndex === -1) return

    const entryAtLog = activeEntryRef.current
    const dateAtLog = currentWorkoutSessionIdRef.current
    const circuitExercises = exercise.circuit
      ? getCircuitItems(circuitGroupKey(exercise.circuit)!).map(({ exercise }) => exercise)
      : []
    const roundBefore = getNextCircuitSet(circuitExercises, setLogsRef.current)?.round
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
    logPendingRef.current = true
    setLogPending(true)
    stopRest()
    itemState.done = true
    bumpData()
    let saved = false
    try {
      saved = await syncLoggedSetRef.current?.(exercise.id, nextIndex) ?? false
    } finally {
      logPendingRef.current = false
      setLogPending(false)
    }
    // Saving may finish after the user browsed elsewhere. Navigation belongs
    // to the current interaction, even when they opened the same move again.
    if (!saved || activeEntryRef.current !== entryAtLog
      || currentWorkoutSessionIdRef.current !== dateAtLog) return

    const circuitName = exercise.circuit?.name
    const isWarmupSet = targetSet?.isWarmup === true
    if (circuitName && isWarmupSet && stateList.some((set) => !set.done)) {
      return
    }

    if (circuitName) {
      const next = getNextCircuitSet(circuitExercises, setLogsRef.current, exercise.id)
      if (!next) {
        hideWorkoutDetail()
        return
      }
      const roundCompleted = roundBefore !== undefined && roundBefore >= 0 && next.round > roundBefore
      // At a new round use circuit order; within it continue after the move
      // just logged, catching up any earlier unfinished round first.
      const target = roundCompleted ? getNextCircuitSet(circuitExercises, setLogsRef.current)! : next
      showWorkoutDetail(target.exercise.id, 'exercise')
      if (roundCompleted) {
        const restDuration = exercise.circuit?.restAfterSec ?? exercise.restSec ?? restDefaultSec
        if (restDuration > 0) startRest(restDuration)
      }
      return
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
    resetHoldTimer,
    startRest,
    stopRest,
    showWorkoutDetail,
    canLogSelectedDay,
  ])

  const logHoldTimerSet = useCallback(() => {
    if (!holdTimer.exerciseId || holdTimer.setIndex === null) return
    if (activeEntryRef.current.type !== 'exercise' || activeEntryRef.current.id !== holdTimer.exerciseId) return

    const exercise = getExercise(holdTimer.exerciseId)
    if (!exercise) return
    const stateList = setLogsRef.current[holdTimer.exerciseId]
    const setItem = stateList?.[holdTimer.setIndex]
    if (!setItem || setItem.done || logPendingRef.current) return

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
    void logNextSet(holdTimer.exerciseId)
  }, [getExercise, holdTimer, logNextSet, startHoldTimer, stopHoldTimer])

  const updateSetField = useCallback(
    (exerciseId: string, index: number, field: 'weight' | 'metric', value: string, propagate = false) => {
      if (!canLogSelectedDay) return
      const exercise = getExercise(exerciseId)
      if (!exercise) return
      const stateList = ensureExerciseStateList(exercise)
      const setItem = stateList[index]
      if (!setItem) return

      // Legacy inherit: typing in the next-set hero carries the value to every
      // remaining unlogged set, so the following set logs what the user did
      // instead of the suggested target. Editing a logged set stays local.
      if (field === 'weight') {
        setItem.weight = value
        setItem.value_source = value.trim() ? 'user_entered' : undefined
        if (propagate) {
          for (let i = index + 1; i < stateList.length; i++) {
            if (stateList[i]?.done) continue
            stateList[i].weight = value
            stateList[i].value_source = value.trim() ? 'user_entered' : undefined
          }
        }
      } else {
        setItem.metric = value
        if (propagate) {
          for (let i = index + 1; i < stateList.length; i++) {
            if (stateList[i]?.done) continue
            stateList[i].metric = value
          }
        }
      }

      bumpData()
    },
    [bumpData, canLogSelectedDay, ensureExerciseStateList, getExercise]
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
  ) => {
    const timestamp = Date.now()
    const html = variant === 'ai' ? await marked.parse(message) : undefined
    const entry: ChatMessage = {
      id: `${timestamp}-${Math.random()}`,
      variant,
      text: message,
      html,
      timestamp,
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
    // Key the thread by blueprint slot (stable across swaps) with the
    // exercise instance as fallback for slot-less items. The payload still
    // sends the current exercise_instance_id so the agent answers from the
    // exercise the user sees.
    const slotId = workoutExercisesRef.current.find((exercise) => exercise.id === exerciseId)?.slotId
    return `coach:${sessionId}:${slotId || exerciseId}`
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

  const fetchFreshModelControl = useCallback(async (scope?: string) => {
    const url = scope ? `${API_BASE_URL}/chat/models?scope=${scope}` : `${API_BASE_URL}/chat/models`
    const response = await apiFetch(url, {
      headers: await getPrivyAuthHeaders(),
    })
    if (!response.ok) throw new Error(`Failed to load Ez models (${response.status})`)
    return (await response.json()) as ModelControl
  }, [getPrivyAuthHeaders])

  const refreshModelControl = useCallback(async () => {
    if (!privyReady || !privyAuthenticated) {
      setModelControl(null)
      return
    }
    setModelControl(await fetchFreshModelControl())
  }, [fetchFreshModelControl, privyAuthenticated, privyReady])

  const handleModelSelection = useCallback(async (value: string) => {
    const option = modelOptions.find((item) => item.value === value)
    if (!option || !modelControl || modelSelectionPending) return
    setModelSelectionPending(true)
    const postModelChoice = async (expectedSession: string | null) => {
      const response = await apiFetch(`${API_BASE_URL}/chat/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() },
        body: JSON.stringify({
          expected_session: expectedSession,
          cli: option.cli,
          provider: option.provider,
          model: option.model,
          effort: option.effort,
        }),
      })
      if (!response.ok) throw new Error(`Failed to select Ez model (${response.status})`)
      return (await response.json()) as ModelControl
    }
    try {
      try {
        setModelControl(await postModelChoice(modelControl.active_session_id))
      } catch {
        // The stored active session can go stale (another tab or a prior
        // switch rotated it) and Ez rejects the guarded POST. Reload the
        // fresh control and retry once with its session instead of leaving
        // the picker stuck on the old model.
        const fresh = await fetchFreshModelControl()
        if (selectedModelValueFor(fresh) === value) {
          setModelControl(fresh)
        } else {
          setModelControl(await postModelChoice(fresh.active_session_id))
        }
      }
      setMessages([])
      setChatInput('')
    } catch (error) {
      console.error('Ez model selection failed:', error)
      await refreshModelControl().catch(() => undefined)
    } finally {
      setModelSelectionPending(false)
    }
  }, [fetchFreshModelControl, getPrivyAuthHeaders, modelControl, modelOptions, modelSelectionPending, refreshModelControl])

  const refreshMiniModelControl = useCallback(async () => {
    if (!privyReady || !privyAuthenticated) {
      setMiniModelControl(null)
      return
    }
    setMiniModelControl(await fetchFreshModelControl(MINI_CHAT_SCOPE))
  }, [fetchFreshModelControl, privyAuthenticated, privyReady])

  const handleMiniModelSelection = useCallback(async (value: string) => {
    const option = miniModelOptions.find((item) => item.value === value)
    if (!option || !miniModelControl || miniModelSelectionPending) return
    setMiniModelSelectionPending(true)
    const postMiniModelChoice = async (expectedSession: string | null) => {
      const response = await apiFetch(`${API_BASE_URL}/chat/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() },
        body: JSON.stringify({
          expected_session: expectedSession,
          scope: MINI_CHAT_SCOPE,
          cli: option.cli,
          provider: option.provider,
          model: option.model,
          effort: option.effort,
        }),
      })
      if (!response.ok) throw new Error(`Failed to select mini-chat Ez model (${response.status})`)
      return (await response.json()) as ModelControl
    }
    try {
      try {
        setMiniModelControl(await postMiniModelChoice(miniModelControl.active_session_id))
      } catch {
        // Same stale-session recovery as the main picker: reload the fresh
        // scope control and retry once with its session.
        const fresh = await fetchFreshModelControl(MINI_CHAT_SCOPE)
        if (selectedModelValueFor(fresh) === value) {
          setMiniModelControl(fresh)
        } else {
          setMiniModelControl(await postMiniModelChoice(fresh.active_session_id))
        }
      }
    } catch (error) {
      console.error('Mini-chat model selection failed:', error)
      await refreshMiniModelControl().catch(() => undefined)
    } finally {
      setMiniModelSelectionPending(false)
    }
  }, [fetchFreshModelControl, getPrivyAuthHeaders, miniModelControl, miniModelOptions, miniModelSelectionPending, refreshMiniModelControl])

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

    const enqueueResponse = await apiFetch(`${API_BASE_URL}/chat/async`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

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

    const params = new URLSearchParams({
      user_id: payload.user_id,
      ...(payload.act_as_link_id ? { act_as_link_id: payload.act_as_link_id } : {}),
    })

    const startedAt = Date.now()
    while (Date.now() - startedAt < CHAT_JOB_MAX_WAIT_MS) {
      await new Promise((resolve) => window.setTimeout(resolve, CHAT_JOB_POLL_MS))

      // Chat jobs can outlive the short-lived Privy token used to enqueue
      // them. Do not reuse the initial headers or a completed reply becomes
      // invisible to the user when its final poll is rejected with 401.
      const pollHeaders = await getPrivyAuthHeaders()
      const pollResponse = await apiFetch(
        `${API_BASE_URL}/chat/jobs/${encodeURIComponent(jobId)}?${params.toString()}`,
        { headers: pollHeaders }
      )

      if (!pollResponse.ok) {
        throw new Error(`Chat job poll failed (${pollResponse.status})`)
      }

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
    const response = await apiFetch(withCoachActAs(`${API_BASE_URL}/v1/workouts?${params.toString()}`), { headers })
    if (!response.ok) {
      throw new Error(`Failed to load workout sessions (${response.status})`)
    }
    const requestedDates = new Set(dateIds)
    const workouts = await response.json() as Array<NonNullable<BackendWorkoutReceipt['workout']>>
    const sessions = workouts
      .filter((workout) => requestedDates.has(workout.date))
      .map((workout) => backendWorkoutToSession(workout, currentUserId))
      .filter((session) => {
        // Drop pre-delete snapshots: the record they describe is gone and
        // applying them would resurrect a cleared day.
        const tombstone = clearedWorkoutAtRef.current[session.date]
        return !tombstone || (session.updated_at ? session.updated_at > tombstone : false)
      })
    const ownerId = coachActAsOwnerId ?? currentUserId
    sessions.forEach((session) => {
      // Coach mode must register the canonical refs under the act-as owner:
      // every act-as read/edit resolves them through that key, so keying by
      // the coach's user id left logging and plan edits disabled.
      const ownerKey = `${ownerId}:${session.date}`
      // Never resurrect refs for a deleted record either; newer sessions
      // already passed the tombstone filter above.
      const tombstone = clearedWorkoutAtRef.current[session.date]
      if (tombstone && !(session.updated_at && session.updated_at > tombstone)) return
      if (session.session_id) workoutIdByOwnerDateRef.current[ownerKey] = session.session_id
      if (!session.revision) return
      workoutRevisionByOwnerDateRef.current[ownerKey] = session.revision
    })
    return sessions
  }, [
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    currentUserId,
    getPrivyAuthHeaders,
    privyAuthenticated,
    privyReady,
    withCoachActAs,
  ])

  const applySavedWorkoutSessionsToWeek = useCallback((
    sessions: WorkoutSession[],
    options: { preserveSelectedDate?: boolean, selectedDate?: string, preserveActiveEntry?: boolean } = {},
  ) => {
    if (sessions.length === 0) return false

    let nextDays = weekPlanRef.current.days
    const nextLogs: WeekSetLogs = { ...weekSetLogsRef.current }
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
      nextLogs[targetDate] = buildSetLogsForExercises(exercises, storedLogs)
      const ownerKey = `${ownerId}:${targetDate}`
      if (session.session_id) workoutIdByOwnerDateRef.current[ownerKey] = session.session_id
      if (session.revision) {
        workoutRevisionByOwnerDateRef.current[ownerKey] = session.revision
      }
      appliedDates.push(targetDate)
    })

    if (appliedDates.length === 0) return false
    // An explicit selectedDate wins. Otherwise preserve live navigation:
    // the async caller's selectedDay may precede a more recent day selection.
    const selectedDate = options.selectedDate
      ?? (options.preserveSelectedDate
        ? (weekPlanRef.current.days[selectedDayIndexRef.current]?.date ?? todayId)
        : appliedDates[appliedDates.length - 1])
    const previousHydrationState = sessionHydrationInProgressRef.current
    sessionHydrationInProgressRef.current = true
    try {
      applyWeekPlan(
        {
          weekStart: weekPlanRef.current.weekStart || appliedDates[0],
          days: nextDays,
        },
        {
          selectedDate,
          logsByDay: nextLogs,
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

  const applySavedWorkoutSessionToWeek = useCallback((session: WorkoutSession, preserveActiveEntry = false) => (
    applySavedWorkoutSessionsToWeek([session], { preserveActiveEntry })
  ), [applySavedWorkoutSessionsToWeek])

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

        let nextDays = weekPlanRef.current.days
        const nextLogs: WeekSetLogs = { ...weekSetLogsRef.current }
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

          nextLogs[targetDate] = buildSetLogsForExercises(savedExercises, savedLogs)
          changed = true
        })

        if (!changed) return

        const previousHydrationState = sessionHydrationInProgressRef.current
        sessionHydrationInProgressRef.current = true
        try {
          applyWeekPlan(
            {
              weekStart: weekPlanRef.current.weekStart || nextDays[0]?.date || todayId,
              days: nextDays,
            },
            {
              selectedDate: selectedDay?.date ?? todayId,
              logsByDay: nextLogs,
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

  const restoreSetState = useCallback((exerciseId: string, index: number, previous?: SetSyncRevert | null) => {
    const currentList = setLogsRef.current[exerciseId]
    const currentItem = currentList?.[index]
    if (!currentItem) return
    if (previous) {
      currentItem.weight = previous.weight
      currentItem.metric = previous.metric
      currentItem.done = previous.done
      currentItem.skipped = previous.skipped
      currentItem.value_source = previous.value_source
    } else if (currentItem.done) {
      currentItem.done = false
      currentItem.skipped = undefined
    } else {
      return
    }
    bumpData()
  }, [bumpData])

  const syncLoggedSet = useCallback(async (exerciseId: string, index: number, previous?: SetSyncRevert | null) => {
    // Navigation waits for the canonical actual. Any local failure clears
    // the optimistic done flag on the originating day.
    const originalItem = setLogsRef.current[exerciseId]?.[index]
    const revertLocal = () => {
      if (!originalItem) return
      if (previous) Object.assign(originalItem, previous)
      else { originalItem.done = false; originalItem.skipped = undefined }
      bumpData()
    }
    if (!canQuerySavedWorkoutSessions) { revertLocal(); return false }
    const ownerId = coachActAsOwnerId ?? currentUserId
    const targetDate = selectedDay?.date ?? todayId
    const ownerKey = `${ownerId}:${targetDate}`
    const workoutId = workoutIdByOwnerDateRef.current[ownerKey]
    const revision = workoutRevisionByOwnerDateRef.current[ownerKey]
    const exercise = getExercise(exerciseId)
    const stateList = setLogsRef.current[exerciseId]
    const setItem = stateList?.[index]
    const setTarget = exercise?.sets[index]
    if (!workoutId || !revision || !exercise || !setItem || !setTarget?.setId || !setItem.done) { revertLocal(); return false }

    const skipped = setItem.skipped === true
    const load = skipped ? null : parseActualLoad(setItem.weight)
    const metric = skipped ? null : parseActualMetric(exercise, setItem.metric)
    if (!skipped && !metric) { revertLocal(); return false }

    const setKey = `${workoutId}:${setTarget.setId}`
    const fingerprint = JSON.stringify([skipped ? 'skipped' : metric, skipped ? null : load])
    if (syncedSetKeysRef.current.get(setKey) === fingerprint) return true

    // A target edit on this set may still be in flight. Wait for it so the
    // log write uses the post-edit revision instead of racing it into a
    // stale_revision.
    const pendingTarget = pendingTargetEditsRef.current.get(setKey)
    if (pendingTarget) await pendingTarget
    const expectedRevision = workoutRevisionByOwnerDateRef.current[ownerKey]
    if (!expectedRevision) { revertLocal(); return false }

    const pending = pendingSetSyncsByDateRef.current
    pending[targetDate] = (pending[targetDate] ?? 0) + 1
    pendingWorkoutDatesRef.current.add(targetDate)
    let refetchAfterSync = false
    try {
      const headers = { 'Content-Type': 'application/json', ...(await getPrivyAuthHeaders()) }
      const response = await apiFetch(
        withCoachActAs(`${API_BASE_URL}/v1/workouts/${encodeURIComponent(workoutId)}/sets/${encodeURIComponent(setTarget.setId)}`),
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            actual: skipped ? { status: 'skipped' } : { status: 'completed', ...metric, ...(load ? { load } : {}) },
            expected_revision: expectedRevision,
            request_id: crypto.randomUUID(),
          }),
        },
      )
      if (response.status === 409) {
        // Canonical state moved on (agent edit or another tab). Pull it back in
        // instead of retrying this write; if the pull fails, drop the
        // optimistic state so the UI never shows an unconfirmed actual.
        delete workoutRevisionByOwnerDateRef.current[ownerKey]
        revertLocal()
        refetchAfterSync = true
        return false
      }
      if (!response.ok) throw new Error(`Set log failed (${response.status})`)
      const receipt = await response.json() as BackendWorkoutReceipt
      const nextRevision = receipt.revision ?? receipt.workout?.revision
      if (nextRevision) workoutRevisionByOwnerDateRef.current[ownerKey] = nextRevision
      syncedSetKeysRef.current.set(setKey, fingerprint)
      return true
    } catch (error) {
      console.warn('Canonical set log failed:', error)
      revertLocal()
      return false
    } finally {
      const remaining = (pending[targetDate] ?? 1) - 1
      if (remaining <= 0) {
        delete pending[targetDate]
        pendingWorkoutDatesRef.current.delete(targetDate)
      } else {
        pending[targetDate] = remaining
      }
      if (refetchAfterSync) {
        const refreshed = await refreshVisibleWorkoutSessions().catch(() => false)
        if (!refreshed) revertLocal()
      }
    }
  }, [
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    currentUserId,
    getExercise,
    getPrivyAuthHeaders,
    refreshVisibleWorkoutSessions,
    bumpData,
    selectedDay?.date,
    todayId,
  ])

  const unlogLoggedSet = useCallback(async (exerciseId: string, index: number, previous?: SetSyncRevert | null) => {
    // Undo removes the canonical actual, then the local state returns to
    // pending; a failed undo restores the logged state.
    const revertLocal = () => restoreSetState(exerciseId, index, previous)
    if (!canQuerySavedWorkoutSessions) { revertLocal(); return }
    const ownerId = coachActAsOwnerId ?? currentUserId
    const targetDate = selectedDay?.date ?? todayId
    const ownerKey = `${ownerId}:${targetDate}`
    const workoutId = workoutIdByOwnerDateRef.current[ownerKey]
    const revision = workoutRevisionByOwnerDateRef.current[ownerKey]
    const exercise = getExercise(exerciseId)
    const stateList = setLogsRef.current[exerciseId]
    const setItem = stateList?.[index]
    const setTarget = exercise?.sets[index]
    if (!workoutId || !revision || !exercise || !setItem || !setTarget?.setId) { revertLocal(); return }

    const pending = pendingSetSyncsByDateRef.current
    pending[targetDate] = (pending[targetDate] ?? 0) + 1
    pendingWorkoutDatesRef.current.add(targetDate)
    let refetchAfterSync = false
    try {
      const headers = { 'Content-Type': 'application/json', ...(await getPrivyAuthHeaders()) }
      const response = await apiFetch(
        withCoachActAs(`${API_BASE_URL}/v1/workouts/${encodeURIComponent(workoutId)}/sets/${encodeURIComponent(setTarget.setId)}/unlog`),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ expected_revision: revision, request_id: crypto.randomUUID() }),
        },
      )
      if (response.status === 409) {
        delete workoutRevisionByOwnerDateRef.current[ownerKey]
        refetchAfterSync = true
        return
      }
      if (!response.ok) throw new Error(`Set undo failed (${response.status})`)
      const receipt = await response.json() as BackendWorkoutReceipt
      const nextRevision = receipt.revision ?? receipt.workout?.revision
      if (nextRevision) workoutRevisionByOwnerDateRef.current[ownerKey] = nextRevision
      syncedSetKeysRef.current.delete(`${workoutId}:${setTarget.setId}`)
    } catch (error) {
      console.warn('Canonical set undo failed:', error)
      revertLocal()
    } finally {
      const remaining = (pending[targetDate] ?? 1) - 1
      if (remaining <= 0) {
        delete pending[targetDate]
        pendingWorkoutDatesRef.current.delete(targetDate)
      } else {
        pending[targetDate] = remaining
      }
      if (refetchAfterSync) {
        const refreshed = await refreshVisibleWorkoutSessions().catch(() => false)
        if (!refreshed) revertLocal()
      }
    }
  }, [
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    currentUserId,
    getExercise,
    getPrivyAuthHeaders,
    refreshVisibleWorkoutSessions,
    restoreSetState,
    selectedDay?.date,
    todayId,
  ])

  useEffect(() => {
    syncLoggedSetRef.current = syncLoggedSet
  }, [syncLoggedSet])


  const unlogSet = useCallback((exerciseId: string, index: number) => {
    if (!canLogSelectedDay || logPendingRef.current) return
    const exercise = getExercise(exerciseId)
    const stateList = setLogsRef.current[exerciseId]
    const setItem = stateList?.[index]
    if (!exercise || !setItem || !setItem.done) return
    const previous: SetSyncRevert = { ...setItem }
    setItem.weight = ''
    setItem.metric = ''
    setItem.value_source = undefined
    setItem.done = false
    setItem.skipped = undefined
    bumpData()
    void unlogLoggedSet(exerciseId, index, previous)
  }, [bumpData, canLogSelectedDay, getExercise, unlogLoggedSet])

  const handleSaveDayNote = useCallback(async (notes: string): Promise<boolean> => {
    if (!canQuerySavedWorkoutSessions || !coachCanEditPrograms || dayNoteSaving) return false
    const ownerId = coachActAsOwnerId ?? currentUserId
    const targetDate = selectedDay?.date ?? todayId
    const ownerKey = `${ownerId}:${targetDate}`
    const workoutId = workoutIdByOwnerDateRef.current[ownerKey]
    const revision = workoutRevisionByOwnerDateRef.current[ownerKey]
    if (!workoutId || !revision) return false

    setDayNoteSaving(true)
    try {
      const headers = { 'Content-Type': 'application/json', ...(await getPrivyAuthHeaders()) }
      const response = await apiFetch(withCoachActAs(`${API_BASE_URL}/v1/workouts/${encodeURIComponent(workoutId)}/notes`), {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ notes, expected_revision: revision, request_id: crypto.randomUUID() }),
      })
      if (response.status === 409) {
        // Canonical state moved on (agent edit or another tab). Pull it back in
        // instead of retrying; the refreshed note is the canonical value.
        delete workoutRevisionByOwnerDateRef.current[ownerKey]
        await refreshVisibleWorkoutSessions().catch(() => false)
        return false
      }
      if (!response.ok) throw new Error(`Day note save failed (${response.status})`)
      const receipt = await response.json() as BackendWorkoutReceipt
      const nextRevision = receipt.revision ?? receipt.workout?.revision
      if (nextRevision) workoutRevisionByOwnerDateRef.current[ownerKey] = nextRevision
      const savedNotes = typeof receipt.workout?.notes === 'string' ? receipt.workout.notes : notes
      setWeekPlan((previous) => ({
        ...previous,
        days: previous.days.map((day) => (day.date === targetDate ? { ...day, planNotes: savedNotes } : day)),
      }))
      return true
    } catch (error) {
      console.warn('Day note save failed:', error)
      return false
    } finally {
      setDayNoteSaving(false)
    }
  }, [
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    coachCanEditPrograms,
    currentUserId,
    dayNoteSaving,
    getPrivyAuthHeaders,
    refreshVisibleWorkoutSessions,
    selectedDay?.date,
    todayId,
    withCoachActAs,
  ])

  const handleSaveExerciseFeedback = useCallback(async (
    exerciseId: string,
    note: string,
    preset: WorkoutFeedbackPreset | null,
  ): Promise<boolean> => {
    if (!canQuerySavedWorkoutSessions || !coachCanEditPrograms || exerciseFeedbackSaving) return false
    const ownerId = coachActAsOwnerId ?? currentUserId
    const targetDate = selectedDay?.date ?? todayId
    const ownerKey = `${ownerId}:${targetDate}`
    const workoutId = workoutIdByOwnerDateRef.current[ownerKey]
    const revision = workoutRevisionByOwnerDateRef.current[ownerKey]
    if (!workoutId || !revision) return false

    setExerciseFeedbackSaving(true)
    try {
      const headers = { 'Content-Type': 'application/json', ...(await getPrivyAuthHeaders()) }
      const response = await apiFetch(
        withCoachActAs(`${API_BASE_URL}/v1/workouts/${encodeURIComponent(workoutId)}/exercises/${encodeURIComponent(exerciseId)}/notes`),
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ note, preset, expected_revision: revision, request_id: crypto.randomUUID() }),
        },
      )
      if (response.status === 409) {
        delete workoutRevisionByOwnerDateRef.current[ownerKey]
        await refreshVisibleWorkoutSessions().catch(() => false)
        return false
      }
      if (!response.ok) throw new Error(`Exercise feedback save failed (${response.status})`)
      const receipt = await response.json() as BackendWorkoutReceipt
      const nextRevision = receipt.revision ?? receipt.workout?.revision
      if (nextRevision) workoutRevisionByOwnerDateRef.current[ownerKey] = nextRevision
      const savedItem = receipt.workout?.segments
        .flatMap((segment) => segment.items)
        .find((item) => item.exercise_instance_id === exerciseId)
      const exercise = workoutExercisesRef.current.find((item) => item.id === exerciseId)
      if (exercise) {
        exercise.notes = savedItem?.notes?.note ?? note
        exercise.feedbackPreset = savedItem ? (savedItem.notes?.preset ?? null) : preset
        bumpData()
      }
      return true
    } catch (error) {
      console.warn('Exercise feedback save failed:', error)
      return false
    } finally {
      setExerciseFeedbackSaving(false)
    }
  }, [
    bumpData,
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    coachCanEditPrograms,
    currentUserId,
    exerciseFeedbackSaving,
    getPrivyAuthHeaders,
    refreshVisibleWorkoutSessions,
    selectedDay?.date,
    todayId,
    withCoachActAs,
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

  const handleOpenWorkoutHistory = useCallback(() => {
    if (!canQuerySavedWorkoutSessions) return
    setWorkoutHistoryOpen(true)
    setWorkoutHistoryLoading(true)
    setWorkoutHistoryError(null)
    const requestId = workoutHistoryRequestRef.current + 1
    workoutHistoryRequestRef.current = requestId
    fetchWorkoutHistory({
      apiBaseUrl: API_BASE_URL,
      getHeaders: getPrivyAuthHeaders,
      actAsLinkId: coachActAsLinkId,
      daysBack: 90,
      endDateId: todayId,
    })
      .then((workouts) => {
        if (workoutHistoryRequestRef.current !== requestId) return
        setWorkoutHistoryItems(workouts)
      })
      .catch(() => {
        if (workoutHistoryRequestRef.current !== requestId) return
        setWorkoutHistoryItems([])
        setWorkoutHistoryError(t('workout.workoutHistoryError'))
      })
      .finally(() => {
        if (workoutHistoryRequestRef.current === requestId) setWorkoutHistoryLoading(false)
      })
  }, [canQuerySavedWorkoutSessions, coachActAsLinkId, getPrivyAuthHeaders, t, todayId])

  const handleSelectWorkoutHistoryDate = useCallback((dateId: string) => {
    setWorkoutHistoryOpen(false)
    handleActiveViewChange('workout')
    handleSelectDay(-1, dateId)
    if (canQuerySavedWorkoutSessions) {
      fetchWorkoutSessionsByDates([dateId])
        .then((sessions) => {
          if (sessions.length > 0) {
            applySavedWorkoutSessionsToWeek(sessions, {
              selectedDate: dateId,
              preserveActiveEntry: true,
            })
          }
        })
        .catch(() => {})
    }
  }, [
    applySavedWorkoutSessionsToWeek,
    canQuerySavedWorkoutSessions,
    fetchWorkoutSessionsByDates,
    handleActiveViewChange,
    handleSelectDay,
  ])

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

    const reply = typeof data?.reply === 'string' ? data.reply : String(data?.reply ?? '')
    await handleAiReply(reply, messageId, presetLabel(data.preset, modelControl?.models))
    try {
      await refreshVisibleWorkoutSessions()
    } catch {
      // The next supported workout refresh will reconcile this view.
    }
  }, [
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

    const reply = typeof data?.reply === 'string' ? data.reply : String(data?.reply ?? '')
    await handleCoachReply(reply, scopeId, exerciseId, messageId, presetLabel(data.preset, modelControl?.models))
    try {
      await refreshVisibleWorkoutSessions()
    } catch {
      // Chat remains usable while workout APIs are intentionally unsupported.
    }
  }, [
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
    if (coachActAsLinkId) {
      const scopeId = `coach-link:${coachActAsLinkId}`
      await addCoachMessage(scopeId, value, 'user')
      const statusId = addCoachThinkingMessage(scopeId)
      const targetDate = selectedDay?.date ?? todayId
      const expectedRevision = workoutRevisionByOwnerDateRef.current[`${coachActAsOwnerId}:${targetDate}`]
      try {
        const result = await fetchChatJobResult({
          user_id: currentUserId,
          request_id: crypto.randomUUID(),
          message: value,
          reference_date: targetDate,
          ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
          act_as_link_id: coachActAsLinkId,
        })
        await updateCoachMessage(scopeId, statusId, typeof result.reply === 'string' ? result.reply : String(result.reply ?? ''))
        await refreshVisibleWorkoutSessions()
      } catch (error) {
        await updateCoachMessage(scopeId, statusId, error instanceof Error ? error.message : t('messages.networkError'))
      }
      return
    }
    await addMessage(value, 'user')
    const statusId = addThinkingMessage(selectedModelLabel)

    try {
      const targetDate = selectedDay?.date ?? todayId
      const expectedRevision = workoutRevisionByOwnerDateRef.current[`${currentUserId}:${targetDate}`]
      const payload = {
        user_id: currentUserId,
        request_id: crypto.randomUUID(),
        message: value,
        reference_date: targetDate,
        ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
      }

      await fetchChatReply(payload, statusId)
    } catch (error) {
      removeMessage(statusId)
      console.error('Chat Error:', error)
      const message = error instanceof Error && error.message.includes('Async chat endpoint unavailable')
        ? 'Backend needs a restart for async chat. /chat/async is not available yet.'
        : error instanceof TypeError || !(error instanceof Error) || !error.message
          ? t('messages.networkError')
          : error.message
      await addMessage(message, 'ai')
    }
  }, [
    addMessage,
    addCoachMessage,
    addCoachThinkingMessage,
    addThinkingMessage,
    chatInput,
    coachActAsLinkId,
    coachActAsOwnerId,
    coachChatEnabled,
    currentUserId,
    fetchChatJobResult,
    fetchChatReply,
    refreshVisibleWorkoutSessions,
    removeMessage,
    selectedDay?.date,
    selectedModelLabel,
    t,
    todayId,
    updateCoachMessage,
  ])

  const handleFastGenerateDayWorkout = useCallback(async () => {
    if (!canGenerateWorkoutSelectedDay || !canQuerySavedWorkoutSessions || !isBackendHealthy) return
    const targetDate = selectedDay?.date ?? todayId
    if (pendingWorkoutDatesRef.current.has(targetDate)) return
    pendingWorkoutDatesRef.current.add(targetDate)
    try {
      const headers = { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() }
      const response = await apiFetch(withCoachActAs(`${API_BASE_URL}/v1/workouts/generate`), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          date: targetDate,
          source: 'default',
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
    withCoachActAs,
  ])

  const handleGenerateDayWorkout = useCallback(() => {
    void handleFastGenerateDayWorkout()
  }, [handleFastGenerateDayWorkout])

  const handleCopyLastWeek = useCallback(async () => {
    if (!canGenerateWorkoutSelectedDay || !canQuerySavedWorkoutSessions || !isBackendHealthy) return
    const targetDate = selectedDay?.date ?? todayId
    if (pendingWorkoutDatesRef.current.has(targetDate)) return
    const targetHasContent = Boolean(workoutExercisesRef.current.length > 0 || workoutExtrasRef.current.length > 0)
    if (targetHasContent && !window.confirm(t('workout.copyLastWeekConfirm', { date: shiftDateId(targetDate, -7) }))) return
    pendingWorkoutDatesRef.current.add(targetDate)
    try {
      const headers = { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() }
      const ownerKey = `${coachActAsOwnerId ?? currentUserId}:${targetDate}`
      const response = await apiFetch(withCoachActAs(`${API_BASE_URL}/v1/workouts/copy-last-week`), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          date: targetDate,
          expected_revision: workoutRevisionByOwnerDateRef.current[ownerKey] ?? null,
          request_id: crypto.randomUUID(),
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string | { code?: string, message?: string } } | null
        const detail = body?.detail
        const code = detail && typeof detail === 'object' ? detail.code : undefined
        const detailMessage = typeof detail === 'string' ? detail : detail?.message
        const message = code === 'workout_has_logged_sets'
          ? t('workout.copyLastWeekLogged')
          : code === 'copy_source_missing'
            ? t('workout.copyLastWeekMissing', { date: shiftDateId(targetDate, -7) })
            : detailMessage
        throw new Error(message || t('workout.copyLastWeekFailed'))
      }
      const receipt = await response.json() as BackendWorkoutReceipt
      if (receipt.workout) {
        // The response is authoritative for this request; release the in-flight
        // guard before hydration so the copied day is not dropped.
        pendingWorkoutDatesRef.current.delete(targetDate)
        applySavedWorkoutSessionToWeek(backendWorkoutToSession(receipt.workout, currentUserId))
      }
      try {
        await refreshVisibleWorkoutSessions()
      } catch {
        // The next supported workout refresh reconciles this view.
      }
    } catch (error) {
      console.warn('Copy last week failed:', error)
      window.alert(error instanceof Error ? error.message : t('workout.copyLastWeekFailed'))
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
    refreshVisibleWorkoutSessions,
    selectedDay?.date,
    t,
    todayId,
    withCoachActAs,
  ])

  const handleClearWorkoutDay = useCallback(async () => {
    if (!canQuerySavedWorkoutSessions || !isBackendHealthy) return
    const targetDate = selectedDay?.date ?? todayId
    const ownerKey = `${coachActAsOwnerId ?? currentUserId}:${targetDate}`
    const workoutId = workoutIdByOwnerDateRef.current[ownerKey]
    const expectedRevision = workoutRevisionByOwnerDateRef.current[ownerKey]
    if (!workoutId || !expectedRevision) return
    if (pendingWorkoutDatesRef.current.has(targetDate)) return
    const logsForDay = weekSetLogsRef.current[targetDate] ?? {}
    const hasLoggedSets = (selectedDay?.exercises ?? []).some((exercise) => (
      (logsForDay[exercise.id] ?? []).some((set) => set.done)
    ))
    const confirmLabel = hasLoggedSets
      ? t('workout.clearUnloggedConfirm', { label: selectedDayLabel })
      : t('workout.clearConfirm', { label: selectedDayLabel })
    if (!window.confirm(confirmLabel)) return
    pendingWorkoutDatesRef.current.add(targetDate)
    try {
      const headers = { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() }
      const response = await apiFetch(withCoachActAs(`${API_BASE_URL}/v1/workouts/${workoutId}/clear`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ expected_revision: expectedRevision, request_id: crypto.randomUUID() }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string | { message?: string } } | null
        const detail = body?.detail
        const detailMessage = typeof detail === 'string' ? detail : detail?.message
        throw new Error(detailMessage || t('workout.clearFailed'))
      }
      const receipt = await response.json() as BackendWorkoutReceipt
      if (receipt.workout) {
        const saved = backendWorkoutToSession(receipt.workout, currentUserId)
        // The reduced day is authoritative. Release the in-flight guard only
        // for the synchronous apply, then hold it again through the refresh
        // below so a stale pre-clear hydration cannot restore removed sets.
        pendingWorkoutDatesRef.current.delete(targetDate)
        applySavedWorkoutSessionToWeek(saved)
        pendingWorkoutDatesRef.current.add(targetDate)
      } else {
        // The canonical record is gone: render the selected day as empty.
        // Keep the in-flight guard held through the refresh below and stamp
        // the suppression time so a stale pre-clear hydration cannot re-apply
        // the just-deleted workout.
        delete workoutIdByOwnerDateRef.current[ownerKey]
        delete workoutRevisionByOwnerDateRef.current[ownerKey]
        // Stamp the delete so any pre-clear fetch resolving late cannot
        // resurrect the day: its snapshot predates this timestamp.
        clearedWorkoutAtRef.current[targetDate] = (receipt as unknown as { updated_at?: string }).updated_at ?? new Date().toISOString()
        const clearedDay: WeekPlanDay = {
          ...(selectedDay ?? { date: targetDate, label: selectedDayLabel, exercises: [], extras: [], isRest: true, planNotes: '', notes: '' }),
          date: targetDate,
          exercises: [],
          extras: [],
          isRest: true,
          autoFillSuppressedAt: (receipt as unknown as { updated_at?: string }).updated_at ?? new Date().toISOString(),
          planNotes: '',
          notes: '',
        }
        applyWeekPlan(
          {
            weekStart: weekPlanRef.current.weekStart,
            days: weekPlanRef.current.days.map((day) => (day.date === targetDate ? clearedDay : day)),
          },
          { selectedDate: targetDate, logsByDay: { ...weekSetLogsRef.current, [targetDate]: {} } },
        )
      }
      try {
        await refreshVisibleWorkoutSessions()
      } catch {
        // The local reduction above already reflects the canonical clear.
      }
    } catch (error) {
      console.warn('Clear workout day failed:', error)
      window.alert(error instanceof Error ? error.message : t('workout.clearFailed'))
    } finally {
      pendingWorkoutDatesRef.current.delete(targetDate)
    }
  }, [
    applySavedWorkoutSessionToWeek,
    applyWeekPlan,
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    currentUserId,
    getPrivyAuthHeaders,
    isBackendHealthy,
    refreshVisibleWorkoutSessions,
    selectedDay,
    selectedDayLabel,
    t,
    todayId,
    weekPlan.days,
    weekPlan.weekStart,
    withCoachActAs,
  ])

  const handleGenerateDayWorkoutWithCoach = useCallback(() => {
    if (!canGenerateWorkoutSelectedDay || !coachChatEnabled) return
    const targetDate = selectedDay?.date ?? todayId
    const prompt = t('workout.generateChatPrompt', { date: targetDate, label: selectedDayLabel })
    handleActiveViewChange('home')
    void handleSend(prompt)
  }, [
    canGenerateWorkoutSelectedDay,
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
    const thinkingId = addCoachThinkingMessage(scopeId, miniSelectedModelLabel)

    const exercise = getExercise(exerciseId)
    if (!exercise) {
      removeCoachMessage(scopeId, thinkingId)
      addCoachMessage(scopeId, t('messages.exerciseNotFound'), 'ai')
      return
    }

    const ownerWorkoutKey = `${coachActAsOwnerId ?? currentUserId}:${selectedDay?.date ?? todayId}`
    const ownerWorkoutId = workoutIdByOwnerDateRef.current[ownerWorkoutKey]
    const payload = {
      user_id: currentUserId,
      request_id: crypto.randomUUID(),
      message: trimmed,
      scope: MINI_CHAT_SCOPE,
      scope_id: scopeId,
      reference_date: selectedDay?.date ?? todayId,
      exercise_id: exercise.id,
      ...(ownerWorkoutId ? { workout_id: ownerWorkoutId } : {}),
      exercise_instance_id: exercise.id,
      ...(workoutRevisionByOwnerDateRef.current[ownerWorkoutKey]
        ? { expected_revision: workoutRevisionByOwnerDateRef.current[ownerWorkoutKey] }
        : {}),
      ...(coachActAsLinkId ? { act_as_link_id: coachActAsLinkId } : {}),
    }

    try {
      await fetchCoachReply(payload, scopeId, exerciseId, thinkingId)
    } catch (error) {
      console.error('Coach Chat Error:', error)
      removeCoachMessage(scopeId, thinkingId)
      const responseMessage = error instanceof Error && error.message.includes('Async chat endpoint unavailable')
        ? 'Backend needs a restart for async chat. /chat/async is not available yet.'
        : error instanceof TypeError || !(error instanceof Error) || !error.message
          ? t('messages.coachNetworkError')
          : error.message
      addCoachMessage(scopeId, responseMessage, 'ai')
    }
  }, [
    addCoachMessage,
    addCoachThinkingMessage,
    coachActAsLinkId,
    coachActAsOwnerId,
    coachChatEnabled,
    currentUserId,
    ensureWorkoutSession,
    fetchCoachReply,
    getCoachScopeId,
    getExercise,
    miniSelectedModelLabel,
    removeCoachMessage,
    selectedDay?.date,
    t,
    todayId,
  ])

  const handleCloseSwap = useCallback(() => {
    swapExerciseIdRef.current = null
    swapResponseRef.current = null
    setSwapOpen(false)
    setSwapLoading(false)
    setSwapError(null)
    setSwapCandidates([])
    setSwappingCandidateId(null)
  }, [])

  const handleOpenSwap = useCallback(async (exerciseId: string): Promise<boolean> => {
    if (!canQuerySavedWorkoutSessions || !coachCanEditPrograms || !isBackendHealthy) return false
    const targetDate = selectedDay?.date ?? todayId
    const workoutId = workoutIdByOwnerDateRef.current[`${coachActAsOwnerId ?? currentUserId}:${targetDate}`]
    if (!workoutId) return false
    swapExerciseIdRef.current = exerciseId
    swapResponseRef.current = null
    setSwapOpen(true)
    setSwapLoading(true)
    setSwapError(null)
    setSwapCandidates([])
    setSwappingCandidateId(null)
    try {
      const headers = await getPrivyAuthHeaders()
      const result = await fetchSwapCandidates({
        apiBaseUrl: API_BASE_URL,
        getHeaders: async () => headers,
        workoutId,
        exerciseInstanceId: exerciseId,
        actAsLinkId: coachActAsLinkId,
      })
      if (swapExerciseIdRef.current !== exerciseId) return false
      swapResponseRef.current = result
      setSwapCandidates(result.candidates)
      if (result.candidates.length === 0 && coachChatEnabled) {
        handleCloseSwap()
        void handleCoachSend(exerciseId, t('workout.swapCoachPrompt'))
        return true
      }
    } catch (error) {
      if (swapExerciseIdRef.current !== exerciseId) return false
      const code = error instanceof SwapCandidatesError ? error.code : null
      if (needsCoachSwap(code) && coachChatEnabled) {
        handleCloseSwap()
        void handleCoachSend(exerciseId, t('workout.swapCoachPrompt'))
        return true
      }
      setSwapError(t(`workout.${swapErrorKey(code)}`))
    } finally {
      if (swapExerciseIdRef.current === exerciseId) setSwapLoading(false)
    }
    return false
  }, [
    canQuerySavedWorkoutSessions,
    coachActAsLinkId,
    coachActAsOwnerId,
    coachCanEditPrograms,
    coachChatEnabled,
    currentUserId,
    getPrivyAuthHeaders,
    handleCloseSwap,
    handleCoachSend,
    isBackendHealthy,
    selectedDay?.date,
    t,
    todayId,
  ])

  const handleSelectSwapCandidate = useCallback(async (candidate: SwapCandidate): Promise<boolean> => {
    const response = swapResponseRef.current
    if (!response || swappingCandidateId) return false
    setSwappingCandidateId(candidate.candidate_id)
    try {
      const headers = { 'Content-Type': 'application/json', ...await getPrivyAuthHeaders() }
      const result = await apiFetch(withCoachActAs(
        `${API_BASE_URL}/v1/workouts/${response.workout_id}/exercises/${response.exercise_instance_id}/swap`,
      ), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'jev',
          reason: `Picked ${candidate.name} from the MiniChat alternatives.`,
          target_candidate_id: candidate.candidate_id,
          expected_revision: response.workout_revision,
          expected_blueprint_revision: response.blueprint_revision,
          request_id: crypto.randomUUID(),
        }),
      })
      if (!result.ok) {
        throw readApiError(await result.json().catch(() => null), result.status, t('workout.swapFailed'))
      }
      const receipt = await result.json() as BackendWorkoutReceipt
      if (!receipt.workout) throw new Error(t('workout.swapFailed'))
      applySavedWorkoutSessionToWeek(backendWorkoutToSession(receipt.workout, currentUserId), true)
      handleCloseSwap()
      try {
        await refreshVisibleWorkoutSessions()
      } catch {
        // The swap receipt above already reflects the canonical record.
      }
      return true
    } catch (error) {
      console.warn('Swap exercise failed:', error)
      const code = error instanceof SwapCandidatesError ? error.code : null
      const key = swapErrorKey(code)
      setSwapError(key === 'swapFailed'
        ? (error instanceof Error && error.message ? error.message : t('workout.swapFailed'))
        : t(`workout.${key}`))
      return false
    } finally {
      setSwappingCandidateId(null)
    }
  }, [
    applySavedWorkoutSessionToWeek,
    currentUserId,
    getPrivyAuthHeaders,
    handleCloseSwap,
    refreshVisibleWorkoutSessions,
    swappingCandidateId,
    t,
    withCoachActAs,
  ])

  // Merge typed-but-unlogged inputs into a freshly built structural receipt so
  // applying it never wipes what the user is mid-way through typing. Logged
  // sets still come from the receipt (done), untouched here.
  const mergeUnloggedSetInputs = useCallback((targetDate: string, session: WorkoutSession) => {
    const previousDay = weekPlanRef.current.days.find((day) => day.date === targetDate)
    const previousLogs = weekSetLogsRef.current[targetDate]
    const nextLogs = session.workout?.set_logs
    if (!previousLogs || !nextLogs) return
    for (const exercise of session.workout?.exercises ?? []) {
      const previousStates = previousLogs[exercise.id]
      const previousExercise = previousDay?.exercises.find((item) => item.id === exercise.id)
      const nextStates = nextLogs[exercise.id]
      if (!previousStates || !previousExercise || !nextStates) continue
      nextStates.forEach((nextState, index) => {
        const setId = exercise.sets[index]?.setId
        const previousIndex = previousExercise.sets.findIndex((set) => set.setId === setId)
        const previous = previousStates[previousIndex]
        if (!previous || nextState.done || previous.done) return
        nextState.weight = previous.weight
        nextState.metric = previous.metric
        if (previous.value_source) nextState.value_source = previous.value_source
      })
    }
  }, [])

  // Apply a structural receipt without rebuilding the day from empty actuals.
  // `workout: null` means the record is gone, mirroring clear.
  const applyStructuralReceipt = useCallback((
    receipt: BackendWorkoutReceipt,
    targetDate: string,
    ownerKey: string,
  ) => {
    if (receipt.workout) {
      if (receipt.workout.workout_id) workoutIdByOwnerDateRef.current[ownerKey] = receipt.workout.workout_id
      const nextRevision = receipt.revision ?? receipt.workout.revision
      if (nextRevision) workoutRevisionByOwnerDateRef.current[ownerKey] = nextRevision
      const session = backendWorkoutToSession(receipt.workout, currentUserId)
      mergeUnloggedSetInputs(targetDate, session)
      // The receipt is canonical; apply it without another full-week fetch.
      pendingWorkoutDatesRef.current.delete(targetDate)
      applySavedWorkoutSessionsToWeek([session], { preserveSelectedDate: true, preserveActiveEntry: true })
      return
    }

    delete workoutIdByOwnerDateRef.current[ownerKey]
    delete workoutRevisionByOwnerDateRef.current[ownerKey]
    clearedWorkoutAtRef.current[targetDate] = (receipt as unknown as { updated_at?: string }).updated_at ?? new Date().toISOString()
    const clearedDay: WeekPlanDay = {
      ...(selectedDay ?? { date: targetDate, label: selectedDayLabel, exercises: [], extras: [], isRest: true, planNotes: '', notes: '' }),
      date: targetDate,
      exercises: [],
      extras: [],
      isRest: true,
      autoFillSuppressedAt: clearedWorkoutAtRef.current[targetDate],
      planNotes: '',
      notes: '',
    }
    applyWeekPlan(
      {
        weekStart: weekPlanRef.current.weekStart,
        days: weekPlanRef.current.days.map((day) => (day.date === targetDate ? clearedDay : day)),
      },
      { selectedDate: targetDate, logsByDay: { ...weekSetLogsRef.current, [targetDate]: {} } },
    )
  }, [
    applySavedWorkoutSessionsToWeek,
    applyWeekPlan,
    currentUserId,
    mergeUnloggedSetInputs,
    selectedDay,
    selectedDayLabel,
  ])

  // One canonical mutation: auth, 409 refresh + message, generic error parse.
  const mutateWorkout = useCallback(async (
    workoutId: string,
    pathSuffix: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    ownerKey: string,
  ): Promise<BackendWorkoutReceipt | null> => {
    const headers = { 'Content-Type': 'application/json', ...(await getPrivyAuthHeaders()) }
    const response = await apiFetch(
      withCoachActAs(`${API_BASE_URL}/v1/workouts/${encodeURIComponent(workoutId)}${pathSuffix}`),
      { method, headers, body: JSON.stringify(body) },
    )
    if (response.status === 409) {
      delete workoutRevisionByOwnerDateRef.current[ownerKey]
      return null
    }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as { detail?: string | { message?: string } } | null
      const detail = errorBody?.detail
      const message = typeof detail === 'string' ? detail : (detail && typeof detail === 'object' ? detail.message : undefined)
      throw new Error(message || t('workout.editFailed'))
    }
    return await response.json() as BackendWorkoutReceipt
  }, [getPrivyAuthHeaders, t, withCoachActAs])

  const runStructuralMutation = useCallback(async (
    workoutId: string,
    pathSuffix: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
    targetDate: string,
    ownerKey: string,
    preview?: () => () => void,
  ): Promise<boolean> => {
    // Tapping add/remove blurs the target input first. Let that save settle
    // instead of dropping the tap or sending its now-stale revision.
    const targetEdits = [...pendingTargetEditsRef.current.entries()]
      .filter(([key]) => key.startsWith(`${workoutId}:`))
      .map(([, promise]) => promise)
    if (targetEdits.length > 0) {
      const saved = await Promise.all(targetEdits)
      if (saved.some((ok) => !ok)) return false
      body = { ...body, expected_revision: workoutRevisionByOwnerDateRef.current[ownerKey] }
    }
    if (pendingWorkoutDatesRef.current.has(targetDate)) return false
    pendingWorkoutDatesRef.current.add(targetDate)
    setStructuralEditPending(true)
    let rollback: (() => void) | undefined
    try {
      rollback = preview?.()
      const receipt = await mutateWorkout(workoutId, pathSuffix, method, body, ownerKey)
      if (!receipt) {
        rollback?.()
        rollback = undefined
        pendingWorkoutDatesRef.current.delete(targetDate)
        await refreshVisibleWorkoutSessions().catch(() => false)
        window.alert(t('workout.editStale'))
        return false
      }
      applyStructuralReceipt(receipt, targetDate, ownerKey)
      return true
    } catch (error) {
      rollback?.()
      console.warn('Workout plan edit failed:', error)
      window.alert(error instanceof Error ? error.message : t('workout.editFailed'))
      return false
    } finally {
      pendingWorkoutDatesRef.current.delete(targetDate)
      setStructuralEditPending(false)
    }
  }, [
    applyStructuralReceipt,
    mutateWorkout,
    refreshVisibleWorkoutSessions,
    t,
  ])

  const requireEditContext = useCallback(() => {
    if (!canEditPlanSelectedDay || !canQuerySavedWorkoutSessions || !isBackendHealthy) return null
    const targetDate = selectedDay?.date ?? todayId
    const ownerId = coachActAsOwnerId ?? currentUserId
    const ownerKey = `${ownerId}:${targetDate}`
    const workoutId = workoutIdByOwnerDateRef.current[ownerKey]
    const revision = workoutRevisionByOwnerDateRef.current[ownerKey]
    if (!workoutId || !revision) return null
    return { targetDate, ownerKey, workoutId, revision }
  }, [
    canEditPlanSelectedDay,
    canQuerySavedWorkoutSessions,
    coachActAsOwnerId,
    currentUserId,
    isBackendHealthy,
    selectedDay?.date,
    todayId,
  ])

  const handleAddSet = useCallback(async (exerciseId: string) => {
    const context = requireEditContext()
    if (!context) return
    const exercise = getExercise(exerciseId)
    const stateList = setLogsRef.current[exerciseId]
    const source = exercise && ([...exercise.sets].reverse().find((set) => !set.isWarmup) ?? exercise.sets[exercise.sets.length - 1])
    if (!exercise || !source || !stateList) return
    await runStructuralMutation(
      context.workoutId,
      `/exercises/${encodeURIComponent(exerciseId)}/sets`,
      'POST',
      { expected_revision: context.revision, request_id: crypto.randomUUID() },
      context.targetDate,
      context.ownerKey,
      () => {
        const previousSets = [...exercise.sets]
        const previousStates = [...stateList]
        const lastActual = [...stateList].reverse().find((set) => set.done && !set.skipped)
        exercise.sets.push({ ...source, setId: undefined, round: source.round == null ? undefined : source.round + 1 })
        stateList.push({
          weight: lastActual?.weight ?? '', metric: lastActual?.metric ?? '', done: false,
          ...(lastActual ? { value_source: 'accepted_target' as const } : {}),
        })
        updateExerciseSummary(exercise)
        bumpData()
        return () => {
          exercise.sets = previousSets
          stateList.splice(0, stateList.length, ...previousStates)
          updateExerciseSummary(exercise)
          bumpData()
        }
      },
    )
  }, [bumpData, getExercise, requireEditContext, runStructuralMutation])

  const handleRemoveSet = useCallback(async (exerciseId: string, index: number) => {
    const context = requireEditContext()
    if (!context) return
    const exercise = getExercise(exerciseId)
    const stateList = setLogsRef.current[exerciseId]
    const setId = exercise?.sets[index]?.setId
    if (!exercise || !stateList || stateList[index]?.done || !setId) return
    await runStructuralMutation(
      context.workoutId,
      `/sets/${encodeURIComponent(setId)}/remove`,
      'POST',
      { expected_revision: context.revision, request_id: crypto.randomUUID() },
      context.targetDate,
      context.ownerKey,
      () => {
        const previousSets = [...exercise.sets]
        const previousStates = [...stateList]
        exercise.sets.splice(index, 1)
        stateList.splice(index, 1)
        setEditingSet(null)
        setEditingSetSnapshot(null)
        stopRest()
        resetHoldTimer()
        updateExerciseSummary(exercise)
        bumpData()
        return () => {
          exercise.sets = previousSets
          stateList.splice(0, stateList.length, ...previousStates)
          updateExerciseSummary(exercise)
          bumpData()
        }
      },
    )
  }, [bumpData, getExercise, requireEditContext, resetHoldTimer, runStructuralMutation, stopRest])

  const handleRemoveExercise = useCallback(async (exerciseId: string) => {
    const context = requireEditContext()
    if (!context) return
    await runStructuralMutation(
      context.workoutId,
      `/exercises/${encodeURIComponent(exerciseId)}/remove`,
      'POST',
      { expected_revision: context.revision, request_id: crypto.randomUUID() },
      context.targetDate,
      context.ownerKey,
    )
  }, [requireEditContext, runStructuralMutation])

  const handleRemoveSegment = useCallback(async (segmentId: string) => {
    const context = requireEditContext()
    if (!context) return
    await runStructuralMutation(
      context.workoutId,
      `/segments/${encodeURIComponent(segmentId)}/remove`,
      'POST',
      { expected_revision: context.revision, request_id: crypto.randomUUID() },
      context.targetDate,
      context.ownerKey,
    )
  }, [requireEditContext, runStructuralMutation])

  const handleRemoveSection = useCallback(async (segmentIds: string[]) => {
    // Remove each distinct segment in the section, chaining the fresh
    // revision from each receipt into the next call.
    for (const segmentId of segmentIds) {
      const context = requireEditContext()
      if (!context) return
      const ok = await runStructuralMutation(
        context.workoutId,
        `/segments/${encodeURIComponent(segmentId)}/remove`,
        'POST',
        { expected_revision: context.revision, request_id: crypto.randomUUID() },
        context.targetDate,
        context.ownerKey,
      )
      if (!ok) return
    }
  }, [requireEditContext, runStructuralMutation])

  const handleReorderSegments = useCallback(async (segmentIds: string[]): Promise<boolean> => {
    const context = requireEditContext()
    if (!context) return false
    return runStructuralMutation(
      context.workoutId,
      '/segments/reorder',
      'POST',
      { segment_ids: segmentIds, expected_revision: context.revision, request_id: crypto.randomUUID() },
      context.targetDate,
      context.ownerKey,
    )
  }, [requireEditContext, runStructuralMutation])

  const handleMoveItem = useCallback(async (exerciseId: string, targetSegmentId: string, targetIndex: number): Promise<boolean> => {
    const context = requireEditContext()
    if (!context) return false
    return runStructuralMutation(
      context.workoutId,
      `/exercises/${encodeURIComponent(exerciseId)}/move`,
      'POST',
      {
        target_segment_id: targetSegmentId,
        target_index: targetIndex,
        expected_revision: context.revision,
        request_id: crypto.randomUUID(),
      },
      context.targetDate,
      context.ownerKey,
    )
  }, [requireEditContext, runStructuralMutation])

  const handleExtractItem = useCallback(async (exerciseId: string, beforeSegmentId: string | null): Promise<boolean> => {
    const context = requireEditContext()
    if (!context) return false
    return runStructuralMutation(
      context.workoutId,
      `/exercises/${encodeURIComponent(exerciseId)}/extract`,
      'POST',
      { before_segment_id: beforeSegmentId, expected_revision: context.revision, request_id: crypto.randomUUID() },
      context.targetDate,
      context.ownerKey,
    )
  }, [requireEditContext, runStructuralMutation])

  const handleCommitSetTarget = useCallback(async (exerciseId: string, index: number, field: 'weight' | 'metric') => {
    const context = requireEditContext()
    if (!context) return
    const exercise = getExercise(exerciseId)
    const stateList = setLogsRef.current[exerciseId]
    const setItem = stateList?.[index]
    const setId = exercise?.sets[index]?.setId
    if (!exercise || !setItem || setItem.done || !setId) return
    const value = field === 'metric' ? setItem.metric : setItem.weight
    const target = composeSetTarget(exercise, exercise.sets[index], field, value)
    if (!target) return

    const setKey = `${context.workoutId}:${setId}`
    const snapshot = captureTargetEditSnapshot(exercise, stateList, index)

    // Optimistic local target + remaining-set propagation. Keep the typed
    // values and never apply the receipt: applying it rebuilds the day from
    // actuals and would wipe typed-but-unlogged inputs.
    applyTargetEditToSets(exercise, stateList, index, field, value)
    bumpData()

    pendingWorkoutDatesRef.current.add(context.targetDate)
    const pendingPromise = (async (): Promise<boolean> => {
      try {
        const headers = { 'Content-Type': 'application/json', ...(await getPrivyAuthHeaders()) }
        const response = await apiFetch(
          withCoachActAs(`${API_BASE_URL}/v1/workouts/${encodeURIComponent(context.workoutId)}/sets/${encodeURIComponent(setId)}/target`),
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
              target,
              apply_to_remaining: true,
              expected_revision: context.revision,
              request_id: crypto.randomUUID(),
            }),
          },
        )
        if (response.status === 409) {
          pendingWorkoutDatesRef.current.delete(context.targetDate)
          delete workoutRevisionByOwnerDateRef.current[context.ownerKey]
          await refreshVisibleWorkoutSessions().catch(() => false)
          window.alert(t('workout.editStale'))
          return false
        }
        if (!response.ok) throw new Error(`Target update failed (${response.status})`)
        const receipt = await response.json() as BackendWorkoutReceipt
        const nextRevision = receipt.revision ?? receipt.workout?.revision
        if (nextRevision) workoutRevisionByOwnerDateRef.current[context.ownerKey] = nextRevision
        return true
      } catch (error) {
        console.warn('Canonical target update failed:', error)
        restoreTargetEditSnapshot(exercise, field, snapshot)
        bumpData()
        window.alert(error instanceof Error ? error.message : t('workout.editFailed'))
        return false
      } finally {
        pendingWorkoutDatesRef.current.delete(context.targetDate)
        pendingTargetEditsRef.current.delete(setKey)
      }
    })()
    pendingTargetEditsRef.current.set(setKey, pendingPromise)
    await pendingPromise
  }, [
    bumpData,
    getExercise,
    getPrivyAuthHeaders,
    refreshVisibleWorkoutSessions,
    requireEditContext,
    t,
    withCoachActAs,
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

  useEffect(() => {
    if (!privyReady) return

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
      setMiniModelControl(null)
      return
    }
    const load = () => {
      refreshModelControl().catch((error) => console.warn('Ez model controls unavailable:', error))
      refreshMiniModelControl().catch((error) => console.warn('Mini-chat model controls unavailable:', error))
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
  }, [isBackendHealthy, privyAuthenticated, privyReady, refreshModelControl, refreshMiniModelControl])

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
      setPrivySubjectId(null)
      return
    }
  }, [privyAuthenticated])

  useEffect(() => {
    if (restState.active && restState.endTs) {
      if (restState.remainingSec <= 0) {
        const shouldAutoStart = restState.autoStartNextSet && restEntryRef.current === activeEntryRef.current
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
    const warmAfterFocus = () => {
      if (document.visibilityState === 'visible') {
        void warmBackend({ force: true })
      }
    }

    window.addEventListener('focus', warmAfterFocus)
    document.addEventListener('visibilitychange', warmAfterFocus)

    return () => {
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
    resetHoldTimer()
    showWorkoutDetail(id, type)
  }, [resetHoldTimer, showWorkoutDetail])

  const resetVisibleWeek = useCallback(() => {
    // The owner changed: drop the previous account's in-memory week and let the
    // canonical hydration effect pull the new owner's records.
    workoutIdByOwnerDateRef.current = {}
    workoutRevisionByOwnerDateRef.current = {}
    weekSetLogsRef.current = {}
    applyWeekPlan(buildWeekPlanFromSingleDay(todayId, [], [], profile.language), {
      selectedDate: todayId,
      logsByDay: {},
    })
  }, [applyWeekPlan, profile.language, todayId])

  const handleStartCoachView = useCallback((target: CoachActAsTarget) => {
    setCoachActAsLinkId(target.linkId)
    setCoachActAsLabel(target.label)
    setCoachActAsPermissions(target.permissions)
    setChatInput('')
    resetVisibleWeek()
    handleActiveViewChange('workout')
  }, [handleActiveViewChange, resetVisibleWeek])

  const handleStopCoachView = useCallback(() => {
    setCoachActAsLinkId(null)
    setCoachActAsLabel('')
    setCoachActAsPermissions(null)
    setChatInput('')
    resetVisibleWeek()
    handleActiveViewChange('workout')
  }, [handleActiveViewChange, resetVisibleWeek])

  const handleProfileChange = useCallback((field: 'language' | 'fontScale', value: string) => {
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
  }, [])

  const activeCoachMessages = activeEntryType === 'exercise' && activeEntryId
    ? (coachMessagesByScope[getCoachScopeId(activeEntryId)] ?? [])
    : []
  return (
    <I18nProvider value={i18n}>
      <div className={`shell shell--${activeView}${coachActAsOwnerId ? ' shell--coach-view' : ''}`}>
        <div className="shell-aura shell-aura-primary" aria-hidden="true" />
        <div className="shell-aura shell-aura-secondary" aria-hidden="true" />
        <div className="content">
          <ChatView
            active={activeView === 'home'}
            messages={coachActAsLinkId ? (coachMessagesByScope[`coach-link:${coachActAsLinkId}`] ?? []) : messages}
            inputValue={chatInput}
            inputDisabled={!coachChatEnabled}
            canStartNewChat={!coachActAsLinkId}
            modelOptions={coachActAsLinkId ? [] : modelOptions}
            showModelLabels
            selectedModel={selectedModelValue}
            modelSelectionDisabled={modelSelectionPending || Boolean(coachActAsLinkId) || messages.some((message) => message.thinking)}
            onModelChange={handleModelSelection}
            onInputChange={setChatInput}
            onSend={handleSend}
            onClearChat={coachActAsLinkId ? () => {} : handleClearChat}
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
            canLogDay={canLogSelectedDay && !structuralEditPending && !logPending}
            canEditPlan={canEditPlanSelectedDay && !structuralEditPending && !logPending}

            coachChatEnabled={coachChatEnabled}
            apiBaseUrl={API_BASE_URL}
            getAuthHeaders={getPrivyAuthHeaders}
            weekDays={weekDaySummaries}
            selectedDayLabel={selectedDayLabel}
            selectedDateId={selectedDay?.date ?? null}
            todayId={todayId}
            onBackToToday={() => handleSelectDay(-1, todayId)}
            hasWeekWorkouts={hasWeekWorkouts}
            loading={sessionLoading}
            exercises={workoutExercisesRef.current}
            extras={displayedWorkoutExtras}
            setLogs={setLogsRef.current}
            planNotes={selectedDay?.planNotes ?? ''}
            savingDayNote={dayNoteSaving}
            savingExerciseFeedback={exerciseFeedbackSaving}
            activeEntryId={activeEntryId}
            activeEntryType={activeEntryType}
            editingSet={editingSet}
            holdTimer={holdTimer}
            coachMessages={activeCoachMessages}
            showModelLabels
            miniModelOptions={miniModelOptions}
            miniSelectedModel={miniSelectedModelValue}
            miniModelSelectionDisabled={miniModelSelectionPending || Boolean(coachActAsLinkId)}
            onMiniModelChange={handleMiniModelSelection}
            onSelectEntry={handleSelectEntry}
            onSelectDay={handleSelectDay}
            onBack={hideWorkoutDetail}
            onLogSet={logNextSet}
            onUnlogSet={unlogSet}
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
                  if (setItem.done) {
                    const previous = editingSetSnapshot
                      ? {
                        weight: editingSetSnapshot.weight,
                        metric: editingSetSnapshot.metric,
                        done: true,
                        value_source: editingSetSnapshot.value_source,
                      }
                      : null
                    void syncLoggedSetRef.current?.(editingSet.exerciseId, editingSet.index, previous)
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
            onCommitSetTarget={handleCommitSetTarget}
            onAddSet={handleAddSet}
            onRemoveSet={handleRemoveSet}
            onStartHoldTimer={startHoldTimer}
            onLogHoldTimerSet={logHoldTimerSet}
            onSaveDayNote={handleSaveDayNote}
            onSaveExerciseFeedback={handleSaveExerciseFeedback}
            onCoachSend={handleCoachSend}
            swapOpen={swapOpen}
            swapLoading={swapLoading}
            swappingCandidateId={swappingCandidateId}
            swapError={swapError}
            swapCandidates={swapCandidates}
            onOpenSwap={handleOpenSwap}
            onSelectSwapCandidate={handleSelectSwapCandidate}
            onCloseSwap={handleCloseSwap}
            onRemoveExercise={handleRemoveExercise}
            onRemoveCircuit={handleRemoveSegment}
            onRemoveSection={handleRemoveSection}
            onReorderSegments={handleReorderSegments}
            onMoveItem={handleMoveItem}
            onExtractItem={handleExtractItem}
            actAsLinkId={coachActAsLinkId}
          />
          <ProfileView
            telegramControl={privyAuthenticated ? <TelegramLink apiBase={API_BASE_URL} getHeaders={getPrivyAuthHeaders} /> : undefined}
            active={activeView === 'profile'}
            language={profile.language}
            fontScale={profile.fontScale}
            onChange={handleProfileChange}
            onAuthClick={handleAuthClick}
            authState={authState}
            apiBaseUrl={API_BASE_URL}
            getHeaders={getPrivyAuthHeaders}
            actAsLinkId={coachActAsLinkId}
            onStartActAs={handleStartCoachView}
            onStopActAs={handleStopCoachView}
          />
        </div>

        <TabBar
          activeView={activeView}
          onChange={handleActiveViewChange}
          coachModeActive={Boolean(coachActAsLinkId)}
          coachContextLabel={coachActAsLabel}
          onExitCoachMode={coachActAsLinkId ? handleStopCoachView : undefined}
          disabledTab={coachActAsLinkId && !coachChatEnabled ? 'home' : null}
          disabledNotice={coachActAsLinkId && !coachChatEnabled ? t('coach.chatDisabledNotice') : ''}
          leadingControl={coachActAsLinkId && activeView === 'home' ? null : activeView === 'home' ? (
            <ChatOverflowMenu onRefresh={handleRefreshSession} />
          ) : (
            <WorkoutOverflowMenu
              canGeneratePlan={canGenerateWorkoutSelectedDay && canQuerySavedWorkoutSessions && isBackendHealthy}
              canGenerateWithCoach={canGenerateWorkoutSelectedDay && canQuerySavedWorkoutSessions && isBackendHealthy && coachChatEnabled}
              canCopyLastWeek={canGenerateWorkoutSelectedDay && canQuerySavedWorkoutSessions && isBackendHealthy}
              canClearWorkout={canClearSelectedDay && isBackendHealthy}
              onShowHistory={handleOpenWorkoutHistory}
              onGenerateWorkout={handleGenerateDayWorkout}
              onGenerateWithCoach={handleGenerateDayWorkoutWithCoach}
              onCopyLastWeek={handleCopyLastWeek}
              onClearWorkout={handleClearWorkoutDay}
              onRefresh={handleRefreshSession}
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
        <WorkoutHistorySheet
          open={workoutHistoryOpen}
          loading={workoutHistoryLoading}
          error={workoutHistoryError}
          workouts={workoutHistoryItems}
          selectedDate={selectedDay?.date ?? null}
          onSelectDate={handleSelectWorkoutHistoryDate}
          onClose={() => setWorkoutHistoryOpen(false)}
        />
      </div>
    </I18nProvider>
  )
}

export default App
