import type { FC, ReactNode } from 'react'

type ProfilePanelProps = {
  id?: string
  eyebrow?: string
  title?: string
  subtitle?: string
  actions?: ReactNode
  children?: ReactNode
  className?: string
}

export const ProfilePanel: FC<ProfilePanelProps> = ({
  id,
  eyebrow,
  title,
  subtitle,
  actions,
  children,
  className = '',
}) => (
  <section id={id} className={`profile-panel ${className}`.trim()}>
    {(eyebrow || title || subtitle || actions) ? (
      <div className="profile-panel-header">
        <div>
          {eyebrow ? <p className="profile-panel-eyebrow">{eyebrow}</p> : null}
          {title ? <h2 className="profile-panel-title">{title}</h2> : null}
          {subtitle ? <p className="profile-panel-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="profile-panel-actions">{actions}</div> : null}
      </div>
    ) : null}
    {children ? <div className="profile-panel-body">{children}</div> : null}
  </section>
)

type ProfileMetricProps = {
  label: string
  value: string | number
  note?: string
  tone?: 'green' | 'peach' | 'blue' | 'gray'
}

export const ProfileMetric: FC<ProfileMetricProps> = ({
  label,
  value,
  note,
  tone = 'green',
}) => (
  <article className={`profile-metric profile-metric--${tone}`}>
    <span className="profile-metric-label">{label}</span>
    <strong className="profile-metric-value">{value}</strong>
    {note ? <span className="profile-metric-note">{note}</span> : null}
  </article>
)

type ProfileTextAreaFieldProps = {
  id: string
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  readOnly?: boolean
  description?: string
}

export const ProfileTextAreaField: FC<ProfileTextAreaFieldProps> = ({
  id,
  label,
  value,
  placeholder,
  onChange,
  readOnly = false,
  description,
}) => (
  <div className="profile-field">
    <label htmlFor={id}>{label}</label>
    <textarea
      id={id}
      placeholder={placeholder}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
    {description ? <small>{description}</small> : null}
  </div>
)

type ProfileSelectFieldProps = {
  id: string
  label: string
  value: string
  options: Array<{ value: string, label: string }>
  onChange: (value: string) => void
}

export const ProfileSelectField: FC<ProfileSelectFieldProps> = ({
  id,
  label,
  value,
  options,
  onChange,
}) => (
  <div className="profile-field">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </div>
)

type ProfileRangeFieldProps = {
  id: string
  label: string
  value: number
  min: string
  max: string
  step: string
  valueLabel: string
  onChange: (value: string) => void
}

export const ProfileRangeField: FC<ProfileRangeFieldProps> = ({
  id,
  label,
  value,
  min,
  max,
  step,
  valueLabel,
  onChange,
}) => (
  <div className="profile-field profile-field--range">
    <label htmlFor={id}>{label}</label>
    <div className="profile-range-control">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-valuetext={valueLabel}
      />
      <span className="profile-range-value">{valueLabel}</span>
    </div>
  </div>
)
