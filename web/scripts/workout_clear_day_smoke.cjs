// Clear-day merge smoke. Executes the real applyWeekPlan and
// applySavedWorkoutSessionsToWeek bodies from App.tsx and proves the
// post-clear refresh cannot rebuild the cleared day from a stale click-time
// weekPlan closure.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const slice = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `missing ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.ok(end >= 0, `missing ${endMarker}`)
  return ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2020 })
}
const applyWeekPlanBlock = slice('  const applyWeekPlan = useCallback(', '  const handleSelectDay =')
const mergeBlock = slice(
  '  const applySavedWorkoutSessionsToWeek = useCallback(',
  '  const applySavedWorkoutSessionToWeek = useCallback(',
)

const CLEARED_DATE = '2026-09-22'
const OTHER_DATE = '2026-09-21'

const day = (dateId, exercises) => ({
  date: dateId,
  label: dateId,
  exercises,
  extras: [],
  isRest: exercises.length === 0,
  planNotes: '',
  notes: '',
})

const generatedPlan = {
  weekStart: OTHER_DATE,
  days: [
    day(OTHER_DATE, []),
    day(CLEARED_DATE, [{ id: 'press', sets: [{}, {}] }, { id: 'row', sets: [{}, {}] }]),
  ],
}

let state = { plan: generatedPlan, selectedIndex: 1, logs: {}, activeEntry: { id: null, type: null } }
const applyCalls = []
const weekPlanRef = { current: generatedPlan }
const env = {
  useCallback: (fn) => fn,
  useEffect() {},
  // State still carries the click-time plan; the ref carries the plan the
  // clear has just applied, exactly like the real handler sequence.
  weekPlan: generatedPlan,
  weekPlanRef,
  weekSetLogsRef: { current: {} },
  selectedDayIndexRef: { current: 1 },
  activeEntryRef: { current: state.activeEntry },
  coachActAsOwnerId: null,
  currentUserId: 'user_1',
  pendingWorkoutDatesRef: { current: new Set([CLEARED_DATE]) },
  canHydrateSavedWorkoutAfterClear: () => true,
  normalizeDateId: (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : null),
  normalizeWorkoutExercises: (value) => (Array.isArray(value) ? value : []),
  normalizeWorkoutExtras: (value) => (Array.isArray(value) ? value : []),
  updateExerciseSummary() {},
  findDayIndexByDate: (days, date) => days.findIndex((item) => item.date === date),
  parseDateId: (value) => (value ? new Date(`${value}T00:00:00`) : null),
  getDateId: (value) => value.toISOString().slice(0, 10),
  getWeekStartDate: () => new Date(`${OTHER_DATE}T00:00:00`),
  buildWeekDates: () => [],
  getWeekdayLabel: () => 'day',
  hasWorkoutContent: (exercises, extras) => exercises.length > 0 || extras.length > 0,
  buildSetLogsForExercises: (exercises) => Object.fromEntries(
    exercises.map((exercise) => [exercise.id, exercise.sets.map(() => ({ done: false }))])
  ),
  workoutIdByOwnerDateRef: { current: {} },
  workoutRevisionByOwnerDateRef: { current: {} },
  sessionHydrationInProgressRef: { current: false },
  profile: { language: 'en' },
  selectedDay: { date: CLEARED_DATE },
  todayId: CLEARED_DATE,
  weekStartDayIndex: 1,
  syncDayRefs(plan, index) { state.selectedIndex = index },
  hideWorkoutDetail() { state.activeEntry = { id: null, type: null } },
  bumpData() {},
  setSelectedDayIndex(index) { state.selectedIndex = index },
  setWeekPlan(plan) { state.plan = plan; applyCalls.push(plan) },
}

const run = new Function(
  ...Object.keys(env),
  applyWeekPlanBlock + '\n' + mergeBlock + '\n; return { applyWeekPlan, applySavedWorkoutSessionsToWeek }',
)(...Object.values(env))

// 1. Generate/apply the canonical day (the user saw it).
run.applyWeekPlan(generatedPlan, { selectedDate: CLEARED_DATE })
assert.equal(weekPlanRef.current.days.find((d) => d.date === CLEARED_DATE).exercises.length, 2)

// 2. Clear: the handler replaces the day with the empty cleared day and the
// ref advances immediately, while the click-time closure still sees the old plan.
const clearedDay = {
  ...day(CLEARED_DATE, []),
  autoFillSuppressedAt: '2026-09-22T11:47:37.197321Z',
}
run.applyWeekPlan(
  {
    weekStart: weekPlanRef.current.weekStart,
    days: weekPlanRef.current.days.map((item) => (item.date === CLEARED_DATE ? clearedDay : item)),
  },
  { selectedDate: CLEARED_DATE },
)
assert.equal(state.plan.days.find((d) => d.date === CLEARED_DATE).exercises.length, 0, 'clear must empty the day')

// 3. The clear handler then refreshes visible sessions; another day resolves
// with a canonical workout and must merge in without restoring the cleared day.
const session = {
  date: OTHER_DATE,
  updated_at: '2026-09-21T13:44:03.737000Z',
  revision: 'rev_other',
  session_id: 'wrk_other',
  workout: { exercises: [{ id: 'row', sets: [{}, {}] }], extras: [], set_logs: {} },
}
const merged = run.applySavedWorkoutSessionsToWeek([session])
assert.equal(merged, true, 'the refresh must apply the other visible day')
const clearedDayAfter = state.plan.days.find((item) => item.date === CLEARED_DATE)
assert.ok(clearedDayAfter, 'the cleared day must stay in the week')
assert.equal(clearedDayAfter.exercises.length, 0, 'the cleared day must stay empty after the refresh merge')
assert.equal(clearedDayAfter.extras.length, 0, 'the cleared day must keep no extras after the refresh merge')
const otherDay = state.plan.days.find((item) => item.date === OTHER_DATE)
assert.equal(otherDay.exercises.length, 1, 'the fetched day must still merge in')

console.log('clear-day merge smoke passed')
