// Exercise the real refresh callback with a delayed server response. A read
// started before a successful drag/log must not replace its receipt revision.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const start = source.indexOf('  const fetchWorkoutSessionsByDates = useCallback(')
const end = source.indexOf('  const applySavedWorkoutSessionsToWeek = useCallback(', start)
const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 })
const date = '2026-09-23'
const key = `owner:${date}`
const workout = revision => ({ date, revision, workout_id: 'workout', updated_at: '2026-09-25T10:00:00Z' })
function fixture(initialRevision = 'before-drag') {
  let respond
  const response = new Promise(resolve => { respond = resolve })
  const env = {
    useCallback: fn => fn, currentUserId: 'owner', coachActAsOwnerId: null,
    coachActAsLinkIdRef: { current: null }, canQuerySavedWorkoutSessions: true,
    privyAuthenticated: true, privyReady: true, getPrivyAuthHeaders: async () => ({}),
    API_BASE_URL: '', withCoachActAs: url => url, apiFetch: () => response,
    backendWorkoutToSession: row => ({ ...row, session_id: row.workout_id }),
    workoutIdByOwnerDateRef: { current: { [key]: 'workout' } },
    workoutRevisionByOwnerDateRef: { current: { [key]: initialRevision } },
    clearedWorkoutAtRef: { current: {} },
  }
  const fetch = new Function(...Object.keys(env), `${code}; return fetchWorkoutSessionsByDates`)(...Object.values(env))
  return { env, fetch, respond: rows => respond({ ok: true, json: async () => rows }) }
}
async function main() {
  for (const receiptRevision of ['after-drag', 'after-log', 'newer-refresh']) {
    const f = fixture()
    const pending = f.fetch([date])
    await Promise.resolve()
    // A mutation receipt (or a newer GET) wins while this GET is in flight.
    f.env.workoutRevisionByOwnerDateRef.current[key] = receiptRevision
    f.respond([workout('before-drag')])
    assert.deepEqual(await pending, [], 'a delayed read cannot roll back saved order or actuals')
    assert.equal(f.env.workoutRevisionByOwnerDateRef.current[key], receiptRevision,
      'the next save must use the acknowledged revision, never the delayed read')
  }
  const fresh = fixture()
  const pending = fresh.fetch([date])
  fresh.respond([workout('external-edit')])
  assert.equal((await pending)[0].revision, 'external-edit', 'an uncontested refresh accepts external edits')
  assert.equal(fresh.env.workoutRevisionByOwnerDateRef.current[key], 'external-edit')

  const conflict = fixture(undefined)
  delete conflict.env.workoutRevisionByOwnerDateRef.current[key]
  const recovery = conflict.fetch([date])
  conflict.respond([workout('server-head')])
  assert.equal((await recovery)[0].revision, 'server-head', '409 recovery repopulates the invalidated revision')
  console.log('workout refresh race smoke passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
