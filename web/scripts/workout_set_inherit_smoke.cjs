// Set-value inheritance smoke. Executes the real updateSetField block from
// App.tsx and proves the legacy behavior: a typed value in the next-set hero
// propagates to the remaining unlogged sets, so the following set inherits the
// value the user logged instead of falling back to the suggested target.
// Editing a logged set (the compact row editor) must stay local, and logged
// sets must never be rewritten.
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

console.log('workout set inherit smoke passed')
