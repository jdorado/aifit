import { useEffect, useRef, useState, type FC } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import { overlayFitScores } from '../../utils/exerciseFit'
import ExerciseFitRating from './ExerciseFitRating'
import type { ExerciseRepertoire, RepertoireCandidate } from '../../utils/exerciseRepertoire'

type Props = {
  onLoad: (rankFit?: boolean, signal?: AbortSignal) => Promise<ExerciseRepertoire>
  onAdd: (candidate: RepertoireCandidate, repertoire: ExerciseRepertoire) => Promise<boolean>
  onClose: () => void
}

const searchable = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/_/g, ' ').toLowerCase()

const AddExerciseSheet: FC<Props> = ({ onLoad, onAdd, onClose }) => {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const loadRef = useRef(onLoad)
  loadRef.current = onLoad
  const mountedRef = useRef(false)
  const busyRef = useRef(false)
  const [repertoire, setRepertoire] = useState<ExerciseRepertoire | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [fitLoading, setFitLoading] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    mountedRef.current = true
    const previous = document.activeElement as HTMLElement | null
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      mountedRef.current = false
      dialog?.close()
      previous?.focus()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    requestRef.current = controller
    const load = loadRef.current
    setLoading(true)
    setFitLoading(false)
    setError(null)
    void (async () => {
      try {
        const result = await load(false, controller.signal)
        if (controller.signal.aborted) return
        setRepertoire(result)
        setLoading(false)
        if (!result.candidates.some((candidate) => !candidate.already_added)) return
        setFitLoading(true)
        try {
          const rated = await load(true, controller.signal)
          if (controller.signal.aborted || busyRef.current) return
          const candidates = overlayFitScores(result, rated)
          if (candidates) setRepertoire({ ...result, candidates })
        } catch {
          // Ratings are optional; the already-rendered list stays usable.
        } finally {
          if (!controller.signal.aborted) setFitLoading(false)
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : t('workout.addExerciseFailed'))
          setLoading(false)
        }
      }
    })()
    return () => { controller.abort() }
  }, [loadAttempt, t])

  const add = async (candidate: RepertoireCandidate) => {
    if (!repertoire || busyRef.current || candidate.already_added) return
    busyRef.current = true
    requestRef.current?.abort()
    setFitLoading(false)
    setAddingId(candidate.exercise_id)
    setError(null)
    try {
      const saved = await onAdd(candidate, repertoire)
      if (!mountedRef.current) return
      if (saved) onClose()
      else setLoadAttempt((value) => value + 1)
    } catch {
      if (mountedRef.current) setError(t('workout.addExerciseFailed'))
    } finally {
      busyRef.current = false
      if (mountedRef.current) setAddingId(null)
    }
  }

  const terms = searchable(query).trim().split(/\s+/).filter(Boolean)
  const candidates = (repertoire?.candidates ?? []).filter((candidate) => {
    const haystack = searchable([
      candidate.name, candidate.equipment_kind, candidate.day_title, candidate.section_title,
      candidate.role, ...candidate.primary_muscles, ...candidate.secondary_muscles,
    ].join(' '))
    return terms.every((term) => haystack.includes(term))
  })

  return createPortal(
    <dialog ref={dialogRef} className="exercise-history-sheet add-exercise-sheet" aria-labelledby="add-exercise-title"
      onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget && !busyRef.current) onClose() }}>
      <header className="exercise-history-header">
        <div>
          <strong id="add-exercise-title">{t('workout.addExercise')}</strong>
          <span>{t('workout.addExerciseHint')}</span>
        </div>
        <button type="button" onClick={onClose} disabled={addingId !== null} aria-label={t('common.close')} autoFocus>×</button>
      </header>
      <div className="add-exercise-search">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t('workout.addExerciseSearch')} aria-label={t('workout.addExerciseSearch')} />
      </div>
      <div className="exercise-history-content" aria-busy={loading || addingId !== null}>
        {loading ? <p className="exercise-history-empty" role="status">{t('common.loading')}</p> : null}
        {!loading && error ? (
          <div className="exercise-history-empty" role="alert">
            <p>{error}</p>
            <button type="button" className="plan-notes-btn" onClick={() => setLoadAttempt((value) => value + 1)}>{t('common.retry')}</button>
          </div>
        ) : null}
        {!loading && !error && !candidates.length ? (
          <p className="exercise-history-empty" role="status">{t(query.trim() ? 'workout.addExerciseNoMatch' : 'workout.addExerciseEmpty')}</p>
        ) : null}
        {!loading && !error ? (
          <div className="exercise-history-list">
            <p className="exercise-fit-hint" role="status">{t(fitLoading ? 'workout.fitLoading' : repertoire?.candidates.some((candidate) => candidate.fit) ? 'workout.fitHint' : 'workout.fitUnavailable')}</p>
            {candidates.map((candidate) => (
              <button key={candidate.exercise_id} type="button" className="exercise-history-row"
                disabled={candidate.already_added || addingId !== null} onClick={() => void add(candidate)}
                aria-label={candidate.already_added ? `${candidate.name}: ${t('workout.addExerciseAlreadyAdded')}` : `${t('workout.addExerciseSelect', { name: candidate.name })}${candidate.fit ? ` · ${t('workout.fitScore', { score: candidate.fit.score })}` : ''}`}>
                <span className="exercise-history-row-head">
                  <strong>{candidate.name}</strong>
                  <span>{candidate.already_added ? t('workout.addExerciseAlreadyAdded') : addingId === candidate.exercise_id ? t('workout.addExerciseSaving') : '+'}</span>
                </span>
                {candidate.fit ? <ExerciseFitRating fit={candidate.fit} /> : null}
                <span className="exercise-history-metrics">
                  <span>{t('workout.addExerciseSets', { count: candidate.sets })} · {candidate.target_summary}</span>
                  {candidate.equipment_kind ? <span>{candidate.equipment_kind.replace(/_/g, ' ')}</span> : null}
                </span>
                <span className="add-exercise-source">{candidate.day_title} · {candidate.section_title}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </dialog>, document.body,
  )
}

export default AddExerciseSheet
