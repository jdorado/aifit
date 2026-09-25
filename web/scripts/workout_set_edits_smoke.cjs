// Exercise the real handlers with a held server response: a row must change
// before persistence, then reconcile or roll back without a full-week fetch.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const block = (from, to) => source.slice(source.indexOf(`  const ${from} =`), source.indexOf(`  const ${to} =`))
const handlers = block('mergeUnloggedSetInputs', 'applyStructuralReceipt')
  + block('mutateWorkout', 'handleRemoveExercise')
const compiled = ts.transpile(handlers, { target: ts.ScriptTarget.ES2020 })
const context = { targetDate: '2026-09-25', ownerKey: 'owner:2026-09-25', workoutId: 'wrk_one', revision: 'rev_one' }

function harness() {
  const sets = [{ setId: 's1', targetReps: '10', targetWeight: '40kg' }, { setId: 's2', targetReps: '8', targetWeight: '50kg' }]
  const exercise = { id: 'ex_one', sets, summary: '' }
  const states = [{ weight: '41kg', metric: '11', done: false }, { weight: '52kg', metric: '9', done: false }]
  const pending = new Set()
  const h = { exercise, states, pending, calls: [], refreshes: 0, alerts: [], busy: false, applied: [], paints: 0 }
  const env = {
    useCallback: fn => fn,
    canEditPlanSelectedDay: true, canQuerySavedWorkoutSessions: true, isBackendHealthy: true,
    selectedDay: { date: context.targetDate }, todayId: context.targetDate, coachActAsOwnerId: null, currentUserId: 'owner',
    workoutIdByOwnerDateRef: { current: { [context.ownerKey]: context.workoutId } },
    workoutRevisionByOwnerDateRef: { current: { [context.ownerKey]: context.revision } },
    weekPlanRef: { current: { days: [{ date: context.targetDate, exercises: [exercise] }] } },
    weekSetLogsRef: { current: { [context.targetDate]: { [exercise.id]: states } } },
    setLogsRef: { current: { [exercise.id]: states } },
    pendingWorkoutDatesRef: { current: pending },
    setStructuralEditPending: value => { h.busy = value },
    getPrivyAuthHeaders: async () => ({}), withCoachActAs: value => value, API_BASE_URL: 'https://example.test',
    apiFetch: (url, options) => {
      h.calls.push({ url, ...options, body: JSON.parse(options.body) })
      return new Promise((resolve, reject) => { h.respond = resolve; h.reject = reject })
    },
    refreshVisibleWorkoutSessions: async () => {
      assert.equal(pending.has(context.targetDate), false, 'conflict readback must be allowed to apply')
      assert.equal(exercise.sets.length, 2, 'rollback precedes conflict readback')
      h.refreshes++
      return true
    },
    applyStructuralReceipt: receipt => { h.applied.push(receipt) },
    getExercise: () => exercise, bumpData: () => { h.paints++ },
    updateExerciseSummary: value => { value.summary = `${value.sets.length} sets` },
    setEditingSet() {}, setEditingSetSnapshot() {}, resetHoldTimer() {},
    t: value => value, window: { alert: value => h.alerts.push(value) },
    console: { warn() {} }, crypto: require('node:crypto').webcrypto,
  }
  Object.assign(h, new Function(...Object.keys(env), `${compiled}; return { handleAddSet, handleRemoveSet, mergeUnloggedSetInputs }`)(...Object.values(env)))
  h.reply = async (status = 200) => {
    // Auth acquisition yields once before the request is sent.
    await Promise.resolve()
    h.respond({ status, ok: status === 200, json: async () => status === 200 ? { revision: 'rev_two', workout: {} } : { detail: 'Save failed' } })
  }
  return h
}

async function main() {
  let h = harness()
  let task = h.handleAddSet('ex_one')
  assert.equal(h.exercise.sets.length, 3, 'add paints before auth/network completes')
  assert.equal(h.states[2].done, false, 'adding never records a completed/skipped set')
  assert.equal(h.exercise.sets[2].setId, undefined, 'a preview cannot reuse a canonical set ID')
  assert.equal(h.exercise.sets[2].targetWeight, '50kg')
  assert.equal(h.busy, true, 'dependent controls wait for the new canonical ID')
  await h.handleAddSet('ex_one')
  assert.equal(h.exercise.sets.length, 3, 'a pending add cannot duplicate the preview')
  await h.reply()
  await task
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0].url, /\/exercises\/ex_one\/sets$/)
  assert.equal(h.refreshes, 0, 'receipt avoids a redundant full-week refresh')
  assert.equal(h.applied.length, 1)
  assert.equal(h.busy, false)

  for (const action of ['handleAddSet', 'handleRemoveSet']) {
    h = harness()
    const before = JSON.stringify([h.exercise.sets, h.states])
    task = h[action]('ex_one', 0)
    await h.reply(500)
    await task
    assert.equal(JSON.stringify([h.exercise.sets, h.states]), before, 'failed save restores sets and draft values')
    assert.equal(h.alerts.length, 1)
    assert.equal(h.busy, false)
    assert.equal(h.pending.size, 0)
  }

  h = harness()
  task = h.handleRemoveSet('ex_one', 0)
  assert.deepEqual(h.exercise.sets.map(set => set.setId), ['s2'], 'delete removes immediately')
  assert.equal(h.states[0].weight, '52kg', 'surviving drafts follow their set')
  assert.equal(h.states.some(set => set.skipped || set.done), false, 'delete must never log skipped')
  await h.reply()
  await task
  assert.match(h.calls[0].url, /\/sets\/s1\/remove$/)
  assert.equal(h.calls[0].body.actual, undefined)
  assert.equal(h.refreshes, 0)

  h = harness()
  task = h.handleRemoveSet('ex_one', 0)
  await h.reply(409)
  await task
  assert.equal(h.refreshes, 1, 'stale revision performs one readback after rollback')
  assert.equal(h.applied.length, 0)
  assert.equal(h.alerts[0], 'workout.editStale')

  h = harness()
  h.states[0].done = true
  await h.handleRemoveSet('ex_one', 0)
  assert.equal(h.exercise.sets.length, 2, 'logged history must be undone before removing')
  assert.equal(h.calls.length, 0)

  h = harness()
  const session = { workout: { exercises: [{ id: 'ex_one', sets: [{ setId: 's2' }, { setId: 'new' }] }], set_logs: { ex_one: [{ weight: '', metric: '', done: false }, { weight: '', metric: '', done: false }] } } }
  h.mergeUnloggedSetInputs(context.targetDate, session)
  assert.equal(session.workout.set_logs.ex_one[0].weight, '52kg', 'receipt merge matches identity after removals')
  assert.equal(session.workout.set_logs.ex_one[1].weight, '', 'a new set cannot inherit an unrelated draft by index')

  const setList = fs.readFileSync(path.join(__dirname, '../src/components/workout/ExerciseSetList.tsx'), 'utf8')
  assert.equal(setList.includes('onSkipSet'), false)
  assert.equal((setList.match(/data-set-action="remove-set"/g) || []).length, 2, 'hero and swipe both remove')
  assert.ok(source.includes('canLogDay={canLogSelectedDay && !structuralEditPending}'), 'cannot log an unsaved preview')
  const view = fs.readFileSync(path.join(__dirname, '../src/views/WorkoutView.tsx'), 'utf8')
  assert.equal(view.includes("t('workout.skipped')"), false, 'removing the final set must not label the exercise skipped')
  console.log('workout set edits smoke passed: immediate add/remove, failures, conflict readback, identity, UI wiring')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
