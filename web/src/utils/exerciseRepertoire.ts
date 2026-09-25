export type RepertoireCandidate = {
  day_id: string
  slot_id: string
  candidate_id: string
  exercise_id: string
  name: string
  equipment_kind: string
  primary_muscles: string[]
  secondary_muscles: string[]
  role: string
  day_title: string
  section_title: string
  sets: number
  target_summary: string
  already_added: boolean
}

export type ExerciseRepertoire = {
  workout_id: string
  workout_revision: string
  blueprint_id: string
  blueprint_revision: string
  candidates: RepertoireCandidate[]
}
