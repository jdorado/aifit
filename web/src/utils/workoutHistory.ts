import type { BackendWorkout } from './backendWorkoutAdapter'

type WorkoutHistoryFetch = {
  apiBaseUrl: string
  getHeaders: () => Promise<Record<string, string>>
  actAsLinkId?: string | null
  daysBack?: number
  endDateId?: string
}

const getDateId = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const shiftDateId = (dateId: string, offsetDays: number) => {
  const parsed = new Date(`${dateId}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return dateId
  parsed.setDate(parsed.getDate() + offsetDays)
  return getDateId(parsed)
}

export const fetchWorkoutHistory = async ({
  apiBaseUrl,
  getHeaders,
  actAsLinkId = null,
  daysBack = 90,
  endDateId,
}: WorkoutHistoryFetch): Promise<BackendWorkout[]> => {
  const end = endDateId ?? getDateId(new Date())
  const start = shiftDateId(end, -(Math.max(1, daysBack) - 1))
  const params = new URLSearchParams({ start, end })
  if (actAsLinkId) params.set('act_as_link_id', actAsLinkId)
  const response = await fetch(`${apiBaseUrl}/v1/workouts?${params.toString()}`, {
    headers: await getHeaders(),
  })
  if (!response.ok) {
    throw new Error(`Failed to load workout history (${response.status})`)
  }
  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) {
    throw new Error('Invalid workout history payload')
  }
  return (payload as BackendWorkout[])
    .filter((workout) => Boolean(workout && typeof workout.date === 'string'))
    .sort((a, b) => b.date.localeCompare(a.date))
}
