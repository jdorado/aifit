export type ExerciseHistoryLoad = {
  value: number
  unit: 'kg' | 'lb'
}

export type ExerciseHistorySet = {
  set_id: string
  workout_id: string
  exercise_instance_id: string
  date: string
  completed_at: string
  load: ExerciseHistoryLoad | null
  reps: number | null
  duration_seconds: number | null
  rpe: number | null
}

export type ExerciseHistorySession = {
  workoutId: string
  date: string
  sets: ExerciseHistorySet[]
  topSet: ExerciseHistorySet | null
  volumeKg: number | null
}

type ExerciseHistoryFetch = {
  apiBaseUrl: string
  getHeaders: () => Promise<Record<string, string>>
  exerciseId: string
  before?: string
  limit?: number
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
)

const asNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
)

const asString = (value: unknown): string | null => (
  typeof value === 'string' && value ? value : null
)

const normalizeLoad = (value: unknown): ExerciseHistoryLoad | null => {
  const load = asRecord(value)
  if (!load) return null
  const amount = asNumber(load.value)
  const unit = load.unit
  if (amount === null || (unit !== 'kg' && unit !== 'lb')) return null
  return { value: amount, unit }
}

const normalizeSet = (value: unknown): ExerciseHistorySet | null => {
  const row = asRecord(value)
  if (!row) return null
  const setId = asString(row.set_id)
  const workoutId = asString(row.workout_id)
  const date = asString(row.date)
  if (!setId || !workoutId || !date) return null
  return {
    set_id: setId,
    workout_id: workoutId,
    exercise_instance_id: asString(row.exercise_instance_id) ?? '',
    date,
    completed_at: asString(row.completed_at) ?? '',
    load: normalizeLoad(row.load),
    reps: asNumber(row.reps),
    duration_seconds: asNumber(row.duration_seconds),
    rpe: asNumber(row.rpe),
  }
}

export const loadInKg = (load: ExerciseHistoryLoad | null): number | null => {
  if (!load) return null
  return load.unit === 'lb' ? load.value * 0.45359237 : load.value
}

export const fetchExerciseHistory = async ({
  apiBaseUrl,
  getHeaders,
  exerciseId,
  before,
  limit = 20,
}: ExerciseHistoryFetch): Promise<ExerciseHistorySet[]> => {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) params.set('before', before)
  const response = await fetch(
    `${apiBaseUrl}/v1/exercises/${encodeURIComponent(exerciseId)}/history?${params.toString()}`,
    { headers: await getHeaders() },
  )
  if (!response.ok) {
    throw new Error(`Failed to load exercise history (${response.status})`)
  }
  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) {
    throw new Error('Invalid exercise history payload')
  }
  return payload
    .map(normalizeSet)
    .filter((row): row is ExerciseHistorySet => row !== null)
}

const setVolumeKg = (set: ExerciseHistorySet): number | null => {
  const load = loadInKg(set.load)
  if (load === null || set.reps === null) return null
  return load * set.reps
}

const topSetRank = (set: ExerciseHistorySet): number => (
  setVolumeKg(set)
  ?? loadInKg(set.load)
  ?? set.reps
  ?? set.duration_seconds
  ?? 0
)

export const groupExerciseHistory = (sets: ExerciseHistorySet[]): ExerciseHistorySession[] => {
  const sessions = new Map<string, ExerciseHistorySet[]>()
  for (const set of sets) {
    const existing = sessions.get(set.workout_id)
    if (existing) {
      existing.push(set)
    } else {
      sessions.set(set.workout_id, [set])
    }
  }

  return Array.from(sessions.entries())
    .map(([workoutId, sessionSets]) => {
      const ordered = [...sessionSets].sort((left, right) => left.completed_at.localeCompare(right.completed_at))
      const volumeKg = sessionSets.reduce((total, set) => total + (setVolumeKg(set) ?? 0), 0)
      const hasVolume = sessionSets.some((set) => setVolumeKg(set) !== null)
      return {
        workoutId,
        date: ordered[0]?.date ?? '',
        sets: ordered,
        topSet: [...sessionSets].sort((left, right) => topSetRank(right) - topSetRank(left))[0] ?? null,
        volumeKg: hasVolume ? volumeKg : null,
      }
    })
    .sort((left, right) => right.date.localeCompare(left.date))
}
