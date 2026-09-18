import type { FC } from 'react'
import { useI18n } from '../../i18n'

type PlanNotesProps = {
  lines: string[]
  open: boolean
  onToggle: () => void
}

const PlanNotes: FC<PlanNotesProps> = ({ lines, open, onToggle }) => {
  const { t } = useI18n()

  if (lines.length === 0) return null

  return (
    <section className="plan-notes" aria-label={t('workout.planNotesLabel')}>
      <button
        className="plan-notes-toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="plan-notes-title">{t('workout.planNotesLabel')}</span>
        <span className="plan-notes-count">{lines.length}</span>
        <span className={`plan-notes-chevron ${open ? 'open' : ''}`} aria-hidden="true">&gt;</span>
      </button>
      {open ? (
        <ul className="plan-notes-list">
          {lines.map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

export default PlanNotes
