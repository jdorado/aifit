import { useCallback, useEffect, useMemo, useState, type FC, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import type { Language } from '../i18n/strings'
import type { AuthUiState } from '../types/app'
import {
  ProfilePanel,
  ProfileRangeField,
  ProfileSegmentField,
  ProfileSwitch,
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

/** "maya.lopez@x.com" -> "Maya". Only a display nicety; falls back to the page title. */
const displayNameFromEmail = (email: string | null | undefined) => {
  const local = (email || '').split('@')[0]?.split(/[._+\-\d]+/).find(Boolean)
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : ''
}

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

  const statusLabel = useCallback((status: CoachLink['status']) => {
    if (status === 'active') return t('coach.statusActive')
    if (status === 'revoked') return t('coach.statusRevoked')
    return t('coach.statusPending')
  }, [t])

  const renderPermissions = (link: CoachLink, editable: boolean) => (
    <div className="pf-link-permissions">
      <span className="pf-mini-label">{t('coach.permissionsLabel')}</span>
      {editable ? (
        <div className="pf-switches">
          <ProfileSwitch
            label={t('coach.permissionViewProgress')}
            checked={link.permissions.view_progress}
            disabled={busyLinkId === link.link_id}
            onChange={(checked) => { void handlePermissionToggle(link, 'view_progress', checked) }}
          />
          <ProfileSwitch
            label={t('coach.permissionEditPrograms')}
            checked={link.permissions.edit_programs}
            disabled={busyLinkId === link.link_id}
            onChange={(checked) => { void handlePermissionToggle(link, 'edit_programs', checked) }}
          />
        </div>
      ) : (
        <ul className="pf-chips">
          {link.permissions.view_progress ? <li>{t('coach.permissionViewProgress')}</li> : null}
          {link.permissions.edit_programs ? <li>{t('coach.permissionEditPrograms')}</li> : null}
        </ul>
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
      <article className={`pf-link pf-link--${link.status}`} key={link.link_id}>
        <div className="pf-link-head">
          <strong title={label}>{label}</strong>
          <span className={`pf-status pf-status--${link.status}`}>{statusLabel(link.status)}</span>
        </div>
        {isPending ? (
          <div className="pf-token">
            <span className="pf-mini-label">{t('coach.inviteTokenLabel')}</span>
            <div className="pf-token-row">
              <code>{link.invite_token}</code>
              <button
                type="button"
                className={`pf-btn pf-btn--ghost${copiedToken === link.link_id ? ' is-done' : ''}`}
                onClick={() => { void handleCopyToken(link) }}
                disabled={busy}
              >
                {copiedToken === link.link_id ? t('coach.copied') : t('coach.copyToken')}
              </button>
            </div>
            {side === 'trainee' && link.invite_expires_at ? (
              <span className="pf-token-expiry">{t('coach.inviteExpires', { date: formatExpiry(link.invite_expires_at) })}</span>
            ) : null}
          </div>
        ) : null}
        {renderPermissions(link, side === 'trainee' && link.status !== 'revoked')}
        {link.status === 'revoked' ? null : (
          <div className="pf-link-actions">
            {side === 'coach' && isPending ? (
              <button type="button" className="pf-btn" onClick={() => { void acceptToken(link.invite_token) }} disabled={busy || acceptBusy}>
                {acceptBusy ? t('coach.accepting') : t('coach.acceptAction')}
              </button>
            ) : null}
            {side === 'coach' && isActive ? (
              actAsLinkId === link.link_id ? (
                <button type="button" className="pf-btn" onClick={onStopActAs} disabled={!onStopActAs}>
                  {t('coach.exitCoachView')}
                </button>
              ) : (
                <button
                  type="button"
                  className="pf-btn"
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
            <button type="button" className="pf-btn pf-btn--danger" onClick={() => { void handleRevoke(link) }} disabled={busy}>
              {busy ? t('coach.revoking') : t('coach.revokeAction')}
            </button>
          </div>
        )}
      </article>
    )
  }

  const displayName = displayNameFromEmail(authState.statusEmail) || t('profile.title')
  const authIcon = (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
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
  )

  return (
    <section className={`view ${active ? 'active' : ''}`} data-view="profile">
      <header className="pf-hero">
        <span className="pf-avatar" aria-hidden="true">{displayName.charAt(0)}</span>
        <div className="pf-hero-copy">
          <p className="pf-eyebrow">{t('profile.eyebrow')}</p>
          <h1 className="pf-name">{displayName}</h1>
          <p className="pf-account-line">
            <i className={signedIn ? 'is-on' : ''} aria-hidden="true" />
            <span>{signedIn ? t('profile.signedIn') : t('profile.signInPrompt')}</span>
          </p>
        </div>
      </header>

      <ProfilePanel id="profile-account" className="pf-group--account" title={t('profile.accountLabel')}>
        <div className="pf-rows">
          {signedIn ? (
            <div className="pf-row pf-row--line">
              <span className="pf-row-label">{t('profile.emailLabel')}</span>
              <span className="auth-email pf-row-value">{authState.statusEmail}</span>
            </div>
          ) : null}
          {authState.errorMessage ? (
            <div className="pf-row">
              <p className="auth-error pf-error" role="alert" title={authState.errorTitle}>{authState.errorMessage}</p>
            </div>
          ) : null}
          {telegramControl}
          {authState.enabled ? (
            <div className="pf-row pf-row--auth">
              <button
                className={`pf-auth-btn${signedIn ? '' : ' pf-auth-btn--primary'}`}
                type="button"
                onClick={onAuthClick}
                disabled={authState.loading}
                aria-label={authState.buttonLabel}
                title={authState.buttonTitle || authState.buttonLabel}
              >
                {authIcon}
                <span>{authState.buttonLabel}</span>
              </button>
            </div>
          ) : null}
        </div>
      </ProfilePanel>

      <ProfilePanel
        id="profile-coach-sharing"
        title={t('coach.sharingTitle')}
        subtitle={t('coach.sharingSubtitle')}
      >
        {!signedIn ? (
          <p className="pf-empty">{t('profile.signInPrompt')}</p>
        ) : (
          <div className="pf-sharing">
            {actAsLinkId ? (
              <div className="pf-viewing" role="status">
                <span>{t('coach.viewingNow')}</span>
                <button type="button" className="pf-btn" onClick={onStopActAs} disabled={!onStopActAs}>
                  {t('coach.exitCoachView')}
                </button>
              </div>
            ) : null}

            <form className="pf-form" onSubmit={handleInvite}>
              <div className="pf-field">
                <label htmlFor="coach-invite-email">{t('coach.coachEmailLabel')}</label>
                <input
                  id="coach-invite-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder={t('coach.coachEmailPlaceholder')}
                  value={inviteEmail}
                  aria-invalid={inviteError ? true : undefined}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
              </div>
              <fieldset className="pf-fieldset">
                <legend className="pf-mini-label">{t('coach.permissionsLabel')}</legend>
                <div className="pf-switches">
                  <ProfileSwitch
                    label={t('coach.permissionViewProgress')}
                    checked={invitePermissions.view_progress}
                    onChange={(checked) => setInvitePermissions((prev) => ({
                      ...prev,
                      view_progress: checked,
                      ...(checked ? {} : { edit_programs: false }),
                    }))}
                  />
                  <ProfileSwitch
                    label={t('coach.permissionEditPrograms')}
                    checked={invitePermissions.edit_programs}
                    onChange={(checked) => setInvitePermissions((prev) => ({
                      ...prev,
                      edit_programs: checked,
                      ...(checked ? { view_progress: true } : {}),
                    }))}
                  />
                </div>
              </fieldset>
              <button type="submit" className="pf-btn pf-btn--primary" disabled={inviteBusy}>
                {inviteBusy ? t('coach.inviting') : t('coach.inviteAction')}
              </button>
              {inviteError ? <p className="pf-error" role="alert">{inviteError}</p> : null}
            </form>

            <form className="pf-form pf-form--accept" onSubmit={handleAccept}>
              <div className="pf-field">
                <label htmlFor="coach-accept-token">{t('coach.acceptTitle')}</label>
                <p className="pf-hint">{t('coach.acceptHint')}</p>
                <div className="pf-inline">
                  <input
                    id="coach-accept-token"
                    value={tokenInput}
                    placeholder={t('coach.inviteTokenLabel')}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setTokenInput(event.target.value)}
                  />
                  <button type="submit" className="pf-btn" disabled={acceptBusy}>
                    {acceptBusy ? t('coach.accepting') : t('coach.acceptAction')}
                  </button>
                </div>
              </div>
              {acceptError ? <p className="pf-error" role="alert">{acceptError}</p> : null}
            </form>

            {linksError ? <p className="pf-error" role="alert">{t('coach.linksError')}</p> : null}
            {linksLoading ? <p className="pf-hint" role="status">{t('coach.linksLoading')}</p> : null}

            <div className="pf-link-group">
              <h3 className="pf-section-rule"><span>{t('coach.traineesTitle')}</span></h3>
              {coachLinks.length === 0
                ? <p className="pf-empty">{t('coach.linksEmpty')}</p>
                : coachLinks.map((link) => renderLinkCard(link, 'coach'))}
            </div>

            <div className="pf-link-group">
              <h3 className="pf-section-rule"><span>{t('coach.coachesTitle')}</span></h3>
              {traineeLinks.length === 0
                ? <p className="pf-empty">{t('coach.linksEmpty')}</p>
                : traineeLinks.map((link) => renderLinkCard(link, 'trainee'))}
            </div>
          </div>
        )}
      </ProfilePanel>

      <ProfilePanel
        id="profile-preferences"
        title={t('profile.preferencesLabel')}
        subtitle={t('profile.preferencesNote')}
      >
        <div className="pf-rows">
          <ProfileSegmentField
            id="profile-language"
            label={t('profile.languageLabel')}
            value={language}
            options={languageOptions}
            onChange={(value) => onChange('language', value)}
          />
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
        </div>
      </ProfilePanel>

      <p className="profile-version pf-version">
        <span className="profile-version-label">{t('profile.versionLabel')}</span>
        <span className="profile-version-value">{versionText || t('profile.versionUnknown')}</span>
      </p>
    </section>
  )
}

export default ProfileView
