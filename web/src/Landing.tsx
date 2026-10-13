import { createI18n } from './i18n'
import { normalizeLanguage } from './i18n/strings'
import BrandMark from './components/ui/BrandMark'

type LandingProps = {
  onLogin?: () => void
  loading?: boolean
  error?: string | null
}

const landingLanguage = () => (
  normalizeLanguage(typeof navigator === 'undefined' ? null : navigator.language) ?? 'en'
)

const Landing = ({ onLogin, loading = false, error = null }: LandingProps) => {
  const { t } = createI18n(landingLanguage())

  if (loading) {
    return (
      <main className="landing landing--loading">
        <BrandMark alt={t('chat.logoAlt')} className="landing-logo-mark" />
        <p>{t('auth.loading')}</p>
      </main>
    )
  }

  return (
    <main className="landing">
      <header className="landing-header">
        <div className="landing-brand">
          <BrandMark alt={t('chat.logoAlt')} className="landing-logo-mark" />
          <span>AIFit</span>
        </div>
        <span>{t('landing.headerTag')}</span>
      </header>
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-kicker">{t('landing.kicker')}</p>
          <h1>
            {t('landing.titleLine1')}
            <br />
            {t('landing.titleLine2')} <em>{t('landing.titleEm')}</em>
          </h1>
          <p className="landing-intro">{t('landing.intro')}</p>
          <button className="landing-cta" type="button" onClick={onLogin} disabled={!onLogin}>
            {t('landing.cta')}
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <small>{t('landing.footnote')}</small>
          {error ? <p className="landing-error">{t('auth.signInFailed')}</p> : null}
        </div>
        <div className="landing-preview" aria-hidden="true">
          <div className="preview-meta">
            <span>{t('landing.previewMeta')}</span>
            <span className="preview-status">{t('landing.previewStatus')}</span>
          </div>
          <div className="preview-workout">{t('landing.previewWorkout')}</div>
          <div className="preview-metrics">
            <div>
              <span>{t('landing.metricSets')}</span>
              <strong>4</strong>
            </div>
            <div>
              <span>{t('landing.metricReps')}</span>
              <strong>8</strong>
            </div>
            <div>
              <span>{t('landing.metricLoad')}</span>
              <strong>24<small>kg</small></strong>
            </div>
          </div>
          <div className="preview-note">
            <span>{t('landing.previewNoteLabel')}</span>
            {t('landing.previewNote')}
          </div>
          <div className="preview-tags">
            <span>{t('landing.previewTag1')}</span>
            <span>{t('landing.previewTag2')}</span>
            <span>{t('landing.previewTag3')}</span>
          </div>
          <div className="preview-advice">
            <div>
              <i />
              <span>{t('landing.previewAdviceKicker')}</span>
              <small>{t('landing.previewAdviceMeta')}</small>
            </div>
            <p>{t('landing.previewAdvice')}</p>
          </div>
        </div>
      </section>
      <footer className="landing-footer">
        <span>{t('landing.footerWorkouts')}</span>
        <i />
        <span>{t('landing.footerMeals')}</span>
        <i />
        <span>{t('landing.footerCoach')}</span>
      </footer>
    </main>
  )
}

export default Landing
