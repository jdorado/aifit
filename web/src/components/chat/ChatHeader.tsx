import { useEffect, useRef, useState, type FC } from 'react'
import { useI18n } from '../../i18n'
type ChatHeaderProps = {
  canStartNewChat: boolean
  modelOptions: Array<{ value: string, label: string }>
  selectedModel: string
  modelSelectionDisabled?: boolean
  onModelChange: (value: string) => void
  onStartNewChat: () => void
}

const ChatHeader: FC<ChatHeaderProps> = ({
  canStartNewChat,
  modelOptions,
  selectedModel,
  modelSelectionDisabled = false,
  onModelChange,
  onStartNewChat,
}) => {
  const { t } = useI18n()
  const activeModelOption = modelOptions.find((option) => option.value === selectedModel)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const modelMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!modelMenuOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [modelMenuOpen])

  useEffect(() => {
    if (modelSelectionDisabled) setModelMenuOpen(false)
  }, [modelSelectionDisabled])

  return (
    <div className="chat-header">
      <div className="chat-title-block">
        <h1 className="chat-name">
          <span>AIFit</span>
          <strong>Coach</strong>
        </h1>
      </div>
      <div className="chat-header-actions">
        {modelOptions.length > 0 ? (
          <div className="chat-model-control" ref={modelMenuRef}>
            <button
              type="button"
              className="chat-model-trigger"
              aria-label="AI model"
              aria-expanded={modelMenuOpen}
              title={activeModelOption?.label}
              disabled={modelSelectionDisabled}
              onClick={() => setModelMenuOpen((open) => !open)}
            >
              <span>{activeModelOption?.label ?? 'Select model'}</span>
              <svg viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1 5 5 5-5" /></svg>
            </button>
            {modelMenuOpen && (
              <div className="chat-model-menu" role="group" aria-label="AI model options">
                {modelOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="chat-model-option"
                    aria-current={option.value === selectedModel ? 'true' : undefined}
                    onClick={() => {
                      setModelMenuOpen(false)
                      onModelChange(option.value)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
        <button
          className="chat-new-session"
          type="button"
          onClick={onStartNewChat}
          disabled={!canStartNewChat}
          aria-label={t('chat.clearAction')}
          title={t('chat.clearAction')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default ChatHeader
