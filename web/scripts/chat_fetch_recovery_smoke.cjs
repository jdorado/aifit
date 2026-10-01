// Exercise the actual chat callback: losing a response must not lose or
// duplicate a coach's blueprint update, or silently cross trainee scopes.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const start = source.indexOf('  const fetchChatJobResult = useCallback(')
const end = source.indexOf('  const fetchWorkoutSessionsByDates = useCallback(', start)
const code = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 })
const payload = {
  user_id: 'coach', request_id: 'same-admission', message: 'Update the golf items',
  act_as_link_id: 'trainee-link', reference_date: '2026-09-28',
}
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
function fixture(steps) {
  const calls = [], waits = [], deadlines = new Map()
  let token = 0, timer = 0
  const env = {
    useCallback: fn => fn, API_BASE_URL: 'https://app.test', CHAT_JOB_POLL_MS: 2500,
    getPrivyAuthHeaders: async () => ({ Authorization: `Bearer fresh-${++token}` }),
    readApiError: (body, status) => new Error(body?.detail || `HTTP ${status}`),
    window: {
      setTimeout: (fn, ms) => {
        if (ms === 45000) { deadlines.set(++timer, fn); return timer }
        waits.push(ms); queueMicrotask(fn); return ++timer
      },
      clearTimeout: id => deadlines.delete(id),
    },
    apiFetch: async (url, init) => {
      calls.push({ url, ...init })
      assert.ok(steps.length, 'unexpected extra network request')
      const step = steps.shift()
      if (step === 'timeout') {
        for (const abort of deadlines.values()) abort()
        assert.equal(init.signal.aborted, true)
        throw new DOMException('Timed out', 'AbortError')
      }
      if (step instanceof Error) throw step
      return step
    },
  }
  const run = new Function(...Object.keys(env), `${code}; return fetchChatJobResult`)(...Object.values(env))
  return { run, calls, waits, deadlines }
}
async function main() {
  const sendPrefix = '  const handleSend = useCallback('
  const sendStart = source.indexOf(sendPrefix) + sendPrefix.length
  const sendEnd = source.indexOf('  }, [', sendStart)
  const sendCode = ts.transpile(`const handleSend = ${source.slice(sendStart, sendEnd)} };`, { target: ts.ScriptTarget.ES2020 })
  for (const link of [null, 'ale-link']) {
    let complete, admissions = 0
    const wait = new Promise(resolve => { complete = resolve })
    const pendingMainChatScopesRef = { current: new Set() }
    const env = {
      chatInput: '', coachChatEnabled: true, coachActAsLinkId: link,
      coachActAsOwnerId: link, currentUserId: 'owner', pendingMainChatScopesRef,
      setChatInput: () => {}, addMessage: async () => {}, addCoachMessage: async () => {},
      addThinkingMessage: () => 'thinking', addCoachThinkingMessage: () => 'thinking',
      selectedDay: { date: '2026-10-01' }, todayId: '2026-10-01',
      workoutRevisionByOwnerDateRef: { current: {} }, crypto: require('node:crypto'),
      selectedModelLabel: 'Luna', updateCoachMessage: async () => {},
      refreshVisibleWorkoutSessions: async () => {}, removeCoachMessage: () => {},
      removeMessage: () => {}, t: value => value,
      fetchChatReply: async () => { admissions++; await wait },
      fetchChatJobResult: async () => { admissions++; await wait; return { reply: 'Saved' } },
    }
    const send = new Function(...Object.keys(env), `${sendCode}; return handleSend`)(...Object.values(env))
    const first = send('Generate Thursday')
    await send('Generate Thursday')
    assert.equal(admissions, 1, 'repeated taps cannot queue duplicate owner or trainee requests')
    complete()
    await first
    assert.equal(pendingMainChatScopesRef.current.size, 0, 'completion releases the admission guard')
    await send('Next request')
    assert.equal(admissions, 2, 'a completed request does not block the next turn')
  }
  const queued = response({ job_id: 'existing-run', status: 'running' })
  const completed = response({ job_id: 'existing-run', status: 'complete', reply: 'Saved' })
  const brokenBody = { ...queued, json: async () => { throw new TypeError('Failed to fetch') } }
  const f = fixture([
    brokenBody, queued, // Admission happened, but its response was lost.
    new TypeError('Failed to fetch'), response({}, 503), 'timeout', brokenBody,
    queued, completed,
  ])
  assert.equal((await f.run(payload)).reply, 'Saved')
  const posts = f.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 2)
  assert.equal(posts[0].body, posts[1].body, 'admission retries retain the exact request ID and content')
  assert.deepEqual(JSON.parse(posts[1].body), payload)
  for (const call of f.calls.slice(2)) {
    const url = new URL(call.url)
    assert.equal(url.pathname, '/chat/jobs/existing-run', 'poll failure never enqueues a new run')
    assert.equal(url.searchParams.get('act_as_link_id'), payload.act_as_link_id)
    assert.equal(url.searchParams.get('user_id'), payload.user_id)
  }
  assert.equal(new Set(f.calls.map(call => call.headers.Authorization)).size, f.calls.length,
    'every retry refreshes auth, including after a long outage')
  assert.ok(f.waits.includes(10000), 'outages back off')
  assert.ok(f.waits.every(ms => ms <= 10000))
  assert.equal(f.deadlines.size, 0, 'successful and failed requests both clear their request timers')

  for (const status of [401, 403, 404, 409, 422]) {
    const terminal = fixture([queued, response({ detail: `Denied ${status}` }, status)])
    await assert.rejects(terminal.run(payload), new RegExp(`Denied ${status}`))
    assert.equal(terminal.calls.length, 2, 'permission, scope and validation errors must not retry')
  }
  for (const status of ['failed', 'cancelled']) {
    for (const steps of [[response({ job_id: 'existing-run', status, error: 'Agent failed' })],
      [queued, response({ job_id: 'existing-run', status, error: 'Agent failed' })]]) {
      await assert.rejects(fixture(steps).run(payload), /Agent failed|cancelled/)
    }
  }
  const unavailable = fixture([response({}, 404)])
  await assert.rejects(unavailable.run(payload), /Async chat endpoint unavailable/)
  const long = fixture([...Array.from({ length: 210 }, () => queued), completed])
  assert.equal((await long.run(payload)).reply, 'Saved')
  assert.ok(long.waits.reduce((sum, ms) => sum + ms, 0) > 8 * 60 * 1000,
    'long agent work has no overall timeout')
  console.log('chat fetch recovery smoke passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
