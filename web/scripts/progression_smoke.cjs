const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const transpile = source => ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS })
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const start = source.indexOf('  const syncLoggedSet = useCallback(')
const end = source.indexOf('  const completeTimedExercise = useCallback(', start)
assert.ok(start >= 0 && end > start)
const set = { weight: '40kg', metric: '12', rpe: 8, done: true }
const calls = []
const revisions = { 'owner:2026-09-25': 'rev_1' }
const env = {
  useCallback: fn => fn, setLogsRef: { current: { ex_one: [set] } }, bumpData() {},
  canQuerySavedWorkoutSessions: true, coachActAsOwnerId: null, currentUserId: 'owner',
  selectedDay: { date: '2026-09-25' }, todayId: '2026-09-25',
  workoutIdByOwnerDateRef: { current: { 'owner:2026-09-25': 'wrk_one' } },
  workoutRevisionByOwnerDateRef: { current: revisions },
  getExercise: () => ({ sets: [{ setId: 'set_one' }] }),
  parseActualLoad: () => ({ value: 40, unit: 'kg' }), parseActualMetric: () => ({ reps: 12 }),
  enqueueWorkoutWrite: async (_workoutId, _date, ownerKey, _path, _method, body) => {
    calls.push({ ...body, expected_revision: revisions[ownerKey] })
    revisions[ownerKey] = `rev_${calls.length + 1}`
    return true
  },
}
const sync = new Function(...Object.keys(env), transpile(source.slice(start, end)) + '; return syncLoggedSet')(...Object.values(env))
const previewExports = {}
new Function('exports', transpile(fs.readFileSync(path.join(__dirname, '../src/utils/progression.ts'), 'utf8')))(previewExports)
const summary = { prescribed_load: { value: 40, unit: 'kg' }, policy: { load_range: [{ value: 40, unit: 'kg' }, { value: 44, unit: 'kg' }] } }
assert.equal(previewExports.previewLoad('40kg', summary), 'atTarget')
assert.equal(previewExports.previewLoad('42', summary), 'aboveTarget')
assert.equal(previewExports.previewLoad('38kg', summary), 'belowTarget')
assert.equal(previewExports.previewLoad('100lb', summary), 'outsidePlan')
assert.equal(previewExports.previewLoad('blue', summary), null)

async function run() {
  assert.equal(await sync('ex_one', 0), true)
  assert.equal(calls[0].actual.rpe, 8)
  set.rpe = 9
  await sync('ex_one', 0)
  assert.equal(calls.length, 2, 'editing only effort must persist a new actual')
  assert.equal(calls[1].expected_revision, 'rev_2')
  set.rpe = undefined
  await sync('ex_one', 0)
  assert.equal('rpe' in calls[2].actual, false, 'clearing effort stays unknown')
  set.skipped = true
  await sync('ex_one', 0)
  assert.deepEqual(calls[3].actual, { status: 'skipped' })
  console.log('progression and effort persistence smoke passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
