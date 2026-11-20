const assert = require('node:assert/strict')
const { callback, source } = require('./workout_write_harness.cjs')
const fs = require('node:fs')
const path = require('node:path')
async function test() {
  const state = {}
  let result = { candidates: [] }
  const env = {
    useCallback: fn => fn, canQuerySavedWorkoutSessions: true, coachCanEditPrograms: true,
    isBackendHealthy: true, selectedDay: { date: 'today' }, todayId: 'today',
    coachActAsOwnerId: null, currentUserId: 'owner', coachActAsLinkId: null,
    workoutIdByOwnerDateRef: { current: { 'owner:today': 'workout' } },
    swapRequestRef: { current: null }, swapExerciseIdRef: { current: null }, swapResponseRef: { current: null },
    getPrivyAuthHeaders: async () => ({}), API_BASE_URL: '', coachChatEnabled: true,
    handleCloseSwap: () => assert.fail('picker must not disappear'),
    handleCoachSend: () => assert.fail('opening Similar must not send a coach message'),
    fetchSwapCandidates: async () => { if (result instanceof Error) throw result; return result },
    SwapCandidatesError: Error, swapErrorKey: () => 'swapOutsideBlueprint', t: key => key,
    overlayFitScores: original => original,
  }
  for (const key of ['SwapOpen','SwapLoading','SwapError','SwapCandidates','SwapFitLoading','SwappingCandidateId'])
    env[`set${key}`] = value => { state[key] = value }
  const open = callback('handleOpenSwap', 'handleSelectSwapCandidate', env)
  await open('selected-item')
  assert.equal(state.SwapOpen, true)
  assert.deepEqual(state.SwapCandidates, [])
  assert.equal(state.SwapLoading, false)
  assert.equal(env.swapExerciseIdRef.current, 'selected-item')
  result = new Error('missing slot')
  await open('other-item')
  assert.equal(state.SwapOpen, true)
  assert.equal(state.SwapError, 'workout.swapOutsideBlueprint')
  assert.equal(env.swapExerciseIdRef.current, 'other-item')
  result = { workout_id: 'workout', exercise_instance_id: 'other-item', workout_revision: 'r2', blueprint_revision: 'b3', candidates: [{ candidate_id: 'choice' }] }
  await open('other-item')
  assert.equal(state.SwapError, null)
  assert.equal(env.swapResponseRef.current.exercise_instance_id, 'other-item')
  const view = fs.readFileSync(path.join(__dirname, '../src/views/WorkoutView.tsx'), 'utf8')
  assert.ok(view.includes('className="exercise-similar-toggle"'))
  assert.ok(view.indexOf('<SwapCandidateSheet') > view.indexOf('<div className="detail-content">'))
  assert.ok(view.indexOf('<SwapCandidateSheet') < view.indexOf('<div className="detail-footer">'))
  assert.ok(view.includes('onAskCoach={coachChatEnabled ?'))
  assert.match(source, /exercises\/\$\{response.exercise_instance_id\}\/swap/)
  assert.match(source, /expected_revision: response.workout_revision/)
  const ts = require('typescript')
  const React = require('react')
  const exports = {}
  new Function('require', 'exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/workout/SwapCandidateSheet.tsx'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText)(id => {
    if (id === 'react') return { ...React, useEffect: () => {} }
    if (id === 'react/jsx-runtime') return require(id)
    if (id === '../../i18n') return { useI18n: () => ({ t: key => key }) }
    if (id === './ExerciseFitRating') return { default: () => null }
    throw Error(id)
  }, exports)
  const nodes = tree => !tree ? [] : Array.isArray(tree) ? tree.flatMap(nodes)
    : React.isValidElement(tree) ? [tree, ...nodes(tree.props.children)] : []
  let selected, closed = false, coached = false
  const props = { open: true, inline: true, loading: false, fitLoading: false, swappingId: null, error: null,
    exerciseName: 'Bike', candidates: [{ candidate_id: 'choice', name: 'Row' }],
    onSelect: c => { selected = c.candidate_id }, onClose: () => { closed = true }, onAskCoach: () => { coached = true } }
  let tree = nodes(exports.default(props))
  assert.ok(!tree.some(n => n.props.className === 'exercise-history-backdrop'))
  assert.ok(tree.some(n => n.props.id === 'exercise-similar-options'))
  tree.find(n => n.props.className === 'exercise-history-row').props.onClick()
  assert.equal(selected, 'choice')
  tree.find(n => n.type === 'button' && n.props['aria-label'] === 'common.close').props.onClick()
  assert.equal(closed, true)
  tree = nodes(exports.default({ ...props, swappingId: 'choice' }))
  assert.equal(tree.find(n => n.props.className === 'exercise-history-row').props.disabled, true)
  tree = nodes(exports.default({ ...props, candidates: [] }))
  tree.find(n => n.type === 'button' && n.props.children === 'workout.askCoach').props.onClick()
  assert.equal(coached, true)
  assert.equal(exports.default({ ...props, open: false }), null)
  console.log('Similar picker smoke passed: visible item control, empty/error retained, retry, explicit coach, scoped API')
}
test().catch(error => { console.error(error); process.exitCode = 1 })
