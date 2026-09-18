import type { FC } from 'react'
import { useI18n } from '../../i18n'

type PromptGridProps = {
  onSelectPrompt: (value: string) => void
}

const PromptGrid: FC<PromptGridProps> = ({ onSelectPrompt }) => {
  const { t } = useI18n()
  const quickPrompts = [
    { title: t('chat.quickTodayTitle'), value: t('chat.quickTodayPrompt') },
    { title: t('chat.quickAdjustTitle'), value: t('chat.quickAdjustPrompt') },
    { title: t('chat.quickRecoverTitle'), value: t('chat.quickRecoverPrompt') },
    { title: t('chat.quickWeekTitle'), value: t('chat.quickWeekPrompt') },
  ]

  return (
    <section className="prompt-grid" aria-label={t('chat.kicker')}>
      {quickPrompts.map((prompt) => (
        <button
          key={prompt.title}
          className="prompt-card"
          type="button"
          onClick={() => onSelectPrompt(prompt.value)}
        >
          <span className="prompt-card-title">{prompt.title}</span>
          <span className="prompt-card-copy">{prompt.value}</span>
        </button>
      ))}
    </section>
  )
}

export default PromptGrid
