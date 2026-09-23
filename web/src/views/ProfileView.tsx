import { useCallback, useEffect, useMemo, useState, type FC, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { Language } from '../i18n/strings'
import type { AuthUiState } from '../types/app'
import {
  ProfileMetric,
  ProfilePanel,
  ProfileRangeField,
  ProfileSelectField,
} from '../components/profile/ProfileBlocks'

export type CoachPermissions = {
  view_progress: boolean
  edit_programs: boolean
}

export type CoachLink = {
  link_id: string
  trainee_account_id: string
  trainee_email: string | null
  coach_account_id: string | null
  coach_email: string | null
  permissions: CoachPermissions
  status: 'pending' | 'active' | 'revoked'
  invite_token: string
  invite_expires_at: string | null
  created_at: string
  updated_at: string
}

export type CoachActAsTarget = {
  linkId: string
  label: string
  permissions: CoachPermissions
}

type ProfileViewProps = {
  telegramControl?: ReactNode
  active: boolean
  language: Language
  fontScale: number
  onChange: (field: 'language' | 'fontScale', value: string) => void
  onAuthClick: () => void
  authState: AuthUiState
  apiBaseUrl?: string
  getHeaders?: () => Promise<Record<string, string>>
  actAsLinkId?: string | null
  onStartActAs?: (target: CoachActAsTarget) => void
  onStopActAs?: () => void
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const ProfileView: FC<ProfileViewProps> = ({
  telegramControl,
  active,
  language,
  fontScale,
  onChange,
  onAuthClick,
  authState,
  apiBaseUrl = '',
  getHeaders,
  actAsLinkId = null,
  onStartActAs,
  onStopActAs,
}) => {
  const { t } = useI18n()
  const [traineeLinks, setTraineeLinks] = useState<CoachLink[]>([])
  const [coachLinks, setCoachLinks] = useState<CoachLink[]>([])
  const [linksLoading, setLinksLoading] = useState(false)
  const [linksError, setLinksError] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [invitePermissions, setInvitePermissions] = useState<CoachPermissions>({ view_progress: true, edit_programs: false })
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [acceptBusy, setAcceptBusy] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null)
  const [copiedToken, setCopiedToken] = useState<string | null>(null)
  const signedIn = Boolean(authState.statusEmail)

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

  const loadLinks = useCallback(async () => {
    if (!apiBaseUrl || !getHeaders || !signedIn) return
    setLinksLoading(true)
    setLinksError(false)
    try {
      const headers = await getHeaders()
      const [traineeResponse, coachResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/v1/coach-links?role=trainee`, { headers }),
        fetch(`${apiBaseUrl}/v1/coach-links?role=coach`, { headers }),
      ])
      if (!traineeResponse.ok || !coachResponse.ok) {
        throw new Error(`Coach links failed (${traineeResponse.status}/${coachResponse.status})`)
      }
      setTraineeLinks(await traineeResponse.json() as CoachLink[])
      setCoachLinks(await coachResponse.json() as CoachLink[])
    } catch (error) {
      console.warn('Coach links failed:', error)
      setLinksError(true)
    } finally {
      setLinksLoading(false)
    }
  }, [apiBaseUrl, getHeaders, signedIn])

  useEffect(() => {
    void loadLinks()
  }, [loadLinks])

  const applyLink = useCallback((link: CoachLink) => {
    setTraineeLinks((prev) => {
      if (link.trainee_account_id && prev.some((row) => row.link_id === link.link_id)) {
        return prev.map((row) => (row.link_id === link.link_id ? link : row))
      }
      return prev
    })
    setCoachLinks((prev) => {
      if (prev.some((row) => row.link_id === link.link_id)) {
        return prev.map((row) => (row.link_id === link.link_id ? link : row))
      }
      return prev
    })
  }, [])

  const patchLink = useCallback(async (linkId: string, body: Record<string, unknown>) => {
    if (!apiBaseUrl || !getHeaders) throw new Error('Coach links are unavailable')
    const headers = { 'Content-Type': 'application/json', ...await getHeaders() }
    const response = await fetch(`${apiBaseUrl}/v1/coach-links/${encodeURIComponent(linkId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ...body, request_id: crypto.randomUUID() }),
    })
    if (!response.ok) throw new Error(`Coach link update failed (${response.status})`)
    return await response.json() as CoachLink
  }, [apiBaseUrl, getHeaders])

  const handleInvite = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!apiBaseUrl || !getHeaders) return
    const email = inviteEmail.trim()
    if (!email) {
      setInviteError(t('coach.emailRequired'))
      return
    }
    if (!EMAIL_PATTERN.test(email)) {
      setInviteError(t('coach.emailInvalid'))
      return
    }
    setInviteBusy(true)
    setInviteError(null)
    try {
      const headers = { 'Content-Type': 'application/json', ...await getHeaders() }
      const response = await fetch(`${apiBaseUrl}/v1/coach-links`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          coach_email: email,
          permissions: invitePermissions,
          request_id: crypto.randomUUID(),
        }),
      })
      if (!response.ok) throw new Error(`Coach invite failed (${response.status})`)
      const link = await response.json() as CoachLink
      setTraineeLinks((prev) => [link, ...prev.filter((row) => row.link_id !== link.link_id)])
      setInviteEmail('')
    } catch (error) {
      console.warn('Coach invite failed:', error)
      setInviteError(t('coach.inviteFailed'))
    } finally {
      setInviteBusy(false)
    }
  }, [apiBaseUrl, getHeaders, inviteEmail, invitePermissions, t])

  const acceptToken = useCallback(async (token: string) => {
    if (!apiBaseUrl || !getHeaders) return false
    setAcceptBusy(true)
    setAcceptError(null)
    try {
      const headers = { 'Content-Type': 'application/json', ...await getHeaders() }
      const response = await fetch(`${apiBaseUrl}/v1/coach-links/accept`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ invite_token: token, request_id: crypto.randomUUID() }),
      })
      if (!response.ok) throw new Error(`Coach accept failed (${response.status})`)
      const link = await response.json() as CoachLink
      setCoachLinks((prev) => [link, ...prev.filter((row) => row.link_id !== link.link_id)])
      setTokenInput('')
      return true
    } catch (error) {
      console.warn('Coach accept failed:', error)
      setAcceptError(t('coach.acceptFailed'))
      return false
    } finally {
      setAcceptBusy(false)
    }
  }, [apiBaseUrl, getHeaders, t])

  const handleAccept = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const token = tokenInput.trim()
    if (!token) {
      setAcceptError(t('coach.tokenRequired'))
      return
    }
    await acceptToken(token)
  }, [acceptToken, t, tokenInput])

  const handleRevoke = useCallback(async (link: CoachLink) => {
    setBusyLinkId(link.link_id)
    try {
      const updated = await patchLink(link.link_id, { status: 'revoked' })
      applyLink(updated)
      if (actAsLinkId === link.link_id) onStopActAs?.()
    } catch (error) {
      console.warn('Coach revoke failed:', error)
      window.alert(t('coach.revokeFailed'))
    } finally {
      setBusyLinkId(null)
    }
  }, [actAsLinkId, applyLink, onStopActAs, patchLink, t])

  const handlePermissionToggle = useCallback(async (
    link: CoachLink,
    permission: keyof CoachPermissions,
    value: boolean,
  ) => {
    const permissions: CoachPermissions = { ...link.permissions, [permission]: value }
    if (permission === 'view_progress' && !value) permissions.edit_programs = false
    if (permission === 'edit_programs' && value) permissions.view_progress = true
    setBusyLinkId(link.link_id)
    try {
      applyLink(await patchLink(link.link_id, { permissions }))
    } catch (error) {
      console.warn('Coach permission update failed:', error)
      window.alert(t('coach.permissionFailed'))
    } finally {
      setBusyLinkId(null)
    }
  }, [applyLink, patchLink, t])

  const handleCopyToken = useCallback(async (link: CoachLink) => {
    try {
      await navigator.clipboard.writeText(link.invite_token)
      setCopiedToken(link.link_id)
      window.setTimeout(() => {
        setCopiedToken((current) => (current === link.link_id ? null : current))
      }, 2000)
    } catch (error) {
      console.warn('Copy invite token failed:', error)
    }
  }, [])

  const formatExpiry = useCallback((value: string | null) => {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleDateString()
  }, [])

  const permissionSummary = useCallback((permissions: CoachPermissions) => (
    [
      permissions.view_progress ? t('coach.permissionViewProgress') : null,
      permissions.edit_programs ? t('coach.permissionEditPrograms') : null,
    ].filter(Boolean).join(' · ')
  ), [t])

  const statusLabel = useCallback((status: CoachLink['status']) => {
    if (status === 'active') return t('coach.statusActive')
    if (status === 'revoked') return t('coach.statusRevoked')
    return t('coach.statusPending')
  }, [t])

  const renderPermissions = (link: CoachLink, editable: boolean) => (
    <div className="coach-link-permissions">
      <span className="coach-link-permissions-label">{t('coach.permissionsLabel')}</span>
      {editable ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={link.permissions.view_progress}
              disabled={busyLinkId === link.link_id}
              onChange={(event) => { void handlePermissionToggle(link, 'view_progress', event.target.checked) }}
            />
            {t('coach.permissionViewProgress')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={link.permissions.edit_programs}
              disabled={busyLinkId === link.link_id}
              onChange={(event) => { void handlePermissionToggle(link, 'edit_programs', event.target.checked) }}
            />
            {t('coach.permissionEditPrograms')}
          </label>
        </>
      ) : (
        <span>{permissionSummary(link.permissions)}</span>
      )}
    </div>
  )

  const renderLinkCard = (link: CoachLink, side: 'coach' | 'trainee') => {
    const busy = busyLinkId === link.link_id
    const isPending = link.status === 'pending'
    const isActive = link.status === 'active'
    const label = side === 'coach'
      ? (link.trainee_email || t('coach.traineeFallback'))
      : (link.coach_email || t('coach.traineeFallback'))
    return (
      <article className="coach-link-card" key={link.link_id}>
        <div className="coach-link-head">
          <strong title={label}>{label}</strong>
          <span className={`coach-link-status coach-link-status--${link.status}`}>{statusLabel(link.status)}</span>
        </div>
        {side === 'coach' && isPending ? (
          <div className="coach-link-token">
            <span className="coach-link-token-label">{t('coach.inviteTokenLabel')}</span>
            <code>{link.invite_token}</code>
            <button type="button" onClick={() => { void handleCopyToken(link) }} disabled={busy}>
              {copiedToken === link.link_id ? t('coach.copied') : t('coach.copyToken')}
            </button>
          </div>
        ) : null}
        {side === 'trainee' && isPending ? (
          <div className="coach-link-token">
            <span className="coach-link-token-label">{t('coach.inviteTokenLabel')}</span>
            <code>{link.invite_token}</code>
            <button type="button" onClick={() => { void handleCopyToken(link) }} disabled={busy}>
              {copiedToken === link.link_id ? t('coach.copied') : t('coach.copyToken')}
            </button>
            {link.invite_expires_at ? (
              <span className="coach-link-expiry">{t('coach.inviteExpires', { date: formatExpiry(link.invite_expires_at) })}</span>
            ) : null}
          </div>
        ) : null}
        {renderPermissions(link, side === 'trainee' && link.status !== 'revoked')}
        <div className="coach-link-actions">
          {link.status === 'revoked' ? null : (
            <>
              {side === 'coach' && isPending ? (
                <button type="button" onClick={() => { void acceptToken(link.invite_token) }} disabled={busy || acceptBusy}>
                  {acceptBusy ? t('coach.accepting') : t('coach.acceptAction')}
                </button>
              ) : null}
              {side === 'coach' && isActive ? (
                actAsLinkId === link.link_id ? (
                  <button type="button" onClick={onStopActAs} disabled={!onStopActAs}>
                    {t('coach.exitCoachView')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!onStartActAs}
                    onClick={() => onStartActAs?.({
                      linkId: link.link_id,
                      label: link.trainee_email || link.trainee_account_id,
                      permissions: link.permissions,
                    })}
                  >
                    {t('coach.openTraineeView')}
                  </button>
                )
              ) : null}
              <button type="button" className="coach-link-revoke" onClick={() => { void handleRevoke(link) }} disabled={busy}>
                {busy ? t('coach.revoking') : t('coach.revokeAction')}
              </button>
            </>
          )}
        </div>
      </article>
    )
  }

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
        id="profile-coach-sharing"
        className="profile-card"
        title={t('coach.sharingTitle')}
        subtitle={t('coach.sharingSubtitle')}
      >
        {!signedIn ? (
          <p className="coach-links-empty">{t('profile.signInPrompt')}</p>
        ) : (
          <div className="coach-sharing">
            {actAsLinkId ? (
              <div className="coach-sharing-active" role="status">
                <span>{t('coach.viewingNow')}</span>
                <button type="button" onClick={onStopActAs} disabled={!onStopActAs}>
                  {t('coach.exitCoachView')}
                </button>
              </div>
            ) : null}

            <form className="coach-invite-form" onSubmit={handleInvite}>
              <div className="coach-field">
                <label htmlFor="coach-invite-email">{t('coach.coachEmailLabel')}</label>
                <input
                  id="coach-invite-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder={t('coach.coachEmailPlaceholder')}
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              </div>
              <fieldset className="coach-permissions-field">
                <legend>{t('coach.permissionsLabel')}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={invitePermissions.view_progress}
                    onChange={(event) => setInvitePermissions((prev) => ({
                      ...prev,
                      view_progress: event.target.checked,
                      ...(event.target.checked ? {} : { edit_programs: false }),
                    }))}
                  />
                  {t('coach.permissionViewProgress')}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={invitePermissions.edit_programs}
                    onChange={(event) => setInvitePermissions((prev) => ({
                      ...prev,
                      edit_programs: event.target.checked,
                      ...(event.target.checked ? { view_progress: true } : {}),
                    }))}
                  />
                  {t('coach.permissionEditPrograms')}
                </label>
              </fieldset>
              <button type="submit" disabled={inviteBusy}>
                {inviteBusy ? t('coach.inviting') : t('coach.inviteAction')}
              </button>
              {inviteError ? <p className="coach-links-error" role="alert">{inviteError}</p> : null}
            </form>

            <form className="coach-accept-form" onSubmit={handleAccept}>
              <label htmlFor="coach-accept-token">{t('coach.acceptTitle')}</label>
              <p className="coach-links-hint">{t('coach.acceptHint')}</p>
              <div className="coach-accept-row">
                <input
                  id="coach-accept-token"
                  value={tokenInput}
                  placeholder={t('coach.inviteTokenLabel')}
                  onChange={(event) => setTokenInput(event.target.value)}
                />
                <button type="submit" disabled={acceptBusy}>
                  {acceptBusy ? t('coach.accepting') : t('coach.acceptAction')}
                </button>
              </div>
              {acceptError ? <p className="coach-links-error" role="alert">{acceptError}</p> : null}
            </form>

            {linksError ? <p className="coach-links-error" role="alert">{t('coach.linksError')}</p> : null}
            {linksLoading ? <p className="coach-links-hint">{t('coach.linksLoading')}</p> : null}

            <div className="coach-link-group">
              <h3>{t('coach.coachesTitle')}</h3>
              {coachLinks.length === 0
                ? <p className="coach-links-empty">{t('coach.linksEmpty')}</p>
                : coachLinks.map((link) => renderLinkCard(link, 'coach'))}
            </div>

            <div className="coach-link-group">
              <h3>{t('coach.traineesTitle')}</h3>
              {traineeLinks.length === 0
                ? <p className="coach-links-empty">{t('coach.linksEmpty')}</p>
                : traineeLinks.map((link) => renderLinkCard(link, 'trainee'))}
            </div>
          </div>
        )}
      </ProfilePanel>

      <ProfilePanel
        id="profile-preferences"
        className="profile-card"
        title={t('profile.preferencesLabel')}
        subtitle={t('profile.preferencesNote')}
      >
        <div className="profile-form-grid">
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
