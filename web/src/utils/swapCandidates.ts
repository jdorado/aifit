export type SwapCandidate = {
  candidate_id: string
  exercise_id: string
  name: string
  equipment_kind: string
  priority: number
  target_summary: string
  rest_seconds: number
}

export type SwapCandidates = {
  workout_id: string
  workout_revision: string
  exercise_instance_id: string
  slot_id: string
  current_candidate_id: string
  current_exercise_name: string
  blueprint_id: string
  blueprint_revision: string
  candidates: SwapCandidate[]
}

export class SwapCandidatesError extends Error {
  code: string | null

  constructor(code: string | null, message: string) {
    super(message)
    this.code = code
  }
}

/** Blueprint-context codes: the day has no usable blueprint slot to swap within. */
const NO_BLUEPRINT_CODES = new Set([
  'active_blueprint_missing',
  'blueprint_date_uncovered',
  'blueprint_day_missing',
  'blueprint_slot_missing',
])

export type SwapErrorKey = 'swapNoBlueprint' | 'swapStaleBlueprint' | 'swapOutsideBlueprint' | 'swapEmpty' | 'swapLocked' | 'swapFailed'

/** Map a backend failure to the picker copy key with recovery guidance. */
export const swapErrorKey = (code: string | null): SwapErrorKey => {
  if (code === 'completed_exercise_locked') return 'swapLocked'
  if (code === 'no_eligible_swap') return 'swapEmpty'
  if (code === 'stale_blueprint') return 'swapStaleBlueprint'
  if (code === 'blueprint_slot_missing') return 'swapOutsideBlueprint'
  if (code && NO_BLUEPRINT_CODES.has(code)) return 'swapNoBlueprint'
  return 'swapFailed'
}

export const readApiError = (body: unknown, status: number, fallback: string): SwapCandidatesError => {
  const detail = asRecord(body)?.detail
  const code = typeof detail === 'object' && detail !== null && typeof (detail as Record<string, unknown>).code === 'string'
    ? (detail as Record<string, unknown>).code as string
    : null
  const message = typeof detail === 'string'
    ? detail
    : typeof detail === 'object' && detail !== null && typeof (detail as Record<string, unknown>).message === 'string'
      ? (detail as Record<string, unknown>).message as string
      : `${fallback} (${status})`
  return new SwapCandidatesError(code, message)
}

type SwapCandidatesFetch = {
  apiBaseUrl: string
  getHeaders: () => Promise<Record<string, string>>
  workoutId: string
  exerciseInstanceId: string
  actAsLinkId?: string | null
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
)

const asString = (value: unknown): string | null => (
  typeof value === 'string' && value ? value : null
)

const normalizeCandidate = (value: unknown): SwapCandidate | null => {
  const row = asRecord(value)
  if (!row) return null
  const candidateId = asString(row.candidate_id)
  const exerciseId = asString(row.exercise_id)
  const name = asString(row.name)
  if (!candidateId || !exerciseId || !name) return null
  const priority = typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : 999
  const restSeconds = typeof row.rest_seconds === 'number' && Number.isFinite(row.rest_seconds) ? row.rest_seconds : 0
  return {
    candidate_id: candidateId,
    exercise_id: exerciseId,
    name,
    equipment_kind: asString(row.equipment_kind) ?? '',
    priority,
    target_summary: asString(row.target_summary) ?? '',
    rest_seconds: restSeconds,
  }
}

export const fetchSwapCandidates = async ({
  apiBaseUrl,
  getHeaders,
  workoutId,
  exerciseInstanceId,
  actAsLinkId = null,
}: SwapCandidatesFetch): Promise<SwapCandidates> => {
  const params = new URLSearchParams()
  if (actAsLinkId) params.set('act_as_link_id', actAsLinkId)
  const query = params.toString()
  const response = await fetch(
    `${apiBaseUrl}/v1/workouts/${encodeURIComponent(workoutId)}/exercises/${encodeURIComponent(exerciseInstanceId)}/swap-candidates${query ? `?${query}` : ''}`,
    { headers: await getHeaders() },
  )
  if (!response.ok) {
    throw readApiError(await response.json().catch(() => null), response.status, 'Failed to load alternatives')
  }
  const payload = asRecord(await response.json())
  const workoutRevision = payload ? asString(payload.workout_revision) : null
  const blueprintRevision = payload ? asString(payload.blueprint_revision) : null
  if (!payload || !workoutRevision || !blueprintRevision || !Array.isArray(payload.candidates)) {
    throw new SwapCandidatesError(null, 'Invalid alternatives payload')
  }
  return {
    workout_id: asString(payload.workout_id) ?? workoutId,
    workout_revision: workoutRevision,
    exercise_instance_id: asString(payload.exercise_instance_id) ?? exerciseInstanceId,
    slot_id: asString(payload.slot_id) ?? '',
    current_candidate_id: asString(payload.current_candidate_id) ?? '',
    current_exercise_name: asString(payload.current_exercise_name) ?? '',
    blueprint_id: asString(payload.blueprint_id) ?? '',
    blueprint_revision: blueprintRevision,
    candidates: payload.candidates
      .map(normalizeCandidate)
      .filter((candidate): candidate is SwapCandidate => candidate !== null),
  }
}
