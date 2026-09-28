import { useI18n } from '../../i18n'
import { formatProgressionLoad, type ExerciseProgression, type MuscleProgression } from '../../utils/progression'

export function ProgressionFeedback({ summary, selectedWeight, onReview }: {
  summary: ExerciseProgression; selectedWeight?: string; onReview?: () => void
}) {
  const { t } = useI18n()
  const comparison = summary.comparison
  const direction = comparison?.status ?? summary.trend.status
  const phase = summary.policy.phase
  const feedback = summary.review_reasons.includes('exercise_feedback')
  const state = feedback ? 'review' : phase === 'deload' ? 'lighter' : phase === 'maintain' ? 'maintain'
    : summary.status === 'ready' ? 'ready'
      : direction === 'improving' ? (comparison?.partial ? 'improvingSoFar' : 'improving')
        : direction === 'lower' ? (comparison?.partial ? 'building' : 'lower')
          : direction === 'holding' ? 'steady' : summary.latest ? 'building' : 'baseline'
  const tone = ['ready', 'improving', 'improvingSoFar'].includes(state) ? 'green'
    : ['lower', 'review'].includes(state) ? 'red'
      : ['steady', 'building'].includes(state) ? 'amber' : 'neutral'
  const last = summary.previous ?? summary.latest
  const lastText = last?.load ? t('progression.compact.last', {
    load: formatProgressionLoad(last.load), reps: last.reps.map(value => value ?? '—').join(' / '),
  }) : t('progression.compact.justLog')
  const next = formatProgressionLoad(summary.next_load)
  const reps = summary.policy.increase_when?.completed_reps_at_or_above ?? summary.target_reps?.max
  return <details className="progression-strip" data-tone={tone}>
    <summary aria-label={`${t('progression.title')}: ${t(`progression.compact.${state}`)}`}>
      <span className="progression-signal" aria-hidden="true">{tone === 'green' ? '↗' : tone === 'red' ? '↘' : '→'}</span>
      <span className="progression-strip-copy"><strong>{t(`progression.compact.${state}`)}</strong><small>{lastText}</small></span>
      <span className="progression-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="progression-detail">
      {feedback || summary.status === 'review' ? <p>{t('progression.compact.review')}</p>
        : summary.status === 'ready' ? <p>{t('progression.nextLoad', { load: next })}</p>
        : phase === 'deload' || phase === 'maintain' ? <p>{summary.policy.goal || t('progression.compact.followPlan')}</p>
          : summary.next_load && reps ? <p>{t('progression.compact.buildReps', { load: next, reps })}</p> : null}
      {selectedWeight && last?.load ? <p>{t('progression.compact.selected', { load: selectedWeight })}</p> : null}
      {comparison?.reference ? <p>{t('progression.compact.compared', { date: comparison.reference.date, count: comparison.sets_compared })}</p> : null}
      {onReview ? <button type="button" className="progression-review" onClick={onReview}>{t('progression.compact.askCoach')}</button> : null}
    </div>
  </details>
}

export function MuscleProgress({ muscles }: { muscles: MuscleProgression[] }) {
  const { t } = useI18n()
  return <div className="muscle-progress">
    <p className="progression-muted">{t('progression.muscleWindow')}</p>
    {muscles.map(muscle => <section key={muscle.muscle} className="muscle-progress-row">
      <h3>{muscle.muscle.replace(/_/g, ' ')}</h3>
      <strong>{t('progression.muscleImproving', { improved: muscle.improving_exercises, total: muscle.tracked_exercises })}</strong>
      <p>{t('progression.directSets', { done: muscle.direct_completed_sets, total: muscle.direct_planned_sets })}</p>
      <p className="progression-muted">{t('progression.indirectSets', { count: muscle.indirect_completed_sets })}</p>
      <details><summary>{t('progression.compact.seeExercises')}</summary>
        {muscle.exercises.map((exercise, index) => <p key={`${exercise.exercise_id}-${index}`}>
          <strong>{exercise.name}</strong> · {t(`progression.trendStatus.${exercise.trend.status}`)}
        </p>)}
      </details>
    </section>)}
  </div>
}
