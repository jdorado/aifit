import type { FC } from 'react'
import { useMemo } from 'react'
import { useI18n } from '../../i18n'
import type { BackendWorkout } from '../../utils/backendWorkoutAdapter'

type WorkoutHistorySheetProps = {
  open: boolean
  loading: boolean
  error: string | null
  workouts: BackendWorkout[]
  selectedDate: string | null
  onSelectDate: (dateId: string) => void
  onClose: () => void
}

const formatDate = (dateId: string) => {
  const parsed = new Date(`${dateId}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return dateId
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(parsed)
}

const countSets = (workout: BackendWorkout) => (
  workout.segments.reduce(
    (total, segment) => total + segment.items.reduce((sum, item) => sum + item.sets.length, 0),
    0,
  )
)

const countLoggedSets = (workout: BackendWorkout) => (
  workout.segments.reduce(
    (total, segment) => total + segment.items.reduce(
      (sum, item) => sum + item.sets.filter((set) => Boolean(set.actual)).length,
      0,
    ),
    0,
  )
)

const countMoves = (workout: BackendWorkout) => (
  workout.segments.reduce((total, segment) => total + segment.items.length, 0)
)

const WorkoutHistorySheet: FC<WorkoutHistorySheetProps> = ({
  open,
  loading,
  error,
  workouts,
  selectedDate,
  onSelectDate,
  onClose,
}) => {
  const { t } = useI18n()

  const rows = useMemo(() => workouts.map((workout) => {
    const total = countSets(workout)
    const logged = countLoggedSets(workout)
    return {
      workout,
      total,
      logged,
      moves: countMoves(workout),
      complete: total > 0 && logged >= total,
    }
  }), [workouts])

  if (!open) return null

  return (
    <>
      <button type="button" className="workout-history-backdrop" aria-label={t('common.close')} onClick={onClose} />
      <aside className="workout-history-sheet" aria-label={t('workout.workoutHistoryTitle')}>
        <header className="workout-history-header">
          <div>
            <strong>{t('workout.workoutHistoryTitle')}</strong>
            <span>{t('workout.workoutHistorySubtitle')}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        <div className="workout-history-content">
          {loading ? <p className="workout-history-empty">{t('workout.workoutHistoryLoading')}</p> : null}
          {!loading && error ? <p className="workout-history-empty error">{error}</p> : null}
          {!loading && !error && rows.length === 0 ? (
            <p className="workout-history-empty">{t('workout.workoutHistoryEmpty')}</p>
          ) : null}
          {!loading && !error && rows.length > 0 ? (
            <ol className="workout-history-timeline">
              {rows.map(({ workout, total, logged, moves, complete }) => {
                const isSelected = selectedDate === workout.date
                return (
                  <li
                    key={workout.workout_id}
                    className={`workout-history-item${complete ? ' complete' : ''}${isSelected ? ' selected' : ''}`}
                  >
                    <span className="workout-history-dot" aria-hidden="true" />
                    <button
                      type="button"
                      className="workout-history-card"
                      onClick={() => onSelectDate(workout.date)}
                    >
                      <span className="workout-history-date">{formatDate(workout.date)}</span>
                      <strong className="workout-history-title">{workout.title || workout.date}</strong>
                      <span className="workout-history-meta">
                        {t('workout.workoutHistoryMoves', { count: moves })}
                        {' · '}
                        {t('workout.workoutHistorySets', { done: logged, total })}
                      </span>
                      {isSelected ? (
                        <span className="workout-history-current">{t('workout.workoutHistoryViewing')}</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ol>
          ) : null}
        </div>
      </aside>
    </>
  )
}

export default WorkoutHistorySheet
