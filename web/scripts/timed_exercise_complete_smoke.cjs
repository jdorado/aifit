const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const start = source.indexOf('  const completeTimedExercise = useCallback(')
const end = source.indexOf('\n  const unlogLoggedSet = useCallback(', start)
assert.ok(start >= 0 && end > start)
const callback = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 })

const run = async (failAt = -1) => {
  const states = [
    { weight: '', metric: '', done: true },
    { weight: '', metric: '', done: false },
    { weight: '', metric: '', done: false },
  ]
  const exercise = {
    id: 'assault-bike', metric: 'time', status: 'planned',
    sets: [{ targetTime: '30s' }, { targetTime: '1m' }, { targetTime: '90s' }],
  }
  const calls = []
  let inFlight = false
  const ref = { current: false }
  const env = {
    useCallback: (fn) => fn,
    canLogSelectedDay: true,
    completingTimedExerciseRef: ref,
    setCompletingTimedExerciseId: () => {},
    resetHoldTimer: () => {},
    getExercise: () => exercise,
    ensureExerciseStateList: () => states,
    parseDurationToSeconds: (value) => value === '1m' ? 60 : Number.parseInt(value, 10),
    normalizeWorkoutTargetText: (value) => value || '',
    bumpData: () => {},
    syncLoggedSet: async (_id, index) => {
      assert.equal(inFlight, false, 'writes must be serial for workout revisions')
      inFlight = true
      await Promise.resolve()
      calls.push(index)
      inFlight = false
      if (index === failAt) {
        states[index].done = false
        return false
      }
      return true
    },
  }
  const completeTimedExercise = new Function(...Object.keys(env), callback + '; return completeTimedExercise')(...Object.values(env))
  await completeTimedExercise(exercise.id)
  assert.equal(ref.current, false)
  assert.equal(states[0].metric, '', 'existing completed set stays untouched')
  assert.deepEqual(calls, failAt === -1 ? [1, 2] : [1])
  assert.equal(states[1].metric, '60s')
  assert.equal(states[2].done, failAt === -1)
  if (failAt === -1) assert.equal(states[2].metric, '90s')
}

Promise.resolve().then(() => run()).then(() => run(1)).then(() => {
  console.log('timed exercise completion smoke passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
