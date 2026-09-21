import { useMemo, type FC, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { Language } from '../i18n/strings'
import type { AuthUiState } from '../types/app'
import {
  ProfileMetric,
  ProfilePanel,
  ProfileRangeField,
  ProfileSelectField,
  ProfileTextAreaField,
} from '../components/profile/ProfileBlocks'

type ProfileViewProps = {
  telegramControl?: ReactNode
  active: boolean
  text: string
  language: Language
  fontScale: number
  onChange: (field: 'text' | 'language' | 'fontScale', value: string) => void
  onAuthClick: () => void
  authState: AuthUiState
}

const ProfileView: FC<ProfileViewProps> = ({
  telegramControl,
  active,
  text,
  language,
  fontScale,
  onChange,
  onAuthClick,
  authState,
}) => {
  const { t } = useI18n()
  const fontScaleLabel = fontScale >= 1.2
    ? t('profile.fontSizeXXL')
    : fontScale >= 1.15
      ? t('profile.fontSizeXL')
      : fontScale >= 1.1
        ? t('profile.fontSizeLarge')
        : fontScale >= 1.05
          ? t('profile.fontSizeMedium')
          : t('profile.fontSizeDefault')

  const versionText = useMemo(() => {
    const formatBuildTime = (value: string) => {
      if (!value) return ''
      const asNumber = Number(value)
      const date = Number.isFinite(asNumber)
        ? new Date(value.length <= 10 ? asNumber * 1000 : asNumber)
        : new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      return date.toISOString().slice(0, 16).replace('T', ' ')
    }

    const rawVersion = (process.env.APP_VERSION || '').trim()
    const rawSha = (process.env.VERCEL_GIT_COMMIT_SHA || '').trim()
    const rawRef = (process.env.VERCEL_GIT_COMMIT_REF || '').trim()
    const rawEnv = (process.env.VERCEL_ENV || '').trim()
    const rawTime = (process.env.VERCEL_GIT_COMMIT_TIMESTAMP || process.env.BUILD_TIME || '').trim()

    const parts: string[] = []
    if (rawVersion) parts.push(`v${rawVersion}`)
    if (rawSha) parts.push(rawSha.slice(0, 7))
    if (rawRef) parts.push(rawRef)
    const timeLabel = formatBuildTime(rawTime)
    if (timeLabel) parts.push(timeLabel)
    if (rawEnv) parts.push(rawEnv)

    return parts.join(' / ')
  }, [])

  const languageLabel = language === 'es'
    ? t('profile.languageOptionEs')
    : t('profile.languageOptionEn')
  const languageOptions = useMemo(() => ([
    { value: 'en', label: t('profile.languageOptionEn') },
    { value: 'es', label: t('profile.languageOptionEs') },
  ]), [t])

  const accountActions = (
    <div className="profile-account-actions">
      {authState.enabled ? (
        <button
          className="header-auth-btn profile-icon-btn"
          type="button"
          onClick={onAuthClick}
          disabled={authState.loading}
          aria-label={authState.buttonLabel}
          title={authState.buttonTitle || authState.buttonLabel}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {authState.statusEmail ? (
              <>
                <path d="M10 17l5-5-5-5" />
                <path d="M15 12H3" />
                <path d="M21 19V5a2 2 0 0 0-2-2h-5" />
                <path d="M14 21h5a2 2 0 0 0 2-2" />
              </>
            ) : (
              <>
                <path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
                <path d="M10 17l5-5-5-5" />
                <path d="M15 12H3" />
              </>
            )}
          </svg>
        </button>
      ) : null}
    </div>
  )

  return (
    <section className={`view ${active ? 'active' : ''}`} data-view="profile">
      <header className="profile-hero">
        <div>
          <p className="eyebrow">{t('profile.eyebrow')}</p>
          <h1 className="page-title">{t('profile.title')}</h1>
        </div>
      </header>

      <section className="metric-grid profile-summary-grid">
        <ProfileMetric
          label={t('profile.accountLabel')}
          value={authState.statusEmail ? t('profile.signedIn') : t('auth.signIn')}
          note={authState.statusEmail || t('profile.signInPrompt')}
          tone="green"
        />
        <ProfileMetric
          label={t('profile.languageLabel')}
          value={languageLabel}
          tone="peach"
        />
      </section>

      <ProfilePanel
        id="profile-account"
        className="profile-auth-card"
        eyebrow={t('profile.accountLabel')}
        title={authState.statusEmail ? t('profile.signedIn') : t('auth.signIn')}
        subtitle={authState.statusEmail ? authState.statusEmail : t('profile.signInPrompt')}
        actions={accountActions}
      >
        <div className={`auth-status ${authState.statusVisible ? '' : 'hidden'}`}>
          <span className="auth-email">{authState.statusEmail}</span>
        </div>
        <div
          className={`auth-error ${authState.errorMessage ? '' : 'hidden'}`}
          title={authState.errorTitle}
        >
          {authState.errorMessage}
        </div>
        {telegramControl}
      </ProfilePanel>

      <ProfilePanel
        id="profile-details"
        className="profile-card"
        title={t('profile.detailsLabel')}
        subtitle={t('profile.detailsPlaceholder')}
      >
        <div className="profile-form-grid">
          <ProfileTextAreaField
            id="profile-text"
            label={t('profile.detailsLabel')}
            placeholder={t('profile.detailsPlaceholder')}
            value={text}
            onChange={(value) => onChange('text', value)}
            description={t('profile.detailsSaved')}
          />
          <div className="profile-controls-grid">
            <ProfileRangeField
              id="profile-font-scale"
              label={t('profile.fontSizeLabel')}
              min="1"
              max="1.2"
              step="0.05"
              value={fontScale}
              valueLabel={fontScaleLabel}
              onChange={(value) => onChange('fontScale', value)}
            />
            <ProfileSelectField
              id="profile-language"
              label={t('profile.languageLabel')}
              value={language}
              options={languageOptions}
              onChange={(value) => onChange('language', value)}
            />
          </div>
        </div>
      </ProfilePanel>

      <p className="profile-version">
        <span className="profile-version-label">{t('profile.versionLabel')}</span>
        <span className="profile-version-value">{versionText || t('profile.versionUnknown')}</span>
      </p>
    </section>
  )
}

export default ProfileView
