import { useId, useState } from 'react'
import type { NutritionMeal, NutrientRange } from './nutrition'
import { macroKeys, midpoint, summarizeNutrition } from './nutrition'

const value = (range: NutrientRange) => range ? `~${Math.round(midpoint(range)!).toLocaleString()}` : '—'
const bounds = (range: NutrientRange) => !range ? 'Not available' : Math.round(range.low) === Math.round(range.high) ? Math.round(range.low).toLocaleString() : `${Math.round(range.low).toLocaleString()}–${Math.round(range.high).toLocaleString()}`

export default function NutritionSummary({ meals, loading, unavailable }: { meals: NutritionMeal[]; loading: boolean; unavailable: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const data = summarizeNutrition(meals)
  const calories = data.totals.calories_kcal
  let offset = 0
  return <section className="nutrition-summary" aria-label="Daily nutrition summary">
    <button className="nutrition-summary-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)}>
      <span><strong>Today’s nutrition</strong></span>
      <span className="nutrition-toggle-meta">{!open && !loading && !unavailable && calories.range && <small>{value(calories.range)} kcal</small>}<span className={`nutrition-chevron ${open ? 'open' : ''}`} aria-hidden="true">⌄</span></span>
    </button>
    {!open && !loading && !unavailable && <div className="nutrition-compact-metrics"><span>Protein <b>{value(data.totals.protein_g.range)} g</b></span><span>Caffeine <b>{value(data.totals.caffeine_mg.range)} mg</b></span>{(calories.missing || data.totals.protein_g.missing || data.totals.caffeine_mg.missing) > 0 && <small>Partial estimates</small>}</div>}
    <div id={id} hidden={!open}>
      {loading ? <div className="nutrition-loading" role="status"><span/><span/><p>Loading your nutrition…</p></div> : unavailable ? <p className="nutrition-empty">Nutrition will appear when your meals finish loading.</p> : <>
        <div className="nutrition-overview">
          <div className="nutrition-ring" aria-label={`Estimated calories: ${calories.range ? `${bounds(calories.range)} kcal${calories.missing ? ', partial total' : ''}` : 'not available'}`}>
            <svg viewBox="0 0 120 120" aria-hidden="true"><circle className="nutrition-ring-track" cx="60" cy="60" r="52"/>
              {data.shares?.map((share, index) => { const start = offset; offset += share; return <circle key={macroKeys[index]} className={`nutrition-ring-segment nutrition-color-${index}`} cx="60" cy="60" r="52" pathLength="100" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start}/> })}
            </svg>
            <div><strong>{value(calories.range)}</strong><span>kcal logged</span>{calories.missing > 0 && <small>partial total</small>}</div>
          </div>
          <div className="nutrition-macro-list">{macroKeys.map((key, index) => <div className={`nutrition-macro nutrition-color-${index}`} key={key}>
            <span className="nutrition-macro-dot"/><div><span>{['Protein', 'Carbs', 'Fat'][index]}</span><small>{data.totals[key].range ? `${bounds(data.totals[key].range)} g${data.totals[key].missing ? ' · partial' : ''}` : 'Not available'}</small></div>
            <strong>{value(data.totals[key].range)}<small> g</small></strong>
          </div>)}</div>
        </div>
        {data.count > 0 ? <>
          <div className="nutrition-range-note">{calories.range ? `${bounds(calories.range)} kcal estimated${calories.missing ? ` · ${calories.missing} meal${calories.missing === 1 ? '' : 's'} missing calories` : ''}` : 'Calories not available'}<span>{data.shares ? 'Ring: energy share from macros' : 'Ring fills when all macros are available'}</span></div>
          <div className="nutrition-highlights nutrition-highlights--three">
            <div><span className="nutrition-highlight-icon" aria-hidden="true">◷</span><strong>{data.count}</strong><small>meal{data.count === 1 ? '' : 's'} logged</small></div>
            <div><span className="nutrition-highlight-icon" aria-hidden="true">✳</span><strong>{value(data.totals.fiber_g.range)}<span> g</span></strong><small>fiber{data.totals.fiber_g.missing ? ' · partial' : ''}</small></div>
            <div><span className="nutrition-highlight-icon" aria-hidden="true">☕</span><strong>{value(data.totals.caffeine_mg.range)}<span> mg</span></strong><small>caffeine{data.totals.caffeine_mg.missing ? ' · partial' : ''}</small></div>
          </div>
          {data.proteinLeader && <p className="nutrition-protein-highlight"><span aria-hidden="true">↗</span><span><strong>Most protein</strong> {data.proteinLeader.title}<small>~{Math.round(data.proteinLeader.grams)} g in this meal</small></span></p>}
        </> : <p className="nutrition-empty">Your day starts here. Log a meal to build your snapshot.</p>}
        {(data.pending > 0 || data.failed > 0) && <p className="nutrition-pending" role="status">{data.pending > 0 && `${data.pending} meal${data.pending === 1 ? '' : 's'} analyzing · totals will update.`} {data.failed > 0 && `${data.failed} failed analysis · excluded from totals.`}</p>}
      </>}
    </div>
  </section>
}
