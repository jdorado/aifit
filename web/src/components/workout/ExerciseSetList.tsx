import { useCallback, useRef, useState, type FC, type FocusEvent, type MouseEvent as ReactMouseEvent, type TouchEvent } from 'react'
import { useI18n } from '../../i18n'
import type { WorkoutExercise } from '../../data/testWorkout'
import type { HoldTimerState, SetState } from '../../types/app'
import {
  formatMetricDisplay,
  formatTime,
  formatWeightDisplay,
  getExerciseSideCount,
  hasPerSideTimedTargets,
  normalizeDropSet,
  normalizeMetricTarget,
  normalizeWeightTarget,
} from '../../utils/workoutDisplay'

type SwipeState = {
  startX: number
  startY: number
  rowIndex: number
}

type ExerciseSetListProps = {
  exercise: WorkoutExercise
  setLabel: string
  stateList: SetState[]
  nextIndex: number
  editingSet: { exerciseId: string, index: number } | null
  holdTimer: HoldTimerState
  holdTimerEnabled: boolean
  holdTargetSec: number
  holdPrepSec: number
  canLogDay: boolean
  canEditPlan: boolean
  onAddSet: () => void
  onRemoveSet: (exerciseId: string, index: number) => void
  onStartEditingSet: (exerciseId: string, index: number) => void
  onSaveEditingSet: () => void
  onCancelEditingSet: () => void
  onUnlogSet: (exerciseId: string, index: number) => void
  onUpdateSetField: (exerciseId: string, index: number, field: 'weight' | 'metric', value: string, propagate?: boolean) => void
  onCommitSetTarget: (exerciseId: string, index: number, field: 'weight' | 'metric') => void
  onStartHoldTimer: (
    exerciseId: string,
    setIndex: number,
    totalSec: number,
    prepSec: number,
    options?: { sideIndex?: number, sideCount?: number },
  ) => void
  onLogHoldTimerSet: () => void
}

const ExerciseSetList: FC<ExerciseSetListProps> = ({
  exercise,
  setLabel,
  stateList,
  nextIndex,
  editingSet,
  holdTimer,
  holdTimerEnabled,
  holdTargetSec,
  holdPrepSec,
  canLogDay,
  canEditPlan,
  onAddSet,
  onRemoveSet,
  onStartEditingSet,
  onSaveEditingSet,
  onCancelEditingSet,
  onUnlogSet,
  onUpdateSetField,
  onCommitSetTarget,
  onStartHoldTimer,
  onLogHoldTimerSet,
}) => {
  const { t } = useI18n()
  const [swipeActiveIndex, setSwipeActiveIndex] = useState<number | null>(null)
  const swipeRef = useRef<SwipeState | null>(null)

  const handleSetInputFocus = useCallback((event: FocusEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    window.requestAnimationFrame(() => {
      if (document.activeElement === input) {
        input.select()
      }
    })
  }, [])

  const handleTouchStart = (index: number) => (event: TouchEvent<HTMLDivElement>) => {
    if (!canLogDay) return
    const touch = event.touches[0]
    swipeRef.current = { startX: touch.clientX, startY: touch.clientY, rowIndex: index }
  }

  const handleTouchEnd = (index: number) => (event: TouchEvent<HTMLDivElement>) => {
    if (!canLogDay) return
    if (!swipeRef.current) return
    const touch = event.changedTouches[0]
    const deltaX = touch.clientX - swipeRef.current.startX
    const deltaY = touch.clientY - swipeRef.current.startY
    const isHorizontal = Math.abs(deltaX) > Math.abs(deltaY)

    if (isHorizontal && Math.abs(deltaX) > 50) {
      if (deltaX < 0) {
        setSwipeActiveIndex(index)
      } else if (deltaX > 0) {
        setSwipeActiveIndex((current) => (current === index ? null : current))
      }
    }

    swipeRef.current = null
  }

  const handleRowClick = (index: number) => (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-set-action]')) return
    if (!canLogDay) return

    if (swipeActiveIndex !== null && swipeActiveIndex !== index) {
      setSwipeActiveIndex(null)
      return
    }

    setSwipeActiveIndex((current) => (current === index ? null : index))
  }

  return (
    <>
      <div className="set-list-header">
        <span>{setLabel}</span>
        <span>{t('workout.previous')}</span>
        <span>{t('workout.repsLabel')}</span>
        <span>{t('workout.weightLabel')}</span>
      </div>
      <div className="set-list">
        {exercise.sets.length === 0 ? (
          <div className="set-empty"></div>
        ) : (
          exercise.sets.map((set, index) => {
            const currentState = stateList[index]
            const isNext = index === nextIndex
            const isEditing = currentState?.done && editingSet?.exerciseId === exercise.id && editingSet.index === index
            const warmupIndex = set.isWarmup
              ? exercise.sets.slice(0, index + 1).filter((item) => item.isWarmup).length
              : 0
            const workIndex = set.isWarmup ? 0 : index + 1 - warmupIndex
            const displayLabel = set.isWarmup
              ? t('workout.warmupLabel', { count: warmupIndex })
              : `${setLabel} ${workIndex}`

            if (isNext) {
              const metricLabel = exercise.metric === 'time'
                ? t('workout.secondsLabel')
                : t('workout.repsLabel')
              const targetWeight = normalizeWeightTarget(set.targetWeight)
              const dropSetInfo = normalizeDropSet(set.targetDropSet)
              const hasDropSet = dropSetInfo.label !== ''
              const hasWeightTarget = targetWeight.trim() !== ''
              const showWeightInput = true
              const targetWeightDisplay = hasWeightTarget
                ? formatWeightDisplay(exercise, targetWeight)
                : ''
              const weightPlaceholder = hasWeightTarget
                ? targetWeightDisplay
                : '0'
              const targetMetricValue = normalizeMetricTarget(exercise.metric === 'time' ? set.targetTime : set.targetReps) || '-'
              const targetMetric = formatMetricDisplay(exercise, targetMetricValue)
              const metricPlaceholder = formatMetricDisplay(exercise, normalizeMetricTarget(exercise.metric === 'time' ? set.targetTime : set.targetReps) || '-')
              const timerForSet = holdTimer.exerciseId === exercise.id && holdTimer.setIndex === index
              const timerPhase = timerForSet ? holdTimer.phase : 'idle'
              const timerSideCount = holdTimerEnabled && hasPerSideTimedTargets(exercise)
                ? getExerciseSideCount(exercise)
                : 1
              const activeSideCount = timerForSet
                ? Math.max(1, holdTimer.sideCount || timerSideCount)
                : timerSideCount
              const activeSideIndex = timerForSet
                ? Math.min(Math.max(0, holdTimer.sideIndex), activeSideCount - 1)
                : 0
              const sideLabel = activeSideCount > 1
                ? t('workout.sideProgress', { current: activeSideIndex + 1, total: activeSideCount })
                : null
              const timerDisplay = timerPhase === 'prep'
                ? formatTime(holdTimer.prepRemainingSec)
                : timerPhase === 'hold'
                  ? formatTime(holdTimer.remainingSec)
                  : timerPhase === 'complete'
                    ? formatTime(0)
                    : formatTime(holdTargetSec)

              return (
                <div key={`${exercise.id}-hero-${index}`} className="set-hero" data-set={index}>
                  <div className="hero-header">
                    <span className="hero-badge">{displayLabel.toUpperCase()}</span>
                    <span className="hero-target">
                      {hasWeightTarget ? (
                        <>
                          {t('workout.targetLabel')}: <strong>{targetMetric}</strong> × <strong>{targetWeightDisplay}</strong>
                        </>
                      ) : (
                        <>
                          {t('workout.targetLabel')}: <strong>{targetMetric}</strong>
                        </>
                      )}
                    </span>
                    <button
                      className="hero-skip-btn"
                      type="button"
                      data-set-action="remove-set"
                      title={t('workout.removeSet')}
                      aria-label={t('workout.removeSet')}
                      disabled={!canEditPlan}
                      onClick={canEditPlan ? () => onRemoveSet(exercise.id, index) : undefined}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                      </svg>
                    </button>
                  </div>

                  {hasDropSet ? (
                    <div className="drop-set">
                      <span className="drop-set-label">{t('workout.dropSetLabel')}</span>
                      {dropSetInfo.items.length > 0 ? (
                        <div className="drop-set-items">
                          {dropSetInfo.items.map((item, itemIndex) => (
                            <span key={`${exercise.id}-drop-${index}-${itemIndex}`} className="drop-set-chip">
                              {item}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="drop-set-text">{dropSetInfo.label}</span>
                      )}
                    </div>
                  ) : null}

                  {holdTimerEnabled ? (
                    <div className={`hold-timer ${timerForSet && (holdTimer.active || holdTimer.phase === 'complete') ? 'active' : ''}`}>
                      <div className="hold-row">
                        <span className="hold-label">{t('workout.holdTimerLabel')}</span>
                        {sideLabel ? <span className="hold-side">{sideLabel}</span> : null}
                        <span className="hold-status">
                          {timerPhase === 'prep' ? t('workout.getReady')
                            : timerPhase === 'hold' ? t('workout.hold')
                              : timerPhase === 'complete' ? t('common.done')
                                : t('common.ready')}
                        </span>
                      </div>
                      <div className="hold-display">
                        {timerDisplay}
                      </div>
                      <div className="hold-actions">
                        <button
                          className="hold-btn primary"
                          type="button"
                          disabled={!canLogDay}
                          onClick={() => onStartHoldTimer(exercise.id, index, holdTargetSec, holdPrepSec, {
                            sideIndex: activeSideIndex,
                            sideCount: activeSideCount,
                          })}
                        >
                          {timerPhase === 'idle' ? t('common.start') : t('common.restart')}
                        </button>
                        <button
                          className="hold-btn"
                          type="button"
                          onClick={onLogHoldTimerSet}
                          disabled={!canLogDay || timerPhase === 'idle'}
                        >
                          {t('common.stop')}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className={`hero-inputs ${showWeightInput ? '' : 'single-col'}`}>
                    <label>
                      <span>{metricLabel}</span>
                      <input
                        type="text"
                        data-field="metric"
                        placeholder={metricPlaceholder}
                        value={currentState.metric}
                        inputMode="numeric"
                        onFocus={handleSetInputFocus}
                        onBlur={canEditPlan ? () => onCommitSetTarget(exercise.id, index, 'metric') : undefined}
                        onChange={(event) => onUpdateSetField(exercise.id, index, 'metric', event.target.value, true)}
                      />
                    </label>
                    {showWeightInput ? (
                      <label>
                        <span>{t('workout.weightLabel')}</span>
                        <input
                          type="text"
                          data-field="weight"
                          placeholder={weightPlaceholder}
                          value={currentState.weight}
                          inputMode="decimal"
                          onFocus={handleSetInputFocus}
                          onBlur={canEditPlan ? () => onCommitSetTarget(exercise.id, index, 'weight') : undefined}
                          onChange={(event) => onUpdateSetField(exercise.id, index, 'weight', event.target.value, true)}
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
              )
            }

            const isSkipped = currentState.skipped === true
            const statusClass = currentState.done ? (isSkipped ? 'skipped' : 'done') : 'queued'
            const targetSet = exercise.sets[index]
            const targetWeightValue = normalizeWeightTarget(targetSet?.targetWeight)
            const dropSetInfo = normalizeDropSet(targetSet?.targetDropSet)
            const hasDropSet = dropSetInfo.label !== ''
            const hasActualWeight = currentState.weight && currentState.weight.trim() !== '' && currentState.weight.toLowerCase() !== 'null'
            const showWeightInput = true
            const weightPlaceholder = targetWeightValue
              ? formatWeightDisplay(exercise, targetWeightValue)
              : '0'
            const metricPlaceholderValue = normalizeMetricTarget(exercise.metric === 'time' ? targetSet?.targetTime : targetSet?.targetReps) || '-'
            const metricPlaceholder = formatMetricDisplay(exercise, metricPlaceholderValue)
            const metricLabel = exercise.metric === 'time'
              ? t('workout.secondsLabel')
              : t('workout.repsLabel')

            if (isEditing) {
              return (
                <div key={`${exercise.id}-edit-${index}`} className="set-row edit" data-set={index}>
                  <div className="set-row-edit-header">
                    <span className="set-num">{displayLabel}</span>
                    <div className="set-row-edit-actions">
                      <button className="set-row-edit-btn primary" type="button" data-set-action="save-edit" onClick={onSaveEditingSet}>
                        {t('common.save')}
                      </button>
                      <button className="set-row-edit-btn" type="button" data-set-action="cancel-edit" onClick={onCancelEditingSet}>
                        {t('common.cancel')}
                      </button>
                    </div>
                  </div>
                  {hasDropSet ? (
                    <div className="set-drop-set-note">{t('workout.dropSetWithValue', { value: dropSetInfo.label })}</div>
                  ) : null}
                  <div className={`set-row-edit-inputs ${showWeightInput ? '' : 'single-col'}`}>
                    <label>
                      <span>{metricLabel}</span>
                      <input
                        type="text"
                        data-field="metric"
                        placeholder={metricPlaceholder}
                        value={currentState.metric}
                        inputMode="numeric"
                        onFocus={handleSetInputFocus}
                        onChange={(event) => onUpdateSetField(exercise.id, index, 'metric', event.target.value)}
                      />
                    </label>
                    {showWeightInput ? (
                      <label>
                        <span>{t('workout.weightLabel')}</span>
                        <input
                          type="text"
                          data-field="weight"
                          placeholder={weightPlaceholder}
                          value={currentState.weight}
                          inputMode="decimal"
                          onFocus={handleSetInputFocus}
                          onChange={(event) => onUpdateSetField(exercise.id, index, 'weight', event.target.value)}
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
              )
            }

            let resultText = ''
            if (isSkipped) {
              resultText = t('workout.skipped')
            } else if (currentState.done) {
              const metricResult = formatMetricDisplay(exercise, currentState.metric || '-')
              const weightResult = hasActualWeight ? formatWeightDisplay(exercise, currentState.weight) : ''
              resultText = hasActualWeight
                ? `${metricResult} × ${weightResult}`
                : metricResult
            } else {
              resultText = t('workout.pending')
            }

            const actionsCount = currentState.done ? (isSkipped ? 1 : 2) : 2

            return (
              <div
                key={`${exercise.id}-row-${index}`}
                className={`set-row compact ${statusClass} ${swipeActiveIndex === index ? 'show-actions' : ''}`}
                data-set={index}
                data-actions={actionsCount}
                onTouchStart={handleTouchStart(index)}
                onTouchEnd={handleTouchEnd(index)}
                onClick={handleRowClick(index)}
              >
                <div className="set-row-main">
                  <span className="set-num">{displayLabel}</span>
                  <div className="set-row-info">
                    <span className="set-prev">{resultText}</span>
                    {hasDropSet ? (
                      <span className="set-drop-set">{t('workout.dropSetWithValue', { value: dropSetInfo.label })}</span>
                    ) : null}
                  </div>
                  <span className="set-status">{isSkipped ? '–' : currentState.done ? '✓' : ''}</span>
                </div>
                <div className="set-row-actions">
                  {currentState.done && !isSkipped ? (
                    <button
                      className="set-row-action"
                      type="button"
                      data-set-action="edit"
                      title={t('workout.editSet')}
                      aria-label={t('workout.editSet')}
                      disabled={!canLogDay}
                      onClick={canLogDay ? () => onStartEditingSet(exercise.id, index) : undefined}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                      </svg>
                    </button>
                  ) : null}
                  {currentState.done ? (
                    <button
                      className="set-row-action"
                      type="button"
                      data-set-action="undo"
                      title={t('workout.undoSet')}
                      aria-label={t('workout.undoSet')}
                      disabled={!canLogDay}
                      onClick={canLogDay ? () => onUnlogSet(exercise.id, index) : undefined}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 7v6h6" />
                        <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                      </svg>
                    </button>
                  ) : (
                    <>
                      <button
                        className="set-row-action danger"
                        type="button"
                        data-set-action="remove-set"
                        title={t('workout.removeSet')}
                        aria-label={t('workout.removeSet')}
                        disabled={!canEditPlan}
                        onClick={canEditPlan ? () => onRemoveSet(exercise.id, index) : undefined}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="set-list-actions">
        <button
          className="add-set-btn"
          type="button"
          onClick={onAddSet}
          disabled={!canEditPlan}
        >
          <span className="add-set-icon">+</span>
          {t('workout.addSet')}
        </button>
      </div>
    </>
  )
}

export default ExerciseSetList
