import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import { MuscleProgress } from './ProgressionFeedback'
import type { MuscleProgression } from '../../utils/progression'
import type { ExerciseHistoryRelated, ExerciseHistorySession, ExerciseHistorySet } from '../../utils/exerciseHistory'

type HistoryTab = 'exercise' | 'related' | 'muscle'

type ExerciseHistorySheetProps = {
  open: boolean
  loading: boolean
  error: string | null
  exerciseName: string
  sessions: ExerciseHistorySession[]
  related: ExerciseHistoryRelated | null
  muscles: MuscleProgression[]
  progressionLoading: boolean
  progressionError: boolean
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
  related,
  muscles,
  progressionLoading,
  progressionError,
  onClose,
}) => {
  const { t } = useI18n()
  const [tab, setTab] = useState<HistoryTab>('exercise')
  const repsLabel = (count: number) => t('workout.historyReps', { count })

  useEffect(() => {
    if (open) setTab('exercise')
  }, [open, exerciseName])

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

  const relatedSessions = useMemo(() => {
    if (!related) return []
    const seen = new Set<string>()
    return [...related.family, ...related.muscle].filter((session) => {
      const key = `${session.workoutId}:${session.exerciseName ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [related])

  const visibleSessions = tab === 'related' ? relatedSessions : sessions
  const visibleLoading = loading || (tab === 'related' && related === null)
  const visibleEmpty = t(tab === 'related' ? 'workout.relatedEmpty' : 'workout.historyEmpty')

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
        <div className="exercise-history-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'exercise'}
            className={tab === 'exercise' ? 'active' : ''}
            onClick={() => setTab('exercise')}
          >
            {t('workout.thisExercise')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'related'}
            className={tab === 'related' ? 'active' : ''}
            onClick={() => setTab('related')}
          >
            {t('workout.relatedMoves')}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'muscle'} className={tab === 'muscle' ? 'active' : ''} onClick={() => setTab('muscle')}>
            {t('progression.muscleTitle')}
          </button>
        </div>
        <div className="exercise-history-content">
          {tab === 'muscle' ? progressionLoading ? <p>{t('progression.loading')}</p> : progressionError ? <p>{t('progression.loadError')}</p> : muscles.length ? <MuscleProgress muscles={muscles} /> : <p>{t('progression.noTrend')}</p> : <>

          {visibleLoading ? <p className="exercise-history-empty">{t('workout.historyLoading')}</p> : null}
          {!visibleLoading && error ? <p className="exercise-history-empty error">{error}</p> : null}
          {!visibleLoading && !error && visibleSessions.length === 0 ? (
            <p className="exercise-history-empty">{visibleEmpty}</p>
          ) : null}
          {!visibleLoading && !error && visibleSessions.length > 0 ? (
            <div className="exercise-history-list">
              {visibleSessions.map((session) => {
                const topSet = session.topSet ? formatSet(session.topSet, repsLabel) : ''
                const volume = session.volumeKg !== null
                  ? t('workout.historyVolume', { value: Math.round(session.volumeKg).toLocaleString() })
                  : ''
                return (
                  <article className="exercise-history-row" key={`${session.workoutId}:${session.exerciseName ?? ''}`}>
                    <div className="exercise-history-row-head">
                      <div>
                        <strong>{formatDate(session.date)}</strong>
                        <span>
                          {tab === 'related' && session.exerciseName ? `${session.exerciseName} · ` : ''}
                          {t('workout.historySetsCount', { count: session.sets.length })}
                        </span>
                      </div>
                    </div>
                    <div className="exercise-history-metrics">
                      {topSet ? <span>{topSet}</span> : null}
                      {volume ? <span>{volume}</span> : null}
                    </div>
                    {tab === 'exercise' ? (
                      <div className="exercise-history-sets">
                        {session.sets.map((set, index) => (
                          <span key={set.set_id}>{`${index + 1}. ${formatSet(set, repsLabel)}`}</span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </div>
          ) : null}
          </>}
        </div>
      </aside>
    </>
  )
}

export default ExerciseHistorySheet
