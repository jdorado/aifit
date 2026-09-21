const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const readSource = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8')

const appSource = readSource('src', 'App.tsx')
const menuSource = readSource('src', 'components', 'workout', 'WorkoutOverflowMenu.tsx')
const stringsSource = readSource('src', 'i18n', 'strings.ts')

const forbiddenTimelinePaths = [
  'applyPastedWorkoutText',
  'handleWorkoutMenuPaste',
  'handleCopyCurrentWorkout',
  'copyWorkoutSessionToDate',
  'parseWorkoutJSON',
]

for (const pathName of forbiddenTimelinePaths) {
  assert.equal(appSource.includes(pathName), false, `${pathName} must not return to the workout timeline`)
}

for (const propName of [
  'onCopyWorkout',
  'onCopyDayInstructions',
  'onPasteWorkout',
  'copyLastWeekAvailable',
  'pastePending',
]) {
  assert.equal(menuSource.includes(propName), false, `${propName} must not return to the workout menu`)
}

for (const translationKey of [
  'copyWorkoutAction',
  'copyDayInstructions',
  'pasteAction',
]) {
  assert.equal(stringsSource.includes(translationKey), false, `${translationKey} must not return to workout copy/paste UI`)
}

assert.match(appSource, /handleGenerateDayWorkout/, 'timeline generation must remain available')
assert.match(menuSource, /onGenerateWorkout/, 'workout menu must keep the generated-workout action')
assert.match(appSource, /\/v1\/workouts\/generate/, 'recommended and Jev generation must use the typed canonical endpoint')
assert.doesNotMatch(appSource, /workout-sessions|coach_links|exercise-history|exercise-decisions|search_videos/, 'removed legacy routes must not return to the public frontend')
assert.match(appSource, /handleVaryDayWorkout/, 'Jev day variation must remain available')
assert.match(menuSource, /onVaryWorkout/, 'workout menu must keep the Jev variation action')

console.log('workout timeline contract passed')
