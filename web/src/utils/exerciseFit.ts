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
