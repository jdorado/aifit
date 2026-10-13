import type { FC } from 'react'
import { useI18n } from '../../i18n'
import type { ChatMessage } from '../../types/app'
import ThinkingCounter, { ReplyElapsed } from './ThinkingCounter'

type ChatMessagesProps = {
  messages: ChatMessage[]
  showModelLabels?: boolean
  showAuthCard?: boolean
  authButtonLabel?: string
  authButtonTitle?: string
  authButtonLoading?: boolean
  onAuthClick?: () => void
  onPickPrompt?: (prompt: string) => void
  promptsDisabled?: boolean
}

const STARTER_PROMPT_KEYS = ['starterLoad', 'starterSore', 'starterWeek'] as const

type CoachBylineProps = {
  label?: string
  timestamp?: number
}

export const CoachByline: FC<CoachBylineProps> = ({ label, timestamp }) => {
  const { t } = useI18n()
  let ago = ''
  if (timestamp) {
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
    if (minutes < 1) ago = t('chat.justNow')
    else if (minutes < 60) ago = `${minutes}m`
    else if (minutes < 60 * 24) ago = `${Math.floor(minutes / 60)}h`
    else ago = `${Math.floor(minutes / (60 * 24))}d`
  }
  return (
    <div className="coach-byline">
      <span className="coach-byline-mark" aria-hidden="true"></span>
      <span className="coach-byline-name">{t('chat.coachName')}</span>
      {label ? <span className="coach-byline-label">{label}</span> : null}
      {ago ? <span className="coach-byline-time">{ago}</span> : null}
    </div>
  )
}

const ChatMessages: FC<ChatMessagesProps> = ({
  messages,
  showModelLabels = false,
  showAuthCard = false,
  authButtonLabel,
  authButtonTitle,
  authButtonLoading = false,
  onAuthClick,
  onPickPrompt,
  promptsDisabled = false,
}) => {
  const { t } = useI18n()
  const signInLabel = authButtonLabel || t('auth.signIn')

  return (
    <>
      {messages.length === 0 ? (
        <div className="chat-empty">
          <span className="chat-empty-kicker">{t('chat.emptyKicker')}</span>
          <h2 className="chat-empty-title">{t('chat.emptyTitle')}</h2>
          <p className="chat-empty-text">{t('chat.emptyHint')}</p>
          {onPickPrompt ? (
            <ul className="chat-starters" aria-label={t('chat.startersLabel')}>
              {STARTER_PROMPT_KEYS.map((key, index) => (
                <li key={key}>
                  <button
                    type="button"
                    className="chat-starter"
                    disabled={promptsDisabled}
                    onClick={() => onPickPrompt(t(`chat.${key}`))}
                  >
                    <span className="chat-starter-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                    <span className="chat-starter-text">{t(`chat.${key}`)}</span>
                    <svg className="chat-starter-arrow" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 17 17 7M8 7h9v9" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {messages.map((message) => {
        if (message.thinking) {
          return (
            <div key={message.id} className="message-stack ai-stack">
              <div className="message ai thinking">
                <CoachByline />
                <ThinkingCounter
                  label={t('chat.thinkingLabel')}
                  statusText={t('common.thinking')}
                  startedAt={message.timestamp}
                />
              </div>
            </div>
          )
        }

        if (message.variant === 'ai') {
          return (
            <div key={message.id} className="message-stack ai-stack">
              <div className="message ai">
                <CoachByline label={showModelLabels ? message.modelLabel : undefined} timestamp={message.timestamp} />
                {message.html ? (
                  <div className="message-body" dangerouslySetInnerHTML={{ __html: message.html }}></div>
                ) : (
                  <div className="message-body"><p>{message.text}</p></div>
                )}
                {message.replyElapsedSeconds ? (
                  <ReplyElapsed
                    label={t('chat.repliedIn')}
                    seconds={message.replyElapsedSeconds}
                  />
                ) : null}
              </div>
            </div>
          )
        }

        return (
          <div key={message.id} className="message-stack user-stack">
            <div className="message user">{message.text}</div>
          </div>
        )
      })}

      {showAuthCard ? (
        <div className="message-stack ai-stack chat-auth-stack">
          <div className="message ai chat-auth-card">
            <span className="chat-auth-kicker">{t('chat.signInCardKicker')}</span>
            <p>{t('chat.signInCardText')}</p>
            <button
              className="chat-auth-action"
              type="button"
              onClick={onAuthClick}
              disabled={authButtonLoading || !onAuthClick}
              title={authButtonTitle}
            >
              {signInLabel}
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

export default ChatMessages
