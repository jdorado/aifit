const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const callback = (name, end, env) => {
  const start = source.indexOf(`  const ${name} = useCallback(`)
  assert.ok(start >= 0, `${name} exists`)
  const block = source.slice(start, source.indexOf(`\n  const ${end} =`, start))
  return new Function(...Object.keys(env), ts.transpile(block, { target: ts.ScriptTarget.ES2020 }) + `; return ${name}`)(...Object.values(env))
}
const loadUtility = () => {
  const filename = path.join(__dirname, '../src/utils/circuitProgress.ts')
  if (!fs.existsSync(filename)) return {}
  const exports = {}
  new Function('exports', ts.transpile(fs.readFileSync(filename, 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  }))(exports)
  return exports
}
const utility = loadUtility()
const fixture = (progress, selected = 'a', options = {}) => {
  const exercises = Object.entries(progress).map(([id, states], order) => ({
    id, metric: 'reps', restSec: 60,
    circuit: { name: 'Circuit', key: 'segment', order, rounds: 3, restAfterSec: 60 },
    sets: states.map((_, index) => ({ setId: `${id}-${index}`, targetReps: '10' })),
  }))
  const logs = Object.fromEntries(Object.entries(progress).map(([id, states]) => [id, states.map(done => ({ weight: '', metric: '', done }))]))
  const navigation = { current: { id: selected, type: 'exercise' } }
  const result = { rests: [], saves: [], closed: false }
  const env = {
    ...utility, useCallback: fn => fn, canLogSelectedDay: true,
    activeEntryId: selected, activeEntryType: 'exercise', activeEntryRef: navigation,
    currentWorkoutSessionIdRef: { current: 'today' },
    logPendingRef: { current: false }, setLogPending() {},
    setLogsRef: { current: logs }, restDefaultSec: 90,
    setEditingSet() {}, setEditingSetSnapshot() {}, resetHoldTimer() {}, stopRest() {}, bumpData() {},
    normalizeWorkoutTargetText: value => value, normalizeWeightLabel: value => value, normalizeRepValue: value => value,
    getExercise: id => exercises.find(exercise => exercise.id === id),
    ensureExerciseStateList: exercise => logs[exercise.id],
    getCircuitItems: () => exercises.map(exercise => ({ exercise })),
    circuitGroupKey: circuit => circuit?.key,
    showWorkoutDetail(id, type) { navigation.current = { id, type } },
    hideWorkoutDetail() { result.closed = true; navigation.current = { id: null, type: null } },
    startRest(seconds) { result.rests.push(seconds) },
    syncLoggedSetRef: { current: async (id, index) => {
      result.saves.push([id, index])
      return options.save ? options.save() : true
    } },
  }
  env.getNextPendingCircuitExercise = callback('getNextPendingCircuitExercise', 'releaseWakeLock', env)
  const log = callback('logNextSet', 'logHoldTimerSet', env)
  return { log, env, exercises, logs, navigation, result }
}

async function main() {
  // A was finished manually, then B completes the first round. Resume B,
  // never jump back to the fully completed A just because it is listed first.
  const uneven = fixture({ a: [true, true], b: [false, false], c: [true, false] }, 'b')
  await uneven.log('b')
  assert.equal(uneven.navigation.current.id, 'b', 'next round starts at the first unfinished exercise')
  assert.deepEqual(uneven.result.rests, [60], 'one rest between completed rounds')

  const short = fixture({ a: [true], b: [true, false], c: [true] }, 'b')
  await short.log('b')
  assert.equal(short.result.closed, true, 'actual sets, not stale circuit.rounds, determine completion')

  const normal = fixture({ a: [false, false], b: [false, false] })
  await normal.log('a')
  assert.equal(normal.navigation.current.id, 'b')
  assert.deepEqual(normal.result.rests, [])
  await normal.log('b')
  assert.equal(normal.navigation.current.id, 'a')
  assert.deepEqual(normal.result.rests, [60])
  await normal.log('a')
  await normal.log('b')
  assert.equal(normal.result.closed, true)
  assert.equal(normal.result.rests.length, 1, 'no rest after completing the circuit')

  let finish
  const delayed = fixture({ a: [false, false], b: [false, false] }, 'a', {
    save: () => new Promise(resolve => { finish = resolve }),
  })
  const saving = delayed.log('a')
  await delayed.log('a')
  assert.equal(delayed.result.saves.length, 1, 'double tap cannot log a second set while saving')
  delayed.env.showWorkoutDetail('b', 'exercise')
  delayed.env.showWorkoutDetail('a', 'exercise')
  finish(true)
  await saving
  assert.equal(delayed.navigation.current.id, 'a', 'a late save cannot override manual navigation, even away and back')
  assert.deepEqual(delayed.result.rests, [])

  const failed = fixture({ a: [false], b: [false] }, 'a', { save: async () => false })
  await failed.log('a')
  assert.equal(failed.navigation.current.id, 'a', 'failed save must not advance')
  assert.deepEqual(failed.result.rests, [])
  assert.equal(failed.env.logPendingRef.current, false)

  const manual = fixture({ a: [false, false], b: [true, false], c: [false, false] }, 'b')
  await manual.log('b')
  assert.equal(manual.navigation.current.id, 'c', 'manual ahead-of-round logging returns to pending work after the selected move')
  assert.deepEqual(manual.result.rests, [], 'logging ahead cannot start a round rest')

  const replacement = fixture({ a: [true], b: [true, false], c: [false] }, 'b')
  replacement.exercises[2].sets[0].round = 2
  await replacement.log('b')
  assert.equal(replacement.navigation.current.id, 'c', 'a swapped exercise keeps its canonical round despite having fewer sets')
  assert.deepEqual(replacement.result.rests, [])

  const noRest = fixture({ a: [false, false], b: [true, false] })
  noRest.exercises[0].circuit.restAfterSec = 0
  await noRest.log('a')
  assert.deepEqual(noRest.result.rests, [], 'explicit zero rest is honored')

  // Execute the real rest-completion effect. A minimized timer must not
  // start a different timed exercise just because it is now on screen.
  const effectStart = source.indexOf('  useEffect(() => {\n    if (restState.active && restState.endTs)')
  const effectEnd = source.indexOf('\n\n  useEffect', effectStart)
  const effect = ts.transpile(source.slice(effectStart, effectEnd), { target: ts.ScriptTarget.ES2020 })
  const entry = { id: 'a', type: 'exercise' }
  const timer = {
    useEffect: fn => fn(), restState: { active: true, endTs: 1, remainingSec: 0, autoStartNextSet: true },
    restEntryRef: { current: entry }, activeEntryRef: { current: entry },
    document: { visibilityState: 'visible' }, completeRest() {},
    autoStartNextHoldSet() { timer.starts++ }, starts: 0,
  }
  const finishRest = () => new Function(...Object.keys(timer), effect)(...Object.values(timer))
  finishRest()
  assert.equal(timer.starts, 1, 'unchanged navigation keeps normal auto-start')
  timer.activeEntryRef.current = { id: 'b', type: 'exercise' }
  finishRest()
  assert.equal(timer.starts, 1, 'manual navigation cancels rest auto-start')
  timer.activeEntryRef.current = { id: 'a', type: 'exercise' }
  finishRest()
  assert.equal(timer.starts, 1, 'away and back does not resurrect auto-start')
  timer.activeEntryRef.current = entry
  timer.document.visibilityState = 'hidden'
  finishRest()
  assert.equal(timer.starts, 1, 'background completion cannot auto-start a hold')

  let holdLogs = 0
  const holdEnv = {
    ...normal.env, holdTimer: { exerciseId: 'a', setIndex: 0, totalSec: 30, remainingSec: 0 },
    getTimedSideCount: () => 1, startHoldTimer() {}, stopHoldTimer() {},
    logNextSet() { holdLogs++ }, sideTransitionPrepSec: 5,
  }
  normal.env.showWorkoutDetail('a', 'exercise')
  const logHold = callback('logHoldTimerSet', 'updateSetField', holdEnv)
  logHold()
  assert.equal(holdLogs, 0, 'timer completion cannot log another set after its set was skipped or already logged')

  // The canonical sync reports success/failure to navigation and rolls back
  // the original set, even after the user selects a different day.
  const original = { done: true, weight: '', metric: '10' }
  let respond
  const syncEnv = {
    useCallback: fn => fn, canQuerySavedWorkoutSessions: true, coachActAsOwnerId: null,
    currentUserId: 'owner', selectedDay: { date: 'today' }, todayId: 'today',
    workoutIdByOwnerDateRef: { current: { 'owner:today': 'workout' } },
    workoutRevisionByOwnerDateRef: { current: { 'owner:today': 'rev1' } },
    setLogsRef: { current: { a: [original] } }, getExercise: () => ({ sets: [{ setId: 'set1' }] }),
    parseActualLoad: () => null, parseActualMetric: () => ({ reps: 10 }),
    syncedSetKeysRef: { current: new Map() }, pendingTargetEditsRef: { current: new Map() },
    pendingSetSyncsByDateRef: { current: {} }, pendingWorkoutDatesRef: { current: new Set() },
    getPrivyAuthHeaders: async () => ({}), API_BASE_URL: 'https://fixture.invalid', withCoachActAs: url => url,
    apiFetch: () => new Promise(resolve => { respond = resolve }), crypto: { randomUUID: () => 'request1' },
    refreshVisibleWorkoutSessions: async () => false, bumpData() {}, console: { warn() {} },
  }
  const sync = callback('syncLoggedSet', 'completeTimedExercise', syncEnv)
  const failure = sync('a', 0)
  await Promise.resolve()
  const differentDay = { done: true, metric: '12' }
  syncEnv.setLogsRef.current = { a: [differentDay] }
  respond({ ok: false, status: 500 })
  assert.equal(await failure, false)
  assert.equal(original.done, false, 'failed write rolls back the originating day')
  assert.equal(differentDay.done, true, 'failed write does not change the newly selected day')
  assert.equal(syncEnv.pendingWorkoutDatesRef.current.size, 0)

  original.done = true
  syncEnv.setLogsRef.current = { a: [original] }
  const success = sync('a', 0)
  await Promise.resolve()
  respond({ ok: true, status: 200, json: async () => ({ revision: 'rev2' }) })
  assert.equal(await success, true)
  assert.equal(syncEnv.workoutRevisionByOwnerDateRef.current['owner:today'], 'rev2')
  console.log('workout circuit progress smoke passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
