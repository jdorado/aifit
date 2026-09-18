import { useEffect, useRef, useState } from 'react'
type Metric = { value: number | null; unit: string; samples?: number; note?: string; partial_at_import?: boolean | null; sessions?: { start_local: string; end_local: string; asleep_minutes: number }[]; source_modified_at: string; last_sample_local: string }
type Report = { date: string; imported_at: string; date_basis: string; metrics: Record<string, Metric> }
type Result = { connected: boolean; records: Report[]; sync: { imported_at: string; latest_date: string; repository?: { status: string } } | null }
type Request = (path: string, init?: RequestInit) => Promise<Response>
const labels: Record<string, string> = { sleep: 'Sleep', resting_heart_rate: 'RHR', hrv_sdnn: 'HRV', active_energy: 'Energy', exercise: 'Exercise' }
const dayString = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
const shift = (day: string, days: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
const display = (metric: Metric | undefined, key: string) => metric?.value == null ? '—' : key === 'sleep'
  ? `${Math.floor(Math.round(metric.value) / 60)}h ${Math.round(metric.value) % 60}m`
  : `${Math.round(metric.value)} ${metric.unit}`
const merge = (previous: Report[], next: Report[]) => [...new Map([...previous, ...next].map(row => [row.date, row])).values()].sort((a, b) => b.date.localeCompare(a.date))
function MetricIcon({ kind }: { kind: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{kind === 'sleep' ? <path d="M20 14.2A8.5 8.5 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/>
    : kind === 'resting_heart_rate' ? <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1Z"/>
    : kind === 'hrv_sdnn' ? <path d="M2 12h4l3-7 5 14 3-7h5"/>
    : kind === 'active_energy' ? <path d="M13 3c1 5-5 6-5 10 0 2 1 3 3 4-1-3 3-4 3-7 5 4 6 11-2 11C2 21 3 9 13 3Z"/>
    : <><circle cx="15" cy="4" r="2"/><path d="m10 9 4-2 3 4h4M4 12l5-4 3 5-3 8m3-8 5 3 1 5"/></>}</svg>
}
function DayCard({ report, today, latest }: { report: Report; today: string; latest: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const date = new Date(`${report.date}T12:00:00`)
  const title = report.date === today ? 'Today' : report.date === shift(today, -1) ? 'Yesterday' : date.toLocaleDateString([], { weekday: 'long' })
  return <li className={`health-day-node ${latest ? 'is-latest' : ''}`}>
    <article className="health-day-card" aria-label={`Health report ${report.date}`}>
      <header><div><h2>{title}</h2><time dateTime={report.date}>{date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })}</time></div><button className="health-day-toggle" type="button" aria-expanded={expanded} aria-controls={`health-details-${report.date}`} aria-label={`Details for ${report.date}`} onClick={() => setExpanded(open => !open)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></button></header>
      <dl className="health-day-metrics">{Object.entries(labels).map(([key, label]) => {
        const metric = report.metrics[key]
        return <div key={key} data-metric={key} className={metric?.value == null ? 'is-missing' : ''}><dt><MetricIcon kind={key}/>{label}</dt><dd>{key === 'sleep' || metric?.value == null ? display(metric, key) : <>{Math.round(metric.value)}<small>{metric.unit}</small></>}{metric?.value != null && key !== 'sleep' && metric.partial_at_import && <span className="health-partial-marker" title="Incomplete day at export" aria-label="Incomplete day at export">·</span>}</dd>
        </div>
      })}</dl>
      <div id={`health-details-${report.date}`} className="health-day-details" hidden={!expanded}>
      {!!report.metrics.sleep?.sessions?.length && <p className="health-night-times">Sleep {report.metrics.sleep.sessions.map(session => `${session.start_local.slice(11, 16)}–${session.end_local.slice(11, 16)}`).join(' · ')}</p>}
      <p>{report.date_basis} Missing measurements are shown as —. A dot marks an incomplete day at export.</p>{Object.entries(report.metrics).map(([key, metric]) => <p key={key}><strong>{labels[key] || key}:</strong> last sample {metric.last_sample_local.replace('T', ' ')}. File updated {new Date(metric.source_modified_at).toLocaleString()}.{metric.note && ` ${metric.note}`}</p>)}</div>
    </article>
  </li>
}
export default function HealthReport({ active, enabled, request }: { active: boolean; enabled: boolean; request: Request }) {
  const today = dayString(new Date())
  const [state, setState] = useState<{ source?: Request; result?: Result; error?: string }>({})
  const [retry, setRetry] = useState(0)
  const [olderLoading, setOlderLoading] = useState(false)
  const [olderNotice, setOlderNotice] = useState('')
  const oldestWindow = useRef(shift(today, -30))
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (!active || !enabled) return
    const controller = new AbortController(); controllerRef.current = controller
    oldestWindow.current = shift(today, -30); setOlderLoading(false); setOlderNotice(''); setState({ source: request })
    const load = async () => {
      try {
        const result: Result = await (await request(`/health/reports?start_date=${shift(today, -30)}&end_date=${today}`, { signal: controller.signal })).json()
        if (!controller.signal.aborted) setState(previous => ({ source: request, result: { ...result, records: merge(previous.source === request ? previous.result?.records || [] : [], result.records) } }))
      } catch (e) { if (!controller.signal.aborted) setState(previous => ({ ...previous, error: e instanceof Error ? e.message : 'Could not load health reports.' })) }
    }
    void load()
    window.addEventListener('focus', load); window.addEventListener('aifit-channel-change', load)
    const timer = setInterval(load, 60000)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener('aifit-channel-change', load) }
  }, [active, enabled, today, request, retry])
  const loadOlder = async () => {
    const controller = controllerRef.current
    if (!controller || controller.signal.aborted || olderLoading) return
    const end = shift(oldestWindow.current, -1); const start = shift(end, -30)
    setOlderLoading(true); setOlderNotice('')
    try {
      const result: Result = await (await request(`/health/reports?start_date=${start}&end_date=${end}`, { signal: controller.signal })).json()
      if (controller.signal.aborted) return
      oldestWindow.current = start
      setState(previous => previous.source !== request || !previous.result ? previous : { ...previous, result: { ...previous.result, records: merge(previous.result.records, result.records) } })
      if (!result.records.length) setOlderNotice(`No reports from ${start} to ${end}.`)
    } catch (e) { if (!controller.signal.aborted) setOlderNotice(e instanceof Error ? e.message : 'Could not load earlier days. Please retry.') }
    finally { if (!controller.signal.aborted) setOlderLoading(false) }
  }
  if (!enabled) return <p className="health-timeline-empty">Sign in to see your health timeline.</p>
  if (state.source !== request || (!state.result && !state.error)) return <p className="health-timeline-empty" role="status">Loading your health timeline…</p>
  const result = state.result
  const error = state.error && <p className="meal-status" role="alert">{state.error} <button className="meal-inline-button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>
  if (!result) return error
  if (!result.connected) return <p className="health-timeline-empty">Apple Health is not connected to this account yet.</p>
  const stale = result.sync && Date.now() - new Date(result.sync.imported_at).getTime() > 36 * 3600000
  return <section className="health-feed" aria-label="Your health timeline">
    <div className="health-feed-context"><span>Apple Health · Available to your coach</span><small>{stale ? 'Waiting for a fresh export' : 'Updated'} {result.sync && new Date(result.sync.imported_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></div>
    {error}{result.sync?.repository?.status === 'error' && <p className="meal-status">Sync needs attention. Showing the last available reports.</p>}
    {result.records.length ? <ol className="health-day-list">{result.records.map((report, index) => <DayCard key={report.date} report={report} today={today} latest={index === 0}/>)}</ol> : <p className="health-timeline-empty">No recent health reports yet. Earlier reports may be available below.</p>}
    {olderNotice && <p className="health-older-notice" role="status">{olderNotice}</p>}
    <button className="health-load-earlier" type="button" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? 'Loading…' : 'Load earlier days'}</button>
  </section>
}
