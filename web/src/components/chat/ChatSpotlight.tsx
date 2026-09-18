import type { FC } from 'react'
import { useI18n } from '../../i18n'

type ChatSpotlightProps = {
  featuredDayLabel: string
  onOpenWorkout: () => void
}

const ChatSpotlight: FC<ChatSpotlightProps> = ({ featuredDayLabel, onOpenWorkout }) => {
  const { t } = useI18n()

  return (
    <section className="hero-panel chat-spotlight">
      <div className="chat-spotlight-copy">
        <p className="card-label">{t('chat.kicker')}</p>
        <h2 className="panel-title">{t('chat.heroTitle')}</h2>
        <p className="panel-copy">{t('chat.heroSubtitle', { day: featuredDayLabel })}</p>
      </div>
      <div className="chat-spotlight-actions">
        <button className="action-pill primary" type="button" onClick={onOpenWorkout}>
          {t('chat.openWorkout', { day: featuredDayLabel })}
        </button>
      </div>
    </section>
  )
}

export default ChatSpotlight
