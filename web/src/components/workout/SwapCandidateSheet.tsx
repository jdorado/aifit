import { useEffect, type FC } from 'react'
import { useI18n } from '../../i18n'
import ExerciseFitRating from './ExerciseFitRating'
import type { SwapCandidate } from '../../utils/swapCandidates'

type SwapCandidateSheetProps = {
  open: boolean
  loading: boolean
  fitLoading: boolean
  swappingId: string | null
  error: string | null
  exerciseName: string
  candidates: SwapCandidate[]
  onSelect: (candidate: SwapCandidate) => void
  onAskCoach?: () => void
  inline?: boolean
  onClose: () => void
}

const SwapCandidateSheet: FC<SwapCandidateSheetProps> = ({
  open,
  loading,
  fitLoading,
  swappingId,
  error,
  exerciseName,
  candidates,
  onSelect,
  onClose,
  onAskCoach,
  inline = false,
}) => {
  const { t } = useI18n()

  useEffect(() => {
    if (!open) return undefined
    if (inline) {
      document.getElementById('exercise-similar-options')?.scrollIntoView({ block: 'nearest' })
      return undefined
    }
    const detailContent = document.querySelector<HTMLElement>('.workout-detail.active .detail-content')
    if (!detailContent) return undefined
    const previous = detailContent.style.overflow
    detailContent.style.overflow = 'hidden'
    return () => {
      detailContent.style.overflow = previous
    }
  }, [open, inline])

  if (!open) return null

  return (
    <>
      {!inline ? <button type="button" className="exercise-history-backdrop" aria-label={t('common.close')} onClick={onClose} /> : null}
      <aside id={inline ? 'exercise-similar-options' : undefined} className={inline ? 'exercise-similar-options' : 'exercise-history-sheet'} aria-label={t('workout.swapTitle')}>
        <header className="exercise-history-header">
          <div>
            <strong>{t('workout.swapTitle')}</strong>
            <span>{t('workout.swapHint', { name: exerciseName })}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </header>
        <div className="exercise-history-content">
          {loading ? <p className="exercise-history-empty">{t('workout.swapLoading')}</p> : null}
          {!loading && error ? <p className="exercise-history-empty error">{error}</p> : null}
          {!loading && !error && candidates.length === 0 ? (
            <p className="exercise-history-empty">{t('workout.swapEmpty')}</p>
          ) : null}
          {!loading && !error && candidates.length > 0 ? (
            <div className="exercise-history-list">
              <p className="exercise-fit-hint" role="status">{t(fitLoading ? 'workout.fitLoading' : candidates.some((candidate) => candidate.fit) ? 'workout.fitHint' : 'workout.fitUnavailable')}</p>
              {candidates.map((candidate) => {
                const busy = swappingId === candidate.candidate_id
                return (
                  <button
                    key={candidate.candidate_id}
                    type="button"
                    className="exercise-history-row"
                    disabled={swappingId !== null}
                    onClick={() => onSelect(candidate)}
                    aria-label={`${t('workout.swapSelect', { name: candidate.name })}${candidate.fit ? ` · ${t('workout.fitScore', { score: candidate.fit.score })}` : ''}`}
                  >
                    <span className="exercise-history-row-head">
                      <strong>{candidate.name}</strong>
                      {busy ? <span>{t('workout.swapSwapping')}</span> : null}
                    </span>
                    {candidate.fit ? <ExerciseFitRating fit={candidate.fit} /> : null}
                    <span className="exercise-history-metrics">
                      {candidate.sets ? <span>{t('workout.addExerciseSets', { count: candidate.sets })}</span> : null}
                      {candidate.target_summary ? <span>{candidate.target_summary}</span> : null}
                      {candidate.equipment_kind ? <span>{candidate.equipment_kind}</span> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}
          {!loading && (error || candidates.length === 0) && onAskCoach ? (
            <button type="button" className="exercise-history-row" onClick={onAskCoach}>
              {t('workout.askCoach')}
            </button>
          ) : null}
        </div>
      </aside>
    </>
  )
}

export default SwapCandidateSheet
