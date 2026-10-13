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
}

const ChatMessages: FC<ChatMessagesProps> = ({
  messages,
  showModelLabels = false,
  showAuthCard = false,
  authButtonLabel,
  authButtonTitle,
  authButtonLoading = false,
  onAuthClick,
}) => {
  const { t } = useI18n()
  const signInLabel = authButtonLabel || t('auth.signIn')

  return (
    <>
      {messages.length === 0 ? (
        <div className="chat-empty message-stack ai-stack">
          <span className="message-avatar" aria-hidden="true">AI</span>
          <div className="message ai">
            <p>{t('chat.empty')}</p>
          </div>
        </div>
      ) : null}

      {messages.map((message) => {
        if (message.thinking) {
          return (
            <div key={message.id} className="message-stack ai-stack">
              <span className="message-avatar" aria-hidden="true">AI</span>
              <div className="message ai thinking">
                <ThinkingCounter
                  label={t('chat.thinkingLabel')}
                  statusText={t('common.thinking')}
                  startedAt={message.timestamp}
                />
              </div>
            </div>
          )
        }

        if (message.variant === 'ai' && message.html) {
          return (
            <div key={message.id} className="message-stack ai-stack">
              <span className="message-avatar" aria-hidden="true">AI</span>
              <div className="message ai">
                <div dangerouslySetInnerHTML={{ __html: message.html }}></div>
                {message.replyElapsedSeconds ? (
                  <ReplyElapsed
                    label={t('chat.repliedIn')}
                    seconds={message.replyElapsedSeconds}
                    modelLabel={showModelLabels ? message.modelLabel : undefined}
                  />
                ) : null}
              </div>
            </div>
          )
        }

        return (
          <div key={message.id} className={`message-stack ${message.variant}-stack`}>
            {message.variant === 'ai' ? <span className="message-avatar" aria-hidden="true">AI</span> : null}
            <div className={`message ${message.variant}`}>
              {message.text}
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

      {showAuthCard ? (
        <div className="message-stack ai-stack chat-auth-stack">
          <span className="message-avatar" aria-hidden="true">AI</span>
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
