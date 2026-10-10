import type { CSSProperties, FC } from 'react'
import { useI18n } from '../../i18n'

type ActiveWeekDay = {
  isToday: boolean
} | null | undefined

type WorkoutMiniBarProps = {
  activeWeekDay: ActiveWeekDay
  selectedDayLabel: string
  workoutTitle?: string
  doneSets?: number
  totalSets?: number
}

const WorkoutMiniBar: FC<WorkoutMiniBarProps> = ({
  activeWeekDay,
  selectedDayLabel,
  workoutTitle,
  doneSets = 0,
  totalSets = 0,
}) => {
  const { t } = useI18n()
  const isToday = Boolean(activeWeekDay?.isToday)
  const title = workoutTitle?.trim()
  // A named workout leads; the weekday moves into the small line above it.
  const kicker = title
    ? (isToday ? `${t('workout.title')} · ${selectedDayLabel}` : selectedDayLabel)
    : (isToday ? t('workout.title') : selectedDayLabel)
  const headline = title || (isToday ? selectedDayLabel : t('workout.sectionWorkout'))

  return (
    <section className="workout-mini-bar">
      <div className="workout-mini-copy">
        <div className="workout-mini-heading">
          <p className="workout-mini-kicker">{t('workout.eyebrow')}</p>
          <h1 className="workout-mini-title">
            <span>{kicker}</span>
            <strong>{headline}</strong>
          </h1>
        </div>
        {totalSets > 0 ? (
          <div
            className="workout-day-progress"
            role="img"
            aria-label={t('workout.daySetsProgress', { done: doneSets, total: totalSets })}
            style={{ '--progress': doneSets / totalSets } as CSSProperties}
          >
            <span className="workout-day-progress-text ds-num">
              {t('workout.daySetsProgress', { done: doneSets, total: totalSets })}
            </span>
            <span className="workout-day-progress-track" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </section>
  )
}

export default WorkoutMiniBar
