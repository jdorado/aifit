// Plan-edit contract smoke. Asserts the browser plan-editing handlers address
// the five canonical routes from docs/plan-edit-contract.md, send the shared
// mutation envelope, apply structural receipts through the existing
// session-apply path (without wiping typed-but-unlogged inputs), and handle
// `workout: null` exactly like clear. Source-level, in the style of
// workout_timeline_contract.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const readSource = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8')

const appSource = readSource('src', 'App.tsx')
const setListSource = readSource('src', 'components', 'workout', 'ExerciseSetList.tsx')
const planListSource = readSource('src', 'components', 'workout', 'WorkoutPlanList.tsx')
const stringsSource = readSource('src', 'i18n', 'strings.ts')
const adapterSource = readSource('src', 'utils', 'backendWorkoutAdapter.ts')
const testWorkoutSource = readSource('src', 'data', 'testWorkout.ts')

const has = (haystack, needle, message) => assert.ok(haystack.includes(needle), `${message} (missing: ${needle})`)

// 1. The five canonical edit routes.
has(appSource, '/exercises/${encodeURIComponent(exerciseId)}/sets', 'add set must call the canonical add-set route')
has(appSource, '/sets/${encodeURIComponent(setId)}/remove', 'remove set must call the canonical remove-set route')
has(appSource, '/sets/${encodeURIComponent(setId)}/target', 'target edit must call the canonical target route')
has(appSource, '/exercises/${encodeURIComponent(exerciseId)}/remove', 'remove exercise must call the canonical remove route')
has(appSource, '/segments/${encodeURIComponent(segmentId)}/remove', 'remove segment must call the canonical segment route')

// 2. Shared mutation envelope: expected revision + fresh request id.
has(appSource, 'expected_revision: context.revision', 'mutations must send the current revision')
has(appSource, 'expected_revision: expectedRevision', 'set logging must send the post-target-edit revision')
has(appSource, 'request_id: crypto.randomUUID()', 'mutations must send a fresh request id')

// 3. Target editing: full target, propagation, no day replacement.
has(appSource, 'apply_to_remaining: true', 'target edit must propagate to remaining pending sets')
has(appSource, 'applyTargetEditToSets(exercise, stateList, index, field, value)', 'target edit must update the local target optimistically')
has(appSource, 'restoreTargetEditSnapshot', 'failed target edit must restore the previous targets')
has(appSource, 'pendingTargetEditsRef', 'logging must await an in-flight target edit for the same set')

// 4. Structural receipts: apply via the session path, preserve unlogged inputs,
//    and handle `workout: null` the same way clear does.
has(appSource, 'backendWorkoutToSession(receipt.workout, currentUserId)', 'structural receipts must convert the public workout')
has(appSource, 'applySavedWorkoutSessionsToWeek([session], { preserveSelectedDate: true, preserveActiveEntry: true })', 'structural receipts must apply without replacing the day')
has(appSource, 'mergeUnloggedSetInputs(targetDate, session)', 'structural receipts must preserve typed-but-unlogged inputs')
has(appSource, 'autoFillSuppressedAt: clearedWorkoutAtRef.current[targetDate]', 'a null workout must empty the day like clear')

// 5. 409 stale_revision reconciles and surfaces a message.
has(appSource, "window.alert(t('workout.editStale'))", 'a stale revision must surface a message')
has(appSource, 'response.status === 409', 'mutations must recognise stale_revision')

// 6. Gating: editable date + edit-program permission.
has(appSource, 'canEditPlanSelectedDay', 'plan editing must be gated by an editable-date flag')
has(appSource, 'isPlanEditableDate(selectedDay?.date ?? todayId) && coachCanEditPrograms', 'plan editing must share the generation date rule and edit permission')

// 7. Segment identity is carried through the adapter for section removal.
has(adapterSource, 'segmentId: segment.segment_id', 'the adapter must expose the canonical segment id')
has(testWorkoutSource, 'segmentId?: string', 'the exercise type must carry an optional segment id')
has(adapterSource, 'workout?: BackendWorkout | null', 'the receipt type must allow a null workout')

// 8. Component wiring: add set, remove set, target commit, swipe-hidden plan
//    delete actions (legacy mobile UX: no always-visible trash at load).
has(setListSource, 'add-set-btn', 'the set list must render the add-set button')
has(setListSource, 'data-set-action="remove-set"', 'unlogged set rows must render a remove-set trash action')
has(setListSource, 'onCommitSetTarget', 'the set inputs must commit target edits on blur')
has(planListSource, 'plan-row-actions', 'plan rows must hide delete actions behind swipe')
has(planListSource, 'workout-stage-actions', 'section headers must hide remove-section behind swipe')
has(planListSource, 'circuit-preview-actions', 'circuit preview items must hide remove-exercise behind swipe')
has(planListSource, 'planSwipeActiveId', 'plan delete actions must only show for the swiped row')
assert.ok(!planListSource.includes('plan-trash-btn'), 'plan rows must not render always-visible trash buttons')
assert.ok(!planListSource.includes('stage-trash-btn'), 'section headers must not render always-visible trash buttons')
assert.ok(!planListSource.includes('circuit-preview-delete'), 'circuit preview items must not render always-visible trash buttons')
has(planListSource, 'window.confirm(t(\'workout.removeExerciseConfirm\'', 'exercise removal must confirm')
has(planListSource, 'window.confirm(t(\'workout.removeCircuitConfirm\'', 'circuit removal must confirm')
has(planListSource, 'window.confirm(t(\'workout.removeSectionConfirm\'', 'section removal must confirm')

// 9. The circuit-key fix must stay intact.
has(planListSource, 'key={`circuit-row-${groupKey}`}', 'the circuit-key fix must remain')

// 10. Strings present in both languages.
for (const key of [
  'addSet',
  'removeSet',
  'deleteAction',
  'removeExercise',
  'removeExerciseConfirm',
  'removeCircuit',
  'removeCircuitConfirm',
  'removeSection',
  'removeSectionConfirm',
  'editFailed',
  'editStale',
]) {
  const matches = stringsSource.match(new RegExp(`\\b${key}:`, 'g')) || []
  assert.equal(matches.length, 2, `${key} must exist in both en and es`)
}
has(stringsSource, "'Add set'", 'en add-set copy')
has(stringsSource, "'Agregar serie'", 'es add-set copy')
has(stringsSource, "'Remove set'", 'en remove-set copy')
has(stringsSource, "'Quitar serie'", 'es remove-set copy')

console.log('plan edit contract passed')
