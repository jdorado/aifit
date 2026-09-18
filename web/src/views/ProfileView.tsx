import { useMemo, useState, type FC, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { Language } from '../i18n/strings'
import type { AuthUiState, CoachLink, CoachPermissions } from '../types/app'
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
  weeklyPlan: string
  activeNotes: string
  language: Language
  fontScale: number
  onChange: (field: 'text' | 'weeklyPlan' | 'activeNotes' | 'language' | 'fontScale', value: string) => void
  onAuthClick: () => void
  authState: AuthUiState
  coachLinks: CoachLink[]
  coachLinksLoading: boolean
  coachLinksError: string | null
  coachActionMessage: string | null
  coachLatestInviteToken: string | null
  coachActAsOwnerId: string | null
  viewerOwnerIdCandidates: string[]
  onCoachActAs: (ownerId: string | null) => void
  onCoachInvite: (permissions: CoachPermissions) => Promise<void>
  onCoachAcceptInvite: (token: string) => Promise<void>
  onCoachUpdatePermissions: (linkId: string, permissions: CoachPermissions) => Promise<void>
  onCoachRevoke: (linkId: string) => Promise<void>
}

const ProfileView: FC<ProfileViewProps> = ({
  telegramControl,
  active,
  text,
  weeklyPlan,
  activeNotes,
  language,
  fontScale,
  onChange,
  onAuthClick,
  authState,
  coachLinks,
  coachLinksLoading,
  coachLinksError,
  coachActionMessage,
  coachLatestInviteToken,
  coachActAsOwnerId,
  viewerOwnerIdCandidates,
  onCoachActAs,
  onCoachInvite,
  onCoachAcceptInvite,
  onCoachUpdatePermissions,
  onCoachRevoke,
}) => {
  const { t } = useI18n()
  const [inviteToken, setInviteToken] = useState('')
  const [invitePerms, setInvitePerms] = useState<CoachPermissions>({
    view_progress: true,
    edit_programs: true,
    chat_as_coach: false,
    view_health: false,
    view_diet: false,
    edit_diet: false,
  })
  const fontScaleLabel = fontScale >= 1.2
    ? t('profile.fontSizeXXL')
    : fontScale >= 1.15
      ? t('profile.fontSizeXL')
      : fontScale >= 1.1
        ? t('profile.fontSizeLarge')
        : fontScale >= 1.05
          ? t('profile.fontSizeMedium')
          : t('profile.fontSizeDefault')

  const coachEmail = (authState.statusEmail || '').toLowerCase()
  const ownerIdSet = useMemo(() => (
    new Set(viewerOwnerIdCandidates.filter((value) => value))
  ), [viewerOwnerIdCandidates])
  const coachLinksAsCoach = useMemo(
    () => coachLinks.filter((link) => (
      (link.coach_owner_id && ownerIdSet.has(link.coach_owner_id))
      || (link.coach_email?.toLowerCase() === coachEmail)
    )),
    [coachEmail, coachLinks, ownerIdSet],
  )
  const coachLinksAsTrainee = useMemo(
    () => coachLinks.filter((link) => ownerIdSet.has(link.trainee_owner_id)),
    [coachLinks, ownerIdSet],
  )
  const visibleCoachLinksAsTrainee = useMemo(
    () => coachLinksAsTrainee.filter((link) => link.status !== 'revoked'),
    [coachLinksAsTrainee],
  )
  const activeCoachLinks = coachLinksAsCoach.filter((link) => (
    link.status === 'active' && link.permissions.view_progress
  ))
  const actAsActive = Boolean(coachActAsOwnerId)
  const activeCoachLabel = useMemo(() => {
    if (!coachActAsOwnerId) return ''
    const match = coachLinksAsCoach.find((link) => (
      link.trainee_owner_id === coachActAsOwnerId
      || (link.trainee_email && link.trainee_email === coachActAsOwnerId)
    ))
    return match?.trainee_email
      || (coachActAsOwnerId.includes('@') ? coachActAsOwnerId : '')
      || t('coach.traineeLabel')
  }, [coachActAsOwnerId, coachLinksAsCoach, t])
  const formatStatus = useMemo(() => (status: string) => {
    switch (status) {
      case 'pending':
        return t('coach.statusPending')
      case 'active':
        return t('coach.statusActive')
      case 'revoked':
        return t('coach.statusRevoked')
      default:
        return status
    }
  }, [t])
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

  const handleInviteSubmit = async () => {
    await onCoachInvite(invitePerms)
  }

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

  const handleAcceptInvite = async () => {
    const trimmed = inviteToken.trim()
    if (!trimmed) return
    await onCoachAcceptInvite(trimmed)
    setInviteToken('')
  }

  const copyToken = async (token: string) => {
    if (!token) return
    if (!navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(token)
    } catch {
      // Clipboard permission can be denied; the token remains visible.
    }
  }

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
        <ProfileMetric
          label={t('coach.sectionTitle')}
          value={activeCoachLinks.length}
          note={t('coach.statusActive')}
          tone="gray"
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
          <ProfileTextAreaField
            id="weekly-plan-text"
            label={t('profile.weeklyPlanLabel')}
            placeholder={t('profile.weeklyPlanPlaceholder')}
            value={weeklyPlan}
            onChange={(value) => onChange('weeklyPlan', value)}
            description={t('profile.weeklyPlanSaved')}
          />
          <ProfileTextAreaField
            id="active-notes-text"
            label={t('profile.activeNotesLabel')}
            placeholder={t('profile.activeNotesPlaceholder')}
            value={activeNotes}
            onChange={(value) => onChange('activeNotes', value)}
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

      <ProfilePanel
        id="profile-coach"
        className="coach-card"
        title={t('coach.sectionTitle')}
        subtitle={t('coach.sectionSubtitle')}
      >
        {!authState.statusEmail ? (
          <p className="coach-note">{t('coach.signInPrompt')}</p>
        ) : (
          <>
            {activeCoachLinks.length > 0 ? (
              <div className="coach-switch-inline">
                <div>
                  <p className="coach-title">{t('coach.traineeSelectLabel')}</p>
                  <p className="coach-meta">{t('coach.traineeSelectHint')}</p>
                </div>
                <div className="coach-switch-row">
                  <select
                    value={coachActAsOwnerId || ''}
                    onChange={(event) => onCoachActAs(event.target.value || null)}
                    disabled={coachLinksLoading}
                    aria-label={t('coach.traineeSelectLabel')}
                  >
                    <option value="">{t('coach.traineeSelectPlaceholder')}</option>
                    {activeCoachLinks.map((link) => {
                      const fallbackEmail = link.trainee_owner_id.includes('@') ? link.trainee_owner_id : ''
                      const label = link.trainee_email || fallbackEmail || t('coach.unknownEmail')
                      // Use trainee_owner_id as the act-as key (stable storage id). Email is display-only.
                      const actAsValue = link.trainee_owner_id
                      return (
                        <option key={link.id} value={actAsValue}>
                          {label}
                        </option>
                      )
                    })}
                  </select>
                </div>
                {actAsActive ? (
                  <p className="coach-active-note">{t('coach.viewingAs', { id: activeCoachLabel })}</p>
                ) : null}
              </div>
            ) : null}
            <div className="coach-grid">
              <div className="coach-panel">
                <p className="coach-title">{t('coach.inviteTitle')}</p>
                <div className="coach-perms">
                  <label>
                    <input
                      type="checkbox"
                      checked={invitePerms.view_progress}
                      onChange={(event) => setInvitePerms((prev) => ({
                        ...prev,
                        view_progress: event.target.checked,
                      }))}
                    />
                    {t('coach.permissionView')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={invitePerms.edit_programs}
                      onChange={(event) => setInvitePerms((prev) => ({
                        ...prev,
                        edit_programs: event.target.checked,
                      }))}
                    />
                    {t('coach.permissionEdit')}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={invitePerms.chat_as_coach}
                      onChange={(event) => setInvitePerms((prev) => ({
                        ...prev,
                        chat_as_coach: event.target.checked,
                      }))}
                    />
                    {t('coach.permissionChat')}
                  </label>
                  {([
                    ['view_health', t('coach.permissionHealth')],
                    ['view_diet', t('coach.permissionDiet')],
                    ['edit_diet', t('coach.permissionDietEdit')],
                  ] as const).map(([permission, label]) => (
                    <label key={permission}>
                      <input type="checkbox" checked={invitePerms[permission] === true}
                        onChange={(event) => setInvitePerms((prev) => ({ ...prev, [permission]: event.target.checked }))} />
                      {label}
                    </label>
                  ))}
                </div>
                <button
                  className="coach-action"
                  type="button"
                  onClick={handleInviteSubmit}
                  disabled={coachLinksLoading}
                >
                  {t('coach.generateToken')}
                </button>

                {coachLatestInviteToken ? (
                  <div className="coach-latest-token">
                    <p className="coach-meta">{t('coach.latestTokenLabel')}</p>
                    <p className="coach-token">{coachLatestInviteToken}</p>
                    <button
                      className="coach-action ghost"
                      type="button"
                      onClick={() => copyToken(coachLatestInviteToken)}
                    >
                      {t('coach.copyToken')}
                    </button>
                  </div>
                ) : null}

                {visibleCoachLinksAsTrainee.length > 0 ? (
                  <div className="coach-list">
                    {visibleCoachLinksAsTrainee.map((link) => (
                      <div key={link.id} className="coach-link">
                        <div>
                          <p className="coach-email">
                            {link.status === 'pending'
                              ? t('coach.pendingInvite')
                              : (link.coach_email || link.accepted_by_email || t('coach.coachLabel'))}
                          </p>
                          <p className="coach-meta">{t('coach.statusLabel', { status: formatStatus(link.status) })}</p>
                          {link.status === 'pending' && link.invite_token ? (
                            <p className="coach-token">{t('coach.tokenLabel', { token: link.invite_token })}</p>
                          ) : null}
                          {link.status === 'active' ? (
                            <div className="coach-perms">
                              {([
                                ['view_progress', t('coach.permissionView')],
                                ['edit_programs', t('coach.permissionEdit')],
                                ['chat_as_coach', t('coach.permissionChat')],
                                ['view_health', t('coach.permissionHealth')],
                                ['view_diet', t('coach.permissionDiet')],
                                ['edit_diet', t('coach.permissionDietEdit')],
                              ] as const).map(([permission, label]) => (
                                <label key={permission}>
                                  <input
                                    type="checkbox"
                                    checked={link.permissions[permission] === true}
                                    disabled={coachLinksLoading}
                                    onChange={(event) => {
                                      onCoachUpdatePermissions(link.id, {
                                        ...link.permissions,
                                        [permission]: event.target.checked,
                                      }).catch(() => undefined)
                                    }}
                                  />
                                  {label}
                                </label>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <div className="coach-actions">
                          {link.status === 'pending' && link.invite_token ? (
                            <button
                              className="coach-action ghost"
                              type="button"
                              onClick={() => copyToken(link.invite_token || '')}
                            >
                              {t('coach.copyToken')}
                            </button>
                          ) : null}
                          <button
                            className="coach-action ghost"
                            type="button"
                            onClick={() => onCoachRevoke(link.id)}
                            disabled={coachLinksLoading}
                          >
                            {t('coach.revoke')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="coach-empty">{t('coach.noCoaches')}</p>
                )}
              </div>

              <div className="coach-panel">
                <p className="coach-title">{t('coach.dashboardTitle')}</p>
                <div className="coach-field">
                  <label htmlFor="coach-invite-token">{t('coach.acceptTokenLabel')}</label>
                  <input
                    id="coach-invite-token"
                    type="text"
                    placeholder={t('coach.acceptTokenPlaceholder')}
                    value={inviteToken}
                    onChange={(event) => setInviteToken(event.target.value)}
                  />
                </div>
                <button
                  className="coach-action"
                  type="button"
                  onClick={handleAcceptInvite}
                  disabled={!inviteToken.trim() || coachLinksLoading}
                >
                  {t('coach.acceptInvite')}
                </button>

                {activeCoachLinks.length === 0 ? (
                  <p className="coach-empty">{t('coach.noActiveTrainees')}</p>
                ) : null}
              </div>
            </div>
            {coachLinksLoading ? <p className="coach-note">{t('coach.refreshing')}</p> : null}
            {coachLinksError ? <p className="coach-error">{coachLinksError}</p> : null}
            {coachActionMessage ? <p className="coach-note">{coachActionMessage}</p> : null}
          </>
        )}
      </ProfilePanel>
      <p className="profile-version">
        <span className="profile-version-label">{t('profile.versionLabel')}</span>
        <span className="profile-version-value">{versionText || t('profile.versionUnknown')}</span>
      </p>
    </section>
  )
}

export default ProfileView
