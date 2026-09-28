export type ExerciseFit = {
  score: number
  tentative: boolean
  factors: { day: number; recovery: number; progress: number }
}

export const readExerciseFit = (value: unknown): ExerciseFit | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const fit = value as ExerciseFit
  const scores = [fit.score, fit.factors?.day, fit.factors?.recovery, fit.factors?.progress]
  return scores.every((score) => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100)
    && typeof fit.tentative === 'boolean' ? fit : undefined
}

type FitCandidate = { candidate_id: string; exercise_id: string; day_id?: string; slot_id?: string; fit?: ExerciseFit }
type FitPicker<T> = {
  workout_id: string
  workout_revision: string
  blueprint_id: string
  blueprint_revision: string
  exercise_instance_id?: string
  candidates: T[]
}

const candidateKey = (candidate: FitCandidate) => JSON.stringify([
  candidate.day_id, candidate.slot_id, candidate.candidate_id, candidate.exercise_id,
])

/** A delayed rating may decorate only the exact choices/revisions already shown. */
export const overlayFitScores = <T extends FitCandidate>(current: FitPicker<T>, rated: FitPicker<T>): T[] | null => {
  if (current.workout_id !== rated.workout_id || current.workout_revision !== rated.workout_revision
    || current.blueprint_id !== rated.blueprint_id || current.blueprint_revision !== rated.blueprint_revision
    || current.exercise_instance_id !== rated.exercise_instance_id
    || current.candidates.length !== rated.candidates.length) return null
  const scores = new Map(rated.candidates.map((candidate) => [candidateKey(candidate), candidate]))
  if (scores.size !== current.candidates.length) return null
  const result: T[] = []
  for (const candidate of current.candidates) {
    const match = scores.get(candidateKey(candidate))
    if (!match || match.exercise_id !== candidate.exercise_id) return null
    result.push({ ...candidate, fit: readExerciseFit(match.fit) })
  }
  return result.sort((a, b) => (b.fit?.score ?? -1) - (a.fit?.score ?? -1))
}
