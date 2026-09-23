import { useCallback, useState, type FC } from 'react'
import { useI18n } from '../../i18n'
import type { WorkoutExercise, WorkoutExtra } from '../../data/testWorkout'
import { circuitGroupKey } from '../../data/testWorkout'
import type { ActiveEntryType, SetState } from '../../types/app'
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

type CircuitGroup = {
  items: Array<{ exercise: WorkoutExercise, index: number }>
  rounds?: number
  restAfterSec?: number
  totalExercises?: number
}

type WorkoutPlanListProps = {
  activeEntryId: string | null
  hasWeekWorkouts: boolean
  loading: boolean
  selectedDayLabel: string
  exercises: WorkoutExercise[]
  extras: WorkoutExtra[]
  setLogs: Record<string, SetState[]>
  planNotes: string
  canEditPlanNotes: boolean
  savingPlanNotes: boolean
  onSavePlanNotes: (notes: string) => Promise<boolean>
  circuitGroups: Map<string, CircuitGroup>
  getNextCircuitExercise: (items: WorkoutExercise[]) => WorkoutExercise | null
  onSelectEntry: (id: string, type: ActiveEntryType) => void
  canEditPlan: boolean
  onRemoveExercise: (exerciseId: string) => void
  onRemoveCircuit: (segmentId: string) => void
  onRemoveSection: (segmentIds: string[]) => void
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
  hasWeekWorkouts,
  loading,
  exercises,
  extras,
  setLogs,
  planNotes,
  canEditPlanNotes,
  savingPlanNotes,
  onSavePlanNotes,
  circuitGroups,
  getNextCircuitExercise,
  onSelectEntry,
  canEditPlan,
  onRemoveExercise,
  onRemoveCircuit,
  onRemoveSection,
}) => {
  const { t } = useI18n()
  const [planNotesOpen, setPlanNotesOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_COLLAPSED_SECTIONS }))

  const toggleSection = useCallback((sectionKey: string) => {
    setCollapsedSections((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }))
  }, [])

  const handleRemoveExercise = useCallback((exercise: WorkoutExercise) => {
    if (!window.confirm(t('workout.removeExerciseConfirm', { name: exercise.name }))) return
    onRemoveExercise(exercise.id)
  }, [onRemoveExercise, t])

  const handleRemoveCircuit = useCallback((segmentId: string, circuitName: string) => {
    if (!window.confirm(t('workout.removeCircuitConfirm', { name: circuitName }))) return
    onRemoveCircuit(segmentId)
  }, [onRemoveCircuit, t])

  const handleRemoveSection = useCallback((sectionLabel: string, segmentIds: string[]) => {
    if (!window.confirm(t('workout.removeSectionConfirm', { name: sectionLabel }))) return
    onRemoveSection(segmentIds)
  }, [onRemoveSection, t])

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

  // Canonical exercises carry their segment id; a section removal deletes each
  // distinct segment whose title maps to the section key.
  const getSectionSegmentIds = (sectionKey: string): string[] => (
    [...new Set(
      exercises
        .filter((exercise) => normalizeSectionKey(exercise.section) === sectionKey)
        .map((exercise) => exercise.segmentId)
        .filter((id): id is string => Boolean(id))
    )]
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

  const renderStageHeader = (stage: SectionInfo, key: string, colorSlot: number, sectionSegmentIds?: string[]) => {
    const collapsed = Boolean(collapsedSections[stage.key])
    const canRemoveSection = canEditPlan && Boolean(sectionSegmentIds?.length)
    return (
      <div
        key={key}
        data-stage={stage.tone}
        data-section-color={colorSlot}
        className="workout-stage-row"
      >
        <button
          className={`workout-stage ${collapsed ? 'is-collapsed' : ''}`}
          type="button"
          data-stage={stage.tone}
          data-section-color={colorSlot}
          aria-expanded={!collapsed}
          onClick={() => toggleSection(stage.key)}
        >
          <span className="workout-stage-label">{stage.label}</span>
          <span className="workout-stage-chevron" aria-hidden="true">&gt;</span>
        </button>
        {canRemoveSection ? (
          <button
            className="stage-trash-btn"
            type="button"
            title={t('workout.removeSection')}
            aria-label={t('workout.removeSection')}
            onClick={() => handleRemoveSection(stage.label, sectionSegmentIds ?? [])}
          >
            <TrashIcon />
          </button>
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
  const extraCards: JSX.Element[] = []
  const priorityExtraCards: JSX.Element[] = []
  let lastExtraStageKey: string | null = null
  let lastPriorityExtraStageKey: string | null = null

  exercises.forEach((exercise) => {
    const circuitName = exercise.circuit?.name
    const groupKey = circuitGroupKey(exercise.circuit)
    if (circuitName && groupKey) {
      if (renderedCircuits.has(groupKey)) return
      renderedCircuits.add(groupKey)
      const stage = getStageInfo(exercise)
      const colorSlot = getSectionColorSlot(stage.key, stage.tone)
      if (stage.key !== lastStageKey) {
        cards.push(renderStageHeader(stage, `stage-${stage.key}-${exercise.id}`, colorSlot, getSectionSegmentIds(stage.key)))
        lastStageKey = stage.key
      }
      if (collapsedSections[stage.key]) return

      const group = circuitGroups.get(groupKey)
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

      cards.push(
        <div
          key={`circuit-row-${groupKey}`}
          className="plan-row"
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
              onClick={() => onSelectEntry((nextExercise || exercisesInCircuit[0]).id, 'exercise')}
            >
              <div>
                <p className="card-label">{t('workout.circuit')}</p>
                <h3>{circuitName}</h3>
                <p className="card-sub">{summaryParts}</p>
              </div>
              <div className="card-meta">
                <span className={`badge ${isCompleted ? 'completed-badge' : ''}`}>{progress}</span>
                {canEditPlan ? null : <span className="chevron">&gt;</span>}
              </div>
            </button>
            <ol className="circuit-preview">
              {exercisesInCircuit.map((item, itemIndex) => {
                const order = item.circuit?.order ?? (itemIndex + 1)
                return (
                  <li
                    key={`${item.id}-preview`}
                    className="circuit-preview-item"
                  >
                    <button
                      className="circuit-preview-btn"
                      type="button"
                      onClick={() => onSelectEntry(item.id, 'exercise')}
                    >
                      <span className="circuit-preview-index">{order}</span>
                      <span className="circuit-preview-name">{item.name}</span>
                    </button>
                    {canEditPlan ? (
                      <button
                        className="circuit-preview-delete"
                        type="button"
                        title={t('workout.removeExercise')}
                        aria-label={t('workout.removeExercise')}
                        onClick={() => handleRemoveExercise(item)}
                      >
                        <TrashIcon />
                      </button>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          </div>
          {canEditPlan ? (
            <button
              className="plan-trash-btn"
              type="button"
              title={t('workout.removeCircuit')}
              aria-label={t('workout.removeCircuit')}
              onClick={() => handleRemoveCircuit(groupKey, circuitName)}
            >
              <TrashIcon />
            </button>
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
      cards.push(renderStageHeader(stage, `stage-${stage.key}-${exercise.id}`, colorSlot, getSectionSegmentIds(stage.key)))
      lastStageKey = stage.key
    }
    if (collapsedSections[stage.key]) return

    cards.push(
      <div
        key={exercise.id}
        className="plan-row"
      >
        <button
          className={`workout-card ${exercise.status === 'skip' ? 'is-skip' : ''} ${isCompleted ? 'is-completed' : ''}`}
          type="button"
          onClick={() => onSelectEntry(exercise.id, 'exercise')}
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
            {canEditPlan ? null : <span className="chevron">&gt;</span>}
          </div>
        </button>
        {canEditPlan ? (
          <button
            className="plan-trash-btn"
            type="button"
            title={t('workout.removeExercise')}
            aria-label={t('workout.removeExercise')}
            onClick={() => handleRemoveExercise(exercise)}
          >
            <TrashIcon />
          </button>
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
        className="plan-row"
      >
        <button
          className="workout-card extra"
          type="button"
          onClick={() => onSelectEntry(extra.id, 'extra')}
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
      </div>
    )
  })

  return (
    <section className={`workout-list ${activeEntryId ? 'hidden' : ''}`}>
      <div className="list-section">
        <PlanNotes
          notes={planNotes}
          open={planNotesOpen}
          canEdit={canEditPlanNotes}
          saving={savingPlanNotes}
          onToggle={() => setPlanNotesOpen((open) => !open)}
          onSave={onSavePlanNotes}
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
      </div>
    </section>
  )
}

export default WorkoutPlanList
