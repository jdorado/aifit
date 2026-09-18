import type { FC } from 'react'
import { useI18n } from '../../i18n'

type ActiveWeekDay = {
  isToday: boolean
} | null | undefined

type WorkoutMiniBarProps = {
  activeWeekDay: ActiveWeekDay
  selectedDayLabel: string
}

const WorkoutMiniBar: FC<WorkoutMiniBarProps> = ({
  activeWeekDay,
  selectedDayLabel,
}) => {
  const { t } = useI18n()

  return (
    <section className="workout-mini-bar">
      <div className="workout-mini-copy">
        <div className="workout-mini-heading">
          <p className="workout-mini-kicker">{t('workout.eyebrow')}</p>
          <h1 className="workout-mini-title">
            <span>{activeWeekDay?.isToday ? t('workout.title') : selectedDayLabel}</span>
            <strong>{activeWeekDay?.isToday ? selectedDayLabel : t('workout.sectionWorkout')}</strong>
          </h1>
        </div>
      </div>
    </section>
  )
}

export default WorkoutMiniBar
