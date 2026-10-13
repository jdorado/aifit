import { useCallback, useRef } from 'react'
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
  canStartNewChat?: boolean
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
  canStartNewChat = true,
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
  const viewRef = useRef<HTMLElement>(null)

  // Starter prompts only pre-fill the composer; the athlete decides when to send.
  const handlePickPrompt = useCallback((prompt: string) => {
    onInputChange(prompt)
    window.requestAnimationFrame(() => {
      const textarea = viewRef.current?.querySelector<HTMLTextAreaElement>('.chat-input textarea')
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(prompt.length, prompt.length)
    })
  }, [onInputChange])

  return (
    <section ref={viewRef} className={`view ${active ? 'active' : ''}`} data-view="home">
      <section className="chat-window">
        <ChatHeader
          canStartNewChat={canStartNewChat && messages.length > 0 && !messages.some((message) => message.thinking)}
          modelOptions={modelOptions}
          selectedModel={selectedModel}
          modelSelectionDisabled={modelSelectionDisabled}
          onModelChange={onModelChange}
          onStartNewChat={onClearChat}
        />

        <div className="chat-body" ref={chatBodyRef} onScroll={onChatScroll} tabIndex={0}>
          <ChatMessages
            messages={messages}
            showModelLabels={showModelLabels}
            showAuthCard={showAuthButton}
            authButtonLabel={authButtonLabel}
            authButtonTitle={authButtonTitle}
            authButtonLoading={authButtonLoading}
            onAuthClick={onAuthClick}
            onPickPrompt={handlePickPrompt}
            promptsDisabled={inputDisabled}
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
          pending={messages.some((message) => message.thinking)}
          onChange={onInputChange}
          onSend={onSend}
        />
      </section>
    </section>
  )
}

export default ChatView
