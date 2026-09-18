const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/components/meals/nutrition.ts'), 'utf8')
const exportsObject = {}
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: exportsObject })
const { summarizeNutrition } = exportsObject
const meal = (patch = {}) => ({ status: 'complete', analysis: { is_food: true, title: 'Latte', nutrients: {
  calories_kcal: { low: 90, high: 110 }, protein_g: { low: 8, high: 12 }, carbs_g: { low: 10, high: 14 }, fat_g: { low: 2, high: 4 }, fiber_g: null } }, ...patch })
const summary = summarizeNutrition([meal(), meal(), meal({ status: 'deleted' }), meal({ intake_only: true }), meal({ discussion_only: true }), meal({ status: 'processing', analysis: null })])
assert.equal(summary.count, 2)
assert.equal(summary.pending, 1)
assert.equal(summary.totals.calories_kcal.range.low, 180)
assert.equal(summary.totals.calories_kcal.range.high, 220)
assert.equal(summary.totals.fiber_g.range, null)
assert.equal(summary.totals.fiber_g.missing, 2)
assert.ok(Math.abs(summary.shares.reduce((a, b) => a + b) - 100) < .0001)
assert.equal(summary.proteinLeader.grams, 10)
const unknown = meal(); unknown.analysis.nutrients.protein_g = null; unknown.analysis.nutrients.calories_kcal = null
const partial = summarizeNutrition([meal(), unknown])
assert.equal(partial.shares, null)
assert.equal(partial.totals.protein_g.missing, 1)
assert.equal(partial.totals.calories_kcal.range.low, 90)
assert.equal(partial.totals.calories_kcal.missing, 1)
assert.equal(summarizeNutrition([]).totals.calories_kcal.range, null)
const zero = meal(); zero.analysis.nutrients.calories_kcal = { low: 0, high: 0 }
assert.equal(summarizeNutrition([zero]).totals.calories_kcal.range.low, 0)
assert.equal(summarizeNutrition([meal({ analysis: { is_food: false, title: 'Not food', nutrients: {} } })]).count, 0)
console.log('Meal nutrition contract passed')

const { nutritionWeek, summarizeWeek } = exportsObject
assert.equal(nutritionWeek('2026-09-09').start, '2026-09-07')
assert.equal(nutritionWeek('2026-09-13').end, '2026-09-13')
const logged = []
for (const date of ['2026-09-07','2026-09-08','2026-09-09']) for (let n = 0; n < 2; n++) {
  const row = meal({ date }); row.analysis.nutrients.calcium_mg = { low: 100, high: 200 }; row.analysis.nutrients.caffeine_mg = { low: 2, high: 15 }; logged.push(row)
}
const week = summarizeWeek([...logged, meal({ date:'2026-09-10' }), meal({ date:'2026-09-09', status:'deleted' })], '2026-09-07','2026-09-13','2026-09-09')
assert.equal(week.days,3); assert.equal(week.count,6)
assert.equal(week.signals[0].average.low,200); assert.equal(week.signals[0].average.high,400)
assert.equal(week.signals[0].possibleGap,true)
assert.equal(week.signals[1].possibleGap,false); assert.equal(week.signals[1].average,null)
assert.equal(week.caffeine[0].range.low,4); assert.equal(week.caffeine[0].range.high,30)
assert.equal(week.caffeine[3].range,null); assert.equal(week.caffeine[3].future,true)
assert.equal(summarizeWeek(logged.slice(0,2),'2026-09-07','2026-09-13','2026-09-09').signals[0].possibleGap,false)
const incomplete = [...logged, meal({ date:'2026-09-09' })]
assert.equal(summarizeWeek(incomplete,'2026-09-07','2026-09-13','2026-09-09').signals[0].possibleGap,false)
console.log('Weekly micronutrient and caffeine contract passed')

assert.equal(summarizeNutrition([meal({template_only:true})]).count,0)
assert.equal(summarizeWeek([meal({date:'2026-09-09',template_only:true})],'2026-09-07','2026-09-13','2026-09-09').days,0)
