import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'

export default function CoachingAudio({ disabled, onListen }: {
  disabled: boolean
  onListen: () => Promise<Blob>
}) {
  const { t } = useI18n()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const audio = useRef<HTMLAudioElement>(null)
  const mounted = useRef(false)
  const objectUrl = useRef('')

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      audio.current?.pause()
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [])

  useEffect(() => {
    // Some mobile browsers require another tap after an asynchronous request.
    // Native controls stay available if autoplay is blocked.
    if (url) void audio.current?.play().catch(() => {})
  }, [url])

  const listen = async () => {
    if (loading || disabled) return
    setLoading(true)
    setError('')
    try {
      const blob = await onListen()
      if (!mounted.current) return
      objectUrl.current = URL.createObjectURL(blob)
      setUrl(objectUrl.current)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('workout.coachingAudioFailed'))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  return (
    <div className="coaching-audio">
      {url ? (
        <audio ref={audio} src={url} controls aria-label={t('workout.listenToCoaching')} />
      ) : (
        <button type="button" className="secondary" disabled={disabled || loading} onClick={() => void listen()}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {loading ? t('workout.preparingCoachingAudio') : t('workout.listenToCoaching')}
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
