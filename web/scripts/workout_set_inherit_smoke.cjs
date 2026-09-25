// Set-value inheritance smoke. Executes the real updateSetField block from
// App.tsx and the real canonical adapter, and proves the legacy behavior: the
// next unlogged set inherits the value the user logged instead of falling
// back to the suggested target — both while typing (draft propagation) and
// when the canonical record is read back (a logged set carries into the
// following unlogged sets). Editing a logged set (the compact row editor) must
// stay local, and logged sets must never be rewritten.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const appSource = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const start = appSource.indexOf('  const updateSetField = useCallback(')
assert.ok(start >= 0, 'App.tsx must define updateSetField')
const end = appSource.indexOf('\n  const addMessage = useCallback(', start)
assert.ok(end > start, 'the updateSetField block must end before addMessage')
const block = appSource.slice(start, end)
const js = ts.transpile(block, { target: ts.ScriptTarget.ES2020 })

const stateList = [
  { weight: '', metric: '', done: false },
  { weight: '', metric: '', done: false },
  { weight: '35', metric: '8', done: true },
  { weight: '', metric: '', done: false },
]
const exercise = { id: 'goblet_squat', metric: 'reps', sets: [{}, {}, {}, {}] }
const env = {
  useCallback: (fn) => fn,
  canLogSelectedDay: true,
  getExercise: () => exercise,
  ensureExerciseStateList: () => stateList,
  bumpData: () => undefined,
}
const updateSetField = new Function(...Object.keys(env), js + '; return updateSetField')(...Object.values(env))

// The hero input propagates: the next set inherits the weight that will be logged.
updateSetField('goblet_squat', 0, 'weight', '40', true)
assert.equal(stateList[0].weight, '40', 'the edited set keeps the typed value')
assert.equal(stateList[1].weight, '40', 'the next unlogged set inherits the typed weight')
assert.equal(stateList[1].value_source, 'user_entered', 'an inherited weight is user-entered, not an accepted target')
assert.equal(stateList[2].weight, '35', 'logged sets stay immutable')
assert.equal(stateList[3].weight, '40', 'every remaining unlogged set inherits the value')

updateSetField('goblet_squat', 0, 'metric', '12', true)
assert.equal(stateList[1].metric, '12', 'the next unlogged set inherits the typed reps')
assert.equal(stateList[2].metric, '8', 'logged reps stay immutable')

// Editing a logged set (the compact row editor) must not touch other sets.
updateSetField('goblet_squat', 2, 'weight', '45', false)
assert.equal(stateList[1].weight, '40', 'a logged-set edit stays local')
assert.equal(stateList[3].weight, '40', 'a logged-set edit never propagates')

// The hero wiring must ask for propagation; the logged-set editor must not.
const setListSource = fs.readFileSync(path.join(__dirname, '../src/components/workout/ExerciseSetList.tsx'), 'utf8')
assert.ok(
  setListSource.includes("onUpdateSetField(exercise.id, index, 'metric', event.target.value, true)")
    && setListSource.includes("onUpdateSetField(exercise.id, index, 'weight', event.target.value, true)"),
  'the next-set hero inputs must propagate typed values to remaining sets',
)
assert.ok(
  !setListSource.includes("onUpdateSetField(exercise.id, index, 'metric', event.target.value, false)")
    && !setListSource.includes("onUpdateSetField(exercise.id, index, 'weight', event.target.value, false)"),
  'the logged-set editor must not request propagation',
)

// The canonical read must carry the last logged actual into the following
// unlogged sets, so reopening a workout shows the value the user logged
// (74kg round 1) instead of the plan target (65kg round 2).
const adapterSource = fs.readFileSync(path.join(__dirname, '../src/utils/backendWorkoutAdapter.ts'), 'utf8')
const adapterCompiled = ts.transpileModule(adapterSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
}).outputText

const adapterExports = {}
const adapterRequire = (id) => {
  if (id === './workoutSafety') {
    return { normalizeEquipmentType: (value) => value, normalizeMuscleGroup: (value) => value }
  }
  throw new Error(`unexpected import in backendWorkoutAdapter: ${id}`)
}
new Function('require', 'exports', 'module', adapterCompiled)(adapterRequire, adapterExports, { exports: adapterExports })
const { backendWorkoutToSession } = adapterExports

const target = () => ({ reps: { min: 8, max: 10 }, load: { value: 65, unit: 'kg' } })
const workoutSet = (setId, actual) => ({ set_id: setId, kind: 'work', target: target(), actual: actual ?? null, round: 1 })
const workout = {
  workout_id: 'wrk_1',
  revision: 'rev_1',
  date: '2026-09-22',
  timezone: 'Asia/Dubai',
  status: 'in_progress',
  title: 'Upper A',
  segments: [{
    segment_id: 'seg_1',
    order: 1,
    kind: 'straight_sets',
    title: 'Arms',
    rounds: 1,
    rest_after_round_seconds: 60,
    items: [{
      exercise_instance_id: 'wex_1',
      slot_id: 'slot_1',
      candidate_id: 'cand_1',
      order: 1,
      exercise_snapshot: {
        exercise_id: 'ex_curl',
        exercise_revision: 'rev_x',
        name: 'Biceps Curl Machine',
        movement_pattern: 'elbow_flexion',
        primary_muscles: ['biceps'],
        secondary_muscles: [],
        equipment_kind: 'machine',
        laterality: 'bilateral',
        load_basis: 'machine_stack',
      },
      sets: [
        workoutSet('s1', { status: 'completed', reps: 6, load: { value: 74, unit: 'kg' }, completed_at: '2026-09-22T13:50:29Z' }),
        workoutSet('s2'),
        workoutSet('s3'),
        workoutSet('s4', { status: 'completed', reps: 8, load: { value: 60, unit: 'kg' }, completed_at: '2026-09-22T13:55:00Z' }),
        workoutSet('s5'),
        workoutSet('s6', { status: 'skipped' }),
        workoutSet('s7'),
      ],
      cues_md: '',
    }],
  }],
  created_at: '2026-09-22T13:00:00Z',
  updated_at: '2026-09-22T13:55:00Z',
}

const session = backendWorkoutToSession(workout, 'user_1')
const states = session.workout.set_logs.wex_1
assert.deepEqual(
  states[0],
  { weight: '74kg', metric: '6', done: true, value_source: 'user_entered' },
  'a logged set keeps its canonical actual',
)
assert.equal(states[1].weight, '74kg', 'the next unlogged set inherits the logged weight')
assert.equal(states[1].metric, '6', 'the next unlogged set inherits the logged reps')
assert.equal(states[1].done, false, 'an inherited set is still unlogged')
assert.equal(states[1].value_source, 'accepted_target', 'an inherited value is a carried draft, not fresh input')
assert.equal(states[2].weight, '74kg', 'the carry continues through consecutive unlogged sets')
assert.equal(states[3].weight, '60kg', 'a later logged set becomes the new carried value')
assert.equal(states[4].weight, '60kg', 'the carry follows the latest logged set')
assert.equal(states[5].done, true, 'a skipped set stays logged')
assert.equal(states[6].weight, '60kg', 'a skipped set does not clear the carried value')

const roundWorkout = structuredClone(workout)
roundWorkout.segments[0].kind = 'circuit'
roundWorkout.segments[0].items[0].sets = [
  { ...workoutSet('warmup'), kind: 'warmup' },
  { ...workoutSet('replacement-round-3'), round: 3 },
]
const roundSets = backendWorkoutToSession(roundWorkout, 'user_1').workout.exercises[0].sets
assert.equal(roundSets[0].isWarmup, true, 'canonical warmups stay outside working rounds')
assert.equal(roundSets[1].round, 3, 'a replacement keeps its actual round instead of its array position')

console.log('workout set inherit smoke passed')
