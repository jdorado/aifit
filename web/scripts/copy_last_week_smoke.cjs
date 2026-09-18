const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/App.tsx'), 'utf8')
const handler = source.slice(source.indexOf('  const handleCopyLastWeek = async () => {'), source.indexOf('\n  useEffect', source.indexOf('  const handleCopyLastWeek = async () => {')))
const js = ts.transpile(handler, { target: ts.ScriptTarget.ES2020 })
const exercise = { id: 'squat', sets: [{ targetReps: '10' }, { targetReps: '8' }] }
async function run({ logged = false, missing = false, conflict = false } = {}) {
  let payload, applied
  const dates = [], alerts = []
  const env = {
    canEditPlanSelectedDay: true, canQuerySavedWorkoutSessions: true, isBackendHealthy: true,
    copyingLastWeekRef: { current: false }, setCopyingLastWeek() {},
    selectedDay: { date: '2026-09-07' }, todayId: '2026-09-07', selectedDayLabel: 'Monday',
    pendingWorkoutDatesRef: { current: new Set() },
    shiftDateId(date, offset) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10) },
    async fetchWorkoutSessionByDate(date) {
      dates.push(date)
      if (date === '2026-08-31') return missing ? null : { notes: 'Tempo: slow down', workout: { exercises: [exercise], extras: [], set_logs: { squat: [{ done: true }] } } }
      return { revision: 'destination-revision', auto_fill_suppressed_at: '2026-09-07T01:00:00Z', workout: { exercises: [], set_logs: logged ? { squat: [{ done: true }] } : {} } }
    },
    hasWorkoutContent: (exercises, extras) => exercises.length + extras.length > 0,
    window: { alert: message => alerts.push(message), confirm: () => true }, t: key => key,
    getPrivyAuthHeaders: async () => ({}), API_BASE_URL: '', currentUserId: 'isolated-test', coachActAsOwnerId: null,
    apiFetch: async (url, request) => { payload = JSON.parse(request.body); return { ok: !conflict, status: conflict ? 409 : 200, json: async () => ({ ...payload, revision: 'new-revision' }) } },
    weekPlan: { days: [{ date: '2026-09-07' }] }, selectedDayIndexRef: { current: 0 },
    applySavedWorkoutSessionToWeek: saved => { applied = saved }, exerciseHistoryCacheRef: { current: new Map() },
    console: { warn() {} },
  }
  await new Function(...Object.keys(env), js + '; return handleCopyLastWeek()')(...Object.values(env))
  assert.equal(env.copyingLastWeekRef.current, false)
  return { payload, applied, dates, alerts }
}
;(async () => {
  const copy = await run()
  assert.deepEqual(copy.dates, ['2026-08-31', '2026-09-07'])
  assert.equal(copy.payload.base_revision, 'destination-revision')
  assert.deepEqual(copy.payload.workout.set_logs, {})
  assert.deepEqual(copy.payload.workout.exercises, [exercise])
  assert.equal(copy.payload.auto_fill_suppressed_at, null)
  assert.equal(copy.applied.revision, 'new-revision')
  for (const options of [{ logged: true }, { missing: true }]) assert.equal((await run(options)).payload, undefined)
  const stale = await run({ conflict: true })
  assert.equal(stale.applied, undefined)
  assert.equal(stale.alerts.length, 1)
  console.log('copy last week smoke passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
