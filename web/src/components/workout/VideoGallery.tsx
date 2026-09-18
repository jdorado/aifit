import type { FC, MouseEvent as ReactMouseEvent } from 'react'
import { useI18n } from '../../i18n'
import type { WorkoutExercise } from '../../data/testWorkout'
import type { Video } from '../../types/app'

type ActiveVideoEntry = {
  name: string
  kind: 'exercise' | 'extra'
} | null

type VideoCarouselProps = {
  activeVideoEntry: ActiveVideoEntry
  activeExercise: WorkoutExercise | null
  activeVideoExactMatch: boolean | null
  activeVideoLoading: boolean
  previewVideos: Video[]
  videoOffline: boolean
  videoSuggestions: WorkoutExercise[]
  previewCount: number
  onOpenVideo: (videoId: string) => void
  onOpenVideoList: () => void
  onRetryVideos: (limit: number) => void
  onSelectExercise: (exerciseId: string) => void
}

type VideoListViewProps = {
  activeVideoEntry: ActiveVideoEntry
  activeExercise: WorkoutExercise | null
  activeVideoLoading: boolean
  activeVideos: Video[]
  onClose: () => void
  onOpenVideo: (videoId: string) => void
  onRetryVideos: (limit: number) => void
}

const ExternalLinkIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)

const RetryIcon = () => (
  <svg className="video-retry-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15.54-5.5" />
    <polyline points="19 3 19 7 15 7" />
    <path d="M21 12a9 9 0 0 1-15.54 5.5" />
    <polyline points="5 21 5 17 9 17" />
  </svg>
)

export const VideoCarousel: FC<VideoCarouselProps> = ({
  activeVideoEntry,
  activeExercise,
  activeVideoExactMatch,
  activeVideoLoading,
  previewVideos,
  videoOffline,
  videoSuggestions,
  previewCount,
  onOpenVideo,
  onOpenVideoList,
  onRetryVideos,
  onSelectExercise,
}) => {
  const { t } = useI18n()

  return (
    <div className="video-carousel-container">
      <div className="video-carousel-header">
        <p className="section-label">{t('workout.demoVideos')}</p>
        {activeVideoEntry && previewVideos.length > 0 ? (
          <button className="video-list-toggle" type="button" onClick={onOpenVideoList}>
            {t('workout.viewAll')}
          </button>
        ) : null}
      </div>
      <div className="video-carousel">
        {activeVideoLoading ? (
          <div className="video-loader">{t('workout.loadingVideos')}</div>
        ) : previewVideos.length > 0 ? (
          previewVideos.map((video) => (
            <div key={video.id} className="video-card" onClick={() => onOpenVideo(video.id)}>
              <div className="video-card-thumb-wrap">
                <img className="video-thumbnail" src={video.thumbnail} alt={video.title} />
                <span className="video-duration">{video.duration || ''}</span>
                <a
                  className="video-card-external-link"
                  href={video.link || `https://www.youtube.com/watch?v=${video.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('common.openExternally')}
                  aria-label={t('common.openExternally')}
                  onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => event.stopPropagation()}
                >
                  <ExternalLinkIcon />
                </a>
              </div>
              <div className="video-title-row">
                <div className="video-title">{video.title}</div>
              </div>
            </div>
          ))
        ) : videoOffline ? (
          <div className="video-loader" style={{ opacity: 0.5 }}>{t('workout.videosOffline')}</div>
        ) : activeVideoExactMatch === false && activeExercise ? (
          <div className="video-empty">
            <p className="video-empty-title">{t('workout.noExactMatch', { name: activeExercise.name })}</p>
            {videoSuggestions.length > 0 ? (
              <>
                <p className="video-empty-subtitle">{t('workout.tryAnother')}</p>
                <div className="video-suggestions">
                  {videoSuggestions.map((exercise) => (
                    <button
                      key={exercise.id}
                      className="video-suggestion-chip"
                      type="button"
                      onClick={() => onSelectExercise(exercise.id)}
                    >
                      {exercise.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="video-empty-subtitle">{t('workout.noOtherExercises')}</p>
            )}
            <button
              className="video-retry-button"
              type="button"
              onClick={() => onRetryVideos(previewCount)}
              aria-label={t('workout.retryVideoSearch')}
            >
              <RetryIcon />
              {t('common.retry')}
            </button>
          </div>
        ) : (
          <div className="video-empty">
            <p className="video-empty-title">{t('workout.noVideosFound')}</p>
            {activeExercise ? (
              <button
                className="video-retry-button"
                type="button"
                onClick={() => onRetryVideos(previewCount)}
                aria-label={t('workout.retryVideoSearch')}
              >
                <RetryIcon />
                {t('common.retry')}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

export const VideoListView: FC<VideoListViewProps> = ({
  activeVideoEntry,
  activeExercise,
  activeVideoLoading,
  activeVideos,
  onClose,
  onOpenVideo,
  onRetryVideos,
}) => {
  const { t } = useI18n()

  return (
    <div className="video-list-view">
      <div className="video-list-header">
        <button className="video-list-back" type="button" onClick={onClose}>
          {t('common.back')}
        </button>
        <div className="video-list-title">
          {activeVideoEntry ? t('workout.videosForExercise', { name: activeVideoEntry.name }) : t('workout.videosTitle')}
        </div>
      </div>
      {activeVideoLoading ? (
        <div className="video-loader">{t('workout.loadingVideos')}</div>
      ) : activeVideos.length > 0 ? (
        <div className="video-list">
          {activeVideos.map((video) => (
            <div key={video.id} className="video-list-row">
              <button
                className="video-list-item"
                type="button"
                onClick={() => onOpenVideo(video.id)}
              >
                <img className="video-list-thumb" src={video.thumbnail} alt={video.title} />
                <div className="video-list-meta">
                  <div className="video-list-title-text">{video.title}</div>
                  <div className="video-list-subtitle">{video.duration || ' '}</div>
                </div>
              </button>
              <a
                className="video-external-link video-list-external-link"
                href={video.link || `https://www.youtube.com/watch?v=${video.id}`}
                target="_blank"
                rel="noopener noreferrer"
                title={t('common.openExternally')}
                aria-label={t('common.openExternally')}
                onClick={(event) => event.stopPropagation()}
              >
                <ExternalLinkIcon />
              </a>
            </div>
          ))}
        </div>
      ) : (
        <div className="video-empty">
          <p className="video-empty-title">{t('workout.noVideosFound')}</p>
          {activeExercise ? (
            <button
              className="video-retry-button"
              type="button"
              onClick={() => onRetryVideos(20)}
              aria-label={t('workout.retryVideoSearch')}
            >
              <RetryIcon />
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
