import { useEffect, useState, type FC } from 'react'
import { useI18n } from '../../i18n'

type PlanNotesProps = {
  notes: string
  open: boolean
  canEdit: boolean
  saving: boolean
  onToggle: () => void
  onSave: (notes: string) => Promise<boolean>
}

const PlanNotes: FC<PlanNotesProps> = ({ notes, open, canEdit, saving, onToggle, onSave }) => {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(notes)

  useEffect(() => {
    if (editing) return
    setDraft(notes)
  }, [editing, notes])

  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean)

  if (!canEdit && lines.length === 0) return null

  const startEditing = () => {
    setDraft(notes)
    setEditing(true)
  }

  const cancelEditing = () => {
    setDraft(notes)
    setEditing(false)
  }

  const save = async () => {
    if (saving) return
    if (await onSave(draft)) {
      setEditing(false)
    }
  }

  return (
    <section className="plan-notes" aria-label={t('workout.dayNotesLabel')}>
      <button
        className="plan-notes-toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="plan-notes-heading">
          <span className="plan-notes-title">{t('workout.dayNotesLabel')}</span>
          <span className="plan-notes-subtitle">{t('workout.dayNotesHint')}</span>
        </span>
        <span className="plan-notes-count">{lines.length}</span>
        <span className={`plan-notes-chevron ${open ? 'open' : ''}`} aria-hidden="true">&gt;</span>
      </button>
      {open ? (
        <div className="plan-notes-panel">
          {editing ? (
            <>
              <textarea
                className="notes-input plan-notes-input"
                rows={3}
                maxLength={4000}
                value={draft}
                placeholder={t('workout.dayNotesPlaceholder')}
                aria-label={t('workout.dayNotesLabel')}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="plan-notes-actions">
                <button
                  className="plan-notes-btn primary"
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                >
                  {saving ? t('common.saving') : t('common.save')}
                </button>
                <button
                  className="plan-notes-btn"
                  type="button"
                  onClick={cancelEditing}
                  disabled={saving}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </>
          ) : lines.length > 0 ? (
            <>
              <ul className="plan-notes-list">
                {lines.map((line, index) => (
                  <li key={`${line}-${index}`}>{line}</li>
                ))}
              </ul>
              {canEdit ? (
                <div className="plan-notes-actions">
                  <button className="plan-notes-btn" type="button" onClick={startEditing} disabled={saving}>
                    {t('workout.planNotesEdit')}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="plan-notes-actions plan-notes-actions--start">
              <p className="plan-notes-empty">{t('workout.planNotesEmpty')}</p>
              {canEdit ? (
                <button className="plan-notes-btn" type="button" onClick={startEditing} disabled={saving}>
                  {t('workout.planNotesAdd')}
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

export default PlanNotes
