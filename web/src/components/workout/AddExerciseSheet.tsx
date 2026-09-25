import { useEffect, useRef, useState, type FC } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../../i18n'
import type { ExerciseRepertoire, RepertoireCandidate } from '../../utils/exerciseRepertoire'

type Props = {
  onLoad: () => Promise<ExerciseRepertoire>
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
    let cancelled = false
    setLoading(true)
    setError(null)
    loadRef.current().then((result) => {
      if (!cancelled) setRepertoire(result)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : t('workout.addExerciseFailed'))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [loadAttempt, t])

  const add = async (candidate: RepertoireCandidate) => {
    if (!repertoire || busyRef.current || candidate.already_added) return
    busyRef.current = true
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
            {candidates.map((candidate) => (
              <button key={candidate.exercise_id} type="button" className="exercise-history-row"
                disabled={candidate.already_added || addingId !== null} onClick={() => void add(candidate)}
                aria-label={candidate.already_added ? `${candidate.name}: ${t('workout.addExerciseAlreadyAdded')}` : t('workout.addExerciseSelect', { name: candidate.name })}>
                <span className="exercise-history-row-head">
                  <strong>{candidate.name}</strong>
                  <span>{candidate.already_added ? t('workout.addExerciseAlreadyAdded') : addingId === candidate.exercise_id ? t('workout.addExerciseSaving') : '+'}</span>
                </span>
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
