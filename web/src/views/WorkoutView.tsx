import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import CoachChat from '../components/workout/CoachChat'
import ExerciseFeedback from '../components/workout/ExerciseFeedback'
import ExerciseHistorySheet from '../components/workout/ExerciseHistorySheet'
import ExerciseSetList from '../components/workout/ExerciseSetList'
import VideoGallery from '../components/workout/VideoGallery'
import WeekStrip from '../components/workout/WeekStrip'
import WorkoutMiniBar from '../components/workout/WorkoutMiniBar'
import WorkoutPlanList from '../components/workout/WorkoutPlanList'
import type { WorkoutExercise, WorkoutExtra, WorkoutFeedbackPreset } from '../data/testWorkout'
import type { ActiveEntryType, ChatMessage, HoldTimerState, SetState } from '../types/app'
import {
  fetchExerciseHistory,
  groupExerciseHistory,
  type ExerciseHistorySession,
} from '../utils/exerciseHistory'
import {
  formatCircuitTarget,
  parseDurationToSeconds,
} from '../utils/workoutDisplay'

type WeekDaySummary = {
  index: number
  date: string
  label: string
  isToday: boolean
  isPast: boolean
  isFuture: boolean
  isSelected: boolean
  isCompleted: boolean
  isRest: boolean
  isProjected?: boolean
  isSelectable?: boolean
}

type SectionTone = 'default' | 'warmup' | 'main' | 'conditioning' | 'circuit' | 'rehab' | 'cooldown' | 'recovery' | 'night'

const SECTION_TONE_COLOR_SLOTS: Partial<Record<SectionTone, number>> = {
  warmup: 0,
  main: 1,
  circuit: 2,
  cooldown: 3,
  night: 4,
  recovery: 4,
  conditioning: 5,
  rehab: 6,
}

type WorkoutViewProps = {
  active: boolean
  canLogDay: boolean
  coachChatEnabled: boolean
  apiBaseUrl: string
  getAuthHeaders: () => Promise<Record<string, string>>
  weekDays: WeekDaySummary[]
  selectedDayLabel: string
  hasWeekWorkouts: boolean
  loading: boolean
  exercises: WorkoutExercise[]
  extras: WorkoutExtra[]
  setLogs: Record<string, SetState[]>
  planNotes: string
  savingDayNote: boolean
  savingExerciseFeedback: boolean
  activeEntryId: string | null
  activeEntryType: ActiveEntryType
  editingSet: { exerciseId: string, index: number } | null
  holdTimer: HoldTimerState
  coachMessages: ChatMessage[]
  showModelLabels?: boolean
  onSelectEntry: (id: string, type: ActiveEntryType) => void
  onSelectDay: (index: number, date: string) => void
  onBack: () => void
  onLogSet: (exerciseId?: string) => void
  onSkipSet: (exerciseId: string, index: number) => void
  onUnlogSet: (exerciseId: string, index: number) => void
  onStartEditingSet: (exerciseId: string, index: number) => void
  onSaveEditingSet: () => void
  onCancelEditingSet: () => void
  onUpdateSetField: (exerciseId: string, index: number, field: 'weight' | 'metric', value: string) => void
  onStartHoldTimer: (
    exerciseId: string,
    setIndex: number,
    totalSec: number,
    prepSec: number,
    options?: { sideIndex?: number, sideCount?: number },
  ) => void
  onLogHoldTimerSet: () => void
  onSaveDayNote: (notes: string) => Promise<boolean>
  onSaveExerciseFeedback: (exerciseId: string, note: string, preset: WorkoutFeedbackPreset | null) => Promise<boolean>
  onCoachSend: (exerciseId: string, message: string) => void
}

const getSectionToneFromText = (rawHaystack: string): SectionTone => {
  const haystack = rawHaystack.toLowerCase()
  if (/(warmup|primer|activation|mobility)/.test(haystack)) return 'warmup'
  if (/(rehab|prehab|physio)/.test(haystack)) return 'rehab'
  if (/(circuit|superset|giant set)/.test(haystack)) return 'circuit'
  if (/(main|strength|hypertrophy|power|lift|compound|accessory)/.test(haystack)) return 'main'
  if (/(conditioning|zone 2|z2|cardio|aerobic|elliptical|bike|treadmill|rower|assault bike|interval)/.test(haystack)) return 'conditioning'
  if (/(cooldown|cool down|stretch|decompression|yin|active rest)/.test(haystack)) return 'cooldown'
  if (/(night|evening|sleep|bedtime|downshift)/.test(haystack)) return 'night'
  if (/(recovery|sauna|hot yoga|yoga)/.test(haystack)) return 'recovery'
  return 'default'
}

const WorkoutView: FC<WorkoutViewProps> = ({
  active,
  canLogDay,
  coachChatEnabled,
  apiBaseUrl,
  getAuthHeaders,
  weekDays,
  selectedDayLabel,
  hasWeekWorkouts,
  loading,
  exercises,
  extras,
  setLogs,
  planNotes,
  savingDayNote,
  savingExerciseFeedback,
  activeEntryId,
  activeEntryType,
  editingSet,
  holdTimer,
  coachMessages,
  showModelLabels = false,
  onSelectEntry,
  onSelectDay,
  onBack,
  onLogSet,
  onSkipSet,
  onUnlogSet,
  onStartEditingSet,
  onSaveEditingSet,
  onCancelEditingSet,
  onUpdateSetField,
  onStartHoldTimer,
  onLogHoldTimerSet,
  onSaveDayNote,
  onSaveExerciseFeedback,
  onCoachSend,
}) => {
  const { t } = useI18n()
  const [coachChatOpen, setCoachChatOpen] = useState(false)
  const [coachDraft, setCoachDraft] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [historySessions, setHistorySessions] = useState<ExerciseHistorySession[]>([])
  const historyRequestRef = useRef(0)

  useEffect(() => {
    if (!coachChatEnabled) {
      setCoachChatOpen(false)
    }
  }, [coachChatEnabled])

  const activeExercise = useMemo(() => (
    activeEntryType === 'exercise'
      ? exercises.find((exercise) => exercise.id === activeEntryId)
      : null
  ), [activeEntryType, activeEntryId, exercises])

  const activeExtra = useMemo(() => (
    activeEntryType === 'extra'
      ? extras.find((extra) => extra.id === activeEntryId)
      : null
  ), [activeEntryType, activeEntryId, extras])

  const activeWeekDay = useMemo(() => (
    weekDays.find((day) => day.isSelected) ?? weekDays[0]
  ), [weekDays])
  const detailTitle = activeExercise?.name ?? activeExtra?.name ?? ''
  const detailSectionColorSlot = useMemo(() => {
    if (activeExercise) {
      const tone = getSectionToneFromText(`${activeExercise.section} ${activeExercise.category ?? ''} ${activeExercise.circuit?.name ?? ''} ${activeExercise.name}`)
      return SECTION_TONE_COLOR_SLOTS[tone] ?? 7
    }
    if (activeExtra) {
      const tone = getSectionToneFromText(`${activeExtra.section} ${activeExtra.category ?? ''} ${activeExtra.name}`)
      return SECTION_TONE_COLOR_SLOTS[tone] ?? 7
    }
    return 7
  }, [activeExercise, activeExtra])

  const circuitGroups = useMemo(() => {
    const groups = new Map<string, {
      items: Array<{ exercise: WorkoutExercise, index: number }>
      rounds?: number
      restAfterSec?: number
      totalExercises?: number
    }>()

    exercises.forEach((exercise, index) => {
      const circuit = exercise.circuit
      if (!circuit?.name) return
      const existing = groups.get(circuit.name) ?? { items: [], rounds: circuit.rounds, restAfterSec: circuit.restAfterSec, totalExercises: circuit.totalExercises }
      existing.items.push({ exercise, index })
      if (existing.rounds === undefined && circuit.rounds !== undefined) existing.rounds = circuit.rounds
      if (existing.restAfterSec === undefined && circuit.restAfterSec !== undefined) existing.restAfterSec = circuit.restAfterSec
      if (existing.totalExercises === undefined && circuit.totalExercises !== undefined) existing.totalExercises = circuit.totalExercises
      groups.set(circuit.name, existing)
    })

    return groups
  }, [exercises])

  const activeCircuit = useMemo(() => {
    const circuitName = activeExercise?.circuit?.name
    if (!circuitName || !activeExercise) return null
    const group = circuitGroups.get(circuitName)
    const items = group?.items.length
      ? group.items
      : [{ exercise: activeExercise, index: 0 }]
    const sortedItems = [...items].sort((a, b) => {
      const orderA = a.exercise.circuit?.order ?? a.index
      const orderB = b.exercise.circuit?.order ?? b.index
      return orderA - orderB
    })
    const exercisesInCircuit = sortedItems.map((item) => item.exercise)
    const activeOrderIndex = exercisesInCircuit.findIndex((exercise) => exercise.id === activeExercise.id)
    const activeOrder = activeExercise.circuit?.order ?? (activeOrderIndex >= 0 ? activeOrderIndex + 1 : undefined)
    const totalExercises = activeExercise.circuit?.totalExercises ?? group?.totalExercises ?? exercisesInCircuit.length
    const workingSetCount = activeExercise.sets.reduce((count, setItem) => (setItem.isWarmup ? count : count + 1), 0)
    const rounds = activeExercise.circuit?.rounds ?? group?.rounds ?? workingSetCount
    const restAfterSec = activeExercise.circuit?.restAfterSec ?? group?.restAfterSec

    return {
      name: circuitName,
      items: exercisesInCircuit,
      activeOrder,
      totalExercises,
      rounds,
      restAfterSec,
    }
  }, [activeExercise, circuitGroups])

  const getNextCircuitExercise = useCallback((items: WorkoutExercise[]): WorkoutExercise | null => {
    let nextExercise: WorkoutExercise | null = null
    let nextRoundIndex = Number.POSITIVE_INFINITY
    let nextOrder = Number.POSITIVE_INFINITY

    items.forEach((exercise, order) => {
      const stateList = setLogs[exercise.id] || []
      const nextSetIndex = exercise.sets.findIndex((_, index) => !stateList[index]?.done)
      if (nextSetIndex === -1) return

      const nextSet = exercise.sets[nextSetIndex]
      const roundIndex = nextSet?.isWarmup
        ? -1
        : exercise.sets.slice(0, nextSetIndex + 1).reduce((count, setItem) => (
          setItem?.isWarmup ? count : count + 1
        ), 0) - 1

      if (
        !nextExercise
        || roundIndex < nextRoundIndex
        || (roundIndex === nextRoundIndex && order < nextOrder)
      ) {
        nextExercise = exercise
        nextRoundIndex = roundIndex
        nextOrder = order
      }
    })

    return nextExercise
  }, [setLogs])

  const stateList = activeExercise
    ? activeExercise.sets.map((_, index) => (
      setLogs[activeExercise.id]?.[index] ?? { weight: '', metric: '', done: false }
    ))
    : []
  const nextIndex = activeExercise
    ? activeExercise.sets.findIndex((_, index) => !stateList[index]?.done)
    : -1
  const hasNext = nextIndex !== -1
  const circuitLogTarget = activeCircuit ? getNextCircuitExercise(activeCircuit.items) : null
  const logTargetExercise = activeExercise
    ? (hasNext ? activeExercise : (circuitLogTarget ?? null))
    : null
  const logTargetStateList = logTargetExercise
    ? logTargetExercise.sets.map((_, index) => (
      setLogs[logTargetExercise.id]?.[index] ?? { weight: '', metric: '', done: false }
    ))
    : []
  const logTargetNextIndex = logTargetExercise
    ? logTargetExercise.sets.findIndex((_, index) => !logTargetStateList[index]?.done)
    : -1
  const hasLogTarget = Boolean(logTargetExercise && logTargetNextIndex !== -1)
  const circuitHasPending = activeCircuit
    ? activeCircuit.items.some((exercise) => {
      const exerciseStates = setLogs[exercise.id] || []
      return exercise.sets.some((_, index) => !exerciseStates[index]?.done)
    })
    : hasNext
  const holdTimerEnabled = Boolean(activeExercise && activeExercise.metric === 'time' && activeExercise.timer?.enabled)
  const isAllDone = Boolean(activeExercise && !circuitHasPending && !hasLogTarget)
  const footerTitle = isAllDone ? detailTitle : (logTargetExercise?.name ?? detailTitle)

  const holdTargetSec = activeExercise && hasNext
    ? (parseDurationToSeconds(activeExercise.sets[nextIndex]?.targetTime) ?? 60)
    : 0
  const holdPrepSec = activeExercise?.timer?.prepSec ?? 3
  const nextActionLabel = useMemo(() => {
    if (isAllDone) return t('workout.allDone')

    const nextSet = logTargetExercise?.sets[logTargetNextIndex]
    if (nextSet?.isWarmup) {
      const warmupIndex = (logTargetExercise?.sets.slice(0, logTargetNextIndex + 1) ?? [])
        .filter((set) => set.isWarmup).length
      return t('workout.logWarmup', { count: warmupIndex })
    }

    if (logTargetExercise?.circuit?.name) {
      return t('workout.logExercise', { name: logTargetExercise.name })
    }

    return t('workout.logSet', { count: (logTargetNextIndex === -1 ? logTargetStateList.length : logTargetNextIndex) + 1 })
  }, [isAllDone, logTargetExercise, logTargetNextIndex, logTargetStateList.length, t])

  useEffect(() => {
    setCoachChatOpen(false)
    setCoachDraft('')
    setHistoryOpen(false)
  }, [activeExercise?.id])

  const openExerciseHistory = useCallback(() => {
    const exerciseId = activeExercise?.exerciseKey
    if (!exerciseId) return
    setCoachChatOpen(false)
    setHistoryOpen(true)
    setHistoryLoading(true)
    setHistoryError(false)
    const requestId = historyRequestRef.current + 1
    historyRequestRef.current = requestId
    fetchExerciseHistory({ apiBaseUrl, getHeaders: getAuthHeaders, exerciseId, limit: 20 })
      .then((rows) => {
        if (historyRequestRef.current !== requestId) return
        setHistorySessions(groupExerciseHistory(rows))
      })
      .catch(() => {
        if (historyRequestRef.current !== requestId) return
        setHistorySessions([])
        setHistoryError(true)
      })
      .finally(() => {
        if (historyRequestRef.current === requestId) setHistoryLoading(false)
      })
  }, [activeExercise?.exerciseKey, apiBaseUrl, getAuthHeaders])

  const renderDetailContent = () => {
    if (activeExtra) {
      return (
        <>
          <div className="detail-summary-card">
            <p className="card-label">{activeExtra.section}</p>
            <p className="card-sub">{activeExtra.summary}</p>
          </div>
          <div className="detail-cues">
            <div className="detail-cues-large">
              <p className="cues-label">{t('workout.notesLabel')}</p>
              <ul>
                {activeExtra.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="set-list"></div>
          <div className="set-list-actions hidden"></div>
        </>
      )
    }

    if (!activeExercise) {
      return null
    }

    const isSkipped = activeExercise.sets.length === 0
    const isCircuitMove = Boolean(activeCircuit)
    const setLabel = isCircuitMove ? t('workout.roundLabel') : t('workout.setLabel')
    const exerciseCues = Array.isArray(activeExercise.cues) ? activeExercise.cues : []

    return (
      <>
        <div className="detail-summary-card detail-target-card">
          <p className="card-label">{isSkipped ? `${activeExercise.section} • ${t('workout.skipped')}` : t('workout.targetLabel')}</p>
          {isSkipped ? null : <p className="card-sub">{activeExercise.summary}</p>}
        </div>
        {activeExercise.exerciseKey ? (
          <VideoGallery
            exerciseKey={activeExercise.exerciseKey}
            exerciseName={activeExercise.name}
            apiBaseUrl={apiBaseUrl}
            getAuthHeaders={getAuthHeaders}
          />
        ) : null}
        {exerciseCues.length > 0 ? (
          <div className="detail-cues">
            <div className="detail-cues-large">
              <p className="cues-label">{t('workout.formCues')}</p>
              <ul>
                {exerciseCues.map((cue) => (
                  <li key={cue}>{cue}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {activeCircuit ? (
          <div className="move-context move-context--compact">
            <span className="move-context-label">{activeCircuit.name}</span>
            <div className="move-context-main">
              <span className="move-context-meta">
                {t('workout.moveOfTotal', {
                  current: activeCircuit.activeOrder ?? 1,
                  total: activeCircuit.totalExercises ?? activeCircuit.items.length,
                })}
              </span>
            </div>
          </div>
        ) : null}
        <ExerciseSetList
          exercise={activeExercise}
          setLabel={setLabel}
          stateList={stateList}
          nextIndex={nextIndex}
          editingSet={editingSet}
          holdTimer={holdTimer}
          holdTimerEnabled={holdTimerEnabled}
          holdTargetSec={holdTargetSec}
          holdPrepSec={holdPrepSec}
          canLogDay={canLogDay}
          onSkipSet={onSkipSet}
          onUnlogSet={onUnlogSet}
          onStartEditingSet={onStartEditingSet}
          onSaveEditingSet={onSaveEditingSet}
          onCancelEditingSet={onCancelEditingSet}
          onUpdateSetField={onUpdateSetField}
          onStartHoldTimer={onStartHoldTimer}
          onLogHoldTimerSet={onLogHoldTimerSet}
        />
        <ExerciseFeedback
          key={activeExercise.id}
          note={activeExercise.notes ?? ''}
          preset={activeExercise.feedbackPreset ?? null}
          canEdit={canLogDay}
          saving={savingExerciseFeedback}
          onSave={(note, preset) => onSaveExerciseFeedback(activeExercise.id, note, preset)}
        />
        {activeCircuit ? (
          <div className="circuit-card">
            <div className="circuit-header">
              <div>
                <p className="circuit-eyebrow">{t('workout.circuit')}</p>
                <h3 className="circuit-title">{activeCircuit.name}</h3>
              </div>
              <div className="circuit-meta">
                {activeCircuit.rounds ? (
                  <span>{t('workout.roundsCount', { count: activeCircuit.rounds })}</span>
                ) : null}
                {typeof activeCircuit.restAfterSec === 'number' ? (
                  <span>{t('workout.restSeconds', { count: activeCircuit.restAfterSec })}</span>
                ) : null}
              </div>
            </div>
            <ol className="circuit-list">
              {activeCircuit.items.map((exercise, itemIndex) => {
                const order = exercise.circuit?.order ?? (itemIndex + 1)
                const target = formatCircuitTarget(exercise)
                const isActive = exercise.id === activeExercise.id

                return (
                  <li key={`${exercise.id}-circuit`} className={`circuit-item ${isActive ? 'active' : ''}`}>
                    <button
                      className="circuit-item-btn"
                      type="button"
                      onClick={() => onSelectEntry(exercise.id, 'exercise')}
                    >
                      <span className="circuit-index">{order}</span>
                      <div className="circuit-body">
                        <span className="circuit-name">{exercise.name}</span>
                        {target ? <span className="circuit-target">{target}</span> : null}
                      </div>
                      {isActive ? <span className="circuit-active">{t('workout.now')}</span> : null}
                    </button>
                  </li>
                )
              })}
            </ol>
            <p className="circuit-note">
              {typeof activeCircuit.restAfterSec === 'number'
                ? t('workout.circuitNoteWithRest', { count: activeCircuit.restAfterSec })
                : t('workout.circuitNote')}
            </p>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <section className={`view ${active ? 'active' : ''}`} data-view="workout">
      {!activeEntryId ? (
        <>
          <WorkoutMiniBar
            activeWeekDay={activeWeekDay}
            selectedDayLabel={selectedDayLabel}
          />
        </>
      ) : null}

      <WeekStrip days={weekDays} onSelectDay={onSelectDay} />

      <WorkoutPlanList
        activeEntryId={activeEntryId}
        hasWeekWorkouts={hasWeekWorkouts}
        loading={loading}
        selectedDayLabel={selectedDayLabel}
        exercises={exercises}
        extras={extras}
        setLogs={setLogs}
        planNotes={planNotes}
        canEditPlanNotes={canLogDay}
        savingPlanNotes={savingDayNote}
        onSavePlanNotes={onSaveDayNote}
        circuitGroups={circuitGroups}
        getNextCircuitExercise={getNextCircuitExercise}
        onSelectEntry={onSelectEntry}
      />

      <section className={`workout-detail ${activeEntryId ? 'active' : ''}`} data-section-color={detailSectionColorSlot}>
        <div className="detail-header-bar">
          <button className="back-btn" type="button" onClick={onBack}>
            <span className="icon-back">‹</span> {t('common.back')}
          </button>
          <div className="detail-title-block">
            <h1 className="detail-title-text">{detailTitle}</h1>
          </div>
          {activeExercise ? (
            <div className="detail-header-actions">
              {activeExercise.exerciseKey ? (
                <button
                  type="button"
                  className={`detail-history-btn${historyOpen ? ' active' : ''}`}
                  aria-label={t('workout.historyTitle')}
                  aria-expanded={historyOpen}
                  onClick={openExerciseHistory}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M3 3v5h5M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
              <button
                type="button"
                className={`detail-coach-btn${coachChatOpen ? ' active' : ''}`}
                aria-label={t('workout.askCoach')}
                aria-expanded={coachChatOpen}
                disabled={!coachChatEnabled}
                onClick={() => {
                  setHistoryOpen(false)
                  setCoachChatOpen((current) => !current)
                }}
              >
                <svg className="detail-coach-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : (
            <span className="detail-header-spacer" aria-hidden="true" />
          )}
        </div>

        <div className="detail-content">
          {renderDetailContent()}
        </div>

        <div className="detail-footer">
          <div className={`footer-actions ${activeExtra ? 'hidden' : ''}`}>
            <button
              className="primary large detail-log-button"
              type="button"
              aria-label={`${isAllDone ? t('common.done') : t('workout.now')} ${footerTitle}: ${nextActionLabel}`}
              onClick={isAllDone ? onBack : () => onLogSet(logTargetExercise?.id)}
              disabled={!canLogDay || (!isAllDone && !hasLogTarget)}
            >
              <span className="detail-log-main">
                <span>{isAllDone ? t('common.done') : t('workout.now')}</span>
                <strong>{footerTitle}</strong>
              </span>
              <span className="detail-log-action">{nextActionLabel}</span>
            </button>
          </div>
        </div>

        {activeExercise ? (
          <ExerciseHistorySheet
            open={historyOpen}
            loading={historyLoading}
            error={historyError ? t('workout.historyError') : null}
            exerciseName={activeExercise.name}
            sessions={historySessions}
            onClose={() => setHistoryOpen(false)}
          />
        ) : null}

        {activeExercise ? (
          <CoachChat
            open={coachChatOpen}
            disabled={!coachChatEnabled}
            messages={coachMessages}
            showModelLabels={showModelLabels}
            draft={coachDraft}
            onToggle={() => setCoachChatOpen((current) => !current)}
            onDraftChange={setCoachDraft}
            onSend={() => {
              const text = coachDraft.trim()
              if (!text || !activeExercise) return
              onCoachSend(activeExercise.id, text)
              setCoachDraft('')
            }}
            onQuickPrompt={(message) => {
              if (activeExercise) onCoachSend(activeExercise.id, message)
            }}
          />
        ) : null}
      </section>
    </section>
  )
}

export default WorkoutView
