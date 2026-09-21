import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n'

type TelegramState = 'needs_bot' | 'ready' | 'connected' | 'link'

type TelegramConnection = {
  state: TelegramState
  connect_url?: string
  expires_at?: string
}

const errorMessage = (value: unknown, fallback: string) => {
  const detail = value && typeof value === 'object' && typeof (value as { detail?: unknown }).detail === 'string'
    ? (value as { detail: string }).detail
    : null
  return detail && detail === 'Telegram is not available for this agent yet.' ? detail : fallback
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
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
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
    if (body.state === 'connected') {
      setExpiresAt(null)
    }
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
    if (!expiresAt) return undefined
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) {
      setExpiresAt(null)
      setConnection((current) => (current?.state === 'connected' ? current : { state: 'ready' }))
      setMessage(t('profile.telegramExpired'))
      return undefined
    }
    const timer = window.setTimeout(() => {
      setExpiresAt(null)
      setConnection((current) => (current?.state === 'connected' ? current : { state: 'ready' }))
      setMessage(t('profile.telegramExpired'))
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [expiresAt, t])

  const acceptLink = (body: unknown) => {
    if (!isTelegramConnection(body)) throw new Error(t('profile.telegramUnavailable'))
    if (body.state === 'connected') {
      setConnection({ state: 'connected' })
      setExpiresAt(null)
      return
    }
    if (body.state !== 'link' || typeof body.connect_url !== 'string' || typeof body.expires_at !== 'string') {
      throw new Error(t('profile.telegramUnavailable'))
    }
    const expiresAtMs = Date.parse(body.expires_at)
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new Error(t('profile.telegramExpired'))
    setConnection({ state: 'link', connect_url: body.connect_url, expires_at: body.expires_at })
    setExpiresAt(expiresAtMs)
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

  const retry = () => {
    setMessage(null)
    setLoading(true)
    void loadConnection()
      .catch((error) => setMessage(error instanceof Error ? error.message : t('profile.telegramUnavailable')))
      .finally(() => setLoading(false))
  }

  const connected = connection?.state === 'connected'
  const needsBot = connection?.state === 'needs_bot'

  return (
    <section className="profile-telegram" aria-label={t('profile.telegramLabel')}>
      <div className="profile-telegram-copy">
        <p className="profile-telegram-title">{t('profile.telegramLabel')}</p>
        <p className="profile-telegram-note">
          {connected
            ? t('profile.telegramConnected')
            : needsBot
              ? t('profile.telegramUnavailable')
              : t('profile.telegramDescription')}
        </p>
      </div>
      <div className="profile-telegram-actions">
        {loading ? <span className="profile-telegram-status">{t('common.loading')}</span> : null}
        {connected ? <span className="profile-telegram-status profile-telegram-status--connected">{t('profile.telegramConnectedStatus')}</span> : null}
        {!loading && connection?.state === 'ready' ? (
          <button className="profile-telegram-connect" type="button" disabled={busy} onClick={() => void connect()}>
            {busy ? t('profile.telegramConnecting') : t('profile.telegramConnect')}
          </button>
        ) : null}
      </div>
      {message ? <p className="profile-telegram-message" role="status">{message}</p> : null}
      {connection?.state === 'link' && connection.connect_url && !connected ? (
        <a className="profile-telegram-open" href={connection.connect_url} target="_blank" rel="noreferrer">
          {t('profile.telegramOpen')}
        </a>
      ) : null}
      {!loading && !connected && message && !connection?.connect_url && !needsBot ? (
        <button className="profile-telegram-retry" type="button" onClick={retry}>{t('common.retry')}</button>
      ) : null}
    </section>
  )
}
