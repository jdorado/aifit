export type Load = { value: number; unit: 'kg' | 'lb' }
export type Exposure = {
  workout_id: string; date: string; complete: boolean; logged_sets: number; expected_sets: number
  load: Load | null; total_reps: number | null; reps: Array<number | null>; effort_recorded: boolean
}
export type PerformanceTrend = {
  status: string; reps_change: number | null; load_change_kg: number | null; days: number | null; exposures: number
  effort_comparable: boolean; baseline: Exposure | null; latest: Exposure | null
}
export type ExerciseProgression = {
  exercise_instance_id: string; exercise_id: string; exercise_name: string; primary_muscles: string[]
  load_basis: string; prescribed_load: Load | null; next_load: Load | null
  policy: {
    kind: 'none' | 'double_progression'; goal?: string | null; phase?: string
    increase_when?: { completed_reps_at_or_above: number; max_rpe: number } | null
    load_range?: Load[] | null; review_by?: string | null
  }
  status: string; reason: string; qualifying_sessions: number; required_sessions: number
  expected_sets: number | null; target_reps: { min: number; max: number } | null
  latest: Exposure | null; trend: PerformanceTrend; review_reasons: string[]
}
export type MuscleProgression = {
  muscle: string; tracked_exercises: number; comparable_exercises: number; improving_exercises: number
  direct_completed_sets: number; direct_planned_sets: number
  indirect_completed_sets: number; indirect_planned_sets: number
  week_start: string; week_end: string
  exercises: Array<{ exercise_id: string; name: string; trend: PerformanceTrend }>
}
export type WorkoutProgression = {
  workout_id: string; revision: string; as_of: string; trend_days: number
  exercises: ExerciseProgression[]; muscles: MuscleProgression[]
}

export const formatProgressionLoad = (load: Load | null) => load ? `${Number(load.value.toFixed(2))} ${load.unit}` : '—'

// This is only a preview against the prescribed target. Recorded performance
// and readiness always come from the canonical API calculation.
export const previewLoad = (value: string, summary: ExerciseProgression): string | null => {
  const match = value.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(kg|lb)?$/)
  if (!match || !summary.prescribed_load) return null
  const kg = (load: Load) => load.value * (load.unit === 'lb' ? 0.45359237 : 1)
  const selected = kg({ value: Number(match[1].replace(',', '.')), unit: match[2] === 'lb' ? 'lb' : 'kg' })
  const range = summary.policy.load_range
  if (range && selected > kg(range[1]) + 0.001) return 'outsidePlan'
  const delta = selected - kg(summary.prescribed_load)
  return Math.abs(delta) < 0.001 ? 'atTarget' : delta > 0 ? 'aboveTarget' : 'belowTarget'
}
