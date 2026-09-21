import type { FC, MouseEvent } from 'react'
import { useEffect } from 'react'
import { useI18n } from '../../i18n'
import type { DemoVideo } from '../../utils/demoVideos'

type VideoModalProps = {
  video: DemoVideo | null
  onClose: () => void
}

const VideoModal: FC<VideoModalProps> = ({ video, onClose }) => {
  const { t } = useI18n()

  useEffect(() => {
    if (!video) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [video, onClose])

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  return (
    <div className={`video-modal ${video ? 'active' : ''}`} onClick={handleOverlayClick}>
      <div className="video-modal-content">
        <div className="video-modal-actions">
          {video ? (
            <a
              className="video-open-external"
              href={video.url || `https://www.youtube.com/watch?v=${video.video_id}`}
              target="_blank"
              rel="noopener noreferrer"
              title={t('common.openExternally')}
              aria-label={t('common.openExternally')}
              onClick={(event) => event.stopPropagation()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </a>
          ) : <span />}
          <button className="video-close-btn" type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        <iframe
          title={video?.title || t('workout.videoModalTitle')}
          allow="autoplay; encrypted-media"
          allowFullScreen
          src={video ? `https://www.youtube.com/embed/${video.video_id}?autoplay=1` : ''}
        ></iframe>
      </div>
    </div>
  )
}

export default VideoModal
