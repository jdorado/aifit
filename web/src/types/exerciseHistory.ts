export type ExerciseHistorySet = {
  set_index: number
  reps?: number
  time_sec?: number
  load_display?: string
  load_value?: number
  load_unit?: 'kg' | 'lb'
  load_kg?: number
  volume_kg?: number
  value_source?: 'user_entered' | 'accepted_target' | 'legacy_unknown'
}

export type ExerciseHistoryExposure = {
  date: string
  name: string
  exercise_key?: string
  movement_family_key?: string
  equipment?: string
  load_basis?: 'per_side' | 'total' | string
  working_sets?: number
  total_reps?: number
  total_time_sec?: number
  volume_kg?: number
  top_set?: {
    load_display?: string
    load_kg?: number
    reps?: number
    volume_kg?: number
    value_source?: 'user_entered' | 'accepted_target' | 'legacy_unknown'
  } | null
  sets?: ExerciseHistorySet[]
}

export type ExerciseHistoryResponse = {
  identity: {
    exercise_key: string
    movement_family_key: string
    display_name: string
    equipment: string
    load_basis: string
    primary_muscle: string
    secondary_muscles: string[]
    match_quality: string
    compatibility_key: string
  }
  last_performed?: ExerciseHistoryExposure | null
  exercise_exposures: ExerciseHistoryExposure[]
  family_exposures: ExerciseHistoryExposure[]
  muscle_exposures: ExerciseHistoryExposure[]
  history_quality: {
    comparable_exposures: number
    lower_confidence_sets: number
    match_quality: string
  }
}
