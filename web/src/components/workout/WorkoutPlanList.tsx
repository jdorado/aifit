import { useCallback, useEffect, useRef, useState, type FC, type MouseEvent as ReactMouseEvent, type TouchEvent } from 'react'
import { useI18n } from '../../i18n'
import type { WorkoutExercise, WorkoutExtra } from '../../data/testWorkout'
import type { ActiveEntryType, SetState } from '../../types/app'
import NotesBlock from './NotesBlock'
import PlanNotes from './PlanNotes'

type SectionTone = 'default' | 'warmup' | 'main' | 'conditioning' | 'circuit' | 'rehab' | 'cooldown' | 'recovery' | 'night'

type SectionInfo = {
  key: string
  label: string
  tone: SectionTone
}

const SECTION_COLOR_COUNT = 8
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

type PlanSwipeState = {
  startX: number
  startY: number
  exerciseId: string
}

type ExtraSwipeState = {
  startX: number
  startY: number
  extraId: string
}

type CircuitGroup = {
  items: Array<{ exercise: WorkoutExercise, index: number }>
  rounds?: number
  restAfterSec?: number
  totalExercises?: number
}

type WorkoutPlanListProps = {
  activeEntryId: string | null
  canEditPlan: boolean
  hasWeekWorkouts: boolean
  loading: boolean
  selectedDayLabel: string
  exercises: WorkoutExercise[]
  extras: WorkoutExtra[]
  setLogs: Record<string, SetState[]>
  planNotes: string
  dayNotes: string
  circuitGroups: Map<string, CircuitGroup>
  getNextCircuitExercise: (items: WorkoutExercise[]) => WorkoutExercise | null
  onSelectEntry: (id: string, type: ActiveEntryType) => void
  onRemoveExercise: (exerciseId: string) => void
  onRemoveExtra: (extraId: string) => void
  onRemoveCircuit: (circuitName: string) => void
  onRemoveSection: (sectionLabel: string) => void
  onUpdateDayNotes: (value: string) => void
}

const DEFAULT_COLLAPSED_SECTIONS: Record<string, boolean> = {}

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
)

const WorkoutPlanList: FC<WorkoutPlanListProps> = ({
  activeEntryId,
  canEditPlan,
  hasWeekWorkouts,
  loading,
  selectedDayLabel,
  exercises,
  extras,
  setLogs,
  planNotes,
  dayNotes,
  circuitGroups,
  getNextCircuitExercise,
  onSelectEntry,
  onRemoveExercise,
  onRemoveExtra,
  onRemoveCircuit,
  onRemoveSection,
  onUpdateDayNotes,
}) => {
  const { t } = useI18n()
  const [planSwipeActiveId, setPlanSwipeActiveId] = useState<string | null>(null)
  const planSwipeRef = useRef<PlanSwipeState | null>(null)
  const planSwipeIgnoreClickRef = useRef(false)
  const [extraSwipeActiveId, setExtraSwipeActiveId] = useState<string | null>(null)
  const extraSwipeRef = useRef<ExtraSwipeState | null>(null)
  const extraSwipeIgnoreClickRef = useRef(false)
  const [planNotesOpen, setPlanNotesOpen] = useState(false)
  const [dayNotesOpen, setDayNotesOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_COLLAPSED_SECTIONS }))

  useEffect(() => {
    setDayNotesOpen(false)
  }, [selectedDayLabel])

  useEffect(() => {
    setPlanSwipeActiveId(null)
  }, [canEditPlan, exercises])

  useEffect(() => {
    setExtraSwipeActiveId(null)
  }, [canEditPlan, extras])

  const handlePlanTouchStart = (exerciseId: string) => (event: TouchEvent<HTMLElement>) => {
    if (!canEditPlan) return
    const touch = event.touches[0]
    planSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, exerciseId }
  }

  const handlePlanTouchEnd = (exerciseId: string) => (event: TouchEvent<HTMLElement>) => {
    if (!canEditPlan) return
    if (!planSwipeRef.current) return
    const touch = event.changedTouches[0]
    const deltaX = touch.clientX - planSwipeRef.current.startX
    const deltaY = touch.clientY - planSwipeRef.current.startY
    const isHorizontal = Math.abs(deltaX) > Math.abs(deltaY)

    if (isHorizontal && Math.abs(deltaX) > 50) {
      planSwipeIgnoreClickRef.current = true
      if (deltaX < 0) {
        setPlanSwipeActiveId(exerciseId)
      } else if (deltaX > 0) {
        setPlanSwipeActiveId((current) => (current === exerciseId ? null : current))
      }
      window.setTimeout(() => {
        planSwipeIgnoreClickRef.current = false
      }, 250)
    }

    planSwipeRef.current = null
  }

  const handlePlanCardClick = (exerciseId: string) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-plan-action]')) return
    if (planSwipeIgnoreClickRef.current) return

    if (planSwipeActiveId !== null) {
      setPlanSwipeActiveId(null)
      return
    }

    onSelectEntry(exerciseId, 'exercise')
  }

  const handleRemoveExercise = useCallback((exercise: WorkoutExercise) => {
    const confirmed = window.confirm(t('workout.removeExerciseConfirm', { name: exercise.name }))
    if (!confirmed) return
    setPlanSwipeActiveId(null)
    onRemoveExercise(exercise.id)
  }, [onRemoveExercise, t])

  const handleRemoveCircuit = useCallback((circuitName: string) => {
    const confirmed = window.confirm(t('workout.removeCircuitConfirm', { name: circuitName }))
    if (!confirmed) return
    setPlanSwipeActiveId(null)
    onRemoveCircuit(circuitName)
  }, [onRemoveCircuit, t])

  const handleRemoveSection = useCallback((sectionLabel: string) => {
    const confirmed = window.confirm(t('workout.removeSectionConfirm', { name: sectionLabel }))
    if (!confirmed) return
    setPlanSwipeActiveId(null)
    setExtraSwipeActiveId(null)
    onRemoveSection(sectionLabel)
  }, [onRemoveSection, t])

  const handleExtraTouchStart = (extraId: string) => (event: TouchEvent<HTMLDivElement>) => {
    if (!canEditPlan) return
    const touch = event.touches[0]
    extraSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, extraId }
  }

  const handleExtraTouchEnd = (extraId: string) => (event: TouchEvent<HTMLDivElement>) => {
    if (!canEditPlan) return
    if (!extraSwipeRef.current) return
    const touch = event.changedTouches[0]
    const deltaX = touch.clientX - extraSwipeRef.current.startX
    const deltaY = touch.clientY - extraSwipeRef.current.startY
    const isHorizontal = Math.abs(deltaX) > Math.abs(deltaY)

    if (isHorizontal && Math.abs(deltaX) > 50) {
      extraSwipeIgnoreClickRef.current = true
      if (deltaX < 0) {
        setExtraSwipeActiveId(extraId)
      } else if (deltaX > 0) {
        setExtraSwipeActiveId((current) => (current === extraId ? null : current))
      }
      window.setTimeout(() => {
        extraSwipeIgnoreClickRef.current = false
      }, 250)
    }

    extraSwipeRef.current = null
  }

  const handleExtraCardClick = (extraId: string) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-extra-action]')) return
    if (extraSwipeIgnoreClickRef.current) return

    if (extraSwipeActiveId !== null) {
      setExtraSwipeActiveId(null)
      return
    }

    onSelectEntry(extraId, 'extra')
  }

  const toggleSection = useCallback((sectionKey: string) => {
    setCollapsedSections((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }))
  }, [])

  const normalizeSectionKey = (value: string) => (
    (value.trim() || t('workout.sectionWorkout'))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'workout'
  )

  const getSectionToneFromText = (rawHaystack: string): SectionTone => {
    const haystack = rawHaystack.toLowerCase()
    if (/(warmup|primer|activation|mobility)/.test(haystack)) {
      return 'warmup'
    }
    if (/(rehab|prehab|physio)/.test(haystack)) {
      return 'rehab'
    }
    if (/(circuit|superset|giant set)/.test(haystack)) {
      return 'circuit'
    }
    if (/(main|strength|hypertrophy|power|lift|compound|accessory)/.test(haystack)) {
      return 'main'
    }
    if (/(conditioning|zone 2|z2|cardio|aerobic|elliptical|bike|treadmill|rower|assault bike|interval)/.test(haystack)) {
      return 'conditioning'
    }
    if (/(cooldown|cool down|stretch|decompression|yin|active rest)/.test(haystack)) {
      return 'cooldown'
    }
    if (/(night|evening|sleep|bedtime|downshift)/.test(haystack)) {
      return 'night'
    }
    if (/(recovery|sauna|hot yoga|yoga|evening|downshift)/.test(haystack)) {
      return 'recovery'
    }
    return 'default'
  }

  const getSectionInfoFromEntry = (section: string | undefined, rawHaystack: string): SectionInfo => {
    const label = section?.trim() || t('workout.sectionWorkout')
    return {
      key: normalizeSectionKey(label),
      label,
      tone: getSectionToneFromText(`${label} ${rawHaystack}`),
    }
  }

  const getStageInfo = (exercise: WorkoutExercise) => (
    getSectionInfoFromEntry(exercise.section, `${exercise.category ?? ''} ${exercise.name ?? ''}`)
  )

  const getExtraStageInfo = (extra: WorkoutExtra) => (
    getSectionInfoFromEntry(extra.section, `${extra.category ?? ''} ${extra.name ?? ''}`)
  )

  const sectionColorSlots = new Map<string, number>()
  const usedSectionColorSlots = new Set<number>()
  let nextSectionColorSlot = 0
  const getSectionColorSlot = (sectionKey: string, tone: SectionTone) => {
    const existing = sectionColorSlots.get(sectionKey)
    if (existing !== undefined) return existing
    const toneSlot = SECTION_TONE_COLOR_SLOTS[tone]
    let next = toneSlot
    if (next === undefined) {
      while (usedSectionColorSlots.has(nextSectionColorSlot % SECTION_COLOR_COUNT)) {
        nextSectionColorSlot += 1
      }
      next = nextSectionColorSlot % SECTION_COLOR_COUNT
      nextSectionColorSlot += 1
    }
    usedSectionColorSlots.add(next)
    sectionColorSlots.set(sectionKey, next)
    return next
  }

  const renderStageHeader = (stage: SectionInfo, key: string, colorSlot: number) => {
    const collapsed = Boolean(collapsedSections[stage.key])
    const stageSwipeId = `section:${stage.key}`
    return (
      <div
        key={key}
        data-stage={stage.tone}
        data-section-color={colorSlot}
        className={`workout-stage-row ${canEditPlan && planSwipeActiveId === stageSwipeId ? 'show-actions' : ''}`}
        onTouchStart={canEditPlan ? handlePlanTouchStart(stageSwipeId) : undefined}
        onTouchEnd={canEditPlan ? handlePlanTouchEnd(stageSwipeId) : undefined}
      >
        <button
          className={`workout-stage ${collapsed ? 'is-collapsed' : ''}`}
          type="button"
          data-stage={stage.tone}
          data-section-color={colorSlot}
          aria-expanded={!collapsed}
          onClick={() => {
            if (planSwipeIgnoreClickRef.current) return
            if (planSwipeActiveId !== null) {
              setPlanSwipeActiveId(null)
              return
            }
            toggleSection(stage.key)
          }}
        >
          <span className="workout-stage-label">{stage.label}</span>
          <span className="workout-stage-chevron" aria-hidden="true">&gt;</span>
        </button>
        {canEditPlan ? (
          <div className="workout-stage-actions">
            <button
              className="plan-row-action danger"
              type="button"
              title={t('workout.removeSection')}
              aria-label={t('workout.removeSection')}
              onClick={() => handleRemoveSection(stage.label)}
            >
              <span className="plan-row-action-icon" aria-hidden="true">
                <TrashIcon />
              </span>
              <span className="plan-row-action-label">{t('workout.deleteAction')}</span>
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  const cards: JSX.Element[] = []
  const renderedCircuits = new Set<string>()
  let lastStageKey: string | null = null
  const isEmptyDay = exercises.length === 0 && extras.length === 0
  const hideEmptyState = loading && isEmptyDay
  const showEmptyState = !hideEmptyState && !hasWeekWorkouts && isEmptyDay
  const showNoWorkoutCard = !hideEmptyState && hasWeekWorkouts && isEmptyDay
  const planNoteLines = planNotes
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean)
  const extraCards: JSX.Element[] = []
  const priorityExtraCards: JSX.Element[] = []
  let lastExtraStageKey: string | null = null
  let lastPriorityExtraStageKey: string | null = null

  exercises.forEach((exercise) => {
    const circuitName = exercise.circuit?.name
    if (circuitName) {
      if (renderedCircuits.has(circuitName)) return
      renderedCircuits.add(circuitName)
      const stage = getStageInfo(exercise)
      const colorSlot = getSectionColorSlot(stage.key, stage.tone)
      if (stage.key !== lastStageKey) {
        cards.push(renderStageHeader(stage, `stage-${stage.key}-${exercise.id}`, colorSlot))
        lastStageKey = stage.key
      }
      if (collapsedSections[stage.key]) return

      const group = circuitGroups.get(circuitName)
      const items = group?.items.length
        ? [...group.items].sort((a, b) => {
          const orderA = a.exercise.circuit?.order ?? a.index
          const orderB = b.exercise.circuit?.order ?? b.index
          return orderA - orderB
        })
        : [{ exercise, index: 0 }]
      const exercisesInCircuit = items.map((item) => item.exercise)
      const getWorkSetCount = (exerciseItem: WorkoutExercise) => (
        exerciseItem.sets.reduce((count, setItem) => (setItem.isWarmup ? count : count + 1), 0)
      )
      const getDoneWorkSetCount = (exerciseItem: WorkoutExercise) => {
        const stateList = setLogs[exerciseItem.id] || []
        return exerciseItem.sets.reduce((count, setItem, index) => (
          setItem.isWarmup ? count : (stateList[index]?.done ? count + 1 : count)
        ), 0)
      }

      const rounds = exercise.circuit?.rounds ?? group?.rounds ?? getWorkSetCount(exercise)
      const totalExercises = exercise.circuit?.totalExercises ?? group?.totalExercises ?? exercisesInCircuit.length
      const restAfterSec = exercise.circuit?.restAfterSec ?? group?.restAfterSec
      const workSetCounts = exercisesInCircuit.map((item) => getWorkSetCount(item))
      const doneWorkSetCounts = exercisesInCircuit.map((item) => getDoneWorkSetCount(item))
      const targetWorkSetCount = workSetCounts.reduce((total, count) => total + count, 0)
      const completedWorkSetCount = doneWorkSetCounts.reduce((total, count) => total + count, 0)
      const doneRounds = doneWorkSetCounts.length
        ? Math.min(...doneWorkSetCounts)
        : 0
      const isCompleted = targetWorkSetCount > 0 && completedWorkSetCount >= targetWorkSetCount
      const progress = isCompleted
        ? t('common.done')
        : targetWorkSetCount
          ? t('workout.progressFraction', { done: completedWorkSetCount, total: targetWorkSetCount })
          : rounds
            ? t('workout.roundProgress', { current: Math.min(doneRounds + 1, rounds), total: rounds })
            : t('common.start')
      const summaryParts = [
        t('workout.movesCount', { count: totalExercises }),
        rounds ? t('workout.roundsCount', { count: rounds }) : null,
        typeof restAfterSec === 'number' ? t('workout.restSeconds', { count: restAfterSec }) : null,
      ].filter(Boolean).join(' · ')
      const nextExercise = getNextCircuitExercise(exercisesInCircuit)
      const circuitSwipeId = `circuit:${circuitName}`

      cards.push(
        <div
          key={`circuit-row-${circuitName}`}
          className={`plan-row ${canEditPlan && planSwipeActiveId === circuitSwipeId ? 'show-actions' : ''}`}
          onTouchStart={canEditPlan ? handlePlanTouchStart(circuitSwipeId) : undefined}
          onTouchEnd={canEditPlan ? handlePlanTouchEnd(circuitSwipeId) : undefined}
        >
          <div
            className={`workout-card circuit-group ${isCompleted ? 'is-completed' : ''}`}
            data-stage={stage.tone}
            data-section-color={colorSlot}
            role="group"
            aria-label={t('workout.circuitAria', { name: circuitName })}
          >
            <button
              className="circuit-group-start"
              type="button"
              onClick={handlePlanCardClick((nextExercise || exercisesInCircuit[0]).id)}
            >
              <div>
                <p className="card-label">{t('workout.circuit')}</p>
                <h3>{circuitName}</h3>
                <p className="card-sub">{summaryParts}</p>
              </div>
              <div className="card-meta">
                <span className={`badge ${isCompleted ? 'completed-badge' : ''}`}>{progress}</span>
                <span className="chevron">&gt;</span>
              </div>
            </button>
            <ol className="circuit-preview">
              {exercisesInCircuit.map((item, itemIndex) => {
                const order = item.circuit?.order ?? (itemIndex + 1)
                return (
                  <li
                    key={`${item.id}-preview`}
                    className={`circuit-preview-item ${canEditPlan && planSwipeActiveId === item.id ? 'show-actions' : ''}`}
                    onTouchStart={canEditPlan
                      ? (event) => {
                        event.stopPropagation()
                        handlePlanTouchStart(item.id)(event)
                      }
                      : undefined}
                    onTouchEnd={canEditPlan
                      ? (event) => {
                        event.stopPropagation()
                        handlePlanTouchEnd(item.id)(event)
                      }
                      : undefined}
                  >
                    <button
                      className="circuit-preview-btn"
                      type="button"
                      onClick={handlePlanCardClick(item.id)}
                    >
                      <span className="circuit-preview-index">{order}</span>
                      <span className="circuit-preview-name">{item.name}</span>
                    </button>
                    {canEditPlan ? (
                      <div className="circuit-preview-actions">
                        <button
                          className="plan-row-action danger"
                          type="button"
                          data-plan-action="remove"
                          title={t('workout.removeExercise')}
                          aria-label={t('workout.removeExercise')}
                          onClick={() => handleRemoveExercise(item)}
                        >
                          <span className="plan-row-action-icon" aria-hidden="true">
                            <TrashIcon />
                          </span>
                          <span className="plan-row-action-label">{t('workout.deleteAction')}</span>
                        </button>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          </div>
          {canEditPlan ? (
            <div className="plan-row-actions">
              <button
                className="plan-row-action danger"
                type="button"
                title={t('workout.removeCircuit')}
                aria-label={t('workout.removeCircuit')}
                onClick={() => handleRemoveCircuit(circuitName)}
              >
                <span className="plan-row-action-icon" aria-hidden="true">
                  <TrashIcon />
                </span>
                <span className="plan-row-action-label">{t('workout.deleteAction')}</span>
              </button>
            </div>
          ) : null}
        </div>
      )
      return
    }

    const stateList = setLogs[exercise.id]
    const doneCount = stateList?.filter((set) => set.done).length ?? 0
    const total = exercise.sets.length
    const isCompleted = total > 0 && doneCount === total
    const progress = isCompleted
      ? t('common.done')
      : (total ? t('workout.progressFraction', { done: doneCount, total }) : t('workout.skip'))
    const stage = getStageInfo(exercise)
    const colorSlot = getSectionColorSlot(stage.key, stage.tone)
    if (stage.key !== lastStageKey) {
      cards.push(renderStageHeader(stage, `stage-${stage.key}-${exercise.id}`, colorSlot))
      lastStageKey = stage.key
    }
    if (collapsedSections[stage.key]) return

    cards.push(
      <div
        key={exercise.id}
        className={`plan-row ${canEditPlan && planSwipeActiveId === exercise.id ? 'show-actions' : ''}`}
        onTouchStart={canEditPlan ? handlePlanTouchStart(exercise.id) : undefined}
        onTouchEnd={canEditPlan ? handlePlanTouchEnd(exercise.id) : undefined}
      >
        <button
          className={`workout-card ${exercise.status === 'skip' ? 'is-skip' : ''} ${isCompleted ? 'is-completed' : ''}`}
          type="button"
          onClick={handlePlanCardClick(exercise.id)}
          data-stage={stage.tone}
          data-section-color={colorSlot}
        >
          <div>
            <p className="card-label">{exercise.section}</p>
            <h3>{exercise.name}</h3>
            <p className="card-sub">{exercise.summary}</p>
          </div>
          <div className="card-meta">
            <span className={`badge ${isCompleted ? 'completed-badge' : ''}`}>
              {exercise.status === 'skip' ? t('workout.skip') : progress}
            </span>
            <span className="chevron">&gt;</span>
          </div>
        </button>
        {canEditPlan ? (
          <div className="plan-row-actions">
            <button
              className="plan-row-action danger"
              type="button"
              data-plan-action="remove"
              title={t('workout.removeExercise')}
              aria-label={t('workout.removeExercise')}
              onClick={() => handleRemoveExercise(exercise)}
            >
              <span className="plan-row-action-icon" aria-hidden="true">
                <TrashIcon />
              </span>
              <span className="plan-row-action-label">{t('workout.deleteAction')}</span>
            </button>
          </div>
        ) : null}
      </div>
    )
  })

  extras.forEach((extra) => {
    const stage = getExtraStageInfo(extra)
    const colorSlot = getSectionColorSlot(stage.key, stage.tone)
    const targetCards = extra.isReadOnly ? priorityExtraCards : extraCards
    const lastKey = extra.isReadOnly ? lastPriorityExtraStageKey : lastExtraStageKey
    if (stage.key !== lastKey) {
      targetCards.push(renderStageHeader(stage, `extra-stage-${stage.key}-${extra.id}`, colorSlot))
      if (extra.isReadOnly) lastPriorityExtraStageKey = stage.key
      else lastExtraStageKey = stage.key
    }
    if (collapsedSections[stage.key]) return

    targetCards.push(
      <div
        key={extra.id}
        className={`plan-row ${canEditPlan && extraSwipeActiveId === extra.id ? 'show-actions' : ''}`}
        onTouchStart={canEditPlan ? handleExtraTouchStart(extra.id) : undefined}
        onTouchEnd={canEditPlan ? handleExtraTouchEnd(extra.id) : undefined}
      >
        <button
          className="workout-card extra"
          type="button"
          onClick={handleExtraCardClick(extra.id)}
          data-stage={stage.tone}
          data-section-color={colorSlot}
        >
          <div>
            <p className="card-label">{extra.section}</p>
            <h3>{extra.name}</h3>
            <p className="card-sub">{extra.summary}</p>
          </div>
          <div className="card-meta">
            <span className="badge">{t('common.info')}</span>
            <span className="chevron">&gt;</span>
          </div>
        </button>
        {canEditPlan && !extra.isReadOnly ? (
          <div className="plan-row-actions">
            <button
              className="plan-row-action danger"
              type="button"
              data-extra-action="remove"
              title={t('workout.removeExtra')}
              aria-label={t('workout.removeExtra')}
              onClick={() => {
                const confirmed = window.confirm(t('workout.removeExtraConfirm', { name: extra.name }))
                if (!confirmed) return
                setExtraSwipeActiveId(null)
                onRemoveExtra(extra.id)
              }}
            >
              <span className="plan-row-action-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </span>
              <span className="plan-row-action-label">{t('workout.deleteAction')}</span>
            </button>
          </div>
        ) : null}
      </div>
    )
  })

  return (
    <section className={`workout-list ${activeEntryId ? 'hidden' : ''}`}>
      <div className="list-section">
        <PlanNotes
          lines={planNoteLines}
          open={planNotesOpen}
          onToggle={() => setPlanNotesOpen((open) => !open)}
        />
        {showEmptyState ? (
          <div className="workout-card rest-day" role="status">
            <div>
              <p className="card-label">{t('workout.emptyPlanLabel')}</p>
              <h3>{t('workout.emptyPlanTitle')}</h3>
              <p className="card-sub">{t('workout.emptyPlanHint')}</p>
            </div>
          </div>
        ) : showNoWorkoutCard ? (
          <div className="workout-card rest-day" role="status">
            <div>
              <p className="card-label">{t('workout.noWorkoutLabel')}</p>
              <h3>{t('workout.noWorkoutTitle')}</h3>
              <p className="card-sub">{t('workout.noWorkoutHint')}</p>
            </div>
          </div>
        ) : [...priorityExtraCards, ...cards, ...extraCards]}
        {!hideEmptyState ? (
          <NotesBlock
            open={dayNotesOpen}
            canEdit={canEditPlan}
            title={t('workout.dayNotesLabel')}
            subtitle={t('workout.dayNotesHint')}
            value={dayNotes}
            placeholder={t('workout.dayNotesPlaceholder')}
            ariaLabel={t('workout.dayNotesLabel')}
            onToggle={() => setDayNotesOpen((open) => !open)}
            onChange={onUpdateDayNotes}
          />
        ) : null}
      </div>
    </section>
  )
}

export default WorkoutPlanList
