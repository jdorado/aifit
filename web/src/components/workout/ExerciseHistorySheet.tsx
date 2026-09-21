import type { FC } from 'react'
import { useEffect } from 'react'
import { useI18n } from '../../i18n'
import type { ExerciseHistorySession, ExerciseHistorySet } from '../../utils/exerciseHistory'

type ExerciseHistorySheetProps = {
  open: boolean
  loading: boolean
  error: string | null
  exerciseName: string
  sessions: ExerciseHistorySession[]
  onClose: () => void
}

const formatDate = (dateId: string) => {
  const parsed = new Date(`${dateId}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return dateId
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed)
}

const setMetric = (set: ExerciseHistorySet, repsLabel: (count: number) => string) => {
  if (set.reps !== null) return repsLabel(set.reps)
  if (set.duration_seconds !== null) return `${set.duration_seconds}s`
  return ''
}

const formatSet = (set: ExerciseHistorySet, repsLabel: (count: number) => string) => {
  const load = set.load ? `${set.load.value}${set.load.unit}` : ''
  const metric = setMetric(set, repsLabel)
  return [load, metric].filter(Boolean).join(' × ')
}

const ExerciseHistorySheet: FC<ExerciseHistorySheetProps> = ({
  open,
  loading,
  error,
  exerciseName,
  sessions,
  onClose,
}) => {
  const { t } = useI18n()
  const repsLabel = (count: number) => t('workout.historyReps', { count })

  useEffect(() => {
    if (!open) return undefined
    const detailContent = document.querySelector<HTMLElement>('.workout-detail.active .detail-content')
    if (!detailContent) return undefined
    const previous = detailContent.style.overflow
    detailContent.style.overflow = 'hidden'
    return () => {
      detailContent.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  return (
    <>
      <button type="button" className="exercise-history-backdrop" aria-label={t('common.close')} onClick={onClose} />
      <aside className="exercise-history-sheet" aria-label={t('workout.historyTitle')}>
        <header className="exercise-history-header">
          <div>
            <strong>{t('workout.historyTitle')}</strong>
            <span>{exerciseName}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        <div className="exercise-history-content">
          {loading ? <p className="exercise-history-empty">{t('workout.historyLoading')}</p> : null}
          {!loading && error ? <p className="exercise-history-empty error">{error}</p> : null}
          {!loading && !error && sessions.length === 0 ? (
            <p className="exercise-history-empty">{t('workout.historyEmpty')}</p>
          ) : null}
          {!loading && !error && sessions.length > 0 ? (
            <div className="exercise-history-list">
              {sessions.map((session) => {
                const topSet = session.topSet ? formatSet(session.topSet, repsLabel) : ''
                const volume = session.volumeKg !== null
                  ? t('workout.historyVolume', { value: Math.round(session.volumeKg).toLocaleString() })
                  : ''
                return (
                  <article className="exercise-history-row" key={session.workoutId}>
                    <div className="exercise-history-row-head">
                      <div>
                        <strong>{formatDate(session.date)}</strong>
                        <span>{t('workout.historySetsCount', { count: session.sets.length })}</span>
                      </div>
                    </div>
                    <div className="exercise-history-metrics">
                      {topSet ? <span>{topSet}</span> : null}
                      {volume ? <span>{volume}</span> : null}
                    </div>
                    <div className="exercise-history-sets">
                      {session.sets.map((set, index) => (
                        <span key={set.set_id}>{`${index + 1}. ${formatSet(set, repsLabel)}`}</span>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          ) : null}
        </div>
      </aside>
    </>
  )
}

export default ExerciseHistorySheet
