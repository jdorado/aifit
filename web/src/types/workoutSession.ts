import type { WorkoutExercise, WorkoutExtra } from '../data/testWorkout'
import type { SetState } from './app'

export type WorkoutSessionExerciseSummary = {
  name: string
  metric?: 'reps' | 'time'
  total_sets: number
  completed_sets: number
  total_reps: number
  total_time_sec: number
  total_volume_kg: number
  top_set?: {
    weight_kg?: number
    reps?: number
    time_sec?: number
    volume_kg?: number
  } | null
}

export type WorkoutSessionSummary = {
  total_sets: number
  completed_sets: number
  total_reps: number
  total_time_sec: number
  total_volume_kg: number
  exercises?: WorkoutSessionExerciseSummary[]
}

export type WorkoutSession = {
  user_id: string
  session_id?: string | null
  date: string
  timezone?: string | null
  label?: string | null
  notes?: string | null
  workout: {
    exercises?: WorkoutExercise[]
    extras?: WorkoutExtra[]
    set_logs?: Record<string, SetState[]>
  }
  summary: WorkoutSessionSummary
  revision?: string | null
  auto_fill_suppressed_at?: string | null
  created_at: string
  updated_at: string
}
