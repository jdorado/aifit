// Design-preview mock API: just enough canonical data to render every AIFit screen without auth.
const http = require('node:http')

const pad = (n) => String(n).padStart(2, '0')
const dateId = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const range = (min, max = min) => ({ min, max })
const done = (reps, load, rpe = 7) => ({ status: 'completed', reps, ...(load ? { load: { value: load, unit: 'kg' } } : {}), rpe, completed_at: new Date().toISOString() })

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
  actual: i < logged ? done(reps, load) : null,
}))
const timed = (seconds, count, logged = 0) => Array.from({ length: count }, (_, i) => ({
  target: { duration_seconds: range(seconds) },
  actual: i < logged ? { status: 'completed', duration_seconds: seconds, completed_at: new Date().toISOString() } : null,
}))

const segment = (order, kind, title, items, rounds = 1, rest = 90) => ({
  segment_id: `seg_${order}_${counter}`, order, kind, title, rounds, rest_after_round_seconds: rest, items,
})

const upperDay = (offset, progress) => {
  const logged = progress ?? 0
  return {
    workout_id: `w_${offset}`,
    revision: 'rev1',
    date: dateId(offset),
    timezone: 'UTC',
    status: logged >= 3 ? 'completed' : 'planned',
    title: 'Upper strength',
    notes: 'Heavy pressing day. Keep two reps in reserve on the last set and own the lowering phase.',
    segments: [
      segment(1, 'warmup', 'Warm-up', [
        exercise('Band pull-apart', ['back'], 'band', 'pull', timed(30, 2, logged ? 2 : 0), 'Ribs down\nSqueeze shoulder blades'),
      ], 1, 30),
      segment(2, 'straight_sets', 'Strength', [
        exercise('Barbell bench press', ['chest'], 'barbell', 'push', straight(6, 70, 4, logged ? 4 : 0), 'Feet planted\nBar to lower chest\nDrive through the floor'),
      ], 1, 150),
      segment(3, 'straight_sets', 'Strength', [
        exercise('Chest-supported row', ['back'], 'machine', 'pull', straight(10, 45, 3, logged > 1 ? 3 : 0), 'Pause one second at the chest'),
      ], 1, 120),
      segment(4, 'superset', 'Superset A', [
        exercise('Dumbbell shoulder press', ['shoulders'], 'dumbbell', 'push', straight(10, 18, 3), 'Stack wrists over elbows'),
        exercise('Cable face pull', ['shoulders'], 'cable', 'pull', straight(15, 20, 3), 'Pull to eye level'),
      ], 3, 75),
      segment(5, 'cooldown', 'Cooldown', [
        exercise('Doorway chest stretch', ['chest'], 'bodyweight', 'mobility', timed(45, 2)),
      ], 1, 20),
    ],
    lineage: { source: 'default' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

const lowerDay = (offset) => ({
  workout_id: `w_${offset}`,
  revision: 'rev1',
  date: dateId(offset),
  timezone: 'UTC',
  status: 'planned',
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
  lineage: { source: 'default' },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
})

const workouts = () => {
  counter = 0
  return [
    { ...upperDay(-3, 3) },
    { ...lowerDay(-2), status: 'completed' },
    upperDay(0, 1),
    lowerDay(1),
    upperDay(3),
    lowerDay(4),
  ].map((workout, index) => ({ ...workout, workout_id: `w_${index}` }))
}

const history = () => {
  const now = Date.now()
  return [
    { role: 'user', content: 'How should I load bench today? My shoulder felt a bit cranky on Tuesday.', timestamp: new Date(now - 1000 * 60 * 42).toISOString() },
    { role: 'ai', content: "Stay at **70 kg for 4×6**, but shorten the range: touch the bar to your lower chest and stop an inch above. If the shoulder pinches on set 2, drop to **65 kg** and keep the same reps.\n\nI added a face-pull superset after the press — it's the cheapest shoulder insurance in the plan.", timestamp: new Date(now - 1000 * 60 * 41).toISOString(), agent_label: 'Everyday help' },
    { role: 'user', content: 'Great. Swap row for something easier on my lower back?', timestamp: new Date(now - 1000 * 60 * 12).toISOString() },
    { role: 'ai', content: 'Done — the **chest-supported row** is already back-friendly because the pad takes your spine out of the equation. Keep the pause at the top and you will get the lats without the load.', timestamp: new Date(now - 1000 * 60 * 11).toISOString(), agent_label: 'Everyday help' },
  ]
}

const modelControl = {
  presets: [
    { id: 'quick', name: 'Quick reply', cli: 'codex', label: 'Quick reply' },
    { id: 'everyday', name: 'Everyday help', cli: 'codex', label: 'Everyday help' },
    { id: 'planning', name: 'Detailed planning', cli: 'codex', label: 'Detailed planning' },
  ],
  selected_id: 'everyday',
  models: [],
  active_session_id: null,
}

// Extra routes live in design-preview/routes/*.cjs. Each exports (url, req, body) => value | undefined.
const fs = require('node:fs')
const path = require('node:path')
const routesDir = path.join(__dirname, 'routes')
const extraRoutes = () => (fs.existsSync(routesDir) ? fs.readdirSync(routesDir).filter((f) => f.endsWith('.cjs')).sort() : [])
  .map((file) => { delete require.cache[require.resolve(path.join(routesDir, file))]; return require(path.join(routesDir, file)) })

const routes = (url, req, body) => {
  for (const handler of extraRoutes()) {
    const value = handler(url, req, body)
    if (value !== undefined) return value
  }
  const { pathname } = url
  if (pathname === '/health') return { ok: true }
  if (pathname === '/account') return { language: 'en' }
  if (pathname === '/v1/workouts') return workouts()
  if (pathname === '/chat/history') return history()
  if (pathname === '/chat/models') return modelControl
  if (pathname === '/v1/coach-links') return []
  return null
}

http.createServer((req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    let parsed = null
    try { parsed = raw ? JSON.parse(raw) : null } catch { /* non-JSON body */ }
    const body = routes(new URL(req.url, 'http://localhost'), req, parsed)
    res.writeHead(body === null ? 404 : 200, headers)
    res.end(JSON.stringify(body ?? { detail: 'not mocked' }))
    if (body === null) console.log('unmocked', req.method, req.url)
  })
}).listen(8199, () => console.log('AIFit design-preview API on :8199'))
