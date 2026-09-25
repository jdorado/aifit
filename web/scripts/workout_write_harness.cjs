const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const callback = (name, next, env) => {
  const start = source.indexOf(`  const ${name} = useCallback(`)
  const end = source.indexOf(`\n  const ${next} =`, start)
  if (start < 0 || end < 0) throw new Error(`Missing callback ${name}`)
  return new Function(...Object.keys(env), ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 }) + `; return ${name}`)(...Object.values(env))
}
const load = filename => {
  const exports = {}
  new Function('exports', ts.transpile(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
  }))(exports)
  return exports
}
const { WorkoutWriteQueue } = load('utils/workoutWriteQueue.ts')
const tick = () => new Promise(resolve => setImmediate(resolve))
function harness(overrides = {}) {
  const h = { requests: [], refreshes: [], errors: [], pending: false, applied: [] }
  const env = {
    useCallback: fn => fn, bumpData() {},
    workoutWriteQueueRef: { current: new WorkoutWriteQueue() },
    workoutWriteScopeRef: { current: 'owner:' },
    workoutRevisionByOwnerDateRef: { current: { 'owner:today': 'r1' } },
    pendingSetSyncsByDateRef: { current: {} }, pendingWorkoutDatesRef: { current: new Set() },
    setWorkoutSavePending: value => { h.pending = value },
    setWorkoutSaveError: value => { h.errors.push(value) },
    withCoachActAs: url => url, API_BASE_URL: 'https://fixture.invalid',
    getPrivyAuthHeaders: async () => ({}), crypto: require('node:crypto').webcrypto,
    console: { warn() {} },
    apiFetch: (url, init) => new Promise((resolve, reject) => {
      h.requests.push({ url, ...init, body: JSON.parse(init.body), resolve, reject })
    }),
    fetchWorkoutSessionsByDates: async dates => { h.refreshes.push(dates); return [] },
    applySavedWorkoutSessionsToWeek: (sessions, options) => { h.applied.push({ sessions, options }) },
    ...overrides,
  }
  h.env = env
  h.enqueue = callback('enqueueWorkoutWrite', 'syncLoggedSet', env)
  h.reply = async (index, status = 200, receipt = { revision: `r${index + 2}` }) => {
    await tick()
    h.requests[index].resolve({ ok: status === 200, status, json: async () => receipt })
    await tick()
  }
  return h
}
module.exports = { source, callback, load, harness, tick }
