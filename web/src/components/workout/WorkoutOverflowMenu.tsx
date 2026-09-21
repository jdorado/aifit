import { useCallback, useEffect, useRef, useState, type FC } from 'react'
import { useI18n } from '../../i18n'

type WorkoutOverflowMenuProps = {
  canGeneratePlan: boolean
  canGenerateWithCoach: boolean
  canCopyLastWeek: boolean
  canClearWorkout: boolean
  onGenerateWorkout: () => void
  onVaryWorkout: () => void
  onGenerateWithCoach: () => void
  onCopyLastWeek: () => void
  onClearWorkout: () => void
  onRefresh: () => void
}

const WorkoutOverflowMenu: FC<WorkoutOverflowMenuProps> = ({
  canGeneratePlan,
  canGenerateWithCoach,
  canCopyLastWeek,
  canClearWorkout,
  onGenerateWorkout,
  onVaryWorkout,
  onGenerateWithCoach,
  onCopyLastWeek,
  onClearWorkout,
  onRefresh,
}) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current) return
      if (!menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const closeAfter = useCallback((action: () => void) => {
    action()
    setOpen(false)
  }, [])

  const handleGenerate = useCallback(() => {
    if (!canGeneratePlan) return
    closeAfter(onGenerateWorkout)
  }, [canGeneratePlan, closeAfter, onGenerateWorkout])

  const handleGenerateWithCoach = useCallback(() => {
    if (!canGenerateWithCoach) return
    closeAfter(onGenerateWithCoach)
  }, [canGenerateWithCoach, closeAfter, onGenerateWithCoach])

  const handleCopyLastWeek = useCallback(() => {
    if (!canCopyLastWeek) return
    closeAfter(onCopyLastWeek)
  }, [canCopyLastWeek, closeAfter, onCopyLastWeek])

  const handleClear = useCallback(() => {
    if (!canClearWorkout) return
    closeAfter(onClearWorkout)
  }, [canClearWorkout, closeAfter, onClearWorkout])

  return (
    <div className="header-menu" ref={menuRef}>
      <button
        className={`header-menu-trigger${open ? ' active' : ''}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label={t('common.more')}
        title={t('common.more')}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <svg className="header-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 7h16M4 12h16M4 17h16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open ? (
        <div className="header-menu-panel" role="menu">
          <button className="header-menu-item" type="button" role="menuitem" onClick={() => closeAfter(onRefresh)}>
            <svg className="header-menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M20 12a8 8 0 1 1-2.34-5.66"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M20 4v5h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t('common.refresh')}</span>
          </button>
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            onClick={handleGenerate}
            disabled={!canGeneratePlan}
          >
            <svg className="header-menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 4v4m0 8v4M4 12h4m8 0h4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle
                cx="12"
                cy="12"
                r="3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              />
            </svg>
            <span>{t('workout.generateAction')}</span>
          </button>
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            onClick={() => closeAfter(onVaryWorkout)}
            disabled={!canGeneratePlan}
          >
            <svg className="header-menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h4l8 10h4M16 7h4v4M4 17h4l2-2M16 17h4v-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{t('workout.varyAction')}</span>
          </button>
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            onClick={handleGenerateWithCoach}
            disabled={!canGenerateWithCoach}
          >
            <svg className="header-menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4ZM5 21a7 7 0 0 1 14 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span>{t('workout.generateWithCoachAction')}</span>
          </button>
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            onClick={handleCopyLastWeek}
            disabled={!canCopyLastWeek}
          >
            <svg className="header-menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 8h12v13H8zM16 8V3H3v13h5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
            <span>{t('workout.copyLastWeekAction')}</span>
          </button>
          <div className="header-menu-divider" role="separator" />
          <button
            className="header-menu-item danger"
            type="button"
            role="menuitem"
            onClick={handleClear}
            disabled={!canClearWorkout}
          >
            <svg className="header-menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M9 6h6M4 6h16M7 6l1-2h8l1 2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M7 6l1 13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-13"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t('workout.clearAction')}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default WorkoutOverflowMenu
