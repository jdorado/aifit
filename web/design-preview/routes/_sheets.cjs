// NOTE: named with a leading underscore so it loads before detail.cjs (first handler to return a value wins).
// Design-preview mock data for the secondary workout surfaces:
// workout history, exercise history, exercise repertoire (Add exercise), swap candidates, progression.
const pad = (n) => String(n).padStart(2, '0')
const dateId = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const isoAt = (offset, hour = 18, minute = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

// ---------- Workout history (GET /v1/workouts?start&end spanning many weeks) ----------
const TITLES = ['Upper strength', 'Lower power + circuit', 'Pull + core', 'Conditioning + mobility']
const historyWorkouts = () => {
  // Training pattern: Mon/Tue/Thu/Sat-ish, three weeks plus a quiet earlier week.
  const offsets = [-1, -2, -4, -5, -8, -9, -11, -12, -15, -16, -18, -19, -22, -23, -26, -29, -30, -33, -36, -40, -47, -55]
  return offsets.map((offset, index) => {
    const moves = 4 + (index % 3)
    const setsPerMove = 3 + (index % 2)
    const total = moves * setsPerMove
    const logged = index === 1 ? Math.round(total * 0.6) : index === 4 ? 0 : total
    let remaining = logged
    const items = Array.from({ length: moves }, (_, m) => ({
      exercise_instance_id: `h_${index}_${m}`,
      sets: Array.from({ length: setsPerMove }, (_, s) => {
        const done = remaining > 0
        if (done) remaining -= 1
        return { set_id: `hs_${index}_${m}_${s}`, kind: 'work', actual: done ? { status: 'completed', reps: 8 } : null }
      }),
    }))
    return {
      workout_id: `hist_${index}`,
      revision: 'rev1',
      date: dateId(offset),
      timezone: 'UTC',
      status: logged >= total ? 'completed' : 'planned',
      title: TITLES[index % TITLES.length],
      segments: [{ segment_id: `hseg_${index}`, order: 1, kind: 'straight_sets', title: 'Strength', rounds: 1, items }],
    }
  })
}

// ---------- Exercise history (GET /v1/exercises/:id/history) ----------
const BASE_LOAD = { barbell_bench_press: 70, chest_supported_row: 45, band_pull_apart: 0, dumbbell_shoulder_press: 18, back_squat: 90 }
const pretty = (id) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

const historyRows = (exerciseId, nameOverride, baseOverride) => {
  const base = baseOverride ?? BASE_LOAD[exerciseId] ?? 30
  const name = nameOverride ?? pretty(exerciseId)
  // newest first: [offset, load delta from base, reps per set]
  const plan = [
    [-3, 0, [6, 6, 6, 5]],
    [-10, 0, [6, 6, 5, 5]],
    [-17, -2.5, [6, 6, 6, 6]],
    [-24, -2.5, [6, 6, 6, 5]],
    [-31, -5, [6, 6, 6, 6]],
    [-38, -5, [8, 7, 6, 6]],
    [-45, -10, [8, 8, 8, 7]],
  ]
  const rows = []
  plan.forEach(([offset, delta, reps], si) => {
    reps.forEach((r, i) => {
      rows.push({
        set_id: `${exerciseId}_${si}_${i}`,
        workout_id: `hx_${exerciseId}_${si}`,
        exercise_instance_id: `hxi_${si}`,
        exercise_id: exerciseId,
        exercise_name: name,
        date: dateId(offset),
        completed_at: isoAt(offset, 18, i * 4),
        load: base ? { value: base + delta, unit: 'kg' } : null,
        reps: r,
        duration_seconds: null,
        rpe: 7,
      })
    })
  })
  return rows.reverse().reverse()
}

const relatedHistory = (exerciseId) => ({
  movement_pattern: 'push',
  primary_muscle: 'chest',
  family: [
    ...historyRows('dumbbell_bench_press', 'Dumbbell bench press', 28).slice(0, 8),
    ...historyRows('incline_barbell_press', 'Incline barbell press', 55).slice(0, 8),
  ],
  muscle: historyRows('cable_fly', 'Cable fly', 15).slice(0, 8),
})

// ---------- Progression (muscle tab) ----------
const trend = (status, repsChange, loadChange) => ({
  status, reps_change: repsChange, load_change_kg: loadChange, days: 42, exposures: 6,
  effort_comparable: true, baseline: null, latest: null,
})
const progression = (workoutId) => ({
  workout_id: workoutId,
  revision: 'rev1',
  as_of: dateId(0),
  trend_days: 42,
  exercises: Array.from({ length: 60 }, (_, i) => ({
    exercise_instance_id: `ex_${i + 1}`, exercise_id: `x_${i + 1}`, exercise_name: 'Exercise',
    primary_muscles: ['chest'], load_basis: 'total', prescribed_load: null, next_load: null,
    policy: { kind: 'none' }, status: 'building', reason: '', qualifying_sessions: 1, required_sessions: 2,
    expected_sets: 4, target_reps: { min: 6, max: 8 }, latest: null, trend: trend('improving', 1, 2.5), review_reasons: [],
  })),
  muscles: [{
    muscle: 'chest', tracked_exercises: 3, comparable_exercises: 3, improving_exercises: 2,
    direct_completed_sets: 9, direct_planned_sets: 12, indirect_completed_sets: 5, indirect_planned_sets: 8,
    week_start: dateId(-5), week_end: dateId(1),
    exercises: [
      { exercise_id: 'barbell_bench_press', name: 'Barbell bench press', trend: trend('improving', 0, 5) },
      { exercise_id: 'dumbbell_bench_press', name: 'Dumbbell bench press', trend: trend('holding', 0, 0) },
      { exercise_id: 'cable_fly', name: 'Cable fly', trend: trend('improving', 2, 0) },
    ],
  }],
})

// ---------- Repertoire (Add exercise) ----------
const fit = (score, day, recovery, progress, tentative = false) => ({ score, tentative, factors: { day, recovery, progress } })
const REPERTOIRE = [
  ['barbell_bench_press', 'Barbell bench press', 'barbell', ['chest'], ['triceps'], 'Upper strength', 'Strength', 4, '6 reps - 70kg', true, null],
  ['band_pull_apart', 'Band pull-apart', 'band', ['back'], ['shoulders'], 'Upper strength', 'Warm-up', 2, '30 reps', true, null],
  ['incline_dumbbell_press', 'Incline dumbbell press', 'dumbbell', ['chest'], ['shoulders', 'triceps'], 'Upper strength', 'Strength', 3, '8-10 reps - 24kg', false, fit(92, 95, 88, 90)],
  ['lat_pulldown', 'Lat pulldown', 'cable', ['back'], ['biceps'], 'Upper strength', 'Strength', 3, '10 reps - 50kg', false, fit(86, 90, 80, 85)],
  ['dumbbell_lateral_raise', 'Dumbbell lateral raise', 'dumbbell', ['shoulders'], [], 'Upper strength', 'Accessory', 3, '15 reps - 8kg', false, fit(78, 70, 92, 72)],
  ['cable_triceps_pushdown', 'Cable triceps pushdown', 'cable', ['triceps'], [], 'Upper strength', 'Accessory', 3, '12 reps - 25kg', false, fit(71, 65, 80, 68)],
  ['barbell_curl', 'Barbell curl', 'barbell', ['biceps'], ['forearms'], 'Pull + core', 'Accessory', 3, '10 reps - 30kg', false, fit(64, 60, 70, 62, true)],
  ['back_squat', 'Back squat', 'barbell', ['quads'], ['glutes'], 'Lower power + circuit', 'Strength', 4, '5 reps - 90kg', false, fit(45, 30, 40, 70)],
  ['romanian_deadlift', 'Romanian deadlift', 'barbell', ['hamstrings'], ['glutes'], 'Lower power + circuit', 'Strength', 3, '8 reps - 80kg', false, fit(38, 25, 35, 60)],
  ['walking_lunge', 'Walking lunge', 'dumbbell', ['quads'], ['glutes'], 'Lower power + circuit', 'Finisher circuit', 3, '12 reps - 14kg', false, fit(34, 20, 40, 55)],
  ['plank', 'Plank', 'bodyweight', ['core'], [], 'Lower power + circuit', 'Finisher circuit', 3, '40s', false, fit(81, 85, 90, 70)],
  ['hanging_knee_raise', 'Hanging knee raise', 'bodyweight', ['core'], ['hip_flexors'], 'Pull + core', 'Accessory', 3, '12 reps', false, fit(58, 55, 70, 50)],
]
const repertoire = (rankFit) => ({
  workout_id: 'w_2',
  workout_revision: 'rev1',
  blueprint_id: 'bp_1',
  blueprint_revision: 'bprev1',
  candidates: REPERTOIRE.map(([id, name, equipment, primary, secondary, day, section, sets, target, added, f], i) => ({
    day_id: `day_${day.toLowerCase().replace(/\W+/g, '_')}`,
    slot_id: `slot_${i}`,
    candidate_id: `cand_${id}`,
    exercise_id: id,
    name,
    equipment_kind: equipment,
    primary_muscles: primary,
    secondary_muscles: secondary,
    role: 'primary',
    day_title: day,
    section_title: section,
    sets,
    target_summary: target,
    already_added: added,
    ...(rankFit && f ? { fit: f } : {}),
  })),
})

// ---------- Swap candidates ----------
const swapCandidates = (workoutId, instanceId, rankFit) => ({
  workout_id: workoutId,
  workout_revision: 'rev1',
  exercise_instance_id: instanceId,
  slot_id: 'slot_2',
  current_candidate_id: 'cand_current',
  current_exercise_name: 'Barbell bench press',
  blueprint_id: 'bp_1',
  blueprint_revision: 'bprev1',
  candidates: [
    ['dumbbell_bench_press', 'Dumbbell bench press', 'dumbbell', 1, '8 reps - 28kg', 4, fit(91, 92, 90, 88)],
    ['machine_chest_press', 'Machine chest press', 'machine', 2, '10 reps - 55kg', 3, fit(83, 80, 90, 78)],
    ['incline_barbell_press', 'Incline barbell press', 'barbell', 3, '6 reps - 55kg', 4, fit(72, 70, 65, 80, true)],
    ['push_up', 'Weighted push-up', 'bodyweight', 4, '12 reps', 3, fit(55, 50, 85, 40)],
  ].map(([id, name, equipment, priority, target, sets, f]) => ({
    candidate_id: `cand_${id}`, exercise_id: id, name, equipment_kind: equipment, priority,
    target_summary: target, sets, rest_seconds: 120, ...(rankFit ? { fit: f } : {}),
  })),
})

module.exports = (url) => {
  const { pathname, searchParams } = url

  if (pathname === '/v1/workouts' && searchParams.get('start') && searchParams.get('end')) {
    const span = (new Date(searchParams.get('end')) - new Date(searchParams.get('start'))) / 86400000
    if (span > 30) {
      // Merge with the live day store owned by detail.cjs so today's workout appears in the timeline.
      const live = (globalThis.__detailStore && globalThis.__detailStore.workouts) || []
      const taken = new Set(live.map((w) => w.date))
      return [...live.filter((w) => w.date <= dateId(0)), ...historyWorkouts().filter((w) => !taken.has(w.date))]
    }
    return undefined
  }

  let match = pathname.match(/^\/v1\/exercises\/([^/]+)\/history$/)
  if (match) return historyRows(decodeURIComponent(match[1]))
  match = pathname.match(/^\/v1\/exercises\/([^/]+)\/related-history$/)
  if (match) return relatedHistory(decodeURIComponent(match[1]))

  match = pathname.match(/^\/v1\/workouts\/([^/]+)\/progression$/)
  if (match) return progression(decodeURIComponent(match[1]))

  match = pathname.match(/^\/v1\/workouts\/([^/]+)\/exercise-repertoire$/)
  if (match) return repertoire(searchParams.get('rank_fit') === 'true')

  match = pathname.match(/^\/v1\/workouts\/([^/]+)\/exercises\/([^/]+)\/swap-candidates$/)
  if (match) return swapCandidates(decodeURIComponent(match[1]), decodeURIComponent(match[2]), searchParams.get('rank_fit') === 'true')

  return undefined
}
