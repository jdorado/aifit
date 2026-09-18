const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8')
const start = source.indexOf('  const applyWeekPlan = useCallback(')
const block = source.slice(start, source.indexOf('  const handleSelectDay =', start))
const js = ts.transpile(block, { target: ts.ScriptTarget.ES2020 })
let memo, deps, closes = 0
const env = {
  useCallback(fn, nextDeps) {
    if (!deps || nextDeps.some((value, index) => value !== deps[index])) memo = fn
    deps = nextDeps
    return memo
  },
  activeEntryId: null, activeEntryType: null,
  activeEntryRef: { current: { id: null, type: null } },
  weekSetLogsRef: { current: {} }, weekBaseCountsRef: { current: {} },
  selectedDayIndexRef: { current: 0 },
  bumpData() {}, hideWorkoutDetail() { closes++ }, profile: { language: 'es' },
  syncDayRefs() {}, todayId: '2026-09-07', weekStartDayIndex: 1,
  findDayIndexByDate: (days, date) => days.findIndex(day => day.date === date),
  buildSetLogsForExercises: () => ({ logs: {}, baseCounts: {} }),
  setSelectedDayIndex() {}, setWeekPlan() {},
}
const render = () => new Function(...Object.keys(env), js + '; return applyWeekPlan')(...Object.values(env))
const beforeOpen = render()
env.activeEntryId = 'goblet_squat'
env.activeEntryType = 'exercise'
env.activeEntryRef.current = { id: 'goblet_squat', type: 'exercise' }
const afterOpen = render()
assert.equal(afterOpen, beforeOpen, 'opening detail must not change the session-loading callback')
afterOpen({ days: [{ date: env.todayId, exercises: [{ id: 'goblet_squat' }], extras: [] }] }, { preserveActiveEntry: true })
assert.equal(closes, 0, 'canonical hydration must preserve the selected exercise')
afterOpen({ days: [{ date: env.todayId, exercises: [], extras: [] }] }, { preserveActiveEntry: true })
assert.equal(closes, 1, 'removing the selected exercise must close detail')
console.log('workout detail smoke passed')
