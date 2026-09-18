export type NutrientRange = { low: number; high: number } | null
export type NutritionMeal = {
  template_only?: boolean
  date?: string
  status: string
  intake_only?: boolean
  discussion_only?: boolean
  analysis: { is_food: boolean; title: string; nutrients: Record<string, NutrientRange> } | null
}
export const macroKeys = ['protein_g', 'carbs_g', 'fat_g'] as const
// FDA food-label Daily Values, not personalized intake prescriptions.
// https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels
export const micronutrients = [
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', reference: 1300 },
  { key: 'iron_mg', label: 'Iron', unit: 'mg', reference: 18 },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', reference: 420 },
  { key: 'potassium_mg', label: 'Potassium', unit: 'mg', reference: 4700 },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', reference: 11 },
  { key: 'folate_ug', label: 'Folate', unit: 'µg DFE', reference: 400 },
  { key: 'vitamin_b12_ug', label: 'Vitamin B12', unit: 'µg', reference: 2.4 },
  { key: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg', reference: 90 },
  { key: 'vitamin_d_ug', label: 'Vitamin D', unit: 'µg', reference: 20 },
] as const
const nutrientKeys = ['calories_kcal', ...macroKeys, 'fiber_g', 'caffeine_mg', ...micronutrients.map(item => item.key)] as const
export const midpoint = (value: NutrientRange) => value ? (value.low + value.high) / 2 : null

export function summarizeNutrition(meals: NutritionMeal[]) {
  const logged = meals.filter(meal => !meal.template_only && !meal.intake_only && !meal.discussion_only && meal.status !== 'deleted')
  const foods = logged.filter(meal => meal.status === 'complete' && meal.analysis?.is_food)
  const totals = Object.fromEntries(nutrientKeys.map(key => {
    const values = foods.map(meal => meal.analysis!.nutrients[key]).filter((value): value is NonNullable<NutrientRange> => value != null)
    return [key, { range: values.length ? { low: values.reduce((sum, value) => sum + value.low, 0), high: values.reduce((sum, value) => sum + value.high, 0) } : null,
      known: values.length, missing: foods.length - values.length }]
  })) as Record<typeof nutrientKeys[number], { range: NutrientRange; known: number; missing: number }>
  const macroEnergy = macroKeys.map((key, index) => (midpoint(totals[key].range) ?? 0) * (index === 2 ? 9 : 4))
  const energy = macroEnergy.reduce((sum, value) => sum + value, 0)
  const completeMacros = foods.length > 0 && macroKeys.every(key => totals[key].missing === 0) && energy > 0
  const proteinLeader = foods.filter(meal => (midpoint(meal.analysis!.nutrients.protein_g) ?? 0) > 0)
    .sort((a, b) => (midpoint(b.analysis!.nutrients.protein_g) ?? 0) - (midpoint(a.analysis!.nutrients.protein_g) ?? 0))[0]?.analysis
  return { totals, count: foods.length,
    pending: logged.filter(meal => ['queued', 'processing'].includes(meal.status)).length,
    failed: logged.filter(meal => meal.status === 'failed').length,
    shares: completeMacros ? macroEnergy.map(value => value / energy * 100) : null,
    proteinLeader: proteinLeader ? { title: proteinLeader.title, grams: midpoint(proteinLeader.nutrients.protein_g)! } : null }
}

export function nutritionWeek(selectedDate: string) {
  const day = new Date(`${selectedDate}T12:00:00Z`)
  if (!Number.isFinite(day.getTime())) return { start: '', end: '' }
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7)
  const start = day.toISOString().slice(0, 10)
  day.setUTCDate(day.getUTCDate() + 6)
  return { start, end: day.toISOString().slice(0, 10) }
}

export function summarizeWeek(meals: NutritionMeal[], start: string, end: string, today: string) {
  const through = end < today ? end : today
  const rows = meals.filter(meal => meal.date && meal.date >= start && meal.date <= through)
  const data = summarizeNutrition(rows)
  const loggedDates = new Set(rows.filter(meal => meal.status === 'complete' && meal.analysis?.is_food && !meal.template_only && !meal.intake_only && !meal.discussion_only).map(meal => meal.date))
  const days = loggedDates.size
  const signals = micronutrients.map(item => {
    const total = data.totals[item.key]
    const average = total.range && days ? { low: total.range.low / days, high: total.range.high / days } : null
    // Missing values never become zero or a shortage. Only flag sustained low
    // logged estimates, with at least two meals/day on average over three days.
    const possibleGap = !!average && !total.missing && days >= 3 && data.count >= days * 2 && average.high < item.reference
    return { ...item, ...total, average, possibleGap,
      percent: average ? { low: average.low / item.reference * 100, high: average.high / item.reference * 100 } : null }
  })
  const caffeine = []
  if (start && end) for (let offset = 0; offset < 7; offset++) {
    const date = new Date(`${start}T12:00:00Z`)
    date.setUTCDate(date.getUTCDate() + offset)
    const id = date.toISOString().slice(0, 10)
    const day = summarizeNutrition(rows.filter(meal => meal.date === id))
    caffeine.push({ date: id, future: id > through, ...day.totals.caffeine_mg })
  }
  return { ...data, days, signals, caffeine, through }
}
