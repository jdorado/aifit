import type { FC } from 'react'
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
  const singleModelOption = modelOptions.length === 1 ? modelOptions[0] : undefined
  const activeModelOption = modelOptions.find((option) => option.value === selectedModel)
    ?? singleModelOption

  return (
    <div className="chat-header">
      <div className="chat-title-block">
        <h1 className="chat-name">
          <span>AIFit</span>
          <strong>Coach</strong>
        </h1>
      </div>
      <div className="chat-header-actions">
        {modelOptions.length > 1 ? (
          <label className="chat-model-control">
            <select
              aria-label="AI model"
              title={modelOptions.find((option) => option.value === selectedModel)?.label}
              value={selectedModel}
              disabled={modelSelectionDisabled}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {modelOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <svg viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1 5 5 5-5" /></svg>
          </label>
        ) : singleModelOption && activeModelOption ? (
          <span
            className="chat-model-single"
            title={activeModelOption.label}
            aria-label="AI model"
          >
            {activeModelOption.label}
          </span>
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
