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

const SET_NUMBERS = [1, 2, 3, 4] as const
const COUNT_STEPS = [0, 1, 2, 3, 4] as const

const Landing = ({ onLogin, loading = false, error = null }: LandingProps) => {
  const { t } = createI18n(landingLanguage())

  if (loading) {
    return (
      <main className="landing landing--loading" aria-busy="true">
        <BrandMark alt={t('chat.logoAlt')} className="landing-logo-mark" />
        <span className="ld-loading-rule" aria-hidden="true"><i /></span>
        <p role="status">{t('auth.loading')}</p>
      </main>
    )
  }

  const steps = [
    { title: t('landing.step1Title'), text: t('landing.step1Text') },
    { title: t('landing.step2Title'), text: t('landing.step2Text') },
    { title: t('landing.step3Title'), text: t('landing.step3Text') },
  ]

  return (
    <main className="landing">
      <header className="ld-header">
        <div className="ld-brand">
          <BrandMark alt={t('chat.logoAlt')} className="landing-logo-mark" />
          <span>AIFit</span>
        </div>
        <span className="ld-tag">{t('landing.headerTag')}</span>
      </header>

      <section className="ld-hero">
        <div className="ld-copy">
          <p className="ld-kicker"><i aria-hidden="true" />{t('landing.kicker')}</p>
          <h1>
            {t('landing.titleLine1')}
            <br />
            {t('landing.titleLine2')} <em>{t('landing.titleEm')}</em>
          </h1>
          <p className="ld-intro">{t('landing.intro')}</p>
          <button className="ld-cta" type="button" onClick={onLogin} disabled={!onLogin}>
            <span>{t('landing.cta')}</span>
            <span className="ld-cta-arrow" aria-hidden="true">
              <svg viewBox="0 0 20 20">
                <path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </button>
          <p className="ld-footnote">{t('landing.footnote')}</p>
          {error ? <p className="ld-error" role="alert">{t('auth.signInFailed')}</p> : null}
        </div>

        <div className="ld-ticket" aria-hidden="true">
          <div className="ld-sheet">
            <div className="ld-ticket-top">
              <span className="ld-label">{t('landing.previewMeta')}</span>
              <span className="ld-chip"><i />{t('landing.previewStatus')}</span>
            </div>
            <p className="ld-ticket-title">{t('landing.previewWorkout')}</p>

            <div className="ld-progress">
              <span className="ld-rule"><i /></span>
              <span className="ld-count">
                {COUNT_STEPS.map((step) => (
                  <b key={step} className={`ld-count-${step}`}>{step}/4</b>
                ))}
              </span>
            </div>

            <ol className="ld-sets">
              {SET_NUMBERS.map((n) => (
                <li key={n} className={`ld-set ld-set-${n}`}>
                  <span className="ld-label">{t('landing.previewSet')} {n}</span>
                  <span className="ld-set-load"><mark>8 × 24 kg</mark></span>
                  <span className="ld-check">
                    <svg viewBox="0 0 20 20">
                      <path d="M5 10.5l3.2 3.2L15 6.8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </li>
              ))}
            </ol>

            <div className="ld-perf"><span /></div>

            <div className="ld-note">
              <span className="ld-label">{t('landing.previewNoteLabel')}</span>
              <p>{t('landing.previewNote')}</p>
              <div className="ld-tags">
                <span>{t('landing.previewTag1')}</span>
                <span>{t('landing.previewTag2')}</span>
                <span>{t('landing.previewTag3')}</span>
              </div>
            </div>

            <div className="ld-advice-slot">
              <div className="ld-advice">
                <span className="ld-label">{t('landing.previewAdviceKicker')}</span>
                <p>{t('landing.previewAdvice')}</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="ld-how" aria-labelledby="ld-how-title">
        <h2 id="ld-how-title" className="ld-section-rule"><span>{t('landing.howTitle')}</span></h2>
        <ol className="ld-steps">
          {steps.map((step, index) => (
            <li key={step.title} className="ld-step">
              <span className="ld-step-num" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="ld-footer">
        <p className="ld-footer-note">{t('landing.footerNote')}</p>
        <p className="ld-footer-links">
          <span>{t('landing.footerWorkouts')}</span>
          <i aria-hidden="true" />
          <span>{t('landing.footerMeals')}</span>
          <i aria-hidden="true" />
          <span>{t('landing.footerCoach')}</span>
        </p>
      </footer>
    </main>
  )
}

export default Landing
