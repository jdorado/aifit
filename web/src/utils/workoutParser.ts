import type {
    ExerciseCategory,
    EquipmentType,
    MuscleGroup,
    WorkoutExercise,
    WorkoutExtra,
    WorkoutSet,
} from '../data/testWorkout'
import { formatDurationForDisplay } from './workoutDisplay'

// The "Simple" Schema expected from JSON/LLM
export interface SimpleExercise {
    id?: string
    exercise_id?: string
    exerciseId?: string
    name: string
    standard_name?: string
    standardName?: string
    exercise_key?: string
    exerciseKey?: string
    movement_family_key?: string
    movementFamilyKey?: string
    video_search_name?: string
    videoSearchName?: string
    section?: string
    sets?: number
    reps?: string | number | null
    time?: string | number | null
    weight?: string | number | null
    set_targets?: Array<{ reps?: string | number | null, time?: string | number | null, weight?: string | number | null }>
    setTargets?: Array<{ reps?: string | number | null, time?: string | number | null, weight?: string | number | null }>
    notes?: string | string[] | null
    drop_set?: string | string[]
    dropSet?: string | string[]
    dropset?: string | string[]
    warmup_sets?: Array<{ reps?: string | number | null, time?: string | number | null, weight?: string | number | null }>
    warmupSets?: Array<{ reps?: string | number | null, time?: string | number | null, weight?: string | number | null }>
    circuit?: {
        name?: string
        rounds?: number
        rest_after_sec?: number
        rest_after?: number
        restAfterSec?: number
        order?: number
        total_exercises?: number
        totalExercises?: number
    }
    rest?: number
    cues?: string[]
    status?: 'skip'
    summary?: string
    category?: ExerciseCategory
    primary_muscle?: MuscleGroup
    secondary_muscles?: MuscleGroup[]
    equipment?: EquipmentType
    primaryMuscle?: MuscleGroup
    secondaryMuscles?: MuscleGroup[]
    timer?: {
        enabled?: boolean
        prep?: number
    }
    sides?: number | string | null
    side_count?: number | string | null
    sideCount?: number | string | null
    per_side?: boolean | null
    perSide?: boolean | null
    targets_per_side?: boolean | null
    targetsPerSide?: boolean | null
    side_mode?: string | null
    sideMode?: string | null
    unilateral?: boolean | null
    weight_mode?: string | null
    weightMode?: string | null
    weight_basis?: string | null
    weightBasis?: string | null
    weight_per_side?: boolean | null
    weightPerSide?: boolean | null
    time_mode?: string | null
    timeMode?: string | null
    time_basis?: string | null
    timeBasis?: string | null
    time_per_side?: boolean | null
    timePerSide?: boolean | null
}

export interface SimpleExtra {
    id?: string
    name: string
    section: string
    summary: string
    notes?: string[]
    category?: ExerciseCategory
}

export interface SimpleSection {
    id?: string
    name?: string
    title?: string
    label?: string
    section?: string
    items?: SimpleExercise[]
    exercises?: SimpleExercise[]
    workout?: SimpleExercise[]
}

// The new "Clean" Schema
export interface UserProfile {
    text?: string
    weekly_plan?: string
    weeklyPlan?: string
    // Legacy fields (older sessions / prompts).
    bio?: string
    goals?: string
    medical?: string
    experience?: string
    language?: string
}

export interface CombinedWorkoutResponse {
    profile?: UserProfile
    workout?: SimpleExercise[]
    sections?: SimpleSection[]
    extras?: SimpleExtra[]
    notes?: string | string[]
    weekly_plan?: string | { text?: string }
    weeklyPlan?: string | { text?: string }
}

// Union type for input: either the old array or the new object
export type WorkoutInput = SimpleExercise[] | CombinedWorkoutResponse

const NULLISH_TOKENS = new Set(['null', 'none', 'n/a', 'na', 'n.a.', 'nil', 'nill', 'undefined', '-'])

const isNullishToken = (value: string) => {
    const trimmed = value.trim().toLowerCase()
    return trimmed !== '' && NULLISH_TOKENS.has(trimmed)
}

const normalizeOptionalString = (value: string | number | null | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed || isNullishToken(trimmed)) return ''
        return trimmed
    }
    return ''
}

const normalizeRepValue = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (trimmed.includes('-') || /\bto\b/i.test(trimmed)) {
        const match = trimmed.match(/(\d+)/)
        return match ? match[1] : trimmed
    }
    return trimmed
}

const normalizeSideCount = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const rounded = Math.max(1, Math.round(value))
        return rounded > 1 ? rounded : null
    }
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed || isNullishToken(trimmed)) return null
        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed)) return null
        const rounded = Math.max(1, Math.round(parsed))
        return rounded > 1 ? rounded : null
    }
    return null
}

const normalizeOptionalBoolean = (value: unknown) => {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase()
        if (!trimmed) return null
        if (['true', 'yes', 'y', '1'].includes(trimmed)) return true
        if (['false', 'no', 'n', '0'].includes(trimmed)) return false
    }
    return null
}

const normalizeSideMode = (value: unknown): 'per_side' | 'total' | null => {
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase()
        if (!trimmed) return null
        if (['per_side', 'per-side', 'per side', 'each_side', 'each-side', 'side', 'per arm', 'per leg', 'each'].includes(trimmed)) {
            return 'per_side'
        }
        if (['total', 'combined', 'both', 'bilateral_total'].includes(trimmed)) {
            return 'total'
        }
    }
    return null
}

const formatWeightValue = (value: number, precision: number) => {
    const rounded = Number(value.toFixed(precision))
    if (!Number.isFinite(rounded)) return ''
    return Number.isInteger(rounded) ? String(rounded) : rounded.toString()
}

const normalizeWeightLabel = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return ''
    const lowered = trimmed.toLowerCase()
    if (isNullishToken(lowered) || ['bodyweight', 'body weight', 'body-weight', 'bw'].includes(lowered)) return ''
    const unitMatch = trimmed.match(/^(-?\d+(?:[.,]\d+)?)\s*(kg|kgs|kilograms?|lb|lbs|pounds?)$/i)
    if (unitMatch) {
        const amount = Number(unitMatch[1].replace(',', '.'))
        if (!Number.isFinite(amount) || amount <= 0) return ''
        const unit = unitMatch[2].toLowerCase()
        const isLb = unit.startsWith('l') || unit.startsWith('p')
        const kgValue = isLb ? amount * 0.45359237 : amount
        return `${formatWeightValue(kgValue, isLb ? 1 : 2)}kg`
    }
    const numericMatch = trimmed.match(/^(-?\d+(?:[.,]\d+)?)$/)
    if (numericMatch) {
        const amount = Number(numericMatch[1].replace(',', '.'))
        if (!Number.isFinite(amount) || amount <= 0) return ''
        return `${formatWeightValue(amount, 2)}kg`
    }
    return trimmed
}

const normalizeId = (raw: unknown, fallbackName: string) => {
    const candidate = typeof raw === 'string' ? raw.trim() : ''
    const base = candidate || fallbackName
    return base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
}

const normalizeSectionLabel = (value: unknown) => (
    typeof value === 'string' && value.trim() ? value.trim() : ''
)

const flattenSections = (sections: SimpleSection[] | undefined) => {
    if (!Array.isArray(sections)) return []

    return sections.flatMap((section) => {
        const sectionLabel = normalizeSectionLabel(
            section.title
            ?? section.name
            ?? section.label
            ?? section.section
        )
        const items = Array.isArray(section.items)
            ? section.items
            : Array.isArray(section.exercises)
                ? section.exercises
                : Array.isArray(section.workout)
                    ? section.workout
                    : []

        return items.map((item) => ({
            ...item,
            section: normalizeSectionLabel(item.section) || sectionLabel || 'Workout',
        }))
    })
}

export const parseWorkout = (input: WorkoutInput): { exercises: WorkoutExercise[], extras: WorkoutExtra[] } => {
    // Normalize input
    let simpleData: SimpleExercise[] = []
    let extraData: SimpleExtra[] = []

    if (Array.isArray(input)) {
        simpleData = input
    } else if (input) {
        const sectionData = flattenSections(input.sections)
        if (sectionData.length > 0) {
            simpleData = sectionData
        } else if (Array.isArray(input.workout)) {
            simpleData = input.workout
        }
        if (Array.isArray(input.extras)) {
            extraData = input.extras
        }
    }

    const usedExerciseIds = new Set<string>()
    const makeUniqueId = (base: string) => {
        let next = base || 'exercise'
        let index = 2
        while (usedExerciseIds.has(next)) {
            next = `${base}_${index}`
            index += 1
        }
        usedExerciseIds.add(next)
        return next
    }

    const exercises = simpleData.map((item) => {
        const rawId = item.id ?? item.exercise_id ?? item.exerciseId
        const baseId = normalizeId(rawId, item.name)
        const id = makeUniqueId(baseId)
        const standardName = normalizeOptionalString(
            item.standard_name
            ?? item.standardName
            ?? item.video_search_name
            ?? item.videoSearchName
        )
        const exerciseKey = normalizeOptionalString(item.exercise_key ?? item.exerciseKey)
        const movementFamilyKey = normalizeOptionalString(item.movement_family_key ?? item.movementFamilyKey)

        const setTargets = Array.isArray(item.set_targets)
            ? item.set_targets
            : Array.isArray(item.setTargets)
                ? item.setTargets
                : []
        const repsValueRaw = normalizeOptionalString(item.reps)
        const repsValue = normalizeRepValue(repsValueRaw)
        const timeValue = normalizeOptionalString(item.time)
        const weightValue = normalizeWeightLabel(normalizeOptionalString(item.weight))
        const inferredTime = !timeValue && /[0-9]+s|min/.test(repsValueRaw) ? repsValueRaw : ''
        const firstSetTime = setTargets.map((target) => normalizeOptionalString(target.time)).find(Boolean) || ''
        const metric: 'reps' | 'time' = (timeValue || inferredTime || (!repsValue && firstSetTime)) ? 'time' : 'reps'
        let sides = normalizeSideCount(item.sides ?? item.side_count ?? item.sideCount)
        const sideMode = normalizeSideMode(item.side_mode ?? item.sideMode)
        const explicitPerSide = normalizeOptionalBoolean(
            item.per_side
            ?? item.perSide
            ?? item.targets_per_side
            ?? item.targetsPerSide
            ?? item.unilateral
        )
        let perSide: boolean | null = null
        if (sideMode === 'per_side') perSide = true
        else if (sideMode === 'total') perSide = false
        else if (explicitPerSide !== null) perSide = explicitPerSide

        let timeMode = normalizeSideMode(item.time_mode ?? item.timeMode ?? item.time_basis ?? item.timeBasis)
        if (!timeMode) {
            const timePerSide = normalizeOptionalBoolean(item.time_per_side ?? item.timePerSide)
            if (timePerSide !== null) {
                timeMode = timePerSide ? 'per_side' : 'total'
            }
        }

        if (metric === 'time') {
            if (timeMode === 'per_side') perSide = true
            else if (timeMode === 'total') perSide = false
        }

        if (sides && perSide === null) {
            perSide = true
        }
        if (perSide && !sides) {
            sides = 2
        }

        const nameLower = item.name.toLowerCase()
        if (!sides && perSide === null && /\bside plank\b/.test(nameLower)) {
            sides = 2
            perSide = true
        }

        let weightMode = normalizeSideMode(item.weight_mode ?? item.weightMode ?? item.weight_basis ?? item.weightBasis)
        if (!weightMode) {
            const weightPerSide = normalizeOptionalBoolean(item.weight_per_side ?? item.weightPerSide)
            if (weightPerSide !== null) {
                weightMode = weightPerSide ? 'per_side' : 'total'
            }
        }
        if (!weightMode && sides && weightValue) {
            weightMode = perSide !== false ? 'per_side' : 'total'
        }

        if (!timeMode && metric === 'time' && sides) {
            timeMode = perSide !== false ? 'per_side' : 'total'
        }

        const perSetMetricValues = setTargets.map((target) => (
            metric === 'time'
                ? normalizeOptionalString(target.time)
                : normalizeRepValue(normalizeOptionalString(target.reps))
        ))
        const distinctPerSetMetricValues = new Set(perSetMetricValues.filter(Boolean))
        const rawSummaryMetricBase = distinctPerSetMetricValues.size > 1
            ? perSetMetricValues.join('/')
            : (metric === 'time' ? (timeValue || inferredTime || perSetMetricValues[0]) : (repsValue || perSetMetricValues[0])) || '-'
        const summaryMetricBase = metric === 'time'
            ? formatDurationForDisplay(rawSummaryMetricBase)
            : rawSummaryMetricBase
        const summaryMetricPerSide = metric === 'time'
            ? Boolean(sides && (timeMode ? timeMode === 'per_side' : perSide !== false))
            : Boolean(sides && perSide)
        const summaryMetric = summaryMetricPerSide ? `${summaryMetricBase}/side` : summaryMetricBase
        const summaryWeight = weightValue
            ? (sides ? `${weightValue} ${weightMode === 'total' ? 'total' : 'per side'}` : weightValue)
            : ''

        // Expand Sets
        const dropSetRaw = item.drop_set ?? item.dropSet ?? item.dropset
        const dropSetValue = Array.isArray(dropSetRaw)
            ? dropSetRaw.map((entry) => String(entry).trim()).filter(Boolean)
            : dropSetRaw
                ? String(dropSetRaw).trim()
                : ''
        const dropSetNormalized = Array.isArray(dropSetValue)
            ? (dropSetValue.length ? dropSetValue : undefined)
            : dropSetValue
                ? dropSetValue
                : undefined

        const warmupData = Array.isArray(item.warmup_sets)
            ? item.warmup_sets
            : Array.isArray(item.warmupSets)
                ? item.warmupSets
                : []
        const warmupSets: WorkoutSet[] = warmupData.map((warmup) => {
            const warmupRepsRaw = normalizeOptionalString(warmup.reps)
            const warmupReps = normalizeRepValue(warmupRepsRaw)
            const warmupTime = normalizeOptionalString(warmup.time)
            const warmupWeight = normalizeWeightLabel(normalizeOptionalString(warmup.weight))
            const inferredWarmupTime = !warmupTime && /[0-9]+s|min|:/.test(warmupRepsRaw) ? warmupRepsRaw : ''
            const useTime = metric === 'time' || Boolean(warmupTime || inferredWarmupTime)

            return {
                targetReps: useTime ? undefined : warmupReps,
                targetTime: useTime ? (warmupTime || inferredWarmupTime || warmupRepsRaw) : undefined,
                targetWeight: warmupWeight,
                isWarmup: true,
            }
        })

        const sets: WorkoutSet[] = [...warmupSets]
        const setCount = setTargets.length || item.sets || 0
        if (setCount > 0) {
            for (let i = 0; i < setCount; i++) {
                const setTarget = setTargets[i]
                const setReps = normalizeRepValue(normalizeOptionalString(setTarget?.reps)) || repsValue
                const setTime = normalizeOptionalString(setTarget?.time) || timeValue || inferredTime
                const setWeight = normalizeWeightLabel(normalizeOptionalString(setTarget?.weight)) || weightValue
                sets.push({
                    targetReps: metric === 'reps' ? setReps : undefined,
                    targetTime: metric === 'time' ? setTime : undefined,
                    targetWeight: setWeight,
                    targetDropSet: dropSetNormalized && i === setCount - 1 ? dropSetNormalized : undefined,
                })
            }
        }

        const timerEnabled = item.timer?.enabled === true
        const prepRaw = item.timer?.prep
        const prepSec = typeof prepRaw === 'number' && Number.isFinite(prepRaw)
            ? Math.max(0, Math.round(prepRaw))
            : 3

        const circuitName = item.circuit?.name?.trim() || ''
        const circuitRounds = typeof item.circuit?.rounds === 'number' && Number.isFinite(item.circuit.rounds)
            ? Math.max(1, Math.round(item.circuit.rounds))
            : undefined
        const circuitRestRaw = item.circuit?.rest_after_sec ?? item.circuit?.rest_after ?? item.circuit?.restAfterSec
        const circuitRestAfterSec = typeof circuitRestRaw === 'number' && Number.isFinite(circuitRestRaw)
            ? Math.max(0, Math.round(circuitRestRaw))
            : undefined
        const circuitOrder = typeof item.circuit?.order === 'number' && Number.isFinite(item.circuit.order)
            ? Math.max(1, Math.round(item.circuit.order))
            : undefined
        const circuitTotalRaw = item.circuit?.total_exercises ?? item.circuit?.totalExercises
        const circuitTotalExercises = typeof circuitTotalRaw === 'number' && Number.isFinite(circuitTotalRaw)
            ? Math.max(1, Math.round(circuitTotalRaw))
            : undefined
        const circuitMeta = circuitName
            ? {
                name: circuitName,
                rounds: circuitRounds,
                restAfterSec: circuitRestAfterSec,
                order: circuitOrder,
                totalExercises: circuitTotalExercises,
            }
            : undefined

        // summary fallback
        const baseSummary = summaryMetric === '-' ? `${item.sets} sets` : `${item.sets} sets x ${summaryMetric}`
        const rawSummary = typeof item.summary === 'string' ? item.summary.trim() : ''
        const displaySummary = metric === 'time' ? formatDurationForDisplay(rawSummary) : rawSummary
        const summaryHasNullish = rawSummary
            ? /\b(nil|nill|null|none|n\/a|na|n\.a\.|undefined)\b/i.test(rawSummary)
            : false
        const summary = displaySummary && !summaryHasNullish
            ? displaySummary
            : (summaryWeight ? `${baseSummary} - ${summaryWeight}` : baseSummary)

        const secondaryMuscles = Array.isArray(item.secondary_muscles)
            ? item.secondary_muscles.filter((muscle): muscle is MuscleGroup => typeof muscle === 'string')
            : Array.isArray(item.secondaryMuscles)
                ? item.secondaryMuscles.filter((muscle): muscle is MuscleGroup => typeof muscle === 'string')
                : []
        const notes = Array.isArray(item.notes)
            ? item.notes.map((note) => String(note).trim()).filter(Boolean).join(' ')
            : (typeof item.notes === 'string' ? item.notes.trim() : '')

        return {
            id,
            name: item.name,
            standardName: standardName || undefined,
            exerciseKey: exerciseKey || undefined,
            movementFamilyKey: movementFamilyKey || undefined,
            section: normalizeSectionLabel(item.section) || 'Workout',
            summary,
            notes: notes || undefined,
            metric,
            restSec: item.rest || 0,
            cues: item.cues || [],
            sets,
            status: item.status,
            timer: timerEnabled ? { enabled: true, prepSec } : undefined,
            category: item.category,
            primaryMuscle: item.primary_muscle ?? item.primaryMuscle,
            secondaryMuscles,
            equipment: item.equipment,
            circuit: circuitMeta,
            sides: sides ?? undefined,
            perSide: sides ? (perSide !== false) : undefined,
            timeMode: metric === 'time' && sides ? (timeMode ?? (perSide !== false ? 'per_side' : 'total')) : undefined,
            weightMode: sides ? (weightMode ?? 'per_side') : undefined,
        }
    })

    const usedExtraIds = new Set<string>()
    const makeUniqueExtraId = (base: string) => {
        let next = base || 'extra'
        let index = 2
        while (usedExtraIds.has(next)) {
            next = `${base}_${index}`
            index += 1
        }
        usedExtraIds.add(next)
        return next
    }

    const extras: WorkoutExtra[] = extraData.map((item) => {
        const baseId = normalizeId(item.id, item.name)
        const id = makeUniqueExtraId(baseId)
        return {
            id,
            name: item.name,
            section: item.section,
            summary: item.summary,
            notes: item.notes || [],
            category: item.category,
        }
    })

    return { exercises, extras }
}
