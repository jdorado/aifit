// Design-preview routes for the exercise detail / set-logging area.
// Keeps a small in-memory copy of the sample week so logging, undo, add/remove set,
// target edits and feedback notes work end-to-end. State lives on globalThis because the
// route loader re-requires this file on every request. Reset it with GET /__detail/reset.
const pad = (n) => String(n).padStart(2, '0')
const dateId = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const range = (min, max = min) => ({ min, max })
const now = () => new Date().toISOString()
const doneActual = (reps, load, rpe = 7) => ({ status: 'completed', reps, ...(load ? { load: { value: load, unit: 'kg' } } : {}), rpe, completed_at: now() })

const build = () => {
  let counter = 0
  const exercise = (name, muscles, equipment, pattern, sets, cues = '') => {
    counter += 1
    return {
      exercise_instance_id: `ex_${counter}`,
      slot_id: `slot_${counter}`,
      candidate_id: `cand_${counter}`,
      order: counter,
      exercise_snapshot: {
        exercise_id: name.toLowerCase().replace(/\W+/g, '_'),
        exercise_revision: 'r1',
        name,
        movement_pattern: pattern,
        primary_muscles: muscles,
        secondary_muscles: [],
        equipment_kind: equipment,
        laterality: 'bilateral',
        load_basis: equipment === 'bodyweight' ? 'bodyweight' : 'total',
      },
      sets: sets.map((set, i) => ({ set_id: `set_${counter}_${i}`, kind: 'work', ...set })),
      cues_md: cues,
    }
  }
  const straight = (reps, load, count, logged = 0) => Array.from({ length: count }, (_, i) => ({
    target: { reps: range(reps), load: { value: load, unit: 'kg' }, rpe: range(7, 8) },
    actual: i < logged ? doneActual(reps, load) : null,
  }))
  const timed = (seconds, count, logged = 0) => Array.from({ length: count }, (_, i) => ({
    target: { duration_seconds: range(seconds) },
    actual: i < logged ? { status: 'completed', duration_seconds: seconds, completed_at: now() } : null,
  }))
  const segment = (order, kind, title, items, rounds = 1, rest = 90) => ({
    segment_id: `seg_${order}_${counter}`, order, kind, title, rounds, rest_after_round_seconds: rest, items,
  })

  // Today: warm-up done, bench 2/4 logged, row untouched, superset pending.
  const upper = (offset, state) => ({
    workout_id: `w_${offset}`, revision: 'rev1', date: dateId(offset), timezone: 'UTC',
    status: state === 'full' ? 'completed' : 'planned',
    title: 'Upper strength',
    notes: 'Heavy pressing day. Keep two reps in reserve on the last set and own the lowering phase.',
    segments: [
      segment(1, 'warmup', 'Warm-up', [
        exercise('Band pull-apart', ['back'], 'band', 'pull', timed(30, 2, state ? 2 : 0), 'Ribs down\nSqueeze shoulder blades'),
      ], 1, 30),
      segment(2, 'straight_sets', 'Strength', [
        exercise('Barbell bench press', ['chest'], 'barbell', 'push', straight(6, 70, 4, state === 'full' ? 4 : state === 'partial' ? 2 : 0), 'Feet planted\nBar to lower chest\nDrive through the floor'),
      ], 1, 150),
      segment(3, 'straight_sets', 'Strength', [
        exercise('Chest-supported row', ['back'], 'machine', 'pull', straight(10, 45, 3, state === 'full' ? 3 : 0), 'Pause one second at the chest'),
      ], 1, 120),
      segment(4, 'superset', 'Superset A', [
        exercise('Dumbbell shoulder press', ['shoulders'], 'dumbbell', 'push', straight(10, 18, 3), 'Stack wrists over elbows'),
        exercise('Cable face pull', ['shoulders'], 'cable', 'pull', straight(15, 20, 3), 'Pull to eye level'),
      ], 3, 75),
      segment(5, 'cooldown', 'Cooldown', [
        exercise('Doorway chest stretch', ['chest'], 'bodyweight', 'mobility', timed(45, 2)),
      ], 1, 20),
    ],
    lineage: { source: 'default' }, created_at: now(), updated_at: now(),
  })
  const lower = (offset) => ({
    workout_id: `w_${offset}`, revision: 'rev1', date: dateId(offset), timezone: 'UTC', status: 'planned',
    title: 'Lower power + circuit',
    notes: 'Fast concentric on every squat. Circuit is conditioning, not a max effort.',
    segments: [
      segment(1, 'warmup', 'Warm-up', [exercise('Goblet squat', ['quads'], 'dumbbell', 'squat', straight(8, 16, 2), 'Pry knees out')], 1, 30),
      segment(2, 'straight_sets', 'Strength', [exercise('Back squat', ['quads'], 'barbell', 'squat', straight(5, 90, 4), 'Brace hard\nBreak at hips and knees together')], 1, 180),
      segment(3, 'straight_sets', 'Strength', [exercise('Romanian deadlift', ['hamstrings'], 'barbell', 'hinge', straight(8, 80, 3), 'Hips back, shins vertical')], 1, 120),
      segment(4, 'circuit', 'Finisher circuit', [
        exercise('Kettlebell swing', ['glutes'], 'kettlebell', 'hinge', straight(15, 24, 3), 'Snap the hips'),
        exercise('Walking lunge', ['quads'], 'dumbbell', 'lunge', straight(12, 14, 3)),
        exercise('Plank', ['core'], 'bodyweight', 'core', timed(40, 3)),
      ], 3, 60),
    ],
    lineage: { source: 'default' }, created_at: now(), updated_at: now(),
  })
  counter = 0
  const fixOrder = (w) => { w.segments.forEach((seg) => seg.items.forEach((item, i) => { item.order = i + 1 })); return w }
  return [upper(-3, 'full'), { ...lower(-2), status: 'completed' }, upper(0, 'partial'), lower(1), upper(3), lower(4)]
    .map((workout, index) => fixOrder({ ...workout, workout_id: `w_${index}` }))
}

const store = () => {
  const g = globalThis
  if (!g.__detailStore || g.__detailStore.day !== dateId(0)) g.__detailStore = { day: dateId(0), rev: 1, workouts: build() }
  return g.__detailStore
}

const thumb = (a, b, label) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${a}"/><circle cx="240" cy="40" r="90" fill="${b}" opacity=".5"/><path d="M130 66v48l42-24z" fill="#fdfcf8"/><text x="16" y="164" font-family="monospace" font-size="12" fill="#fdfcf8">${label}</text></svg>`,
)}`

const videos = (q) => ({
  query: q, exact_match: true,
  videos: [
    { video_id: 'mock1', title: `${q}: setup and bar path`, duration_text: '4:12', duration_seconds: 252, thumbnail_url: thumb('#16204a', '#2a44f5', 'SETUP'), channel_title: 'Barbell Basics', url: 'https://www.youtube.com/watch?v=mock1' },
    { video_id: 'mock2', title: `Common ${q.toLowerCase()} mistakes`, duration_text: '6:40', duration_seconds: 400, thumbnail_url: thumb('#0c1020', '#d5f24b', 'MISTAKES'), channel_title: 'Strength Lab', url: 'https://www.youtube.com/watch?v=mock2' },
    { video_id: 'mock3', title: `${q} in 60 seconds`, duration_text: '1:02', duration_seconds: 62, thumbnail_url: thumb('#3a4a6b', '#c8401f', 'QUICK'), channel_title: 'Form Check', url: 'https://www.youtube.com/watch?v=mock3' },
  ],
})

const history = (exerciseId) => {
  const rows = []
  ;[-4, -11, -18].forEach((offset, s) => {
    for (let i = 0; i < 4; i += 1) {
      rows.push({
        set_id: `h_${s}_${i}`, workout_id: `hist_${s}`, exercise_instance_id: `hx_${s}`, exercise_id: exerciseId,
        exercise_name: 'Barbell bench press', date: dateId(offset), completed_at: `${dateId(offset)}T10:${pad(10 + i)}:00Z`,
        load: { value: 65 + s * -2.5 + (i === 3 ? 2.5 : 0), unit: 'kg' }, reps: 6 - (i === 3 ? 1 : 0), duration_seconds: null, rpe: 7 + (i > 1 ? 1 : 0),
      })
    }
  })
  return rows
}

const findWorkout = (st, id) => st.workouts.find((w) => w.workout_id === id)
const eachItem = (w, fn) => w.segments.forEach((seg) => seg.items.forEach((item) => fn(item, seg)))
const receipt = (st, w, effect) => {
  st.rev += 1
  w.revision = `rev${st.rev}`
  w.updated_at = now()
  return { resource: 'workout', resource_id: w.workout_id, revision: w.revision, effect, workout: w }
}

module.exports = (url, req, body) => {
  const { pathname } = url
  const method = req.method
  if (pathname === '/__detail/reset') { globalThis.__detailStore = null; return { ok: true } }
  if (pathname === '/v1/videos') return videos(url.searchParams.get('q') || 'Exercise')
  let m = pathname.match(/^\/v1\/exercises\/([^/]+)\/history$/)
  if (m) return history(decodeURIComponent(m[1]))
  m = pathname.match(/^\/v1\/exercises\/([^/]+)\/related-history$/)
  if (m) return { exercise_id: m[1], movement_pattern: 'push', primary_muscle: 'chest', family: [], muscle: [] }
  if (pathname === '/v1/workouts' && method === 'GET') return store().workouts

  m = pathname.match(/^\/v1\/workouts\/([^/]+)\/(.+)$/)
  if (!m || method === 'GET') return undefined
  const st = store()
  const w = findWorkout(st, decodeURIComponent(m[1]))
  if (!w) return undefined
  const rest = m[2]
  let hit
  const set = (setId) => { let found = null; eachItem(w, (item) => item.sets.forEach((s, i) => { if (s.set_id === setId) found = { item, set: s, index: i } })); return found }

  if ((hit = rest.match(/^sets\/([^/]+)\/unlog$/))) {
    const f = set(decodeURIComponent(hit[1])); if (f) f.set.actual = null
    return receipt(st, w, 'set_unlogged')
  }
  if ((hit = rest.match(/^sets\/([^/]+)\/remove$/))) {
    const id = decodeURIComponent(hit[1])
    eachItem(w, (item) => { item.sets = item.sets.filter((s) => s.set_id !== id) })
    return receipt(st, w, 'set_removed')
  }
  if ((hit = rest.match(/^sets\/([^/]+)\/target$/))) {
    const f = set(decodeURIComponent(hit[1]))
    if (f && body && body.target) {
      f.item.sets.forEach((s, i) => { if (i === f.index || (body.apply_to_remaining && i > f.index && !s.actual)) s.target = { ...s.target, ...body.target } })
    }
    return receipt(st, w, 'set_target_updated')
  }
  if ((hit = rest.match(/^sets\/([^/]+)$/)) && method === 'PATCH') {
    const f = set(decodeURIComponent(hit[1])); if (f && body && body.actual) f.set.actual = body.actual
    return receipt(st, w, 'set_logged')
  }
  if ((hit = rest.match(/^exercises\/([^/]+)\/sets$/)) && method === 'POST') {
    const id = decodeURIComponent(hit[1])
    eachItem(w, (item) => {
      if (item.exercise_instance_id !== id) return
      const last = item.sets[item.sets.length - 1]
      item.sets.push({ set_id: `set_new_${Date.now()}`, kind: 'work', target: last ? last.target : { reps: range(8) }, actual: null })
    })
    return receipt(st, w, 'set_added')
  }
  if ((hit = rest.match(/^exercises\/([^/]+)\/notes$/)) && method === 'PATCH') {
    const id = decodeURIComponent(hit[1])
    eachItem(w, (item) => { if (item.exercise_instance_id === id) item.notes = { note: (body && body.note) || '', preset: (body && body.preset) || null, updated_at: now() } })
    return receipt(st, w, 'exercise_notes_updated')
  }
  if (rest === 'notes' && method === 'PATCH') { w.notes = (body && body.notes) || ''; return receipt(st, w, 'notes_updated') }
  return undefined
}
