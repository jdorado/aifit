const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const start = source.indexOf('  const applyWeekPlan = useCallback(')
const block = source.slice(start, source.indexOf('  const handleSelectDay =', start))
const js = ts.transpile(block, { target: ts.ScriptTarget.ES2020 })
let memo, deps, closes = 0, selectedId = null
const env = {
  useCallback(fn, nextDeps) {
    if (!deps || nextDeps.some((value, index) => value !== deps[index])) memo = fn
    deps = nextDeps
    return memo
  },
  useEffect() {},
  weekPlan: { weekStart: '2026-09-07', days: [] },
  weekPlanRef: { current: { weekStart: '2026-09-07', days: [] } },
  activeEntryId: null, activeEntryType: null,
  activeEntryRef: { current: { id: null, type: null } },
  weekSetLogsRef: { current: {} }, weekBaseCountsRef: { current: {} },
  selectedDayIndexRef: { current: 0 },
  bumpData() {}, hideWorkoutDetail() { closes++ }, profile: { language: 'es' },
  syncDayRefs() {}, todayId: '2026-09-07', weekStartDayIndex: 1,
  findDayIndexByDate: (days, date) => days.findIndex(day => day.date === date),
  buildSetLogsForExercises: () => ({ logs: {}, baseCounts: {} }),
  setSelectedDayIndex() {}, setWeekPlan() {}, setActiveEntryId(id) { selectedId = id },
}
const render = () => new Function(...Object.keys(env), js + '; return applyWeekPlan')(...Object.values(env))
const beforeOpen = render()
env.activeEntryId = 'goblet_squat'
env.activeEntryType = 'exercise'
env.activeEntryRef.current = { id: 'goblet_squat', type: 'exercise' }
const afterOpen = render()
assert.equal(afterOpen, beforeOpen, 'opening detail must not change the session-loading callback')
afterOpen({ days: [{ date: env.todayId, exercises: [{ id: 'goblet_squat', sets: [{}] }], extras: [] }] }, { preserveActiveEntry: true })
assert.equal(closes, 0, 'canonical hydration must preserve the selected exercise')
afterOpen({ days: [{ date: env.todayId, exercises: [], extras: [] }] }, { preserveActiveEntry: true })
assert.equal(closes, 1, 'removing the selected exercise must close detail')

// A partially logged swap retains the old instance as history and inserts a
// fresh instance for the open sets. The detail and its slot chat follow the
// fresh exercise so the user can continue the same conversation.
const old = { id: 'wex_old', slotId: 'slot_press', sets: [{}, {}] }
const replacement = { id: 'wex_new', slotId: 'slot_press', sets: [{}] }
const day = (exercises) => ({ date: env.todayId, exercises, extras: [] })
const logged = { done: true }
const open = { done: false }
env.weekPlanRef.current = { days: [day([old])] }
env.weekSetLogsRef.current = { [env.todayId]: { [old.id]: [logged, open] } }
env.activeEntryRef.current = { id: old.id, type: 'exercise' }
const beforeSwapCloses = closes
afterOpen({ days: [day([{ ...old, sets: [{}] }, replacement])] }, {
  selectedDate: env.todayId,
  logsByDay: { [env.todayId]: { [old.id]: [logged], [replacement.id]: [open] } },
  preserveActiveEntry: true,
})
assert.equal(selectedId, replacement.id, 'detail follows the open replacement in the same slot')
assert.equal(env.activeEntryRef.current.id, replacement.id, 'the selected instance tracks the replacement')
assert.equal(closes, beforeSwapCloses, 'swap does not close the conversation')

env.weekPlanRef.current = { days: [day([old])] }
env.weekSetLogsRef.current = { [env.todayId]: { [old.id]: [open, open] } }
env.activeEntryRef.current = { id: old.id, type: 'exercise' }
afterOpen({ days: [day([replacement])] }, {
  selectedDate: env.todayId,
  logsByDay: { [env.todayId]: { [replacement.id]: [open] } },
  preserveActiveEntry: true,
})
assert.equal(env.activeEntryRef.current.id, replacement.id, 'agent replacement with a new instance keeps the slot selected')
assert.equal(closes, beforeSwapCloses, 'agent replacement in the same slot keeps the conversation open')

// An ordinary refresh must not jump to another item merely because it shares
// a slot; only the old item's open work becoming fully logged allows that.
env.weekPlanRef.current = { days: [day([old, replacement])] }
env.weekSetLogsRef.current = { [env.todayId]: { [old.id]: [open, open], [replacement.id]: [open] } }
env.activeEntryRef.current = { id: old.id, type: 'exercise' }
selectedId = old.id
afterOpen({ days: [day([old, replacement])] }, {
  selectedDate: env.todayId,
  logsByDay: env.weekSetLogsRef.current,
  preserveActiveEntry: true,
})
assert.equal(selectedId, old.id, 'ordinary refresh keeps the selected instance')
console.log('workout detail smoke passed')
