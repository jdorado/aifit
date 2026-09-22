import { useEffect, type FC } from 'react'
import { useI18n } from '../../i18n'
import type { SwapCandidate } from '../../utils/swapCandidates'

type SwapCandidateSheetProps = {
  open: boolean
  loading: boolean
  swappingId: string | null
  error: string | null
  exerciseName: string
  candidates: SwapCandidate[]
  onSelect: (candidate: SwapCandidate) => void
  onClose: () => void
}

const SwapCandidateSheet: FC<SwapCandidateSheetProps> = ({
  open,
  loading,
  swappingId,
  error,
  exerciseName,
  candidates,
  onSelect,
  onClose,
}) => {
  const { t } = useI18n()

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
      <aside className="exercise-history-sheet" aria-label={t('workout.swapTitle')}>
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
              {candidates.map((candidate) => {
                const busy = swappingId === candidate.candidate_id
                return (
                  <button
                    key={candidate.candidate_id}
                    type="button"
                    className="exercise-history-row"
                    disabled={swappingId !== null}
                    onClick={() => onSelect(candidate)}
                    aria-label={t('workout.swapSelect', { name: candidate.name })}
                  >
                    <span className="exercise-history-row-head">
                      <strong>{candidate.name}</strong>
                      {busy ? <span>{t('workout.swapSwapping')}</span> : null}
                    </span>
                    <span className="exercise-history-metrics">
                      {candidate.target_summary ? <span>{candidate.target_summary}</span> : null}
                      {candidate.equipment_kind ? <span>{candidate.equipment_kind}</span> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      </aside>
    </>
  )
}

export default SwapCandidateSheet
