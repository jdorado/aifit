
export type WorkoutSet = {
    targetReps?: string
    targetTime?: string
    targetWeight?: string
    targetDropSet?: string | string[]
    isWarmup?: boolean
}

export type CircuitMeta = {
    name: string
    rounds?: number
    restAfterSec?: number
    order?: number
    totalExercises?: number
}

export type ExerciseCategory =
    'strength'
    | 'hypertrophy'
    | 'power'
    | 'conditioning'
    | 'mobility'
    | 'skill'
    | 'rehab'
    | 'warmup'
    | 'cooldown'

export type MuscleGroup =
    'chest'
    | 'back'
    | 'shoulders'
    | 'biceps'
    | 'triceps'
    | 'quads'
    | 'hamstrings'
    | 'glutes'
    | 'calves'
    | 'core'
    | 'full_body'
    | 'cardio'

export type EquipmentType =
    'bodyweight'
    | 'dumbbell'
    | 'barbell'
    | 'kettlebell'
    | 'machine'
    | 'cable'
    | 'band'
    | 'sled'
    | 'other'

export type WorkoutTimer = {
    enabled: boolean
    prepSec?: number
}

export type WorkoutExercise = {
    id: string
    name: string
    standardName?: string
    exerciseKey?: string
    movementFamilyKey?: string
    catalogMatchQuality?: string
    section: string
    summary: string
    notes?: string
    restSec?: number
    metric: 'reps' | 'time'
    sets: WorkoutSet[]
    cues: string[]
    status?: 'skip'
    timer?: WorkoutTimer
    category?: ExerciseCategory
    primaryMuscle?: MuscleGroup
    secondaryMuscles?: MuscleGroup[]
    equipment?: EquipmentType
    circuit?: CircuitMeta
    sides?: number
    perSide?: boolean
    timeMode?: 'per_side' | 'total'
    weightMode?: 'per_side' | 'total'
}

export type WorkoutExtra = {
    id: string
    name: string
    section: string
    summary: string
    notes: string[]
    category?: ExerciseCategory
    isReadOnly?: boolean
}

// Types only; workout data comes from the authenticated backend.
