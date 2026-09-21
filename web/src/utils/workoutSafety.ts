import type { WorkoutExercise } from '../data/testWorkout'

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

export const normalizeMuscleGroup = (value: unknown): WorkoutExercise['primaryMuscle'] | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = normalizeToken(value)
  return muscleGroups.has(normalized as NonNullable<WorkoutExercise['primaryMuscle']>)
    ? normalized as WorkoutExercise['primaryMuscle']
    : undefined
}
