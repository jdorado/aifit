import type { FC } from 'react'
import { useI18n } from '../../i18n'

type WeekDaySummary = {
  index: number
  date: string
  label: string
  isToday: boolean
  isPast: boolean
  isFuture: boolean
  isSelected: boolean
  isCompleted: boolean
  isRest: boolean
  isProjected?: boolean
  isSelectable?: boolean
}

type WeekStripProps = {
  days: WeekDaySummary[]
  onSelectDay: (index: number, date: string) => void
}

const WeekStrip: FC<WeekStripProps> = ({ days, onSelectDay }) => {
  const { t } = useI18n()

  if (days.length === 0) return null

  return (
    <div className="week-strip" role="tablist" aria-label={t('workout.weekStripLabel')}>
      {days.map((day) => {
        const dayNumber = String(Number(day.date.split('-').pop() || ''))
        const isSelectable = day.isSelectable ?? true
        return (
          <button
            key={day.date}
            className={`week-day ${day.isSelected ? 'active' : ''} ${day.isToday ? 'today' : ''} ${day.isPast ? 'past' : ''} ${day.isFuture ? 'future' : ''} ${day.isCompleted ? 'completed' : ''} ${day.isRest ? 'rest' : ''} ${day.isProjected ? 'projected' : ''}`}
            type="button"
            onClick={() => {
              if (isSelectable) onSelectDay(day.index, day.date)
            }}
            disabled={!isSelectable}
            aria-pressed={day.isSelected}
            aria-disabled={!isSelectable}
            aria-label={`${day.label} ${day.date}`}
          >
            <span className="week-day-label">{day.label}</span>
            <span className="week-day-date">{dayNumber}</span>
            <span className="week-day-dot">
              {day.isCompleted ? (
                <svg className="week-day-check" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 8.4 6.8 11 12 5" />
                </svg>
              ) : day.isRest ? '•' : ''}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export default WeekStrip
