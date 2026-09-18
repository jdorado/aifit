import type { FC, MouseEvent } from 'react'
import { useI18n } from '../i18n'

type VideoModalProps = {
  activeVideoId: string | null
  onClose: () => void
}

const VideoModal: FC<VideoModalProps> = ({ activeVideoId, onClose }) => {
  const { t } = useI18n()
  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  const youtubeUrl = activeVideoId ? `https://www.youtube.com/watch?v=${activeVideoId}` : null

  return (
    <div className={`video-modal ${activeVideoId ? 'active' : ''}`} onClick={handleOverlayClick}>
      <div className="video-modal-content">
        <div className="video-modal-actions">
          {youtubeUrl ? (
            <a
              className="video-open-external"
              href={youtubeUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={t('common.openExternally')}
              aria-label={t('common.openExternally')}
              onClick={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </a>
          ) : null}
          <button className="video-close-btn" type="button" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        <iframe
          title={t('workout.videoModalTitle')}
          allow="autoplay; encrypted-media"
          allowFullScreen
          src={activeVideoId ? `https://www.youtube.com/embed/${activeVideoId}?autoplay=1` : ''}
        ></iframe>
      </div>
    </div>
  )
}

export default VideoModal
