import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../i18n'
import type { ExerciseHistoryExposure, ExerciseHistoryResponse } from '../../types/exerciseHistory'

type HistoryTab = 'exercise' | 'related'

type ExerciseHistorySheetProps = {
  open: boolean
  loading: boolean
  error: string | null
  history: ExerciseHistoryResponse | null
  onClose: () => void
}

const formatDate = (dateId: string) => {
  const parsed = new Date(`${dateId}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return dateId
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed)
}

const formatTopSet = (exposure: ExerciseHistoryExposure) => {
  const top = exposure.top_set
  if (!top) return null
  const load = top.load_display || (typeof top.load_kg === 'number' ? `${top.load_kg.toFixed(1)} kg` : '')
  const reps = typeof top.reps === 'number' ? `${top.reps} reps` : ''
  return [load, reps].filter(Boolean).join(' × ')
}

const formatVolume = (value?: number) => {
  if (typeof value !== 'number') return null
  return `${Math.round(value).toLocaleString()} kg vol`
}

const HistoryRows: FC<{ rows: ExerciseHistoryExposure[], detailed?: boolean }> = ({ rows, detailed = false }) => {
  const { t } = useI18n()
  if (rows.length === 0) {
    return <p className="exercise-history-empty">{t('workout.historyEmpty')}</p>
  }
  return (
    <div className="exercise-history-list">
      {rows.map((exposure, index) => {
        const topSet = formatTopSet(exposure)
        const volume = formatVolume(exposure.volume_kg)
        return (
          <article className="exercise-history-row" key={`${exposure.date}-${exposure.exercise_key ?? exposure.name}-${index}`}>
            <div className="exercise-history-row-head">
              <div>
                <strong>{formatDate(exposure.date)}</strong>
                {!detailed ? <span>{exposure.name}</span> : null}
              </div>
              {exposure.load_basis === 'per_side' ? <small>{t('workout.perSideShort')}</small> : null}
            </div>
            <div className="exercise-history-metrics">
              {topSet ? <span>{topSet}</span> : null}
              {typeof exposure.working_sets === 'number' ? <span>{exposure.working_sets} {t('workout.workSetsShort')}</span> : null}
              {volume ? <span>{volume}</span> : null}
            </div>
            {detailed && exposure.sets?.length ? (
              <div className="exercise-history-sets">
                {exposure.sets.map((set) => (
                  <span key={set.set_index}>
                    {set.load_display ? `${set.load_display} × ` : ''}
                    {typeof set.reps === 'number' ? set.reps : `${set.time_sec ?? 0}s`}
                    {set.value_source !== 'user_entered' ? <sup>~</sup> : null}
                  </span>
                ))}
              </div>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

const ExerciseHistorySheet: FC<ExerciseHistorySheetProps> = ({ open, loading, error, history, onClose }) => {
  const { t } = useI18n()
  const [tab, setTab] = useState<HistoryTab>('exercise')

  useEffect(() => {
    if (open) setTab('exercise')
  }, [open, history?.identity.exercise_key])

  const rows = useMemo(() => {
    if (!history) return []
    if (tab === 'related') {
      const exactKey = history.identity.exercise_key
      const seen = new Set<string>()
      return [...history.family_exposures, ...history.muscle_exposures]
        .filter((exposure) => exposure.exercise_key !== exactKey)
        .filter((exposure) => {
          const key = `${exposure.date}:${exposure.exercise_key ?? exposure.name}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .sort((left, right) => right.date.localeCompare(left.date))
    }
    return history.exercise_exposures
  }, [history, tab])

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
            <span>{history?.identity.display_name ?? t('workout.historyLoading')}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        <div className="exercise-history-tabs" role="tablist">
          <button type="button" className={tab === 'exercise' ? 'active' : ''} onClick={() => setTab('exercise')}>{t('workout.thisExercise')}</button>
          <button type="button" className={tab === 'related' ? 'active' : ''} onClick={() => setTab('related')}>{t('workout.relatedMoves')}</button>
        </div>
        <div className="exercise-history-content">
          {loading ? <p className="exercise-history-empty">{t('workout.historyLoading')}</p> : null}
          {!loading && error ? <p className="exercise-history-empty error">{error}</p> : null}
          {!loading && !error ? <HistoryRows rows={rows} detailed={tab === 'exercise'} /> : null}
          {!loading && history?.history_quality.lower_confidence_sets ? (
            <p className="exercise-history-confidence">~ {t('workout.historyEstimatedNote')}</p>
          ) : null}
        </div>
      </aside>
    </>
  )
}

export default ExerciseHistorySheet
