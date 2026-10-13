import type { CSSProperties, FC, ReactNode } from 'react'

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
  <section id={id} className={`pf-group ${className}`.trim()} aria-labelledby={title ? `${id ?? 'pf'}-title` : undefined}>
    {(eyebrow || title || subtitle || actions) ? (
      <div className="pf-group-head">
        <div className="pf-group-copy">
          {eyebrow ? <p className="pf-group-eyebrow">{eyebrow}</p> : null}
          {title ? <h2 className="pf-group-title" id={`${id ?? 'pf'}-title`}>{title}</h2> : null}
          {subtitle ? <p className="pf-group-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="pf-group-actions">{actions}</div> : null}
      </div>
    ) : null}
    {children ? <div className="pf-group-body">{children}</div> : null}
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

type ProfileSegmentFieldProps = {
  id: string
  label: string
  value: string
  options: Array<{ value: string, label: string }>
  onChange: (value: string) => void
}

/** Native radios under the hood: arrow keys, focus and form semantics come for free. */
export const ProfileSegmentField: FC<ProfileSegmentFieldProps> = ({
  id,
  label,
  value,
  options,
  onChange,
}) => (
  <div className="pf-row pf-row--stack">
    <span className="pf-row-label" id={`${id}-label`}>{label}</span>
    <div className="pf-segment" role="radiogroup" aria-labelledby={`${id}-label`}>
      {options.map((option) => (
        <label className="pf-segment-opt" key={option.value}>
          <input
            type="radio"
            name={id}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  </div>
)

type ProfileSwitchProps = {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** A checkbox with switch semantics: same keyboard and form behaviour, clearer on/off affordance. */
export const ProfileSwitch: FC<ProfileSwitchProps> = ({ label, checked, disabled = false, onChange }) => (
  <label className="pf-switch">
    <span className="pf-switch-label">{label}</span>
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span className="pf-switch-track" aria-hidden="true"><span className="pf-switch-thumb" /></span>
  </label>
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
}) => {
  const percent = Math.round(((value - Number(min)) / (Number(max) - Number(min))) * 100)
  return (
    <div className="pf-row pf-row--stack">
      <div className="pf-row-line">
        <label className="pf-row-label" htmlFor={id}>{label}</label>
        <span className="pf-row-value">{valueLabel}</span>
      </div>
      <input
        id={id}
        className="pf-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pf-range': `${percent}%` } as CSSProperties}
        onChange={(event) => onChange(event.target.value)}
        aria-valuetext={valueLabel}
      />
    </div>
  )
}
