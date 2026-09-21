import type { FC, ReactNode } from 'react'
import { useI18n } from '../i18n'
import BrandMark from './ui/BrandMark'

type TabName = 'home' | 'workout' | 'profile'

type TabBarProps = {
  activeView: TabName
  onChange: (view: TabName) => void
  coachModeActive?: boolean
  coachContextLabel?: string
  onExitCoachMode?: () => void
  disabledTab?: TabName | null
  disabledNotice?: string
  leadingControl?: ReactNode
}

const TabBar: FC<TabBarProps> = ({
  activeView,
  onChange,
  coachModeActive = false,
  coachContextLabel = '',
  onExitCoachMode,
  disabledTab = null,
  disabledNotice = '',
  leadingControl = null,
}) => {
  const { t } = useI18n()
  const tabs: Array<{
    key: TabName
    label: string
    icon: JSX.Element
    featured?: boolean
  }> = [
    {
      key: 'home',
      label: t('tabs.home'),
      icon: (
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
    {
      key: 'workout',
      label: t('tabs.workout'),
      featured: true,
      icon: (
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6.5 6.5 11 11" />
          <path d="m21 21-1-1" />
          <path d="m3 3 1 1" />
          <path d="m18 22 4-4" />
          <path d="m2 6 4-4" />
          <path d="m3 10 7-7" />
          <path d="m14 21 7-7" />
        </svg>
      ),
    },
    {
      key: 'profile',
      label: t('tabs.profile'),
      icon: (
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="3" />
          <path d="M4 20c2-4 14-4 16 0" />
        </svg>
      ),
    },
  ]

  return (
    <div className={`app-top-bar ${coachModeActive ? 'coach-active' : ''}`}>
      <BrandMark alt={t('chat.logoAlt')} className="app-top-bar-logo" />
      {coachModeActive || coachContextLabel ? (
        <div className="app-top-bar-coach-context" role="status">
          <span>{t('coach.viewingTrainee')}</span>
          <strong title={coachContextLabel}>{coachContextLabel || t('coach.traineeFallback')}</strong>
          {disabledNotice ? (
            <span className="app-top-bar-coach-notice">{disabledNotice}</span>
          ) : null}
          {onExitCoachMode ? (
            <button type="button" className="app-top-bar-coach-exit" onClick={onExitCoachMode}>
              {t('coach.exitCoachView')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="app-top-bar-controls">
        <nav className={`app-top-nav ${coachModeActive ? 'coach-active' : ''}`} aria-label="Primary">
          <div className="app-top-nav-track">
            {tabs.map((tab) => {
              const tabDisabled = disabledTab === tab.key
              return (
                <button
                  key={tab.key}
                  className={`app-top-nav-btn ${activeView === tab.key ? 'active' : ''} ${tab.featured ? 'featured' : ''}`}
                  data-tab={tab.key}
                  type="button"
                  onClick={() => onChange(tab.key)}
                  aria-label={tab.label}
                  aria-pressed={activeView === tab.key}
                  aria-disabled={tabDisabled}
                  disabled={tabDisabled}
                  title={tabDisabled ? (disabledNotice || tab.label) : tab.label}
                >
                  <span className="app-top-nav-icon">{tab.icon}</span>
                </button>
              )
            })}
          </div>
        </nav>
        {leadingControl ? <div className="app-top-bar-extra">{leadingControl}</div> : null}
      </div>
    </div>
  )
}

export default TabBar
