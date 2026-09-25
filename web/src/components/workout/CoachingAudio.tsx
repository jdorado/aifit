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
  const [open, setOpen] = useState(false)
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
    if (url) { setOpen((current) => !current); return }
    setLoading(true)
    setOpen(true)
    setError('')
    try {
      const blob = await onListen()
      if (!mounted.current) return
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
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
      <button type="button" className={`detail-audio-btn${open ? ' active' : ''}`} disabled={disabled || loading}
        onClick={() => void listen()} aria-label={loading ? t('workout.preparingCoachingAudio') : t('workout.listenToCoaching')}
        title={loading ? t('workout.preparingCoachingAudio') : t('workout.listenToCoaching')} aria-expanded={open}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4V5Zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? <div className="coaching-audio-panel">
        {loading ? <span role="status">{t('workout.preparingCoachingAudio')}</span> : null}
        {url ? <audio ref={audio} src={url} controls aria-label={t('workout.listenToCoaching')} /> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div> : null}
    </div>
  )
}
