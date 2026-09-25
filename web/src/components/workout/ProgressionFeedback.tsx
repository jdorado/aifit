import { useI18n } from '../../i18n'
import { formatProgressionLoad, type ExerciseProgression, type MuscleProgression } from '../../utils/progression'

export function ProgressionFeedback({ summary, onReview }: {
  summary: ExerciseProgression; onReview?: () => void
}) {
  const { t } = useI18n()
  const rule = summary.policy.increase_when
  return <div className="progression-feedback" aria-label={t('progression.title')}>
    <div className="progression-heading"><strong>{t(`progression.status.${summary.status}`)}</strong>
      {summary.prescribed_load ? <span>{formatProgressionLoad(summary.prescribed_load)} · {t(`progression.basis.${summary.load_basis}`)}</span> : null}
    </div>
    <p>{t(`progression.reason.${summary.reason}`)}</p>
    {rule ? <p>{t('progression.rule', { sets: summary.expected_sets ?? '—', reps: rule.completed_reps_at_or_above, rpe: rule.max_rpe })}
      {' '}{t('progression.qualifying', { count: summary.qualifying_sessions, total: summary.required_sessions })}</p> : null}
    {summary.status === 'ready' ? <p><strong>{t('progression.nextLoad', { load: formatProgressionLoad(summary.next_load) })}</strong></p> : null}
    <details><summary>{t('progression.evidence')}</summary>
      {summary.policy.goal ? <p>{summary.policy.goal}</p> : null}
      {summary.latest ? <p>{t('progression.latest', { date: summary.latest.date, reps: summary.latest.reps.map(value => value ?? '—').join(' / '), load: formatProgressionLoad(summary.latest.load) })}</p> : null}
      {summary.trend.reps_change !== null ? <p>{t('progression.trend', { change: `${summary.trend.reps_change >= 0 ? '+' : ''}${summary.trend.reps_change}`, days: summary.trend.days ?? 0, count: summary.trend.exposures })}
        {summary.trend.load_change_kg ? ` ${t('progression.loadGain', { load: formatProgressionLoad({ value: summary.trend.load_change_kg, unit: 'kg' }) })}` : ''}
        {!summary.trend.effort_comparable ? ` ${t('progression.effortUnconfirmed')}` : ''}</p> : <p>{t('progression.noTrend')}</p>}
      {summary.policy.review_by ? <p>{t('progression.reviewBy', { date: summary.policy.review_by })}</p> : null}
      {summary.review_reasons.map(reason => <p key={reason}>{t(`progression.review.${reason}`)}</p>)}
      <p className="progression-muted">{t('progression.ageUnavailable')}</p>
    </details>
    {onReview && (summary.review_reasons.length > 0 || summary.status === 'review' || summary.status === 'coach_managed') ?
      <button className="progression-review" type="button" onClick={onReview}>{t('progression.reviewCoach')}</button> : null}
  </div>
}

export function MuscleProgress({ muscles }: { muscles: MuscleProgression[] }) {
  const { t } = useI18n()
  return <div className="muscle-progress">
    <p className="progression-muted">{t('progression.muscleWindow')}</p>
    {muscles.map(muscle => <section key={muscle.muscle} className="muscle-progress-row">
      <h3>{muscle.muscle.replace(/_/g, ' ')}</h3>
      <strong>{t('progression.muscleImproving', { improved: muscle.improving_exercises, total: muscle.tracked_exercises })}</strong>
      <p>{t('progression.coverage', { count: muscle.comparable_exercises, total: muscle.tracked_exercises })}</p>
      <p>{t('progression.directSets', { done: muscle.direct_completed_sets, total: muscle.direct_planned_sets })}</p>
      <p className="progression-muted">{t('progression.indirectSets', { count: muscle.indirect_completed_sets })} · {muscle.week_start} – {muscle.week_end}</p>
      <details><summary>{t('progression.evidence')}</summary>
        {muscle.exercises.map((exercise, index) => <p key={`${exercise.exercise_id}-${index}`}>
          <strong>{exercise.name}</strong> · {t(`progression.trendStatus.${exercise.trend.status}`)}
          {exercise.trend.reps_change !== null ? ` (${exercise.trend.reps_change >= 0 ? '+' : ''}${exercise.trend.reps_change} ${t('workout.repsLabel')})` : ''}
          {exercise.trend.load_change_kg ? ` · ${t('progression.loadGain', { load: formatProgressionLoad({ value: exercise.trend.load_change_kg, unit: 'kg' }) })}` : ''}
        </p>)}
      </details>
    </section>)}
    <p className="progression-muted">{t('progression.doseScope')}</p>
    <p className="progression-muted">{t('progression.ageUnavailable')}</p>
  </div>
}
