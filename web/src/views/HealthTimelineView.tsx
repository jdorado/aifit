import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import WeekStrip from '../components/workout/WeekStrip'
import HealthReport from '../components/health/HealthReport'
import NutritionSummary from '../components/meals/NutritionSummary'
import MicronutrientSummary from '../components/meals/MicronutrientSummary'
import { micronutrients, nutritionWeek } from '../components/meals/nutrition'

type Estimate = { low: number; high: number } | null
type Analysis = {
  is_food: boolean; title: string; description: string; confidence: string
  foods: { name: string; portion: string; confidence: string }[]
  nutrients: Record<string, Estimate>
  assumptions: string[]; micronutrients: string[]; limitations: string[]
  glycemic_context: string; sleep_context: string; fat_loss_context: string; longevity_context: string
}
type Meal = {
  request_id?: string; saving?: boolean; saveError?: string;
  template_only?: boolean; repeat_of?: string; usual_time?: string; approximate_time?: boolean; time_request?: unknown;
  id: string; date: string; captured_at: string; timezone: string
  status: 'queued' | 'processing' | 'complete' | 'failed'
  intake_only?: boolean; delete_requested?: boolean; delete_error?: string;
  analysis: Analysis | null; error: string | null; thumbnail_url: string | null; source?: string
}
type Suggestion = { favorite?: boolean; usual_time?: string; source_id: string; title: string; foods: Analysis['foods']; nutrients: Analysis['nutrients']; count: number }
type Entry = { request_id: string; captured_at?: string; meal_date?: string; local_time?: string; timezone_name: string; description?: string; source_id?: string; as_usual?: boolean; usual_time?: string; approximate_time?: boolean }
type Props = {
  kind: 'diet' | 'health'; active: boolean
  weekDays: ComponentProps<typeof WeekStrip>['days']; selectedDayLabel: string
  onSelectDay: ComponentProps<typeof WeekStrip>['onSelectDay']; onChat: () => void
  apiBase: string; userId: string; actAsOwnerId: string | null; enabled: boolean; canEdit: boolean
  getAuthHeaders: () => Promise<Record<string, string>>
}
const amount = (estimate: Estimate | undefined, unit: string) => estimate
  ? `~${Math.round((estimate.low + estimate.high) / 2)} ${unit}` : `${unit}: unknown`
const range = (estimate: Estimate | undefined, unit: string) => estimate
  ? `${Math.round(estimate.low)}–${Math.round(estimate.high)} ${unit}` : 'Unknown'

function MealCard({ meal, request, retry, remove, deleting, actionsOpen, onActions, canEdit, favorite, toggleFavorite, editTime }: {
  meal: Meal; request: (path: string, init?: RequestInit) => Promise<Response>; retry: () => void
  favorite: boolean; toggleFavorite: () => void; editTime: () => void
  remove: () => void; deleting: boolean; actionsOpen: boolean; onActions: (open: boolean) => void; canEdit: boolean
}) {
  const gesture = useRef<{ x: number; y: number } | null>(null)
  const suppressClickUntil = useRef(0)
  const [thumbnail, setThumbnail] = useState('')
  useEffect(() => {
    setThumbnail('')
    if (!meal.thumbnail_url) return
    let url = ''; let cancelled = false
    const controller = new AbortController()
    void request(meal.thumbnail_url, { signal: controller.signal }).then(r => r.blob()).then(blob => {
      if (cancelled) return
      url = URL.createObjectURL(blob); setThumbnail(url)
    }).catch(() => undefined)
    return () => { cancelled = true; controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [meal.thumbnail_url, request])
  const a = meal.analysis
  return <li className="meal-timeline-item"><div className="meal-time-row"><time>{meal.approximate_time ? '≈ ' : ''}{new Date(meal.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: meal.timezone })}</time>{canEdit && <span><button className="meal-meta-button" onClick={editTime} disabled={!!meal.time_request || deleting}>{meal.time_request ? 'Updating time…' : 'Edit date / time'}</button><button className="meal-favorite-button" aria-label={favorite ? 'Remove from usuals' : 'Save as usual'} aria-pressed={favorite} onClick={toggleFavorite} disabled={meal.status !== 'complete' || deleting}>{favorite ? '★' : '☆'}</button></span>}</div>
    <div className={`meal-swipe-row ${actionsOpen ? 'show-actions' : ''}`} onPointerDown={event => {
      if (!canEdit || event.button !== 0) return
      gesture.current = { x: event.clientX, y: event.clientY }
    }} onPointerUp={event => {
      const start = gesture.current; gesture.current = null
      if (!start) return
      const dx = event.clientX - start.x; const dy = event.clientY - start.y
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        suppressClickUntil.current = Date.now() + 250; onActions(dx < 0)
      }
    }} onPointerCancel={() => { gesture.current = null }} onKeyDown={event => { if (event.key === 'Escape') onActions(false) }}>
    <div className="health-timeline-entry health-timeline-entry--meal" onClickCapture={event => {
      if (Date.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); return }
      if (actionsOpen) { onActions(false); event.preventDefault(); event.stopPropagation() }
    }}>
      <div className="meal-card-summary">{thumbnail && <img src={thumbnail} alt={a?.title || 'Uploaded meal'} className="meal-thumbnail"/>}<div><small>{meal.intake_only ? 'Photo review · not logged yet' : meal.source === 'repeat' ? 'Saved estimate' : meal.source === 'text' ? 'Estimated nutrition' : meal.status === 'complete' ? 'Photo estimate' : 'Meal photo'}</small><h2><button className="meal-title-button" disabled={!canEdit} onClick={editTime}>{a?.title || (meal.status === 'failed' ? 'Analysis failed' : 'Analyzing your meal…')}</button></h2>{a?.is_food && <p className="meal-calories">{amount(a.nutrients.calories_kcal, 'kcal')}</p>}</div></div>
      {a?.is_food && <p className="meal-macros">Protein {amount(a.nutrients.protein_g, 'g')} · Carbs {amount(a.nutrients.carbs_g, 'g')} · Fat {amount(a.nutrients.fat_g, 'g')}</p>}
      {meal.saving && <p className="meal-saving" role="status">Saving…</p>}
      {meal.saveError && <p role="alert">Save not confirmed. {meal.saveError} <button className="meal-inline-button" onClick={retry}>Retry save</button></p>}
      {!meal.saving && !meal.saveError && (meal.status === 'queued' || meal.status === 'processing') && <p role="status">{meal.source === 'repeat' ? 'Saving your serving…' : meal.status === 'queued' ? 'Queued for analysis…' : 'Estimating nutrition…'}</p>}
      {meal.delete_requested && <p role="status">{meal.delete_error || 'Deleting meal…'}</p>}
      {meal.status === 'failed' && <><p role="alert">{meal.error}</p><button className="meal-inline-button" disabled={!canEdit || deleting} onClick={retry}>Retry analysis</button></>}
      {a && <details className="meal-analysis"><summary>Foods & full analysis</summary><p>{a.description}</p>
        <ul>{a.foods.map((food, index) => <li key={index}><strong>{food.name}</strong> — {food.portion} <small>({food.confidence} confidence)</small></li>)}</ul>
        {a.is_food && <><h3>Estimated nutrition</h3><dl>{[['calories_kcal','Calories','kcal'],['protein_g','Protein','g'],['carbs_g','Carbohydrates','g'],['fat_g','Fat','g'],['fiber_g','Fiber','g'],['sugar_g','Sugar','g'],['saturated_fat_g','Saturated fat','g'],['sodium_mg','Sodium','mg'],['caffeine_mg','Caffeine','mg'],...micronutrients.map(item => [item.key,item.label,item.unit])].map(([key,label,unit]) => <div key={key}><dt>{label}</dt><dd>{range(a.nutrients[key],unit)}</dd></div>)}</dl></>}
        {a.assumptions.length > 0 && <><h3>Portion & ingredient assumptions</h3><ul>{a.assumptions.map((text,i) => <li key={i}>{text}</li>)}</ul></>}
        {a.micronutrients.length > 0 && <><h3>Micronutrient clues</h3><ul>{a.micronutrients.map((text,i) => <li key={i}>{text}</li>)}</ul></>}
        {a.is_food && [['Carbohydrates & glycemic context',a.glycemic_context],['Sleep',a.sleep_context],['Fat loss & body composition',a.fat_loss_context],['Long-term nutrition',a.longevity_context]].map(([title,text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}
        <h3>Estimate limitations</h3><ul>{a.limitations.map((text,i) => <li key={i}>{text}</li>)}</ul><small>Nutrition estimate · {a.confidence} confidence · logged time may differ from eating time</small>
      </details>}
    </div>
    {canEdit && <div className="meal-row-actions"><button className="meal-delete-action" type="button" aria-label={`Delete ${a?.title || 'meal'}`} onFocus={() => onActions(true)} disabled={deleting} onClick={remove}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6"/></svg>
      <span>{deleting ? 'Deleting…' : 'Delete'}</span>
    </button></div>}
    </div></li>
}

export default function HealthTimelineView({ kind, active, weekDays, selectedDayLabel, onSelectDay, onChat, apiBase, userId, actAsOwnerId, enabled, canEdit, getAuthHeaders }: Props) {
  const selectedDate = weekDays.find(day => day.isSelected)?.date || ''
  const [weekMeals, setWeekMeals] = useState<Meal[]>([])
  const [pendingAdds, setPendingAdds] = useState<{ entry: Entry; meal: Meal }[]>([])
  const accountKey = `${userId}:${actAsOwnerId || ''}`
  const currentAccount = useRef(accountKey)
  currentAccount.current = accountKey
  const sending = useRef(new Set<string>())
  const meals = useMemo(() => [
    ...weekMeals.filter(meal => !pendingAdds.some(item => item.meal.id === meal.id || item.entry.request_id === meal.request_id)),
    ...pendingAdds.map(item => item.meal),
  ].filter(meal => meal.date === selectedDate).sort((a,b) => Date.parse(b.captured_at) - Date.parse(a.captured_at)), [weekMeals, pendingAdds, selectedDate])
  const week = nutritionWeek(selectedDate)
  const [swipeId, setSwipeId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const deletingRef = useRef(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [usuals, setUsuals] = useState<Meal[]>([])
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editTime, setEditTime] = useState('')
  const [editApproximate, setEditApproximate] = useState(true)
  const [savingTime, setSavingTime] = useState(false)
  const favoriteBusy = useRef(false)
  const pendingFavorites = useRef<Record<string, Entry>>({})
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [suggestionState, setSuggestionState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [description, setDescription] = useState('')
  const [quickAddOpen, setQuickAddOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadNotice, setUploadNotice] = useState('')
  const uploadBusy = useRef(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const pendingUpload = useRef<{ file: File; id: string; capturedAt: string; timezone: string } | null>(null)
  const mounted = useRef(true)
  const uploadAbort = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; uploadAbort.current?.abort() }
  }, [])
  const request = useCallback(async (path: string, init?: RequestInit) => {
    if (!enabled) throw new Error('Sign in to use your meal log.')
    const url = new URL(path, apiBase)
    url.searchParams.set('user_id', userId)
    if (actAsOwnerId) url.searchParams.set('act_as_owner_id', actAsOwnerId)
    const headers = await getAuthHeaders()
    const response = await fetch(url, { ...init, headers: { ...headers, ...init?.headers } })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(typeof body?.detail === 'string' ? body.detail : `Request failed (${response.status}).`)
    }
    return response
  }, [apiBase, userId, actAsOwnerId, enabled, getAuthHeaders])
  useEffect(() => {
    if (!active || !enabled || !selectedDate || kind !== 'diet') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoading(true); setError(''); setLoadFailed(false); setSwipeId(null)
    const load = async () => {
      try {
        const response = await request(`/meals?start_date=${week.start}&end_date=${week.end}`, { signal: controller.signal })
        const rows: Meal[] = await response.json()
        if (controller.signal.aborted) return
        setWeekMeals(rows); setPendingAdds(items => items.flatMap(item => {
          const row = rows.find(row => row.id === item.meal.id || row.request_id === item.entry.request_id)
          if (!row) return [item]
          if (row.status === 'complete' || row.status === 'failed') return []
          return [{ ...item, meal: { ...row, analysis: row.analysis || item.meal.analysis } }]
        })); setLoading(false); setLoadFailed(false); setError('')
        if (rows.some(row => row.status === 'queued' || row.status === 'processing' || row.delete_requested || !!row.time_request)) timer = setTimeout(load, 4000)
      } catch (e) {
        if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Could not load meals.'); setLoading(false); setLoadFailed(true); timer = setTimeout(load, 10000) }
      }
    }
    void load()
    const refresh = () => { if (timer) clearTimeout(timer); void load() }
    window.addEventListener('focus', refresh)
    window.addEventListener('aifit-channel-change', refresh)
    return () => { controller.abort(); if (timer) clearTimeout(timer); window.removeEventListener('focus', refresh); window.removeEventListener('aifit-channel-change', refresh) }
  }, [active, enabled, kind, selectedDate, week.start, week.end, request, refreshKey])
  useEffect(() => {
    setUsuals([]); setWeekMeals([]); setPendingAdds([]); setEditingMeal(null); pendingFavorites.current = {}; setSuggestions([]); setSuggestionState('loading');
  }, [userId, actAsOwnerId])
  useEffect(() => {
    if (!active || !enabled || kind !== 'diet') return
    const controller = new AbortController()
    const load = () => {
      void request('/meals/usuals', { signal: controller.signal }).then(r => r.json()).then(rows => { if (!controller.signal.aborted) setUsuals(rows) }).catch(() => undefined)
      const params = new URLSearchParams({ timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone })
      void request(`/meals/suggestions?${params}`, { signal: controller.signal }).then(r => r.json()).then(rows => {
        if (!controller.signal.aborted) { setSuggestions(rows); setSuggestionState('ready') }
      }).catch(() => { if (!controller.signal.aborted) setSuggestionState('error') })
    }
    load()
    const timer = setInterval(load, 60000)
    window.addEventListener('focus', load)
    window.addEventListener('aifit-channel-change', load)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', load); window.removeEventListener('aifit-channel-change', load) }
  }, [active, enabled, kind, request, refreshKey, meals])
  const savedOptions: Suggestion[] = usuals.filter(item => item.status === 'complete' && item.analysis?.is_food).map(item => ({
    source_id:item.id, title:item.analysis!.title, foods:item.analysis!.foods, nutrients:item.analysis!.nutrients,
    count:0, usual_time:item.usual_time, favorite:true,
  }))
  const servingOptions = savedOptions.length ? savedOptions : suggestions.slice(0, 4)
  const sendEntry = async (entry: Entry) => {
    if (sending.current.has(entry.request_id)) return
    sending.current.add(entry.request_id)
    const owner = accountKey
    setPendingAdds(items => items.map(item => item.entry.request_id === entry.request_id ? { ...item, meal: { ...item.meal, saving: true, saveError: undefined } } : item))
    try {
      const response = await request('/meals/entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })
      const saved: Meal = await response.json()
      if (!mounted.current || currentAccount.current !== owner) return
      setPendingAdds(items => items.map(item => item.entry.request_id === entry.request_id ? { entry, meal: { ...saved, analysis: saved.analysis || item.meal.analysis } } : item))
      setRefreshKey(key => key + 1)
    } catch (e) {
      if (!mounted.current || currentAccount.current !== owner) return
      setPendingAdds(items => items.map(item => item.entry.request_id === entry.request_id ? { ...item, meal: { ...item.meal, saving: false, saveError: e instanceof Error ? e.message : 'Could not save.' } } : item))
    } finally { sending.current.delete(entry.request_id) }
  }
  const addEntry = (sourceId?: string) => {
    if (!selectedDate || !enabled || !canEdit || (!sourceId && !description.trim())) return
    const now = new Date()
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    const option = servingOptions.find(item => item.source_id === sourceId)
    const localTime = selectedDate === today ? `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` : option?.usual_time || '13:00'
    const entry: Entry = { request_id: crypto.randomUUID(), meal_date: selectedDate, local_time: localTime, timezone_name: zone, approximate_time: selectedDate !== today,
      ...(sourceId ? { source_id: sourceId } : { description: description.trim() }) }
    const known = usuals.find(item => item.id === sourceId)?.analysis
    const analysis = known || (option ? { is_food: true, title: option.title, foods: option.foods, nutrients: option.nutrients, description: '', confidence: 'medium', assumptions: [], micronutrients: [], limitations: [], glycemic_context: '', sleep_context: '', fat_loss_context: '', longevity_context: '' } : null)
    const meal: Meal = { id: entry.request_id, date: selectedDate, captured_at: new Date(`${selectedDate}T${localTime}:00`).toISOString(), timezone: zone, approximate_time: entry.approximate_time,
      status: 'queued', saving: true, analysis, error: null, thumbnail_url: null, source: sourceId ? 'repeat' : 'text', repeat_of: sourceId }
    setPendingAdds(items => [...items, { entry, meal }])
    setDescription(''); setQuickAddOpen(false)
    void sendEntry(entry)
  }
  const toggleFavorite = async (meal: Meal) => {
    if (favoriteBusy.current) return
    favoriteBusy.current = true; setError('')
    try {
      const existing = usuals.find(item => item.repeat_of === meal.id || item.id === meal.repeat_of)
      if (existing) await request(`/meals/${existing.id}`, { method: 'DELETE' })
      else {
        const entry = pendingFavorites.current[meal.id] ||= { request_id: crypto.randomUUID(), source_id: meal.id,
          captured_at: meal.captured_at, timezone_name: meal.timezone, as_usual: true,
          usual_time: new Date(meal.captured_at).toLocaleTimeString('en-GB', { hour:'2-digit',minute:'2-digit',timeZone:meal.timezone }) }
        await request('/meals/entry', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(entry) })
        delete pendingFavorites.current[meal.id]
      }
      setUsuals(await (await request('/meals/usuals')).json()); setRefreshKey(key => key + 1)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update usuals.') }
    finally { favoriteBusy.current = false }
  }
  const saveTime = async () => {
    if (!editingMeal || savingTime) return
    setSavingTime(true); setError('')
    try {
      await request(`/meals/${editingMeal.id}/time`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        meal_date:editDate, local_time:editTime, timezone_name:editingMeal.timezone, approximate_time:editApproximate,
      }) })
      setEditingMeal(null); setRefreshKey(key => key + 1)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change meal time.') }
    finally { setSavingTime(false) }
  }
  const upload = async () => {
    const pending = pendingUpload.current
    if (!pending || uploadBusy.current) return
    uploadBusy.current = true
    setUploading(true); setUploadError(''); setUploadNotice('')
    uploadAbort.current = new AbortController()
    const timeout = setTimeout(() => uploadAbort.current?.abort(), 60000)
    try {
      const params = new URLSearchParams({ captured_at: pending.capturedAt, timezone_name: pending.timezone, request_id: pending.id })
      await request(`/meals?${params}`, { method: 'POST', headers: { 'Content-Type': pending.file.type || 'image/heic' }, body: pending.file, signal: uploadAbort.current.signal })
      if (!mounted.current) return
      pendingUpload.current = null; setUploadNotice('Photo saved. Analyzing your meal…'); setRefreshKey(key => key + 1)
    } catch (e) {
      if (mounted.current) setUploadError(`${e instanceof Error && e.name !== 'AbortError' ? e.message : 'Upload timed out.'} Photo not confirmed saved. Keep this page open and retry.`)
    } finally { clearTimeout(timeout); uploadBusy.current = false; if (mounted.current) setUploading(false) }
  }
  const selectPhoto = (file?: File) => {
    if (!file || uploadBusy.current) return
    setUploadNotice('')
    if (file.size > 12 * 1024 * 1024) { setUploadError('Choose a photo up to 12 MB.'); return }
    const moment = new Date()
    const [year,month,day] = selectedDate.split('-').map(Number)
    moment.setFullYear(year,month - 1,day)
    pendingUpload.current = { file, id: crypto.randomUUID(), capturedAt: moment.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
    void upload()
  }
  const retry = async (meal: Meal) => {
    try { await request(`/meals/${meal.id}/retry`, { method: 'POST' }); setRefreshKey(key => key + 1) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not retry.') }
  }
  const deleteMeal = async (meal: Meal) => {
    if (!canEdit || deletingRef.current || !window.confirm(`Delete ${meal.analysis?.title || 'this meal'}?`)) return
    deletingRef.current = true; setDeletingId(meal.id); setError('')
    try {
      await request(`/meals/${meal.id}`, { method: 'DELETE' })
      setWeekMeals(current => current.filter(row => row.id !== meal.id))
      setSuggestions(current => current.filter(item => item.source_id !== meal.id))
      setSwipeId(null); setRefreshKey(key => key + 1)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete meal. Please retry.') }
    finally { deletingRef.current = false; setDeletingId(null) }
  }
  return <section className={`view health-timeline-view ${active ? 'active' : ''}`} data-view={kind}>
    <header className="health-timeline-heading"><h1>{kind === 'diet' ? 'Diet' : 'Health'}</h1><span>{kind === 'health' ? 'Your days, at a glance' : selectedDayLabel}</span></header>
    {kind === 'diet' && <WeekStrip days={weekDays.map(day => ({ ...day, isCompleted: false, isRest: false, isProjected: false }))} onSelectDay={onSelectDay}/>}
    <div className="health-timeline-scroll">
      {kind === 'health' ? <HealthReport active={active} enabled={enabled} request={request}/> : <>
      <div className="meal-action-row" role="group" aria-label="Add a meal">
        <button type="button" aria-expanded={quickAddOpen} aria-controls="diet-quick-add" disabled={!enabled || !canEdit || !selectedDate} onClick={() => setQuickAddOpen(open => !open)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/></svg><span>Add food</span>
        </button>
        <button type="button" aria-label="Take meal photo" title="Take photo" disabled={!enabled || !canEdit || uploading || !selectedDate} onClick={() => camera.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5 9.5 3h5L16 5h4a1 1 0 0 1 1 1v13H3V6a1 1 0 0 1 1-1Z"/><circle cx="12" cy="12" r="4"/></svg><span>Photo</span>
        </button>
        <button type="button" aria-label="Upload meal photo" title="Upload photo" disabled={!enabled || !canEdit || uploading || !selectedDate} onClick={() => gallery.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/></svg><span>Upload</span>
        </button>
      </div>

      {enabled && <div className="meal-usual-chips" role="group" aria-label="Tap to log a serving">
        {servingOptions.map(item => <button key={item.source_id} type="button" disabled={!canEdit || !selectedDate} onClick={() => addEntry(item.source_id)} title={item.foods.map(food => `${food.name}: ${food.portion}`).join(' · ')}>{item.title}<span aria-hidden="true">＋</span></button>)}
        {!servingOptions.length && suggestionState === 'loading' && <small>Loading servings…</small>}
      </div>}
      {enabled && quickAddOpen && <form id="diet-quick-add" className="meal-text-entry" onSubmit={event => { event.preventDefault(); addEntry() }}>
        <input autoFocus aria-label="Describe a meal" placeholder="What did you eat?" value={description} maxLength={2200} disabled={!canEdit} onChange={event => setDescription(event.target.value)}/>
        <button type="submit" disabled={!canEdit || !description.trim() || !selectedDate}>Add</button>
      </form>}

      <input ref={camera} hidden type="file" accept="image/*" capture="environment" onChange={e => { selectPhoto(e.target.files?.[0]); e.target.value = '' }}/><input ref={gallery} hidden type="file" accept="image/*" onChange={e => { selectPhoto(e.target.files?.[0]); e.target.value = '' }}/>
      {uploading && <p className="meal-status" role="status">Uploading photo… Keep this page open until saved.</p>}
      {uploadNotice && <p className="meal-status" role="status">{uploadNotice}</p>}
      {uploadError && <div className="meal-status" role="alert">{uploadError}{pendingUpload.current && !uploading && <button className="meal-inline-button" onClick={() => void upload()}>Retry upload</button>}</div>}
      {error && <div className="meal-status" role="alert">{error}</div>}
      {editingMeal && <div className="meal-edit-backdrop" onClick={() => { if (!savingTime) setEditingMeal(null) }}><div role="dialog" aria-modal="true" aria-label="Edit meal" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape' && !savingTime) setEditingMeal(null) }}><form className="meal-time-editor" onSubmit={event => { event.preventDefault(); void saveTime() }} aria-label="Edit meal date and time">
        <strong>{editingMeal.analysis?.title}</strong><div className="meal-entry-time"><label>Date<input autoFocus type="date" aria-label="Edit meal date" required value={editDate} onInput={event => setEditDate(event.currentTarget.value)}/></label><label>Time<input type="time" aria-label="Edit meal time" required value={editTime} onInput={event => setEditTime(event.currentTarget.value)}/></label></div>
        <label><input type="checkbox" checked={editApproximate} onChange={event => setEditApproximate(event.target.checked)}/> Approximate time</label>
        <div><button type="submit" disabled={savingTime}>Save time</button><button type="button" disabled={savingTime} onClick={() => setEditingMeal(null)}>Cancel</button></div>
      </form></div></div>}
      {enabled && <NutritionSummary meals={meals.filter(meal => meal.date === selectedDate)} loading={loading} unavailable={loadFailed}/>}
      {enabled && <MicronutrientSummary meals={weekMeals} start={week.start} end={week.end} selectedDate={selectedDate} loading={loading} unavailable={loadFailed}/>}
      <div className="health-timeline-caption"><span>Meals</span><small>Nutrition estimates</small></div>
      {!enabled ? <p className="health-timeline-empty">Sign in to save meals and photos.</p> : loading && !meals.length ? <p className="health-timeline-empty" role="status">Loading meals…</p> : meals.length ? <ol className="health-timeline">{meals.map(meal => <MealCard key={meal.id} meal={meal} request={request} retry={() => { const pending = pendingAdds.find(item => item.meal.id === meal.id); if (pending) void sendEntry(pending.entry); else void retry(meal) }} remove={() => void deleteMeal(meal)} deleting={deletingId === meal.id} actionsOpen={swipeId === meal.id} onActions={open => setSwipeId(open ? meal.id : null)} canEdit={canEdit && !meal.saving && !meal.saveError && !pendingAdds.some(item => item.meal.id === meal.id)} favorite={usuals.some(item => item.repeat_of === meal.id || item.id === meal.repeat_of)} toggleFavorite={() => void toggleFavorite(meal)} editTime={() => { setEditingMeal(meal); setEditDate(meal.date); setEditTime(new Date(meal.captured_at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:meal.timezone})); setEditApproximate(!!meal.approximate_time) }}/>)}</ol> : !error && <p className="health-timeline-empty">No meals logged for this day. Describe a meal or take a photo.</p>}
      </>}
      {kind === 'diet' && <button className="health-timeline-chat" type="button" onClick={onChat}>Discuss in chat <span>↗</span></button>}
    </div>
  </section>
}
