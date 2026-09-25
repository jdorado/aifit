const assert = require('node:assert/strict')
const { callback, harness, tick } = require('./workout_write_harness.cjs')

async function main() {
  let h = harness()
  const first = h.enqueue('workout', 'today', 'owner:today', '/sets/a/target', 'PATCH', { target: { reps: 12 } }, () => {})
  const second = h.enqueue('workout', 'today', 'owner:today', '/sets/a', 'PATCH', { actual: { reps: 12 } }, () => {})
  const third = h.enqueue('workout', 'today', 'owner:today', '/sets/b', 'PATCH', { actual: { reps: 8 } }, () => {})
  assert.equal(h.pending, true)
  await tick()
  assert.equal(h.requests.length, 1, 'target, log and next circuit move are sent serially')
  assert.equal(h.requests[0].body.expected_revision, 'r1')
  await h.reply(0)
  assert.equal(h.requests[1].body.expected_revision, 'r2')
  assert.equal(h.env.pendingWorkoutDatesRef.current.has('today'), true, 'queued logs remain protected from hydration')
  await h.reply(1)
  assert.equal(h.requests[2].body.expected_revision, 'r3')
  await h.reply(2)
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true])
  assert.equal(new Set(h.requests.map(request => request.body.request_id)).size, 3)
  assert.equal(h.pending, false)
  assert.equal(h.env.pendingWorkoutDatesRef.current.size, 0)
  assert.equal(h.refreshes.length, 0, 'successful logging needs no full-week refresh')

  // Execute real log/undo callbacks on the same set before any response.
  h = harness()
  const state = { done: true, metric: '10', weight: '30kg' }
  const env = {
    ...h.env, canQuerySavedWorkoutSessions: true, coachActAsOwnerId: null,
    currentUserId: 'owner', selectedDay: { date: 'today' }, todayId: 'today',
    workoutIdByOwnerDateRef: { current: { 'owner:today': 'workout' } },
    setLogsRef: { current: { a: [state] } }, getExercise: () => ({ sets: [{ setId: 'a1' }] }),
    parseActualLoad: value => ({ value: parseFloat(value), unit: 'kg' }),
    parseActualMetric: (_exercise, value) => ({ reps: Number(value) }),
    enqueueWorkoutWrite: h.enqueue,
  }
  const sync = callback('syncLoggedSet', 'completeTimedExercise', env)
  // unlogLoggedSet is followed by an effect; extract only its declaration.
  const undo = callback('unlogLoggedSet', 'unlogSet', { ...env, useEffect() {}, syncLoggedSetRef: { current: null }, syncLoggedSet: sync })
  const logging = sync('a', 0)
  const prior = { ...state }
  state.done = false
  state.metric = ''
  const undoing = undo('a', 0, prior)
  state.done = true
  state.metric = '15'
  const relogging = sync('a', 0)
  await tick()
  assert.equal(h.requests[0].body.actual.reps, 10, 'queued actual is a tap-time snapshot')
  await h.reply(0)
  assert.match(h.requests[1].url, /\/unlog$/)
  await h.reply(1)
  assert.equal(h.requests[2].body.actual.reps, 15, 'relogging is never skipped as already synced')
  await h.reply(2)
  await Promise.all([logging, undoing, relogging])

  const original = { done: true, metric: '10', weight: '' }
  env.setLogsRef.current = { a: [original] }
  const originalSave = sync('a', 0)
  const otherDay = { done: true, metric: '20', weight: '' }
  env.setLogsRef.current = { a: [otherDay] }
  await h.reply(3, 500)
  assert.equal(await originalSave, false)
  assert.equal(original.done, false, 'failure rolls back the originating day')
  assert.equal(otherDay.done, true, 'failure cannot change the day opened while saving')

  h = harness()
  h.env.workoutRevisionByOwnerDateRef.current['owner:tomorrow'] = 'r9'
  const todaySave = h.enqueue('workout', 'today', 'owner:today', '/sets/a', 'PATCH', {}, () => {})
  const tomorrowSave = h.enqueue('workout2', 'tomorrow', 'owner:tomorrow', '/sets/b', 'PATCH', {}, () => {})
  await tick()
  assert.equal(h.requests.length, 2, 'a slow workout cannot block another day')
  await h.reply(1)
  assert.equal(h.env.pendingWorkoutDatesRef.current.has('today'), true)
  assert.equal(h.env.pendingWorkoutDatesRef.current.has('tomorrow'), false)
  await h.reply(0)
  await Promise.all([todaySave, tomorrowSave])

  for (const failure of [409, 500, 'network']) {
    h = harness()
    const rollback = []
    const a = h.enqueue('workout', 'today', 'owner:today', '/sets/a', 'PATCH', {}, () => rollback.push('a'))
    const b = h.enqueue('workout', 'today', 'owner:today', '/sets/b', 'PATCH', {}, () => rollback.push('b'))
    const c = h.enqueue('workout', 'today', 'owner:today', '/sets/c', 'PATCH', {}, () => rollback.push('c'))
    await tick()
    if (failure === 'network') h.requests[0].reject(new Error('offline'))
    else await h.reply(0, failure)
    assert.deepEqual(await Promise.all([a, b, c]), [false, false, false])
    assert.deepEqual(rollback, ['c', 'b', 'a'], 'rollback unwinds dependent optimistic edits in reverse order')
    assert.equal(h.requests.length, 1, 'dependent writes are cancelled after a failure')
    assert.deepEqual(h.refreshes, [['today']], 'one canonical readback of the originating day')
    assert.equal(h.errors.length, 1, 'failure is visible without alerting on each queued set')
    assert.equal(h.pending, false)
    assert.equal(h.env.pendingWorkoutDatesRef.current.size, 0)
  }

  h = harness()
  let reverted = false
  const ownerWrite = h.enqueue('workout', 'today', 'owner:today', '/sets/a', 'PATCH', {}, () => { reverted = true })
  h.env.workoutWriteScopeRef.current = 'owner:trainee'
  assert.equal(await ownerWrite, false, 'switching owner cancels unsent writes')
  assert.equal(h.requests.length, 0, 'old queued work cannot execute under the new trainee')
  assert.equal(reverted, true)
  assert.equal(h.errors.length, 0, 'another owner must not receive this error')
  assert.equal(h.refreshes.length, 0, 'another owner must not receive this workout')
  console.log('workout async writes smoke passed: serial revisions, target/log/undo ordering, snapshots, failure rollback, owner isolation')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
