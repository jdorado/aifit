export type DemoVideo = {
  video_id: string
  title: string
  duration_text: string
  duration_seconds: number | null
  thumbnail_url: string
  channel_title: string | null
  url: string
}

export type DemoVideoSearch = {
  query: string
  exact_match: boolean
  videos: DemoVideo[]
}

type VideoFetch = {
  apiBaseUrl: string
  getHeaders: () => Promise<Record<string, string>>
  query: string
  limit?: number
  force?: boolean
}

type CacheEntry = {
  ts: number
  result: DemoVideoSearch
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const cache = new Map<string, CacheEntry>()

const cacheKey = (query: string, limit: number) => `${limit}:${query.trim().toLowerCase()}`

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
)

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const asNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
)

const normalizeVideo = (value: unknown): DemoVideo | null => {
  const video = asRecord(value)
  if (!video) return null
  const videoId = asString(video.video_id)
  const title = asString(video.title)
  if (!videoId || !title) return null
  const url = asString(video.url) || `https://www.youtube.com/watch?v=${videoId}`
  const channel = asString(video.channel_title)
  return {
    video_id: videoId,
    title,
    duration_text: asString(video.duration_text),
    duration_seconds: asNumber(video.duration_seconds),
    thumbnail_url: asString(video.thumbnail_url),
    channel_title: channel || null,
    url,
  }
}

export const fetchDemoVideos = async ({
  apiBaseUrl,
  getHeaders,
  query,
  limit = 20,
  force = false,
}: VideoFetch): Promise<DemoVideoSearch> => {
  const seed = query.trim()
  const key = cacheKey(seed, limit)
  const cached = force ? null : cache.get(key)
  if (cached && Date.now() - cached.ts <= CACHE_TTL_MS) {
    return cached.result
  }
  if (cached) cache.delete(key)

  const params = new URLSearchParams({ q: seed, limit: String(limit) })
  const response = await fetch(`${apiBaseUrl}/v1/videos?${params.toString()}`, {
    headers: await getHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Failed to load demo videos (${response.status})`)
  }
  const payload = asRecord(await response.json())
  if (!payload || !Array.isArray(payload.videos)) {
    throw new Error('Invalid demo video payload')
  }
  const result: DemoVideoSearch = {
    query: asString(payload.query) || seed,
    exact_match: payload.exact_match === true,
    videos: payload.videos
      .map(normalizeVideo)
      .filter((video): video is DemoVideo => video !== null),
  }
  if (result.videos.length > 0) {
    cache.set(key, { ts: Date.now(), result })
  }
  return result
}
