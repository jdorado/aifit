import { useId, useState } from 'react'
import type { NutritionMeal, NutrientRange } from './nutrition'
import { midpoint, summarizeWeek } from './nutrition'

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })
const bounds = (value: NutrientRange) => value ? `${number(value.low)}–${number(value.high)}` : '—'
const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })

export default function MicronutrientSummary({ meals, start, end, selectedDate, loading, unavailable }: {
  meals: NutritionMeal[]; start: string; end: string; selectedDate: string; loading: boolean; unavailable: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const data = summarizeWeek(meals, start, end, today)
  const gaps = data.signals.filter(item => item.possibleGap)
  const caffeineMax = Math.max(1, ...data.caffeine.map(day => day.range?.high ?? 0))
  return <section className="nutrition-summary micronutrient-summary" aria-label="Weekly micronutrients and caffeine">
    <button className="nutrition-summary-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span><strong>Micronutrients</strong></span>
      <span className="nutrition-toggle-meta"><small>{loading ? 'Loading…' : unavailable ? 'Unavailable' : `${data.days}/7 days`}</small><span className={`nutrition-chevron ${open ? 'open' : ''}`} aria-hidden="true">⌄</span></span>
    </button>
    <div id={id} hidden={!open}>
      {loading ? <p className="nutrition-empty" role="status">Loading this week’s meals…</p> : unavailable ? <p className="nutrition-empty">Weekly coverage is unavailable. Refresh to try again.</p> : <>
        <p className="micro-week-label">{start && shortDate(start)} – {end && shortDate(end)} · {data.count} meals · {data.days} logged days</p>
        <div className="micro-caffeine-heading"><strong>Caffeine by day</strong><small>Estimated mg · gaps mean unknown</small></div>
        <div className="micro-caffeine-chart" aria-label="Estimated daily caffeine in milligrams">{data.caffeine.map(day => <div key={day.date} className={day.date === selectedDate ? 'selected' : ''}>
          <span className="micro-caffeine-value">{day.future ? '—' : day.range ? `~${number(midpoint(day.range)!)}` : '?'}</span>
          <div className={`micro-caffeine-track ${!day.range ? 'unknown' : ''}`} title={`${day.date}: ${day.future ? 'Future day' : `${bounds(day.range)} mg${day.missing ? ' · partial' : ''}`}`}><span style={{ height: day.range ? `${midpoint(day.range)! / caffeineMax * 100}%` : '0%' }}/></div>
          <small>{new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' })}{day.missing > 0 && day.range ? '*' : ''}</small>
        </div>)}</div>
        <p className="micro-footnote">Includes decaf when logged. * Partial total; some meals lack caffeine estimates.</p>
        <div className={`micro-signal ${gaps.length ? 'watch' : ''}`}>
          <strong>{gaps.length ? 'Possible gaps in logged food' : data.days < 3 ? 'Building your weekly picture' : 'Coverage from your logged food'}</strong>
          <p>{gaps.length ? gaps.map(item => item.label).join(' · ') : 'More complete meal logs make the pattern clearer. Missing days and unknown nutrients are not counted as zero.'}</p>
        </div>
        <div className="micro-table-heading"><span>Average per logged day</span><span>% daily reference</span></div>
        <div className="micro-nutrient-list">{data.signals.map(item => <div className={`micro-nutrient-row ${item.possibleGap ? 'watch' : ''}`} key={item.key}>
          <div><strong>{item.label}</strong><small>{bounds(item.average)} {item.unit}{item.missing ? ' · partial' : ''}</small></div>
          <div className="micro-coverage"><span>{item.percent ? `${Math.round(item.percent.low)}–${Math.round(item.percent.high)}%` : 'No estimate'}</span><div className="micro-coverage-track"><span style={{ width: item.percent ? `${Math.min(100, (item.percent.low + item.percent.high) / 2)}%` : '0%' }}/></div></div>
          <small className="micro-row-status">{item.possibleGap ? 'Low in logs' : item.missing ? 'Incomplete' : item.average ? 'Estimated' : 'Unknown'}</small>
        </div>)}</div>
        <p className="micro-footnote">Ranges use assumed portions. Comparisons use <a href="https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels" target="_blank" rel="noreferrer">FDA food-label Daily Values</a>, not personal targets. Low logged coverage is a prompt to review food variety, not evidence of deficiency. Unlogged food and supplements can change the picture.</p>
      </>}
    </div>
  </section>
}
