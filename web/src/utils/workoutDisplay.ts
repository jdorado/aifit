import type { WorkoutExercise } from '../data/testWorkout'

export const formatTime = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const secs = safeSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

export const parseDurationToSeconds = (value: string | undefined) => {
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

export const formatDurationForDisplay = (value: string) => (
  value.replace(/(\d+)\s*(?:seconds?|secs?|s)\b/gi, (match, secondsValue: string) => {
    const totalSeconds = Number(secondsValue)
    if (!Number.isFinite(totalSeconds) || totalSeconds < 60) return match

    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`
  })
)

const NULLISH_TOKENS = new Set(['null', 'none', 'n/a', 'na', 'n.a.', 'nil', 'nill', 'undefined', '-'])

const isNullishToken = (value: string) => {
  const trimmed = value.trim().toLowerCase()
  return trimmed !== '' && NULLISH_TOKENS.has(trimmed)
}

export type DropSetInfo = {
  label: string
  items: string[]
}

const formatWeightValue = (value: number, precision: number) => {
  const rounded = Number(value.toFixed(precision))
  if (!Number.isFinite(rounded)) return ''
  return Number.isInteger(rounded) ? String(rounded) : rounded.toString()
}

export const normalizeWeightForStorage = (value: string) => {
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

export const normalizeWorkoutTargetText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const amount = record.value
  if (typeof amount !== 'string' && (typeof amount !== 'number' || !Number.isFinite(amount))) return undefined
  const unit = typeof record.unit === 'string' ? record.unit.trim() : ''
  return `${amount}${unit}`
}

export const normalizeWeightTarget = (value: unknown) => {
  const text = normalizeWorkoutTargetText(value) ?? ''
  const trimmed = text.trim()
  if (!trimmed) return ''
  const lowered = trimmed.toLowerCase()
  if (isNullishToken(lowered) || ['bodyweight', 'body weight', 'body-weight', 'bw'].includes(lowered)) return ''
  const normalizedKg = normalizeWeightForStorage(trimmed)
  if (normalizedKg) return `${normalizedKg}kg`
  return trimmed
}

export const normalizeMetricTarget = (value: unknown) => {
  const text = normalizeWorkoutTargetText(value) ?? ''
  const trimmed = text.trim()
  if (!trimmed || isNullishToken(trimmed)) return ''
  return trimmed
}

export const normalizeDropSet = (value?: string | string[] | null): DropSetInfo => {
  if (!value) return { label: '', items: [] }
  if (Array.isArray(value)) {
    const items = value.map((entry) => String(entry).trim()).filter(Boolean)
    return { label: items.join(' -> '), items }
  }
  const label = String(value).trim()
  return label ? { label, items: [] } : { label: '', items: [] }
}

export const getExerciseSideCount = (exercise: WorkoutExercise) => {
  if (typeof exercise.sides !== 'number' || !Number.isFinite(exercise.sides)) return 1
  return Math.max(1, Math.round(exercise.sides))
}

const hasPerSideTargets = (exercise: WorkoutExercise) => {
  const sides = getExerciseSideCount(exercise)
  return sides > 1 && exercise.perSide !== false
}

const resolveTimeMode = (exercise: WorkoutExercise) => {
  const sides = getExerciseSideCount(exercise)
  if (exercise.metric !== 'time' || sides <= 1) return null
  if (exercise.timeMode === 'per_side' || exercise.timeMode === 'total') return exercise.timeMode
  return hasPerSideTargets(exercise) ? 'per_side' : 'total'
}

const hasPerSideMetricTargets = (exercise: WorkoutExercise) => {
  const sides = getExerciseSideCount(exercise)
  if (sides <= 1) return false
  if (exercise.metric === 'time') return resolveTimeMode(exercise) !== 'total'
  return exercise.perSide !== false
}

export const hasPerSideTimedTargets = (exercise: WorkoutExercise) => (
  resolveTimeMode(exercise) === 'per_side'
)

const resolveWeightMode = (exercise: WorkoutExercise) => {
  const sides = getExerciseSideCount(exercise)
  if (sides <= 1) return null
  if (exercise.weightMode === 'per_side' || exercise.weightMode === 'total') return exercise.weightMode
  return hasPerSideTargets(exercise) ? 'per_side' : 'total'
}

export const formatMetricDisplay = (exercise: WorkoutExercise, value: string) => {
  if (!value || value === '-') return value
  const displayValue = exercise.metric === 'time' ? formatDurationForDisplay(value) : value
  return hasPerSideMetricTargets(exercise) ? `${displayValue}/side` : displayValue
}

export const formatWeightDisplay = (exercise: WorkoutExercise, value: string) => {
  if (!value) return value
  const mode = resolveWeightMode(exercise)
  if (!mode) return value
  return mode === 'per_side' ? `${value}/side` : `${value} total`
}

export const formatCircuitTarget = (exercise: WorkoutExercise) => {
  const firstSet = exercise.sets.find((set) => !set.isWarmup) ?? exercise.sets[0]
  if (!firstSet) return ''
  const metricValue = formatMetricDisplay(exercise, normalizeMetricTarget(exercise.metric === 'time'
    ? firstSet.targetTime
    : firstSet.targetReps))
  const weightValue = formatWeightDisplay(exercise, normalizeWeightTarget(firstSet.targetWeight))
  if (weightValue && metricValue) return `${metricValue} × ${weightValue}`
  return metricValue || weightValue
}
