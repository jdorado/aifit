import { useEffect, useRef, useState } from 'react'
import type { FC } from 'react'

type ThinkingCounterProps = {
  label: string
  statusText: string
  startedAt?: number
}

type ReplyElapsedProps = {
  label: string
  seconds: number
  modelLabel?: string
}

const MODEL_LABEL_MAX_CHARS = 32

const formatElapsedTime = (elapsedSeconds: number) => {
  const wholeSeconds = Math.max(0, Math.floor(elapsedSeconds))
  const minutes = Math.floor(wholeSeconds / 60)
  const seconds = String(wholeSeconds % 60).padStart(2, '0')
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const truncateModelLabel = (label: string) => {
  if (label.length <= MODEL_LABEL_MAX_CHARS) return label

  const suffixStart = label.lastIndexOf(' · ')
  const suffix = suffixStart > 0 ? label.slice(suffixStart) : ''
  const prefixLength = MODEL_LABEL_MAX_CHARS - suffix.length - 1
  if (prefixLength <= 0) return `${label.slice(0, MODEL_LABEL_MAX_CHARS - 1)}…`
  return `${label.slice(0, prefixLength).trimEnd()}…${suffix}`
}

const ThinkingCounter: FC<ThinkingCounterProps> = ({ label, statusText, startedAt }) => {
  const fallbackStartedAt = useRef(Date.now())
  const effectiveStartedAt = startedAt ?? fallbackStartedAt.current
  const [elapsedSeconds, setElapsedSeconds] = useState(() => (
    Math.max(0, Math.floor((Date.now() - effectiveStartedAt) / 1000))
  ))

  useEffect(() => {
    const updateElapsedSeconds = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - effectiveStartedAt) / 1000)))
    }

    updateElapsedSeconds()
    const intervalId = window.setInterval(updateElapsedSeconds, 1000)
    return () => window.clearInterval(intervalId)
  }, [effectiveStartedAt])

  const displayTime = formatElapsedTime(elapsedSeconds)

  return (
    <span
      className="thinking-status"
      role="timer"
      aria-label={`${label}: ${elapsedSeconds}s`}
    >
      <span className="thinking-status-label" aria-hidden="true">{statusText}</span>
      <span className="thinking-status-divider" aria-hidden="true">·</span>
      <span className="thinking-seconds" aria-hidden="true">{displayTime}</span>
    </span>
  )
}

export const ReplyElapsed: FC<ReplyElapsedProps> = ({ label, seconds, modelLabel }) => {
  const displayTime = formatElapsedTime(seconds)
  const displayModelLabel = modelLabel ? truncateModelLabel(modelLabel) : undefined
  const ariaLabel = modelLabel
    ? `${label} ${displayTime}, ${modelLabel}`
    : `${label} ${displayTime}`

  return (
    <span className="reply-elapsed" aria-label={ariaLabel}>
      <span>{label}</span>
      <span className="reply-elapsed-time">{displayTime}</span>
      {modelLabel ? <span aria-hidden="true">·</span> : null}
      {displayModelLabel ? <span className="reply-model" title={modelLabel}>{displayModelLabel}</span> : null}
    </span>
  )
}

export default ThinkingCounter
