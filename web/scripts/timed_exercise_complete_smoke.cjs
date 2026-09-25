const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const { load } = require('./workout_write_harness.cjs')
const { WorkoutWriteQueue } = load('utils/workoutWriteQueue.ts')

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
  const queue = new WorkoutWriteQueue()
  let release
  const held = new Promise(resolve => { release = resolve })
  let inFlight = false
  const ref = { current: false }
  const env = {
    useCallback: (fn) => fn,
    canLogSelectedDay: true,
    logPendingRef: ref,
    setLogPending: () => {},
    setCompletingTimedExerciseId: () => {},
    resetHoldTimer: () => {},
    stopRest: () => {},
    getExercise: () => exercise,
    ensureExerciseStateList: () => states,
    parseDurationToSeconds: (value) => value === '1m' ? 60 : Number.parseInt(value, 10),
    normalizeWorkoutTargetText: (value) => value || '',
    bumpData: () => {},
    syncLoggedSet: (_id, index, previous) => queue.enqueue('workout', {
      run: async () => {
        assert.equal(inFlight, false, 'writes must be serial for workout revisions')
        inFlight = true
        await held
        calls.push(index)
        inFlight = false
        if (index === failAt) throw new Error('offline')
      },
      rollback: () => Object.assign(states[index], previous),
      onError() {},
    }),
  }
  const completeTimedExercise = new Function(...Object.keys(env), callback + '; return completeTimedExercise')(...Object.values(env))
  const saving = completeTimedExercise(exercise.id)
  assert.equal(states[1].done, true, 'quick completion paints all remaining sets before persistence')
  assert.equal(states[2].done, true)
  release()
  await saving
  assert.equal(ref.current, false)
  assert.equal(states[0].metric, '', 'existing completed set stays untouched')
  assert.deepEqual(calls, failAt === -1 ? [1, 2] : [1])
  assert.equal(states[1].metric, failAt === -1 ? '60s' : '', 'failure restores the previous input')
  assert.equal(states[2].done, failAt === -1)
  if (failAt === -1) assert.equal(states[2].metric, '90s')
}

Promise.resolve().then(() => run()).then(() => run(1)).then(() => {
  console.log('timed exercise completion smoke passed')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
