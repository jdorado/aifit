import type { FC } from 'react'

type NotesBlockProps = {
  open: boolean
  canEdit: boolean
  title: string
  subtitle: string
  value: string
  placeholder: string
  ariaLabel: string
  rows?: number
  presets?: string[]
  onToggle: () => void
  onChange: (value: string) => void
  onPresetClick?: (preset: string) => void
}

const NotesBlock: FC<NotesBlockProps> = ({
  open,
  canEdit,
  title,
  subtitle,
  value,
  placeholder,
  ariaLabel,
  rows = 3,
  presets = [],
  onToggle,
  onChange,
  onPresetClick,
}) => (
  <div className={`notes-block${open ? ' open' : ''}${canEdit ? '' : ' disabled'}`}>
    <button
      className="notes-toggle"
      type="button"
      onClick={onToggle}
      aria-expanded={open}
    >
      <span className="notes-toggle-text">
        <span className="notes-title">{title}</span>
        <span className="notes-subtitle">{subtitle}</span>
      </span>
      <span className="notes-chevron">›</span>
    </button>
    <div className="notes-panel">
      <textarea
        className="notes-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={!canEdit}
        aria-label={ariaLabel}
      />
      {presets.length > 0 ? (
        <div className="note-chips">
          {presets.map((preset) => (
            <button
              key={preset}
              className="note-chip"
              type="button"
              onClick={() => onPresetClick?.(preset)}
              disabled={!canEdit}
            >
              {preset}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  </div>
)

export default NotesBlock
