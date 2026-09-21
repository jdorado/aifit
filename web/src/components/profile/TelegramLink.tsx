import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n'

type TelegramState = 'needs_bot' | 'ready' | 'connected' | 'link'

type TelegramConnection = {
  state: TelegramState
  connect_url?: string
  expires_at?: string
}

const knownTelegramErrors = new Set([
  'Telegram is not available for this agent yet.',
  'Telegram could not verify that bot. Check its token and try again.',
])

const errorMessage = (value: unknown, fallback: string) => {
  const detail = value && typeof value === 'object' && typeof (value as { detail?: unknown }).detail === 'string'
    ? (value as { detail: string }).detail
    : null
  return detail && knownTelegramErrors.has(detail) ? detail : fallback
}

const isTelegramConnection = (value: unknown): value is TelegramConnection => (
  Boolean(value)
  && typeof value === 'object'
  && ['needs_bot', 'ready', 'connected', 'link'].includes((value as { state?: unknown }).state as string)
)

export default function TelegramLink({ apiBase, getHeaders }: {
  apiBase: string
  getHeaders: () => Promise<Record<string, string>>
}) {
  const { t } = useI18n()
  const [connection, setConnection] = useState<TelegramConnection | null>(null)
  const [botToken, setBotToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [waitingUntil, setWaitingUntil] = useState<number | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadConnection = useCallback(async () => {
    const response = await fetch(`${apiBase}/account/telegram`, { headers: await getHeaders() })
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(errorMessage(body, t('profile.telegramUnavailable')))
    if (!isTelegramConnection(body) || body.state === 'link') throw new Error(t('profile.telegramUnavailable'))
    setConnection((current) => {
      if (body.state === 'connected') return { state: 'connected' }
      if (body.state === 'ready' && current?.state === 'link') return current
      return { state: body.state }
    })
    if (body.state === 'connected') setWaitingUntil(null)
    return body
  }, [apiBase, getHeaders, t])

  useEffect(() => {
    let current = true
    setLoading(true)
    void loadConnection()
      .catch((error) => {
        if (current) setMessage(error instanceof Error ? error.message : t('profile.telegramUnavailable'))
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => { current = false }
  }, [loadConnection, t])

  useEffect(() => {
    if (!waitingUntil) return
    const interval = window.setInterval(() => {
      if (Date.now() >= waitingUntil) {
        setWaitingUntil(null)
        setConnection((current) => current?.state === 'connected' ? current : { state: 'ready' })
        setMessage(t('profile.telegramExpired'))
        return
      }
      void loadConnection().catch(() => {
        // The next short poll retries a transient read failure without disrupting the handoff.
      })
    }, 4_000)
    return () => window.clearInterval(interval)
  }, [loadConnection, t, waitingUntil])

  useEffect(() => {
    if (connection?.state !== 'link') return undefined
    const check = () => {
      if (document.visibilityState === 'visible') {
        void loadConnection().catch(() => {
          // A transient read failure must not interrupt the handoff.
        })
      }
    }
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [connection?.state, loadConnection])

  const acceptLink = (body: unknown) => {
    if (!isTelegramConnection(body)) throw new Error(t('profile.telegramUnavailable'))
    if (body.state === 'connected') {
      setConnection({ state: 'connected' })
      setWaitingUntil(null)
      return
    }
    if (body.state !== 'link' || typeof body.connect_url !== 'string' || typeof body.expires_at !== 'string') {
      throw new Error(t('profile.telegramUnavailable'))
    }
    const expiresAt = Date.parse(body.expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error(t('profile.telegramExpired'))
    setConnection({ state: 'link', connect_url: body.connect_url, expires_at: body.expires_at })
    setWaitingUntil(expiresAt)
    setMessage(t('profile.telegramOpenHint'))
    window.open(body.connect_url, '_blank', 'noopener,noreferrer')
  }

  const connect = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${apiBase}/account/telegram/link`, {
        method: 'POST',
        headers: await getHeaders(),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(errorMessage(body, t('profile.telegramUnavailable')))
      acceptLink(body)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('profile.telegramUnavailable'))
    } finally {
      setBusy(false)
    }
  }

  const addBot = async () => {
    const value = botToken.trim()
    if (!value) {
      setMessage(t('profile.telegramBotRequired'))
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${apiBase}/account/telegram/bot`, {
        method: 'POST',
        headers: { ...(await getHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify({ bot_token: value }),
      })
      const body = await response.json().catch(() => null)
      setBotToken('')
      if (!response.ok) {
        throw new Error(errorMessage(body, t('profile.telegramBotInvalid')))
      }
      acceptLink(body)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('profile.telegramBotInvalid'))
    } finally {
      setBusy(false)
    }
  }

  const retry = () => {
    setMessage(null)
    setLoading(true)
    void loadConnection()
      .catch((error) => setMessage(error instanceof Error ? error.message : t('profile.telegramUnavailable')))
      .finally(() => setLoading(false))
  }

  const connected = connection?.state === 'connected'
  const needsBot = connection?.state === 'needs_bot'
  const liveLink = connection?.state === 'link' && connection.connect_url && connection.expires_at
    && Date.parse(connection.expires_at) > Date.now()
    ? connection.connect_url
    : null

  return (
    <section className="profile-telegram" aria-label={t('profile.telegramLabel')}>
      <div className="profile-telegram-copy">
        <p className="profile-telegram-title">{t('profile.telegramLabel')}</p>
        <p className="profile-telegram-note">
          {connected
            ? t('profile.telegramConnected')
            : needsBot
              ? t('profile.telegramBotDescription')
              : t('profile.telegramDescription')}
        </p>
        {message ? <p className="profile-telegram-message" role="status">{message}</p> : null}
      </div>
      <div className="profile-telegram-actions">
        {loading ? <span className="profile-telegram-status">{t('common.loading')}</span> : null}
        {connected ? <span className="profile-telegram-status profile-telegram-status--connected">{t('profile.telegramConnectedStatus')}</span> : null}
        {!loading && connection?.state === 'ready' ? (
          <button className="profile-telegram-connect" type="button" disabled={busy} onClick={() => void connect()}>
            {busy ? t('profile.telegramConnecting') : t('profile.telegramConnect')}
          </button>
        ) : null}
        {!loading && !connected && connection?.state === 'link' && connection.connect_url ? (
          <a
            className="profile-telegram-open"
            href={connection.connect_url}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!liveLink) {
                event.preventDefault()
                void connect()
                return
              }
              void loadConnection().catch(() => {
                // The poll retries; a read failure here must not block the handoff.
              })
            }}
          >
            {t('profile.telegramOpen')}
          </a>
        ) : null}
      </div>
      {!loading && needsBot ? (
        <div className="profile-telegram-bot">
          <a className="profile-telegram-botfather" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
            {t('profile.telegramGetBot')}
          </a>
          <label className="profile-telegram-token-label" htmlFor="telegram-bot-token">
            {t('profile.telegramBotToken')}
          </label>
          <div className="profile-telegram-token-row">
            <input
              id="telegram-bot-token"
              className="profile-telegram-token"
              type="password"
              autoComplete="off"
              spellCheck="false"
              value={botToken}
              placeholder={t('profile.telegramBotTokenPlaceholder')}
              disabled={busy}
              onChange={(event) => setBotToken(event.target.value)}
            />
            <button className="profile-telegram-connect" type="button" disabled={busy} onClick={() => void addBot()}>
              {busy ? t('profile.telegramAddingBot') : t('profile.telegramAddBot')}
            </button>
          </div>
          <p className="profile-telegram-token-note">{t('profile.telegramBotTokenNote')}</p>
        </div>
      ) : null}
      {!loading && !connected && message && !connection?.connect_url && !needsBot ? (
        <button className="profile-telegram-retry" type="button" onClick={retry}>{t('common.retry')}</button>
      ) : null}
    </section>
  )
}
