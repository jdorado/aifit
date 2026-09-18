import type { FC, RefObject } from 'react'
import ChatComposer from '../components/chat/ChatComposer'
import ChatHeader from '../components/chat/ChatHeader'
import ChatMessages from '../components/chat/ChatMessages'
import { useI18n } from '../i18n'
import type { ChatMessage } from '../types/app'

type ChatViewProps = {
  active: boolean
  messages: ChatMessage[]
  inputValue: string
  inputDisabled?: boolean
  modelOptions: Array<{ value: string, label: string }>
  showModelLabels?: boolean
  selectedModel: string
  modelSelectionDisabled?: boolean
  onModelChange: (value: string) => void
  onInputChange: (value: string) => void
  onSend: () => void
  onClearChat: () => void
  onRefresh: () => void
  onAuthClick: () => void
  showAuthButton: boolean
  authButtonLabel: string
  authButtonTitle?: string
  authButtonLoading: boolean
  chatBodyRef: RefObject<HTMLDivElement>
  showScrollToBottom: boolean
  onChatScroll: () => void
  onScrollToBottom: () => void
}

const ChatView: FC<ChatViewProps> = ({
  active,
  messages,
  inputValue,
  inputDisabled = false,
  modelOptions,
  showModelLabels = false,
  selectedModel,
  modelSelectionDisabled = false,
  onModelChange,
  onInputChange,
  onSend,
  onClearChat,
  onAuthClick,
  showAuthButton,
  authButtonLabel,
  authButtonTitle,
  authButtonLoading,
  chatBodyRef,
  showScrollToBottom,
  onChatScroll,
  onScrollToBottom,
}) => {
  const { t } = useI18n()

  return (
    <section className={`view ${active ? 'active' : ''}`} data-view="home">
      <section className="chat-window">
        <ChatHeader
          canStartNewChat={messages.length > 0 && !messages.some((message) => message.thinking)}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          modelSelectionDisabled={modelSelectionDisabled}
          onModelChange={onModelChange}
          onStartNewChat={onClearChat}
        />

        <div className="chat-body" ref={chatBodyRef} onScroll={onChatScroll}>
          <ChatMessages
            messages={messages}
            showModelLabels={showModelLabels}
            showAuthCard={showAuthButton}
            authButtonLabel={authButtonLabel}
            authButtonTitle={authButtonTitle}
            authButtonLoading={authButtonLoading}
            onAuthClick={onAuthClick}
          />
        </div>

        {showScrollToBottom ? (
          <button
            className="chat-scroll-bottom"
            type="button"
            onClick={onScrollToBottom}
            aria-label={t('chat.scrollToLatest')}
            title={t('chat.scrollToLatest')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        ) : null}

        <ChatComposer
          value={inputValue}
          disabled={inputDisabled}
          onChange={onInputChange}
          onSend={onSend}
        />
      </section>
    </section>
  )
}

export default ChatView
