import type { WorkoutExercise } from '../data/testWorkout'
import type { SetState } from '../types/app'

// Canonical round numbers survive swaps/removals; older sessions fall back
// to the working-set position. Always choose real open work, not round counts.
export const getCircuitSetRound = (exercise: WorkoutExercise, index: number): number => (
  exercise.sets[index]?.isWarmup ? -1
    : (exercise.sets[index]?.round ?? exercise.sets.slice(0, index + 1)
      .filter((set) => !set.isWarmup).length) - 1
)

export const getNextCircuitSet = (
  exercises: WorkoutExercise[],
  logs: Record<string, SetState[]>,
  afterExerciseId?: string,
): { exercise: WorkoutExercise, index: number, round: number } | null => {
  const start = afterExerciseId ? exercises.findIndex((exercise) => exercise.id === afterExerciseId) + 1 : 0
  let next: ReturnType<typeof getNextCircuitSet> = null
  for (let offset = 0; offset < exercises.length; offset++) {
    const exercise = exercises[(start + offset) % exercises.length]
    if (exercise.status === 'skip') continue
    const index = exercise.sets.findIndex((_, i) => !logs[exercise.id]?.[i]?.done)
    if (index === -1) continue
    const round = getCircuitSetRound(exercise, index)
    if (!next || round < next.round) next = { exercise, index, round }
  }
  return next
}
