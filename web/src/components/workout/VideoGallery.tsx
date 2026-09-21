import type { FC, MouseEvent as ReactMouseEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { fetchDemoVideos, type DemoVideo } from '../../utils/demoVideos'
import VideoModal from './VideoModal'

type VideoGalleryProps = {
  exerciseKey: string
  exerciseName: string
  apiBaseUrl: string
  getAuthHeaders: () => Promise<Record<string, string>>
}

const PREVIEW_COUNT = 5
const VIDEO_LIMIT = 20

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

const VideoGallery: FC<VideoGalleryProps> = ({
  exerciseKey,
  exerciseName,
  apiBaseUrl,
  getAuthHeaders,
}) => {
  const { t } = useI18n()
  const [videos, setVideos] = useState<DemoVideo[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [activeVideo, setActiveVideo] = useState<DemoVideo | null>(null)
  const requestRef = useRef(0)
  const authHeadersRef = useRef(getAuthHeaders)

  useEffect(() => {
    authHeadersRef.current = getAuthHeaders
  }, [getAuthHeaders])

  const load = useCallback(async (force: boolean) => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setFailed(false)
    try {
      const result = await fetchDemoVideos({
        apiBaseUrl,
        getHeaders: () => authHeadersRef.current(),
        query: exerciseName,
        limit: VIDEO_LIMIT,
        force,
      })
      if (requestRef.current !== requestId) return
      setVideos(result.videos)
    } catch {
      if (requestRef.current !== requestId) return
      setVideos([])
      setFailed(true)
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [apiBaseUrl, exerciseName])

  useEffect(() => {
    setListOpen(false)
    setActiveVideo(null)
    void load(false)
  }, [exerciseKey, load])

  const retry = () => {
    void load(true)
  }

  const openExternal = (event: ReactMouseEvent<HTMLAnchorElement>) => event.stopPropagation()

  const emptyState = (
    <div className="video-empty">
      <p className={`video-empty-title${failed ? ' error' : ''}`}>
        {failed ? t('workout.videoError') : t('workout.noVideosFound')}
      </p>
      <button
        className="video-retry-button"
        type="button"
        onClick={retry}
        aria-label={t('workout.retryVideoSearch')}
      >
        <RetryIcon />
        {t('common.retry')}
      </button>
    </div>
  )

  const listView = (
    <div className="video-list-view">
      <div className="video-list-header">
        <button className="video-list-back" type="button" onClick={() => setListOpen(false)}>
          {t('common.back')}
        </button>
        <div className="video-list-title">{t('workout.videosForExercise', { name: exerciseName })}</div>
      </div>
      {loading ? (
        <div className="video-loader">{t('workout.loadingVideos')}</div>
      ) : videos.length > 0 ? (
        <div className="video-list">
          {videos.map((video) => (
            <div key={video.video_id} className="video-list-row">
              <button className="video-list-item" type="button" onClick={() => setActiveVideo(video)}>
                {video.thumbnail_url ? (
                  <img className="video-list-thumb" src={video.thumbnail_url} alt={video.title} loading="lazy" />
                ) : <span className="video-list-thumb" aria-hidden="true" />}
                <div className="video-list-meta">
                  <div className="video-list-title-text">{video.title}</div>
                  <div className="video-list-subtitle">
                    {[video.duration_text, video.channel_title].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </button>
              <a
                className="video-external-link video-list-external-link"
                href={video.url}
                target="_blank"
                rel="noopener noreferrer"
                title={t('common.openExternally')}
                aria-label={t('common.openExternally')}
                onClick={openExternal}
              >
                <ExternalLinkIcon />
              </a>
            </div>
          ))}
        </div>
      ) : emptyState}
    </div>
  )

  return (
    <>
      {listOpen ? listView : (
        <div className="video-carousel-container">
          <div className="video-carousel-header">
            <p className="section-label">{t('workout.demoVideos')}</p>
            {videos.length > 0 ? (
              <button className="video-list-toggle" type="button" onClick={() => setListOpen(true)}>
                {t('workout.viewAll')}
              </button>
            ) : null}
          </div>
          <div className="video-carousel">
            {loading ? (
              <div className="video-loader">{t('workout.loadingVideos')}</div>
            ) : videos.length > 0 ? (
              videos.slice(0, PREVIEW_COUNT).map((video) => (
                <div key={video.video_id} className="video-card" onClick={() => setActiveVideo(video)}>
                  <div className="video-card-thumb-wrap">
                    {video.thumbnail_url ? (
                      <img className="video-thumbnail" src={video.thumbnail_url} alt={video.title} loading="lazy" />
                    ) : <span className="video-thumbnail" aria-hidden="true" />}
                    <span className="video-duration">{video.duration_text || ''}</span>
                    <a
                      className="video-card-external-link"
                      href={video.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t('common.openExternally')}
                      aria-label={t('common.openExternally')}
                      onClick={openExternal}
                    >
                      <ExternalLinkIcon />
                    </a>
                  </div>
                  <div className="video-title-row">
                    <div className="video-title">{video.title}</div>
                  </div>
                </div>
              ))
            ) : emptyState}
          </div>
        </div>
      )}
      {activeVideo ? (
        <VideoModal video={activeVideo} onClose={() => setActiveVideo(null)} />
      ) : null}
    </>
  )
}

export default VideoGallery
