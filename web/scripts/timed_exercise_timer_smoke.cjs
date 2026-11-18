// Canonical backend duration targets must expose the existing work timer.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const load = (filename) => {
  const exports = {}
  const source = fs.readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText
  new Function('require', 'exports', compiled)(
    id => load(path.resolve(path.dirname(filename), `${id}.ts`)), exports,
  )
  return exports
}
const { backendWorkoutToSession } = load(path.join(__dirname, '../src/utils/backendWorkoutAdapter.ts'))
const { parseDurationToSeconds } = load(path.join(__dirname, '../src/utils/workoutDisplay.ts'))
const item = (id, target) => ({
  exercise_instance_id: id, slot_id: id, candidate_id: id, order: 1,
  exercise_snapshot: {
    exercise_id: id, exercise_revision: 'r1', name: id,
    movement_pattern: 'conditioning', primary_muscles: [], secondary_muscles: [],
    equipment_kind: 'machine', laterality: 'bilateral', load_basis: 'bodyweight',
  },
  sets: [{ set_id: `${id}-1`, target }],
})
const session = backendWorkoutToSession({
  workout_id: 'test', revision: 'r1', date: '2026-11-18', timezone: 'UTC',
  status: 'planned', title: 'Timed work', created_at: '', updated_at: '',
  segments: [{
    segment_id: 'main', order: 1, kind: 'interval', rounds: 1,
    rest_after_round_seconds: 45,
    items: [
      item('Assault bike', { duration_seconds: { min: 60, max: 60 } }),
      item('Plank', { duration_seconds: { min: 30, max: 45 } }),
      item('Squat', { reps: { min: 8, max: 12 } }),
    ],
  }],
}, 'fixture-user')
const [bike, plank, squat] = session.workout.exercises
assert.equal(bike.metric, 'time')
assert.equal(bike.timer?.enabled, true, 'Assault bike work timer must be enabled')
assert.equal(parseDurationToSeconds(bike.sets[0].targetTime), 60)
assert.equal(bike.restSec, 45, 'rest remains separate from the work duration')
assert.equal(plank.timer?.enabled, true, 'other duration-based exercises also get a timer')
assert.equal(parseDurationToSeconds(plank.sets[0].targetTime), 45)
assert.equal(squat.metric, 'reps')
assert.equal(squat.timer?.enabled, undefined, 'rep-based exercises must not get a work timer')
console.log('Timed exercise timer smoke passed')
