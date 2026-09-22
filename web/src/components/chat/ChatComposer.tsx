import { useRef } from 'react'
import type { FC, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useI18n } from '../../i18n'
import { useAutoGrowTextarea } from '../../utils/autoGrowTextarea'

type ChatComposerProps = {
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  onSend: () => void
}

const ChatComposer: FC<ChatComposerProps> = ({
  value,
  disabled = false,
  onChange,
  onSend,
}) => {
  const { t } = useI18n()
  const sentOnTouchRef = useRef(false)
  const textareaRef = useAutoGrowTextarea(value)
  const canSend = !disabled && value.trim().length > 0

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (disabled) return
      onSend()
    }
  }

  const handleSendClick = () => {
    // iOS delivers the compatibility click after the touch press. The message was
    // already sent in handleSendPointerDown, while the keyboard was still stable.
    if (sentOnTouchRef.current) {
      sentOnTouchRef.current = false
      return
    }
    if (!canSend) return
    onSend()
  }

  const handleSendPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' || !canSend) return

    // On iPhone, tapping a button beside a focused textarea can blur the field
    // before click and move the fixed composer underneath the finger. Send on
    // the touch press and preserve focus so the button remains tappable.
    event.preventDefault()
    sentOnTouchRef.current = true
    onSend()
  }

  return (
    <div className="chat-input">
      <textarea
        ref={textareaRef}
        placeholder={disabled ? t('coach.chatPermissionRequired') : t('chat.placeholder')}
        value={value}
        disabled={disabled}
        rows={1}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
      />
      <button
        className="primary"
        type="button"
        onPointerDown={handleSendPointerDown}
        onClick={handleSendClick}
        disabled={!canSend}
        aria-label={t('common.send')}
        title={t('common.send')}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14" />
          <path d="m13 6 6 6-6 6" />
        </svg>
      </button>
    </div>
  )
}

export default ChatComposer
