// A delayed advisory score must never replace the prescription or revision
// the user is selecting. Exercise the actual picker loaders with held ratings.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const read = file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
const transpile = source => ts.transpile(source, { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS })
const fitExports = {}
new Function('exports', transpile(read('utils/exerciseFit.ts')))(fitExports)
const { overlayFitScores } = fitExports
const fit = score => ({ score, tentative: false, factors: { day: score, recovery: score, progress: score } })
const base = {
  workout_id: 'workout', workout_revision: 'revision', blueprint_id: 'plan', blueprint_revision: 'plan-revision',
  candidates: [
    { candidate_id: 'a', exercise_id: 'a', target_summary: '8 reps' },
    { candidate_id: 'b', exercise_id: 'b', target_summary: '6 reps' },
  ],
}
const rated = { ...base, candidates: base.candidates.map((candidate, i) => ({ ...candidate, fit: fit(60 + i * 20) })) }
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(kind) {
  let resolveRating, rejectRating, cleanup
  const heldRating = new Promise((resolve, reject) => { resolveRating = resolve; rejectRating = reject })
  const state = {}, calls = []
  const controller = { current: null }
  const load = async (rankFit = false, signal) => {
    calls.push({ rankFit, signal })
    return rankFit ? heldRating : base
  }
  const env = {
    overlayFitScores, t: key => key, requestRef: controller, loadRef: { current: load }, busyRef: { current: false }, loadAttempt: 0,
    useEffect: fn => { cleanup = fn() }, useCallback: fn => fn,
    setLoading: value => { state.loading = value }, setFitLoading: value => { state.fitLoading = value },
    setError: value => { state.error = value }, setRepertoire: value => { state.candidates = value.candidates },
    canQuerySavedWorkoutSessions: true, coachCanEditPrograms: true, isBackendHealthy: true,
    selectedDay: { date: 'today' }, todayId: 'today', currentUserId: 'owner', coachActAsOwnerId: null,
    workoutIdByOwnerDateRef: { current: { 'owner:today': 'workout' } }, swapRequestRef: controller,
    swapExerciseIdRef: { current: null }, swapResponseRef: { current: null },
    getPrivyAuthHeaders: async () => ({}), API_BASE_URL: '', coachActAsLinkId: null, coachChatEnabled: false,
    handleCloseSwap: () => controller.current?.abort(), handleCoachSend: () => assert.fail('optional scoring must not start coaching'),
    setSwapOpen: () => {}, setSwappingCandidateId: () => {},
    setSwapCandidates: value => { state.candidates = value },
    fetchSwapCandidates: options => load(options.rankFit, options.signal),
    SwapCandidatesError: Error, needsCoachSwap: () => false, swapErrorKey: () => 'failed',
  }
  env.setSwapLoading = env.setLoading
  env.setSwapFitLoading = env.setFitLoading
  env.setSwapError = env.setError
  let source, expression
  if (kind === 'add') {
    source = read('components/workout/AddExerciseSheet.tsx')
    source = source.slice(source.indexOf('  useEffect(() => {\n    const controller'), source.indexOf('  const add = async'))
    expression = 'undefined'
  } else {
    source = read('App.tsx')
    source = source.slice(source.indexOf('  const handleOpenSwap = useCallback('), source.indexOf('  const handleSelectSwapCandidate = useCallback('))
    expression = 'handleOpenSwap("instance")'
  }
  const started = new Function(...Object.keys(env), `${transpile(source)}; return ${expression}`)(...Object.values(env))
  return { state, calls, resolveRating, rejectRating, started, cancel: () => kind === 'add' ? cleanup() : env.handleCloseSwap() }
}

async function main() {
  const decorated = overlayFitScores(base, { ...rated, candidates: rated.candidates.map(c => ({ ...c, target_summary: 'incorrect replacement' })) })
  assert.deepEqual(decorated.map(c => [c.exercise_id, c.target_summary]), [['b', '6 reps'], ['a', '8 reps']])
  for (const key of ['workout_id', 'workout_revision', 'blueprint_id', 'blueprint_revision', 'exercise_instance_id']) {
    assert.equal(overlayFitScores(base, { ...rated, [key]: 'changed' }), null, `ignore changed ${key}`)
  }
  assert.equal(overlayFitScores(base, { ...rated, candidates: [rated.candidates[0]] }), null)
  assert.equal(overlayFitScores(base, { ...rated, candidates: rated.candidates.map(c => ({ ...c, exercise_id: 'other' })) }), null)
  const scoped = { ...base, candidates: base.candidates.map((c, i) => ({ ...c, candidate_id: 'reused', exercise_id: 'same', day_id: `day${i}`, slot_id: `slot${i}` })) }
  assert.equal(overlayFitScores(scoped, scoped).length, 2, 'candidate IDs may repeat across days or slots')

  for (const kind of ['add', 'swap']) {
    for (const outcome of ['success', 'failure', 'stale', 'closed']) {
      const f = fixture(kind)
      await f.started
      await tick()
      assert.deepEqual(f.calls.map(c => c.rankFit), [false, true])
      assert.deepEqual(f.state.candidates, base.candidates, `${kind}: choices render while rating is held`)
      assert.equal(f.state.loading, false)
      assert.equal(f.state.fitLoading, true)
      if (outcome === 'closed') {
        f.cancel()
        assert.equal(f.calls[1].signal.aborted, true)
      }
      if (outcome === 'failure') f.rejectRating(new Error('provider unavailable'))
      else f.resolveRating(outcome === 'stale' ? { ...rated, workout_revision: 'new revision' } : rated)
      await tick()
      assert.deepEqual(f.state.candidates, outcome === 'success' ? overlayFitScores(base, rated) : base.candidates)
      assert.equal(f.state.error, null, 'optional ranking cannot block the picker')
      if (outcome !== 'closed') assert.equal(f.state.fitLoading, false)
      f.cancel()
    }
  }
  console.log('exercise fit race smoke passed: immediate choices, optional/stale/aborted scoring, preserved prescriptions')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
