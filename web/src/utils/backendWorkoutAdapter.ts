import type { WorkoutExercise, WorkoutExtra, WorkoutFeedbackPreset } from '../data/testWorkout'
import type { WorkoutSession, WorkoutSessionExerciseSummary } from '../types/workoutSession'
import type { SetState } from '../types/app'
import { normalizeEquipmentType, normalizeMuscleGroup } from './workoutSafety'

type BackendRange = {
  min: number
  max: number
}

type BackendTarget = {
  reps?: BackendRange
  duration_seconds?: BackendRange
  load?: {
    value: number
    unit: 'kg' | 'lb'
  }
}

type BackendLoad = {
  value: number
  unit: 'kg' | 'lb'
}

type BackendActual = {
  status: 'completed' | 'skipped'
  reps?: number
  duration_seconds?: number
  load?: BackendLoad
  rpe?: number
  completed_at?: string
}

type BackendWorkoutSet = {
  set_id: string
  target: BackendTarget
  actual?: BackendActual | null
  kind?: string
  round?: number
}

type BackendExerciseSnapshot = {
  exercise_id: string
  exercise_revision: string
  name: string
  movement_pattern: string
  primary_muscles: string[]
  secondary_muscles: string[]
  equipment_kind: string
  laterality: 'bilateral' | 'unilateral' | 'alternating'
  load_basis: 'total' | 'per_side' | 'per_hand' | 'machine_stack' | 'bodyweight' | 'assisted' | 'band_level'
  equipment_profile_id?: string | null
}

export type BackendExerciseFeedback = {
  note: string
  preset: WorkoutFeedbackPreset | null
  updated_at?: string
}

type BackendWorkoutItem = {
  exercise_instance_id: string
  slot_id: string
  candidate_id: string
  order: number
  exercise_snapshot: BackendExerciseSnapshot
  sets: BackendWorkoutSet[]
  cues_md?: string
  notes?: BackendExerciseFeedback | null
}

type BackendSegment = {
  segment_id: string
  order: number
  kind: 'warmup' | 'straight_sets' | 'superset' | 'circuit' | 'interval' | 'mobility' | 'cooldown'
  title?: string | null
  rounds: number
  rest_after_round_seconds: number
  items: BackendWorkoutItem[]
}

export type BackendWorkout = {
  workout_id: string
  revision: string
  date: string
  timezone: string
  status: string
  title: string
  notes?: string | null
  segments: BackendSegment[]
  lineage?: {
    source?: 'default' | 'jev' | 'agent_override' | 'copy_last_week' | 'legacy_import'
    blueprint_id?: string
    blueprint_revision?: string
    day_id?: string
  }
  created_at: string
  updated_at: string
}

export type BackendWorkoutReceipt = {
  resource?: string
  resource_id?: string
  revision?: string
  effect?: string
  workout?: BackendWorkout | null
}

const formatRange = (range: BackendRange | undefined) => {
  if (!range) return undefined
  return range.min === range.max ? String(range.min) : `${range.min}-${range.max}`
}

const formatLoad = (load: BackendTarget['load']) => (
  load ? `${load.value}${load.unit}` : undefined
)

const loadInKg = (load: BackendLoad | undefined) => {
  if (!load) return 0
  return load.unit === 'lb' ? load.value * 0.45359237 : load.value
}

const actualToSetState = (actual: BackendWorkoutSet['actual']): SetState => {
  if (!actual) return { weight: '', metric: '', done: false }
  if (actual.status === 'skipped') {
    return { weight: '', metric: '', done: true, skipped: true }
  }
  return {
    weight: actual.load ? formatLoad(actual.load) ?? '' : '',
    metric: actual.reps !== undefined
      ? String(actual.reps)
      : actual.duration_seconds !== undefined
        ? String(actual.duration_seconds)
        : '',
    done: true,
    value_source: 'user_entered',
  }
}

const sectionLabel = (kind: BackendSegment['kind']) => {
  switch (kind) {
    case 'straight_sets': return 'Strength'
    case 'superset': return 'Superset'
    case 'circuit': return 'Circuit'
    case 'interval': return 'Conditioning'
    case 'warmup': return 'Warm-up'
    case 'cooldown': return 'Cooldown'
    case 'mobility': return 'Mobility'
    default: return 'Workout'
  }
}

const exerciseCategory = (kind: BackendSegment['kind']): WorkoutExercise['category'] => {
  switch (kind) {
    case 'warmup': return 'warmup'
    case 'cooldown': return 'cooldown'
    case 'mobility': return 'mobility'
    case 'interval': return 'conditioning'
    default: return 'strength'
  }
}

const targetToSet = (row: BackendWorkoutSet) => ({
  setId: row.set_id,
  targetReps: formatRange(row.target.reps),
  targetTime: row.target.duration_seconds ? formatRange(row.target.duration_seconds) : undefined,
  targetWeight: formatLoad(row.target.load),
})

const exerciseSummary = (sets: BackendWorkoutSet[], metric: WorkoutExercise['metric']) => {
  const firstTarget = sets[0]?.target
  const metricValue = metric === 'time'
    ? formatRange(firstTarget?.duration_seconds)
    : formatRange(firstTarget?.reps)
  const weightValue = formatLoad(firstTarget?.load)
  const base = `${sets.length} sets x ${metricValue ?? '-'}`
  return weightValue ? `${base} - ${weightValue}` : base
}

const summarizeActuals = (sets: BackendWorkoutSet[], name: string, metric: WorkoutExercise['metric']): WorkoutSessionExerciseSummary => {
  const actuals = sets.flatMap((set) => set.actual ? [set.actual] : [])
  const totalReps = actuals.reduce((sum, actual) => sum + (actual.reps ?? 0), 0)
  const totalTime = actuals.reduce((sum, actual) => sum + (actual.duration_seconds ?? 0), 0)
  const totalVolume = actuals.reduce((sum, actual) => sum + loadInKg(actual.load) * (actual.reps ?? 0), 0)
  const top = actuals
    .map((actual) => ({
      weight_kg: actual.load ? loadInKg(actual.load) : undefined,
      reps: actual.reps,
      time_sec: actual.duration_seconds,
      volume_kg: actual.load && actual.reps !== undefined ? loadInKg(actual.load) * actual.reps : undefined,
    }))
    .sort((a, b) => (b.volume_kg ?? b.weight_kg ?? b.reps ?? b.time_sec ?? 0) - (a.volume_kg ?? a.weight_kg ?? a.reps ?? a.time_sec ?? 0))[0] ?? null

  return {
    name,
    metric,
    total_sets: sets.length,
    completed_sets: actuals.length,
    total_reps: totalReps,
    total_time_sec: totalTime,
    total_volume_kg: totalVolume,
    top_set: top,
  }
}

const toExercise = (segment: BackendSegment, item: BackendWorkoutItem): WorkoutExercise => {
  const snapshot = item.exercise_snapshot
  const firstTarget = item.sets[0]?.target
  const metric: WorkoutExercise['metric'] = firstTarget?.duration_seconds ? 'time' : 'reps'
  const sideCount = snapshot.laterality === 'bilateral' ? undefined : 2
  const perSide = sideCount
    ? snapshot.load_basis === 'per_side' || snapshot.load_basis === 'per_hand'
    : undefined
  const cues = (item.cues_md ?? '')
    .split(/\r?\n/)
    .map((cue) => cue.trim())
    .filter(Boolean)
  // Imported legacy days keep their section name. New titles are agent-authored;
  // missing history falls back to the kind label. Grouping uses circuit.key.
  const label = segment.title?.trim() || sectionLabel(segment.kind)

  return {
    id: item.exercise_instance_id,
    segmentId: segment.segment_id,
    name: snapshot.name,
    standardName: snapshot.name,
    exerciseKey: snapshot.exercise_id,
    movementFamilyKey: snapshot.movement_pattern,
    section: label,
    summary: exerciseSummary(item.sets, metric),
    restSec: segment.rest_after_round_seconds || undefined,
    metric,
    sets: item.sets.map(targetToSet),
    cues,
    ...(item.notes ? { notes: item.notes.note, feedbackPreset: item.notes.preset } : {}),
    category: exerciseCategory(segment.kind),
    primaryMuscle: normalizeMuscleGroup(snapshot.primary_muscles[0]),
    secondaryMuscles: snapshot.secondary_muscles
      .map((muscle) => normalizeMuscleGroup(muscle))
      .filter((muscle): muscle is NonNullable<WorkoutExercise['primaryMuscle']> => Boolean(muscle)),
    equipment: normalizeEquipmentType(snapshot.equipment_kind),
    sides: sideCount,
    perSide,
    weightMode: sideCount ? (perSide ? 'per_side' : 'total') : undefined,
    ...(segment.kind === 'circuit' || segment.kind === 'superset'
      ? {
        circuit: {
          name: label,
          key: segment.segment_id,
          rounds: segment.rounds,
          restAfterSec: segment.rest_after_round_seconds,
          order: item.order,
          totalExercises: segment.items.length,
        },
      }
      : {}),
  }
}

export const backendWorkoutToSession = (
  workout: BackendWorkout,
  userId: string,
): WorkoutSession => {
  const exercises: WorkoutExercise[] = []
  const exerciseSummaries: WorkoutSessionExerciseSummary[] = []
  const setLogs: Record<string, SetState[]> = {}

  for (const segment of [...workout.segments].sort((a, b) => a.order - b.order)) {
    for (const item of [...segment.items].sort((a, b) => a.order - b.order)) {
      const exercise = toExercise(segment, item)
      exercises.push(exercise)
      setLogs[exercise.id] = item.sets.map((set) => actualToSetState(set.actual))
      exerciseSummaries.push(summarizeActuals(item.sets, exercise.name, exercise.metric))
    }
  }

  const totalSets = exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0)
  const completedSets = exerciseSummaries.reduce((sum, summary) => sum + summary.completed_sets, 0)
  const totalReps = exerciseSummaries.reduce((sum, summary) => sum + summary.total_reps, 0)
  const totalTime = exerciseSummaries.reduce((sum, summary) => sum + summary.total_time_sec, 0)
  const totalVolume = exerciseSummaries.reduce((sum, summary) => sum + summary.total_volume_kg, 0)

  return {
    user_id: userId,
    session_id: workout.workout_id,
    date: workout.date,
    timezone: workout.timezone,
    label: workout.title,
    notes: typeof workout.notes === 'string' ? workout.notes : null,
    workout: {
      exercises,
      extras: [] as WorkoutExtra[],
      set_logs: setLogs,
    },
    summary: {
      total_sets: totalSets,
      completed_sets: completedSets,
      total_reps: totalReps,
      total_time_sec: totalTime,
      total_volume_kg: totalVolume,
      exercises: exerciseSummaries,
    },
    revision: workout.revision,
    auto_fill_suppressed_at: null,
    created_at: workout.created_at,
    updated_at: workout.updated_at,
  }
}
