
export type WorkoutSet = {
    setId?: string
    targetReps?: string
    targetTime?: string
    targetWeight?: string
    targetDropSet?: string | string[]
    isWarmup?: boolean
}

export type CircuitMeta = {
    name: string
    // Stable group identity: the backend segment id. Display keeps `name`.
    // Untitled segments of the same kind share a name, so grouping by name
    // merges distinct circuits (e.g. three 2-exercise circuits render as one
    // group of 6). Group by circuitGroupKey() instead.
    key?: string
    rounds?: number
    restAfterSec?: number
    order?: number
    totalExercises?: number
}

export const circuitGroupKey = (circuit?: CircuitMeta): string | undefined => (
    circuit?.key ?? circuit?.name
)

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

export type WorkoutFeedbackPreset = 'pain' | 'hard' | 'easy' | 'form'

export type WorkoutExercise = {
    id: string
    // Canonical segment identity (segment_id). Section/circuit removals need
    // this to address `POST /segments/{segment_id}/remove`; display grouping
    // still uses circuitGroupKey().
    segmentId?: string
    // Canonical blueprint slot identity. Stable across swaps (a swap keeps
    // slot_id while the exercise instance id may change), so mini-chat
    // threads key on this with id as fallback.
    slotId?: string
    name: string
    standardName?: string
    exerciseKey?: string
    movementFamilyKey?: string
    catalogMatchQuality?: string
    section: string
    summary: string
    notes?: string
    feedbackPreset?: WorkoutFeedbackPreset | null
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
