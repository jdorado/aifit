import type { WorkoutExercise } from '../data/testWorkout'
import type { SetState } from '../types/app'

export type CoachTimerUpdate = {
  enabled: boolean
  prepSec?: number
}

export type CoachExerciseUpdate = {
  exerciseId?: string
  name?: string
  standardName?: string
  section?: string
  summary?: string
  notes?: string
  category?: WorkoutExercise['category']
  primaryMuscle?: WorkoutExercise['primaryMuscle']
  secondaryMuscles?: WorkoutExercise['secondaryMuscles']
  equipment?: WorkoutExercise['equipment']
  setCount?: number
  setDelta?: number
  reps?: string
  time?: string
  weight?: string
  restSec?: number
  timer?: CoachTimerUpdate | null
  cues?: string[]
}

const equipmentTypes = new Set<NonNullable<WorkoutExercise['equipment']>>([
  'bodyweight',
  'dumbbell',
  'barbell',
  'kettlebell',
  'machine',
  'cable',
  'band',
  'sled',
  'other',
])

const categories = new Set<NonNullable<WorkoutExercise['category']>>([
  'strength',
  'hypertrophy',
  'power',
  'conditioning',
  'mobility',
  'skill',
  'rehab',
  'warmup',
  'cooldown',
])

const muscleGroups = new Set<NonNullable<WorkoutExercise['primaryMuscle']>>([
  'chest',
  'back',
  'shoulders',
  'biceps',
  'triceps',
  'quads',
  'hamstrings',
  'glutes',
  'calves',
  'core',
  'full_body',
  'cardio',
])

const normalizeLabel = (value: string) => (
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
)

export const normalizeExerciseKey = (exercise: { name: string, section?: string, metric?: string }) => (
  `${normalizeLabel(exercise.name)}|${normalizeLabel(exercise.section ?? '')}|${exercise.metric ?? ''}`
)

export const isExerciseLockedFromLogs = (exerciseId: string, logsForDay?: Record<string, SetState[]>) => {
  const states = logsForDay?.[exerciseId]
  return Array.isArray(states) && states.some((state) => Boolean(state?.done))
}

export const reconcileExerciseIds = (incoming: WorkoutExercise[], existing: WorkoutExercise[]) => {
  const existingById = new Map(existing.map((exercise) => [exercise.id, exercise]))
  const existingByKey = new Map<string, WorkoutExercise[]>()
  existing.forEach((exercise) => {
    const key = normalizeExerciseKey(exercise)
    const list = existingByKey.get(key)
    if (list) {
      list.push(exercise)
    } else {
      existingByKey.set(key, [exercise])
    }
  })

  const usedExistingIds = new Set<string>()
  for (const exercise of incoming) {
    if (existingById.has(exercise.id) && !usedExistingIds.has(exercise.id)) {
      usedExistingIds.add(exercise.id)
      continue
    }
    const key = normalizeExerciseKey(exercise)
    const list = existingByKey.get(key) ?? []
    const match = list.find((candidate) => !usedExistingIds.has(candidate.id))
    if (match) {
      exercise.id = match.id
      usedExistingIds.add(match.id)
    }
  }

  const usedIncomingIds = new Set<string>()
  for (const exercise of incoming) {
    const base = exercise.id || 'exercise'
    if (!usedIncomingIds.has(base)) {
      usedIncomingIds.add(base)
      continue
    }
    let suffix = 2
    let candidate = `${base}_${suffix}`
    while (usedIncomingIds.has(candidate)) {
      suffix += 1
      candidate = `${base}_${suffix}`
    }
    exercise.id = candidate
    usedIncomingIds.add(candidate)
  }

  return incoming
}

export const protectLoggedExercises = (
  incoming: WorkoutExercise[],
  existing: WorkoutExercise[],
  logsForDay?: Record<string, SetState[]>
) => {
  if (!logsForDay) return incoming
  const lockedIds = new Set<string>()
  const lockedById = new Map<string, WorkoutExercise>()
  const lockedByKey = new Map<string, WorkoutExercise[]>()
  existing.forEach((exercise) => {
    if (!isExerciseLockedFromLogs(exercise.id, logsForDay)) return
    lockedIds.add(exercise.id)
    lockedById.set(exercise.id, exercise)
    const key = normalizeExerciseKey(exercise)
    const list = lockedByKey.get(key)
    if (list) {
      list.push(exercise)
    } else {
      lockedByKey.set(key, [exercise])
    }
  })
  if (lockedIds.size === 0) return incoming

  const usedLockedIds = new Set<string>()
  const mergeWithLoggedSets = (exercise: WorkoutExercise, lockedExercise: WorkoutExercise) => {
    const stateList = logsForDay[lockedExercise.id] ?? []
    const doneIndexes = stateList
      .map((state, index) => (state?.done ? index : -1))
      .filter((index) => index >= 0)
    if (doneIndexes.length === 0) return exercise

    const requiredLength = Math.max(
      exercise.sets.length,
      Math.max(...doneIndexes) + 1
    )
    const mergedSets: WorkoutExercise['sets'] = []
    for (let index = 0; index < requiredLength; index++) {
      if (doneIndexes.includes(index) && lockedExercise.sets[index]) {
        mergedSets.push({ ...lockedExercise.sets[index] })
        continue
      }
      if (exercise.sets[index]) {
        mergedSets.push({ ...exercise.sets[index] })
      }
    }

    return {
      ...lockedExercise,
      sets: mergedSets,
    }
  }

  const next = incoming.map((exercise) => {
    const lockedByExactId = lockedById.get(exercise.id)
    if (lockedByExactId && !usedLockedIds.has(lockedByExactId.id)) {
      usedLockedIds.add(lockedByExactId.id)
      return mergeWithLoggedSets(exercise, lockedByExactId)
    }

    const key = normalizeExerciseKey(exercise)
    const lockedByStableKey = (lockedByKey.get(key) ?? []).find((candidate) => !usedLockedIds.has(candidate.id))
    if (lockedByStableKey) {
      usedLockedIds.add(lockedByStableKey.id)
      return mergeWithLoggedSets({ ...exercise, id: lockedByStableKey.id }, lockedByStableKey)
    }

    return exercise
  })

  existing.forEach((exercise, index) => {
    if (!lockedIds.has(exercise.id)) return
    if (usedLockedIds.has(exercise.id) || next.some((candidate) => candidate.id === exercise.id)) return
    next.splice(Math.min(index, next.length), 0, exercise)
  })

  return next
}

const normalizeToken = (value: string) => (
  normalizeLabel(value)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
)

export const normalizeEquipmentType = (value: unknown): WorkoutExercise['equipment'] | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeToken(value)
  if (normalized === 'db' || normalized === 'dumbbells') return 'dumbbell'
  if (normalized === 'bb') return 'barbell'
  return equipmentTypes.has(normalized as NonNullable<WorkoutExercise['equipment']>)
    ? normalized as WorkoutExercise['equipment']
    : undefined
}

export const normalizeCategory = (value: unknown): WorkoutExercise['category'] | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeToken(value)
  return categories.has(normalized as NonNullable<WorkoutExercise['category']>)
    ? normalized as WorkoutExercise['category']
    : undefined
}

export const normalizeMuscleGroup = (value: unknown): WorkoutExercise['primaryMuscle'] | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeToken(value)
  return muscleGroups.has(normalized as NonNullable<WorkoutExercise['primaryMuscle']>)
    ? normalized as WorkoutExercise['primaryMuscle']
    : undefined
}

export const normalizeCoachStringArray = (value: unknown) => {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  return undefined
}

const ensureStateListLength = (exercise: WorkoutExercise, stateList: SetState[]) => {
  while (stateList.length < exercise.sets.length) {
    stateList.push({ weight: '', metric: '', done: false })
  }
}

const getDoneWorkingCount = (exercise: WorkoutExercise, stateList: SetState[]) => {
  let count = 0
  for (let index = 0; index < exercise.sets.length; index++) {
    if (exercise.sets[index]?.isWarmup) continue
    if (stateList[index]?.done) count += 1
  }
  return count
}

const getWorkingSetCount = (exercise: WorkoutExercise) => (
  exercise.sets.reduce((count, setItem) => (setItem?.isWarmup ? count : count + 1), 0)
)

const getLastWorkingSet = (exercise: WorkoutExercise) => (
  [...exercise.sets].reverse().find((set) => !set.isWarmup)
)

const appendWorkingSet = (exercise: WorkoutExercise, stateList: SetState[]) => {
  const lastWorkSet = getLastWorkingSet(exercise)
  const isTime = exercise.metric === 'time'
  exercise.sets.push({
    targetReps: isTime ? undefined : (lastWorkSet?.targetReps ?? '10'),
    targetTime: isTime ? (lastWorkSet?.targetTime ?? '60s') : undefined,
    targetWeight: lastWorkSet?.targetWeight ?? '',
  })
  stateList.push({ weight: '', metric: '', done: false })
}

const removeLastUnloggedWorkingSet = (exercise: WorkoutExercise, stateList: SetState[]) => {
  for (let index = exercise.sets.length - 1; index >= 0; index--) {
    if (exercise.sets[index]?.isWarmup) continue
    if (stateList[index]?.done) continue
    exercise.sets.splice(index, 1)
    stateList.splice(index, 1)
    return true
  }
  return false
}

export const applyCoachExerciseUpdateToDraft = (
  exercise: WorkoutExercise,
  stateList: SetState[],
  update: CoachExerciseUpdate
) => {
  ensureStateListLength(exercise, stateList)

  let didChange = false
  const setStringField = (key: 'name' | 'standardName' | 'section' | 'summary' | 'notes', value?: string) => {
    if (value === undefined) return
    const trimmed = value.trim()
    if (!trimmed || exercise[key] === trimmed) return
    exercise[key] = trimmed
    didChange = true
  }

  setStringField('name', update.name)
  setStringField('standardName', update.standardName)
  setStringField('section', update.section)
  setStringField('summary', update.summary)
  setStringField('notes', update.notes)

  if (update.category !== undefined && exercise.category !== update.category) {
    exercise.category = update.category
    didChange = true
  }
  if (update.primaryMuscle !== undefined && exercise.primaryMuscle !== update.primaryMuscle) {
    exercise.primaryMuscle = update.primaryMuscle
    didChange = true
  }
  if (update.secondaryMuscles !== undefined) {
    exercise.secondaryMuscles = update.secondaryMuscles
    didChange = true
  }
  if (update.equipment !== undefined && exercise.equipment !== update.equipment) {
    exercise.equipment = update.equipment
    didChange = true
  }

  let desiredWorkCount = getWorkingSetCount(exercise)
  if (update.setCount !== undefined) {
    desiredWorkCount = Math.max(0, update.setCount)
  } else if (update.setDelta !== undefined && update.setDelta !== 0) {
    desiredWorkCount = Math.max(0, desiredWorkCount + update.setDelta)
  }
  desiredWorkCount = Math.max(desiredWorkCount, getDoneWorkingCount(exercise, stateList))

  while (getWorkingSetCount(exercise) < desiredWorkCount) {
    appendWorkingSet(exercise, stateList)
    didChange = true
  }
  while (getWorkingSetCount(exercise) > desiredWorkCount) {
    if (!removeLastUnloggedWorkingSet(exercise, stateList)) break
    didChange = true
  }

  const applyMetricTargets = (value: string, field: 'targetReps' | 'targetTime') => {
    exercise.metric = field === 'targetTime' ? 'time' : 'reps'
    for (let index = 0; index < exercise.sets.length; index++) {
      const setItem = exercise.sets[index]
      if (setItem.isWarmup) continue
      setItem[field] = value
      if (field === 'targetReps') {
        setItem.targetTime = undefined
      } else {
        setItem.targetReps = undefined
      }
      if (!stateList[index]?.done) {
        stateList[index].metric = value
      }
    }
    didChange = true
  }

  if (update.reps !== undefined) {
    applyMetricTargets(update.reps, 'targetReps')
  }

  if (update.time !== undefined) {
    applyMetricTargets(update.time, 'targetTime')
  }

  if (update.weight !== undefined) {
    for (let index = 0; index < exercise.sets.length; index++) {
      const setItem = exercise.sets[index]
      if (setItem.isWarmup) continue
      setItem.targetWeight = update.weight
      if (!stateList[index]?.done) {
        stateList[index].weight = update.weight
      }
    }
    didChange = true
  }

  if (update.restSec !== undefined && exercise.restSec !== update.restSec) {
    exercise.restSec = update.restSec
    didChange = true
  }

  if (update.timer !== undefined && exercise.metric === 'time') {
    if (!update.timer || update.timer.enabled === false) {
      if (exercise.timer !== undefined) {
        exercise.timer = undefined
        didChange = true
      }
    } else {
      exercise.timer = {
        enabled: true,
        prepSec: update.timer.prepSec ?? exercise.timer?.prepSec ?? 3,
      }
      didChange = true
    }
  }

  if (update.cues !== undefined) {
    exercise.cues = update.cues
    didChange = true
  }

  return didChange
}
