import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FC, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useI18n } from '../../i18n'
import type { ChatMessage } from '../../types/app'
import ThinkingCounter, { ReplyElapsed } from '../chat/ThinkingCounter'
import { useAutoGrowTextarea } from '../../utils/autoGrowTextarea'

type CoachChatProps = {
  open: boolean
  disabled?: boolean
  messages: ChatMessage[]
  showModelLabels?: boolean
  modelOptions?: Array<{ value: string, label: string }>
  selectedModel?: string
  modelSelectionDisabled?: boolean
  onModelChange?: (value: string) => void
  subtitle?: string
  draft: string
  onToggle: () => void
  onDraftChange: (value: string) => void
  onSend: () => void
  onQuickPrompt: (message: string) => void
  onSwap?: () => void
}

const QUICK_PROMPT_KEYS = [
  'quickExplainForm',
  'quickSuggestWeight',
  'quickMakeEasier',
  'quickLastTime',
  'quickProgressOrDeload',
  'quickRestTime',
  'quickAdjustVolume',
  'quickNextExercise',
] as const

const CoachChat: FC<CoachChatProps> = ({
  open,
  disabled = false,
  messages,
  showModelLabels = false,
  modelOptions = [],
  selectedModel = '',
  modelSelectionDisabled = false,
  onModelChange,
  subtitle,
  draft,
  onToggle,
  onDraftChange,
  onSend,
  onQuickPrompt,
  onSwap,
}) => {
  const { t } = useI18n()
  const hasDraft = !disabled && draft.trim().length > 0
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useAutoGrowTextarea(draft, open)
  const scrollFrameRef = useRef<number | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const [isMobileViewport, setIsMobileViewport] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
  ))

  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)')
    const sync = () => setIsMobileViewport(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  const clearPendingScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  const scrollMessagesToBottom = useCallback(() => {
    const node = messagesRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [])

  const scheduleMessagesToBottom = useCallback(() => {
    clearPendingScroll()
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null
      scrollMessagesToBottom()
    })
  }, [clearPendingScroll, scrollMessagesToBottom])

  const handleSend = () => {
    if (!hasDraft) return
    onSend()
    // Keep focus for quick back-and-forth after send.
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current)
    }
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      const input = inputRef.current
      if (input && document.activeElement !== input) {
        input.focus({ preventScroll: true })
      }
    })
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      handleSend()
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    scrollMessagesToBottom()
  }, [messages, open, scrollMessagesToBottom])

  useEffect(() => () => {
    clearPendingScroll()
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [clearPendingScroll])

  // Follow the keyboard: sheet follows the shared visible viewport; keep latest messages visible.
  useEffect(() => {
    if (!open) return undefined

    const onViewportChange = () => {
      if (document.activeElement === inputRef.current) {
        scheduleMessagesToBottom()
      }
    }

    const visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', onViewportChange)
    visualViewport?.addEventListener('scroll', onViewportChange)

    return () => {
      visualViewport?.removeEventListener('resize', onViewportChange)
      visualViewport?.removeEventListener('scroll', onViewportChange)
    }
  }, [open, scheduleMessagesToBottom])

  // Soft lock: prevent detail page scroll bleed while the sheet is open.
  useEffect(() => {
    if (!open || !isMobileViewport) return undefined
    const body = document.body
    const root = document.documentElement
    const previousBodyOverflow = body.style.overflow
    const previousRootOverflow = root.style.overflow
    const previousRootOverscroll = root.style.overscrollBehavior
    body.classList.add('aifit-coach-chat-open')
    body.style.overflow = 'hidden'
    root.style.overflow = 'hidden'
    root.style.overscrollBehavior = 'none'

    return () => {
      body.classList.remove('aifit-coach-chat-open')
      body.style.overflow = previousBodyOverflow
      root.style.overflow = previousRootOverflow
      root.style.overscrollBehavior = previousRootOverscroll
    }
  }, [isMobileViewport, open])

  useEffect(() => {
    if (!open) return undefined
    const detailContent = document.querySelector<HTMLElement>('.workout-detail.active .detail-content')
    if (!detailContent) return undefined
    const previous = detailContent.style.overflow
    detailContent.style.overflow = 'hidden'
    return () => {
      detailContent.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  const chatSurface = (
    <>
      <button
        type="button"
        className="coach-chat-backdrop"
        aria-label={t('common.close')}
        onClick={onToggle}
      />
      <aside
        className={`coach-chat open${isMobileViewport ? ' coach-chat--portaled' : ''}`}
        aria-label={t('workout.coachChatLabel')}
      >
        <div className="coach-chat-header">
          <span className="coach-chat-dot" aria-hidden="true"></span>
          <span className="coach-chat-text">
            <span className="coach-chat-title">{t('workout.askCoach')}</span>
            <span className="coach-chat-subtitle">{subtitle || t('workout.coachSheetHint')}</span>
          </span>
          {modelOptions.length > 0 && onModelChange ? (
            <label className="coach-chat-model-select">
              <select
                value={selectedModel}
                onChange={(event) => onModelChange(event.target.value)}
                aria-label="AI model"
                disabled={disabled || modelSelectionDisabled}
              >
                <option value="" disabled>Select model</option>
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <svg viewBox="0 0 12 8" aria-hidden="true">
                <path d="m1 1 5 5 5-5" />
              </svg>
            </label>
          ) : null}
          <button
            type="button"
            className="coach-chat-close"
            onClick={onToggle}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
        <div className="coach-chat-panel" role="region" aria-live="polite">
          <div className="coach-chat-messages" ref={messagesRef}>
            {messages.length === 0 ? (
              <p className="coach-chat-empty">{t('workout.coachEmpty')}</p>
            ) : null}
            {messages.map((message) => {
              if (message.thinking) {
                return (
                  <div key={message.id} className="coach-chat-msg ai thinking">
                    <ThinkingCounter
                      label={t('workout.coachThinking')}
                      statusText={t('common.thinking')}
                      startedAt={message.timestamp}
                    />
                  </div>
                )
              }

              return (
                <div key={message.id} className={`coach-chat-msg ${message.variant}`}>
                  <div>
                    {message.variant === 'ai' && message.html ? (
                      <div dangerouslySetInnerHTML={{ __html: message.html }}></div>
                    ) : (
                      <p>{message.text}</p>
                    )}
                    {message.variant === 'ai' && message.replyElapsedSeconds ? (
                      <ReplyElapsed
                        label={t('chat.repliedIn')}
                        seconds={message.replyElapsedSeconds}
                        modelLabel={showModelLabels ? message.modelLabel : undefined}
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="coach-chat-prompts" role="group" aria-label={t('workout.quickPromptsLabel')}>
            {onSwap ? (
              <button
                type="button"
                disabled={disabled}
                onClick={onSwap}
              >
                {t('workout.quickSwap')}
              </button>
            ) : null}
            {QUICK_PROMPT_KEYS.map((key) => (
              <button
                type="button"
                key={key}
                disabled={disabled}
                onClick={() => onQuickPrompt(t(`workout.${key}`))}
              >
                {t(`workout.${key}`)}
              </button>
            ))}
          </div>
          <div className="coach-chat-input">
            <textarea
              ref={inputRef}
              placeholder={t('workout.coachPlaceholder')}
              value={draft}
              disabled={disabled}
              rows={1}
              onChange={(event) => onDraftChange(event.target.value)}
              onFocus={scheduleMessagesToBottom}
              onKeyDown={handleKeyDown}
              enterKeyHint="send"
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" onClick={handleSend} disabled={!hasDraft}>
              {t('common.send')}
            </button>
          </div>
        </div>
      </aside>
    </>
  )

  return isMobileViewport ? createPortal(chatSurface, document.body) : chatSurface
}

export default CoachChat
