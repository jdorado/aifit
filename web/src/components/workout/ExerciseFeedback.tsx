import { useEffect, useState, type FC } from 'react'
import type { WorkoutFeedbackPreset } from '../../data/testWorkout'
import { useI18n } from '../../i18n'

const FEEDBACK_PRESETS: WorkoutFeedbackPreset[] = ['pain', 'hard', 'easy', 'form']

const PRESET_LABEL_KEYS: Record<WorkoutFeedbackPreset, string> = {
  pain: 'workout.feedbackPresetPain',
  hard: 'workout.feedbackPresetHard',
  easy: 'workout.feedbackPresetEasy',
  form: 'workout.feedbackPresetForm',
}

type ExerciseFeedbackProps = {
  note: string
  preset: WorkoutFeedbackPreset | null
  canEdit: boolean
  saving: boolean
  onSave: (note: string, preset: WorkoutFeedbackPreset | null) => Promise<boolean>
}

const ExerciseFeedback: FC<ExerciseFeedbackProps> = ({ note, preset, canEdit, saving, onSave }) => {
  const { t } = useI18n()
  const [draft, setDraft] = useState(note)
  const [selectedPreset, setSelectedPreset] = useState<WorkoutFeedbackPreset | null>(preset)
  const [savedNotice, setSavedNotice] = useState(false)
  const dirty = draft !== note || selectedPreset !== preset

  useEffect(() => {
    if (dirty) return
    setDraft(note)
    setSelectedPreset(preset)
  }, [dirty, note, preset])

  useEffect(() => {
    if (!savedNotice) return undefined
    const timeoutId = window.setTimeout(() => setSavedNotice(false), 2000)
    return () => window.clearTimeout(timeoutId)
  }, [savedNotice])

  const save = async () => {
    if (!canEdit || saving || !dirty) return
    const note = draft.trim()
    if (await onSave(note, selectedPreset)) {
      setDraft(note)
      setSavedNotice(true)
    }
  }

  return (
    <section className="notes-block exercise-feedback open" aria-label={t('workout.feedbackLabel')}>
      <div className="notes-toggle exercise-feedback-header">
        <span className="notes-toggle-text">
          <span className="notes-title">{t('workout.feedbackLabel')}</span>
          <span className="notes-subtitle">{t('workout.feedbackHint')}</span>
        </span>
        {savedNotice ? <span className="exercise-feedback-saved">{t('workout.feedbackSaved')}</span> : null}
      </div>
      <div className="notes-panel exercise-feedback-panel">
        <div className="note-chips" role="group" aria-label={t('workout.feedbackLabel')}>
          {FEEDBACK_PRESETS.map((item) => (
            <button
              key={item}
              className={`note-chip${selectedPreset === item ? ' is-active' : ''}`}
              type="button"
              aria-pressed={selectedPreset === item}
              disabled={!canEdit || saving}
              onClick={() => setSelectedPreset(selectedPreset === item ? null : item)}
            >
              {t(PRESET_LABEL_KEYS[item])}
            </button>
          ))}
        </div>
        <textarea
          className="notes-input exercise-feedback-input"
          rows={2}
          maxLength={2000}
          value={draft}
          placeholder={t('workout.feedbackPlaceholder')}
          aria-label={t('workout.feedbackLabel')}
          disabled={!canEdit || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="exercise-feedback-actions">
          <button
            className="exercise-feedback-save primary"
            type="button"
            onClick={() => void save()}
            disabled={!canEdit || saving || !dirty}
          >
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </section>
  )
}

export default ExerciseFeedback
