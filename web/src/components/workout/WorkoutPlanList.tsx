import { useCallback, useEffect, useMemo, useRef, useState, type FC, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent } from 'react'
import { useI18n } from '../../i18n'
import type { WorkoutExercise, WorkoutExtra } from '../../data/testWorkout'
import { circuitGroupKey } from '../../data/testWorkout'
import type { ActiveEntryType, SetState } from '../../types/app'
import PlanNotes from './PlanNotes'

type PlanSwipeState = {
  startX: number
  startY: number
  rowId: string
}

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

const DRAG_START_THRESHOLD = 6

type CircuitGroup = {
  items: Array<{ exercise: WorkoutExercise, index: number }>
  rounds?: number
  restAfterSec?: number
  totalExercises?: number
}

type DragPayload =
  | { kind: 'block', blockId: string, segmentIds: string[] }
  | { kind: 'item', itemId: string, segmentId: string }

type DragState = {
  pointerId: number
  startY: number
  moved: boolean
  payload: DragPayload
  deltaY: number
  dropSegmentId: string | null
  dropBeforeItemId: string | null
  dropBeforeBlockId: string | null
  dropBeforeSegmentId: string | null | undefined
}

type RenderBlock = {
  id: string
  stage: SectionInfo
  colorSlot: number
  segmentIds: string[]
  exercises: WorkoutExercise[]
}

type PendingItemMove = {
  itemId: string
  targetSegmentId: string
  targetIndex: number
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
  canAddExercise: boolean
  onAddExercise: () => void
  onRemoveExercise: (exerciseId: string) => void
  onRemoveCircuit: (segmentId: string) => void
  onRemoveSection: (segmentIds: string[]) => void
  onReorderSegments: (segmentIds: string[]) => Promise<boolean>
  onMoveItem: (exerciseId: string, targetSegmentId: string, targetIndex: number) => Promise<boolean>
  onExtractItem: (exerciseId: string, beforeSegmentId: string | null) => Promise<boolean>
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

const findScrollContainer = (element: HTMLElement): HTMLElement | null => {
  let node = element.parentElement
  while (node) {
    const style = window.getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    node = node.parentElement
  }
  return null
}

const moveExerciseInList = (list: WorkoutExercise[], itemId: string, targetSegmentId: string, targetIndex: number): WorkoutExercise[] => {
  const item = list.find((exercise) => exercise.id === itemId)
  if (!item) return list
  const without = list.filter((exercise) => exercise.id !== itemId)
  const targetItems = without.filter((exercise) => exercise.segmentId === targetSegmentId)
  const anchor = targetItems[targetIndex - 1]
  if (anchor) {
    const at = without.indexOf(anchor)
    return [...without.slice(0, at), item, ...without.slice(at)]
  }
  const last = targetItems[targetItems.length - 1]
  if (!last) return [...without, item]
  const at = without.indexOf(last) + 1
  return [...without.slice(0, at), item, ...without.slice(at)]
}

const orderExercisesBySegments = (list: WorkoutExercise[], segmentIds: string[]): WorkoutExercise[] => {
  const rank = new Map(segmentIds.map((id, index) => [id, index]))
  return [...list].sort((a, b) => (
    (rank.get(a.segmentId ?? '') ?? segmentIds.length) - (rank.get(b.segmentId ?? '') ?? segmentIds.length)
  ))
}

const sameExerciseOrder = (a: WorkoutExercise[], b: WorkoutExercise[]) => (
  a.length === b.length && a.every((exercise, index) => exercise.id === b[index]?.id)
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
  canAddExercise,
  onAddExercise,
  onRemoveExercise,
  onRemoveCircuit,
  onRemoveSection,
  onReorderSegments,
  onMoveItem,
  onExtractItem,
}) => {
  const { t } = useI18n()
  const [planNotesOpen, setPlanNotesOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_COLLAPSED_SECTIONS }))
  const [planSwipeActiveId, setPlanSwipeActiveId] = useState<string | null>(null)
  const planSwipeRef = useRef<PlanSwipeState | null>(null)
  const planSwipeIgnoreClickRef = useRef(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const liveDragRef = useRef<DragState | null>(null)
  const lastPointerYRef = useRef(0)
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  const [pendingItemMove, setPendingItemMove] = useState<PendingItemMove | null>(null)
  const [pendingSegmentOrder, setPendingSegmentOrder] = useState<string[] | null>(null)

  useEffect(() => {
    setPlanSwipeActiveId(null)
    liveDragRef.current = null
    setDrag(null)
  }, [canEditPlan, exercises])

  // A receipt or refresh landed: the canonical order is authoritative again.
  useEffect(() => {
    setPendingItemMove(null)
    setPendingSegmentOrder(null)
  }, [exercises])

  const orderedExercises = useMemo(() => {
    let list = exercises
    if (pendingItemMove) {
      list = moveExerciseInList(list, pendingItemMove.itemId, pendingItemMove.targetSegmentId, pendingItemMove.targetIndex)
    }
    if (pendingSegmentOrder) {
      list = orderExercisesBySegments(list, pendingSegmentOrder)
    }
    return list
  }, [exercises, pendingItemMove, pendingSegmentOrder])

  const orderedExercisesRef = useRef<WorkoutExercise[]>(orderedExercises)
  useEffect(() => {
    orderedExercisesRef.current = orderedExercises
  }, [orderedExercises])

  const handlePlanTouchStart = (rowId: string) => (event: TouchEvent<HTMLElement>) => {
    if (!canEditPlan) return
    const touch = event.touches[0]
    planSwipeRef.current = { startX: touch.clientX, startY: touch.clientY, rowId }
  }

  const handlePlanTouchEnd = (rowId: string) => (event: TouchEvent<HTMLElement>) => {
    if (!canEditPlan) return
    if (!planSwipeRef.current) return
    const touch = event.changedTouches[0]
    const deltaX = touch.clientX - planSwipeRef.current.startX
    const deltaY = touch.clientY - planSwipeRef.current.startY
    const isHorizontal = Math.abs(deltaX) > Math.abs(deltaY)

    if (isHorizontal && Math.abs(deltaX) > 50) {
      planSwipeIgnoreClickRef.current = true
      if (deltaX < 0) {
        setPlanSwipeActiveId(rowId)
      } else if (deltaX > 0) {
        setPlanSwipeActiveId((current) => (current === rowId ? null : current))
      }
      window.setTimeout(() => {
        planSwipeIgnoreClickRef.current = false
      }, 250)
    }

    planSwipeRef.current = null
  }

  const handlePlanCardClick = (id: string, type: ActiveEntryType) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-plan-action]')) return
    if (planSwipeIgnoreClickRef.current) return

    if (planSwipeActiveId !== null) {
      setPlanSwipeActiveId(null)
      return
    }

    onSelectEntry(id, type)
  }

  const toggleSection = useCallback((sectionKey: string) => {
    setCollapsedSections((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }))
  }, [])

  const handleRowTap = (id: string, type: ActiveEntryType) => {
    if (planSwipeIgnoreClickRef.current) return
    if (planSwipeActiveId !== null) {
      setPlanSwipeActiveId(null)
      return
    }
    onSelectEntry(id, type)
  }

  const handleStageTap = (sectionKey: string) => {
    if (planSwipeIgnoreClickRef.current) return
    if (planSwipeActiveId !== null) {
      setPlanSwipeActiveId(null)
      return
    }
    toggleSection(sectionKey)
  }

  const handleRemoveExercise = useCallback((exercise: WorkoutExercise) => {
    if (!window.confirm(t('workout.removeExerciseConfirm', { name: exercise.name }))) return
    setPlanSwipeActiveId(null)
    onRemoveExercise(exercise.id)
  }, [onRemoveExercise, t])

  const handleRemoveCircuit = useCallback((segmentId: string, circuitName: string) => {
    if (!window.confirm(t('workout.removeCircuitConfirm', { name: circuitName }))) return
    setPlanSwipeActiveId(null)
    onRemoveCircuit(segmentId)
  }, [onRemoveCircuit, t])

  const handleRemoveSection = useCallback((sectionLabel: string, segmentIds: string[]) => {
    if (!window.confirm(t('workout.removeSectionConfirm', { name: sectionLabel }))) return
    setPlanSwipeActiveId(null)
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

  const renderBlocks: RenderBlock[] = []
  let currentBlock: RenderBlock | null = null
  orderedExercises.forEach((exercise) => {
    const stage = getStageInfo(exercise)
    if (!currentBlock || currentBlock.stage.key !== stage.key) {
      currentBlock = {
        id: `block-${renderBlocks.length}`,
        stage,
        colorSlot: getSectionColorSlot(stage.key, stage.tone),
        segmentIds: [],
        exercises: [],
      }
      renderBlocks.push(currentBlock)
    }
    if (exercise.segmentId && !currentBlock.segmentIds.includes(exercise.segmentId)) {
      currentBlock.segmentIds.push(exercise.segmentId)
    }
    currentBlock.exercises.push(exercise)
  })

  const renderBlocksRef = useRef<RenderBlock[]>([])
  useEffect(() => {
    renderBlocksRef.current = renderBlocks
  })

  const updateDragTarget = useCallback((pointerY: number) => {
    const live = liveDragRef.current
    if (!live || !live.moved) return
    if (live.payload.kind === 'item') {
      const draggedId = live.payload.itemId
      const segmentBounds = new Map<string, { top: number, bottom: number }>()
      document.querySelectorAll<HTMLElement>('[data-drag-segment-container]').forEach((element) => {
        if (element.dataset.dragItem === draggedId) return
        const id = element.dataset.dragSegmentContainer
        if (!id) return
        const rect = element.getBoundingClientRect()
        const previous = segmentBounds.get(id)
        segmentBounds.set(id, { top: Math.min(previous?.top ?? rect.top, rect.top), bottom: Math.max(previous?.bottom ?? rect.bottom, rect.bottom) })
      })
      const segments = [...segmentBounds].sort((a, b) => a[1].top - b[1].top)
      const beforeSegment = segments.find(([, bounds]) => pointerY < bounds.top)
      const previousSegment = beforeSegment
        ? segments[segments.findIndex(([id]) => id === beforeSegment[0]) - 1]
        : segments[segments.length - 1]
      if (segments.length && (!previousSegment || pointerY > previousSegment[1].bottom)
        && (!beforeSegment || pointerY < beforeSegment[1].top)) {
        const next: DragState = { ...live, deltaY: pointerY - live.startY,
          dropSegmentId: null, dropBeforeItemId: null, dropBeforeSegmentId: beforeSegment?.[0] ?? null }
        liveDragRef.current = next
        setDrag(next)
        return
      }
      const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-drag-item]'))
      const others = elements.filter((element) => element.dataset.dragItem !== draggedId)
      let beforeElement: HTMLElement | null = null
      for (const element of others) {
        const rect = element.getBoundingClientRect()
        if (pointerY < rect.top + rect.height / 2) {
          beforeElement = element
          break
        }
      }
      const lastOther = others[others.length - 1]
      const next: DragState = {
        ...live,
        deltaY: pointerY - live.startY,
        dropSegmentId: beforeElement?.dataset.dragSegment ?? lastOther?.dataset.dragSegment ?? null,
        dropBeforeItemId: beforeElement?.dataset.dragItem ?? null,
        dropBeforeSegmentId: undefined,
      }
      liveDragRef.current = next
      setDrag(next)
      return
    }

    const draggedBlockId = live.payload.blockId
    const headers = Array.from(document.querySelectorAll<HTMLElement>('[data-drag-block-header]'))
    let beforeBlockId: string | null = null
    for (const element of headers) {
      const blockId = element.dataset.dragBlockHeader
      if (!blockId || blockId === draggedBlockId) continue
      const blockElements = Array.from(document.querySelectorAll<HTMLElement>(`[data-drag-block="${blockId}"]`))
      const rects = blockElements.map((item) => item.getBoundingClientRect())
      if (!rects.length) continue
      const top = Math.min(...rects.map((rect) => rect.top))
      const bottom = Math.max(...rects.map((rect) => rect.bottom))
      if (pointerY < top + (bottom - top) / 2) {
        beforeBlockId = blockId
        break
      }
    }
    const next: DragState = { ...live, deltaY: pointerY - live.startY, dropBeforeBlockId: beforeBlockId }
    liveDragRef.current = next
    setDrag(next)
  }, [])

  const updateDragTargetRef = useRef(updateDragTarget)
  useEffect(() => {
    updateDragTargetRef.current = updateDragTarget
  }, [updateDragTarget])

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, payload: DragPayload) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const handle = event.currentTarget
    if (!handle.setPointerCapture) return
    handle.setPointerCapture(event.pointerId)
    scrollContainerRef.current = findScrollContainer(handle)
    lastPointerYRef.current = event.clientY
    const initial: DragState = {
      pointerId: event.pointerId,
      startY: event.clientY,
      moved: false,
      payload,
      deltaY: 0,
      dropSegmentId: payload.kind === 'item' ? payload.segmentId : null,
      dropBeforeItemId: null,
      dropBeforeBlockId: payload.kind === 'block' ? payload.blockId : null,
      dropBeforeSegmentId: undefined,
    }
    liveDragRef.current = initial
    setPlanSwipeActiveId(null)
    setDrag(initial)
    event.preventDefault()
    event.stopPropagation()
  }

  const commitDrag = useCallback(async (live: DragState) => {
    if (live.payload.kind === 'item') {
      const { itemId } = live.payload
      if (live.dropBeforeSegmentId !== undefined) {
        await onExtractItem(itemId, live.dropBeforeSegmentId)
        return
      }
      const targetSegmentId = live.dropSegmentId
      if (!targetSegmentId) return
      const current = orderedExercisesRef.current
      const targetItems = current.filter((exercise) => exercise.segmentId === targetSegmentId && exercise.id !== itemId)
      let targetIndex = targetItems.length + 1
      if (live.dropBeforeItemId) {
        const anchorIndex = targetItems.findIndex((exercise) => exercise.id === live.dropBeforeItemId)
        if (anchorIndex >= 0) targetIndex = anchorIndex + 1
      }
      if (sameExerciseOrder(moveExerciseInList(current, itemId, targetSegmentId, targetIndex), current)) return
      setPendingItemMove({ itemId, targetSegmentId, targetIndex })
      const ok = await onMoveItem(itemId, targetSegmentId, targetIndex)
      if (!ok) setPendingItemMove(null)
      return
    }

    const { segmentIds } = live.payload
    const currentSegmentIds: string[] = []
    for (const exercise of orderedExercisesRef.current) {
      if (exercise.segmentId && !currentSegmentIds.includes(exercise.segmentId)) {
        currentSegmentIds.push(exercise.segmentId)
      }
    }
    const remaining = currentSegmentIds.filter((id) => !segmentIds.includes(id))
    let insertAt = remaining.length
    if (live.dropBeforeBlockId) {
      const anchorBlock = renderBlocksRef.current.find((block) => block.id === live.dropBeforeBlockId)
      const anchor = anchorBlock?.segmentIds.find((id) => remaining.includes(id))
      if (anchor) insertAt = remaining.indexOf(anchor)
    }
    const nextOrder = [...remaining.slice(0, insertAt), ...segmentIds, ...remaining.slice(insertAt)]
    if (nextOrder.join('|') === currentSegmentIds.join('|')) return
    setPendingSegmentOrder(nextOrder)
    const ok = await onReorderSegments(nextOrder)
    if (!ok) setPendingSegmentOrder(null)
  }, [onExtractItem, onMoveItem, onReorderSegments])

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const live = liveDragRef.current
    if (!live || event.pointerId !== live.pointerId) return
    lastPointerYRef.current = event.clientY
    const deltaY = event.clientY - live.startY
    if (!live.moved && Math.abs(deltaY) < DRAG_START_THRESHOLD) return
    live.moved = true
    updateDragTarget(event.clientY)
  }

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean, onTap?: () => void) => {
    const live = liveDragRef.current
    if (!live || event.pointerId !== live.pointerId) return
    liveDragRef.current = null
    setDrag(null)
    const handle = event.currentTarget
    if (handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId)
    }
    if (!commit || !live.moved) {
      // The grip is invisible, so a tap on it must behave like a tap on the row.
      if (commit) onTap?.()
      return
    }
    void commitDrag(live)
  }

  useEffect(() => {
    if (!drag) return
    let frame = 0
    const step = () => {
      const container = scrollContainerRef.current
      const pointerY = lastPointerYRef.current
      if (container) {
        const rect = container.getBoundingClientRect()
        const edge = 84
        let delta = 0
        if (pointerY < rect.top + edge) {
          delta = -Math.max(2, Math.ceil((rect.top + edge - pointerY) / 3))
        } else if (pointerY > rect.bottom - edge) {
          delta = Math.max(2, Math.ceil((pointerY - (rect.bottom - edge)) / 3))
        }
        if (delta) {
          container.scrollTop += delta
          updateDragTargetRef.current(pointerY)
        }
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [drag !== null])

  // Invisible grip: the drag zone keeps the card design untouched, so it has no
  // icon and no layout width. A tap on it stays a tap on the row.
  const renderDragHandle = (
    payload: DragPayload,
    label: string,
    testId: string,
    onTap: () => void,
  ) => (
    <button
      className="plan-drag-handle"
      type="button"
      data-plan-drag={testId}
      aria-label={label}
      onPointerDown={(event) => beginDrag(event, payload)}
      onPointerMove={handleDragPointerMove}
      onPointerUp={(event) => finishDrag(event, true, onTap)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
      onClick={(event) => event.preventDefault()}
    />
  )

  const renderStageHeader = (stage: SectionInfo, key: string, colorSlot: number, blockId: string, sectionSegmentIds: string[]) => {
    const collapsed = Boolean(collapsedSections[stage.key])
    const canRemoveSection = canEditPlan && sectionSegmentIds.length > 0
    const stageSwipeId = `section:${key}`
    const activeBlockDrag = drag && drag.payload.kind === 'block' && drag.payload.blockId === blockId && drag.moved ? drag : null
    const isDraggingBlock = Boolean(activeBlockDrag)
    const isDropBefore = Boolean(drag && drag.payload.kind === 'block' && drag.moved && drag.payload.blockId !== blockId && drag.dropBeforeBlockId === blockId)
    const isDropAfter = Boolean(
      drag && drag.payload.kind === 'block' && drag.moved && drag.dropBeforeBlockId === null
      && drag.payload.blockId !== blockId && renderBlocks[renderBlocks.length - 1]?.id === blockId,
    )
    const dragAttributes = blockId
      ? { 'data-drag-block': blockId, 'data-drag-block-header': blockId }
      : {}
    return (
      <div
        key={key}
        data-stage={stage.tone}
        data-section-color={colorSlot}
        {...dragAttributes}
        className={`workout-stage-row ${canEditPlan && planSwipeActiveId === stageSwipeId ? 'show-actions' : ''} ${isDraggingBlock ? 'is-dragging' : ''} ${isDropBefore ? 'drop-before' : ''} ${isDropAfter ? 'drop-after' : ''}`}
        style={activeBlockDrag ? { transform: `translateY(${activeBlockDrag.deltaY}px)` } : undefined}
        onTouchStart={canEditPlan ? handlePlanTouchStart(stageSwipeId) : undefined}
        onTouchEnd={canEditPlan ? handlePlanTouchEnd(stageSwipeId) : undefined}
      >
        {canRemoveSection
          ? renderDragHandle(
            { kind: 'block', blockId, segmentIds: sectionSegmentIds },
            t('workout.moveSection'),
            'block',
            () => handleStageTap(stage.key),
          )
          : null}
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
        {canRemoveSection ? (
          <div className="workout-stage-actions">
            <button
              className="plan-row-action danger"
              type="button"
              data-plan-action="remove"
              title={t('workout.removeSection')}
              aria-label={t('workout.removeSection')}
              onClick={() => handleRemoveSection(stage.label, sectionSegmentIds)}
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
  const isEmptyDay = exercises.length === 0 && extras.length === 0
  const hideEmptyState = loading && isEmptyDay
  const showEmptyState = !hideEmptyState && !hasWeekWorkouts && isEmptyDay
  const showNoWorkoutCard = !hideEmptyState && hasWeekWorkouts && isEmptyDay
  const extraCards: JSX.Element[] = []
  const priorityExtraCards: JSX.Element[] = []
  let lastExtraStageKey: string | null = null
  let lastPriorityExtraStageKey: string | null = null

  renderBlocks.forEach((block) => {
    cards.push(renderStageHeader(block.stage, `stage-${block.id}`, block.colorSlot, block.id, block.segmentIds))
    if (collapsedSections[block.stage.key]) return

    let lastSegmentId: string | null = null
    block.exercises.forEach((exercise) => {
      const segmentId = exercise.segmentId
      const activeBlockDrag = drag && drag.payload.kind === 'block' && drag.payload.blockId === block.id && drag.moved ? drag : null
      const isDraggingBlock = Boolean(activeBlockDrag)
      const blockTransform = activeBlockDrag ? { transform: `translateY(${activeBlockDrag.deltaY}px)` } : undefined

      const circuitName = exercise.circuit?.name
      const groupKey = circuitGroupKey(exercise.circuit)
      if (circuitName && groupKey) {
        const circuitSegmentId = segmentId ?? groupKey
        if (circuitSegmentId === lastSegmentId) return
        lastSegmentId = circuitSegmentId
        const group = circuitGroups.get(groupKey)
        const items = block.exercises.filter((item) => (item.segmentId ?? circuitGroupKey(item.circuit)) === circuitSegmentId)
        const exercisesInCircuit = items
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
        const activeItemId = drag && drag.payload.kind === 'item' && drag.moved ? drag.payload.itemId : null
        const isItemDragFromCircuit = Boolean(activeItemId && exercisesInCircuit.some((item) => item.id === activeItemId))

        const circuitSwipeId = `circuit:${groupKey}`
        cards.push(
          <div
            key={`circuit-row-${groupKey}`}
            data-drag-block={block.id}
            data-drag-segment-container={circuitSegmentId}
            className={`plan-row ${canEditPlan && planSwipeActiveId === circuitSwipeId ? 'show-actions' : ''} ${isDraggingBlock ? 'is-dragging' : ''} ${isItemDragFromCircuit ? 'drag-open' : ''} ${drag?.dropBeforeSegmentId === circuitSegmentId ? 'drop-before' : ''}`}
            style={blockTransform}
            onTouchStart={canEditPlan ? handlePlanTouchStart(circuitSwipeId) : undefined}
            onTouchEnd={canEditPlan ? handlePlanTouchEnd(circuitSwipeId) : undefined}
          >
            <div
              className={`workout-card circuit-group ${isCompleted ? 'is-completed' : ''}`}
              data-stage={block.stage.tone}
              data-section-color={block.colorSlot}
              role="group"
              aria-label={t('workout.circuitAria', { name: circuitName })}
            >
              <button
                className="circuit-group-start"
                type="button"
                onClick={handlePlanCardClick((nextExercise || exercisesInCircuit[0]).id, 'exercise')}
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
                  const order = itemIndex + 1
                  const activeItemDrag = drag && drag.payload.kind === 'item' && drag.payload.itemId === item.id && drag.moved ? drag : null
                  const isDraggingItem = Boolean(activeItemDrag)
                  const isDropBefore = Boolean(drag && drag.payload.kind === 'item' && drag.moved && drag.dropSegmentId === circuitSegmentId && drag.dropBeforeItemId === item.id)
                  const isDropAfter = Boolean(drag && drag.payload.kind === 'item' && drag.moved && drag.dropSegmentId === circuitSegmentId && drag.dropBeforeItemId === null && itemIndex === exercisesInCircuit.length - 1)
                  return (
                    <li
                      key={`${item.id}-preview`}
                      data-drag-item={item.id}
                      data-drag-segment={circuitSegmentId}
                      className={`circuit-preview-item ${canEditPlan && planSwipeActiveId === item.id ? 'show-actions' : ''} ${isDraggingItem ? 'is-dragging' : ''} ${isDropBefore ? 'drop-before' : ''} ${isDropAfter ? 'drop-after' : ''}`}
                      style={activeItemDrag ? { transform: `translateY(${activeItemDrag.deltaY}px)` } : undefined}
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
                      {canEditPlan
                        ? renderDragHandle(
                          { kind: 'item', itemId: item.id, segmentId: circuitSegmentId },
                          t('workout.moveExercise'),
                          'item',
                          () => handleRowTap(item.id, 'exercise'),
                        )
                        : null}
                      <button
                        className="circuit-preview-btn"
                        type="button"
                        onClick={handlePlanCardClick(item.id, 'exercise')}
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
                  data-plan-action="remove"
                  title={t('workout.removeCircuit')}
                  aria-label={t('workout.removeCircuit')}
                  onClick={() => handleRemoveCircuit(groupKey, circuitName)}
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
      const segmentItems = segmentId ? orderedExercises.filter((item) => item.segmentId === segmentId) : [exercise]
      const isLastOfSegment = segmentItems[segmentItems.length - 1]?.id === exercise.id
      const activeItemDrag = drag && drag.payload.kind === 'item' && drag.payload.itemId === exercise.id && drag.moved ? drag : null
      const isDraggingItem = Boolean(activeItemDrag)
      const isDropBefore = Boolean(drag && drag.payload.kind === 'item' && drag.moved && drag.dropSegmentId === segmentId && drag.dropBeforeItemId === exercise.id)
      const isDropAfter = Boolean(drag && drag.payload.kind === 'item' && drag.moved && drag.dropSegmentId === segmentId && drag.dropBeforeItemId === null && isLastOfSegment)
      const activeRowDrag = activeItemDrag ?? activeBlockDrag

      cards.push(
        <div
          key={exercise.id}
          data-drag-block={block.id}
          data-drag-item={exercise.id}
          data-drag-segment={segmentId}
          data-drag-segment-container={segmentId}
          className={`plan-row ${canEditPlan && planSwipeActiveId === exercise.id ? 'show-actions' : ''} ${isDraggingItem || isDraggingBlock ? 'is-dragging' : ''} ${isDropBefore || (drag?.dropBeforeSegmentId === segmentId && segmentItems[0]?.id === exercise.id) ? 'drop-before' : ''} ${isDropAfter ? 'drop-after' : ''}`}
          style={activeRowDrag ? { transform: `translateY(${activeRowDrag.deltaY}px)` } : undefined}
          onTouchStart={canEditPlan ? handlePlanTouchStart(exercise.id) : undefined}
          onTouchEnd={canEditPlan ? handlePlanTouchEnd(exercise.id) : undefined}
        >
          {canEditPlan && segmentId
            ? renderDragHandle(
              { kind: 'item', itemId: exercise.id, segmentId },
              t('workout.moveExercise'),
              'item',
              () => handleRowTap(exercise.id, 'exercise'),
            )
            : null}
          <button
            className={`workout-card ${exercise.status === 'skip' ? 'is-skip' : ''} ${isCompleted ? 'is-completed' : ''}`}
            type="button"
            onClick={handlePlanCardClick(exercise.id, 'exercise')}
            data-stage={block.stage.tone}
            data-section-color={block.colorSlot}
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
  })

  extras.forEach((extra) => {
    const stage = getExtraStageInfo(extra)
    const colorSlot = getSectionColorSlot(stage.key, stage.tone)
    const targetCards = extra.isReadOnly ? priorityExtraCards : extraCards
    const lastKey = extra.isReadOnly ? lastPriorityExtraStageKey : lastExtraStageKey
    if (stage.key !== lastKey) {
      targetCards.push(renderStageHeader(stage, `extra-stage-${stage.key}-${extra.id}`, colorSlot, '', []))
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
    <section className={`workout-list ${activeEntryId ? 'hidden' : ''} ${drag ? 'is-reordering' : ''}`}>
      <div className="list-section">
        {canAddExercise ? (
          <button type="button" className="workout-add-exercise" onClick={onAddExercise}>
            <span aria-hidden="true">＋</span> {t('workout.addExercise')}
          </button>
        ) : null}
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
