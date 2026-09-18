import { useCallback, useEffect, useRef, useState, type FC } from 'react'
import { useI18n } from '../../i18n'

type ChatOverflowMenuProps = {
  onRefresh: () => void
}

const ChatOverflowMenu: FC<ChatOverflowMenuProps> = ({
  onRefresh,
}) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    const handleOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const closeAfter = useCallback((action: () => void) => {
    setOpen(false)
    action()
  }, [])

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
          <button
            className="header-menu-item"
            type="button"
            role="menuitem"
            onClick={() => closeAfter(onRefresh)}
          >
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
        </div>
      ) : null}
    </div>
  )
}

export default ChatOverflowMenu
