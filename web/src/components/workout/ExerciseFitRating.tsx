import { useI18n } from '../../i18n'
import type { ExerciseFit } from '../../utils/exerciseFit'

export default function ExerciseFitRating({ fit }: { fit: ExerciseFit }) {
  const { t } = useI18n()
  const level = fit.score >= 80 ? 'Strong' : fit.score >= 60 ? 'Good' : fit.score >= 40 ? 'Fair' : 'Low'
  return (
    <span className="exercise-fit" data-level={level.toLowerCase()} title={t('workout.fitMeaning')}>
      <span className="exercise-fit-heading">
        <strong>{t('workout.fitScore', { score: fit.score })}</strong>
        <span>{t(`workout.fit${level}`)}</span>
        {fit.tentative ? <small>{t('workout.fitTentative')}</small> : null}
      </span>
      <span className="exercise-fit-meter" aria-hidden="true"><span style={{ width: `${fit.score}%` }} /></span>
      <span className="exercise-fit-factors">
        <span>{t('workout.fitDay')} <b>{fit.factors.day}</b></span>
        <span>{t('workout.fitRecovery')} <b>{fit.factors.recovery}</b></span>
        <span>{t('workout.fitProgress')} <b>{fit.factors.progress}</b></span>
      </span>
    </span>
  )
}
