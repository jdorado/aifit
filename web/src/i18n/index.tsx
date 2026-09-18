import type { FC, ReactNode } from 'react'
import { createContext, useContext, useMemo } from 'react'
import { DEFAULT_LANGUAGE, STRINGS, type Language } from './strings'

type InterpolationValues = Record<string, string | number>

export type I18n = {
  language: Language
  t: (key: string, values?: InterpolationValues) => string
}

const interpolate = (template: string, values?: InterpolationValues) => {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, token) => {
    const value = values[token]
    return value === undefined ? match : String(value)
  })
}

const resolvePath = (payload: Record<string, unknown>, path: string) => {
  const segments = path.split('.')
  let current: unknown = payload
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

export const createI18n = (language: Language): I18n => {
  const t = (key: string, values?: InterpolationValues) => {
    const primary = resolvePath(STRINGS[language] as Record<string, unknown>, key)
    const fallback = resolvePath(STRINGS[DEFAULT_LANGUAGE] as Record<string, unknown>, key)
    const raw = (typeof primary === 'string' ? primary : undefined)
      ?? (typeof fallback === 'string' ? fallback : undefined)
      ?? key
    return interpolate(raw, values)
  }

  return { language, t }
}

const I18nContext = createContext<I18n>(createI18n(DEFAULT_LANGUAGE))

export const I18nProvider: FC<{ value: I18n, children: ReactNode }> = ({ value, children }) => (
  <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
)

export const useI18n = () => {
  const context = useContext(I18nContext)
  return useMemo(() => context, [context])
}
