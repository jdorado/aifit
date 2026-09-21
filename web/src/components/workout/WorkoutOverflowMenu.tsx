import { useCallback, useEffect, useRef, useState, type FC } from 'react'
import { useI18n } from '../../i18n'

type WorkoutOverflowMenuProps = {
  canGeneratePlan: boolean
  onGenerateWorkout: () => void
  onVaryWorkout: () => void
  onRefresh: () => void
}

const WorkoutOverflowMenu: FC<WorkoutOverflowMenuProps> = ({
  canGeneratePlan,
  onGenerateWorkout,
  onVaryWorkout,
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
        </div>
      ) : null}
    </div>
  )
}

export default WorkoutOverflowMenu
