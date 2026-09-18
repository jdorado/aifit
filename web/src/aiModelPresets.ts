export const AI_MODEL_PRESETS = [
  {
    id: 'astra-low',
    label: '6 Astra Light',
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-6-astra',
    reasoningEffort: 'low',
  },
  {
    id: 'astra-medium',
    label: '6 Astra Medium',
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-6-astra',
    reasoningEffort: 'medium',
  },
  {
    id: 'astra-high',
    label: '6 Astra High',
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-6-astra',
    reasoningEffort: 'high',
  },
  {
    id: 'sol-low',
    label: '5.6 Sol Light',
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'low',
  },
  {
    id: 'luna-max',
    label: '5.6 Luna Max',
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
  },
  {
    id: 'sol-medium',
    label: '5.6 Sol Medium',
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
  },
  {
    id: 'sol-high',
    label: '5.6 Sol High',
    cli: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  },
  {
    id: 'grok-medium',
    label: 'Grok 4.6 Medium',
    cli: 'grok',
    provider: 'grok',
    model: 'grok-4.6',
    reasoningEffort: 'medium',
  },
  {
    id: 'grok-high',
    label: 'Grok 4.6 High',
    cli: 'grok',
    provider: 'grok',
    model: 'grok-4.6',
    reasoningEffort: 'high',
  },
  {
    id: 'openrouter-gemini-flash-medium',
    label: 'Gemini 3.8 Flash',
    cli: 'codex',
    provider: 'openrouter',
    model: 'google/gemini-3.8-flash',
    reasoningEffort: 'medium',
  },
  {
    id: 'openrouter-deepseek-flash-low',
    label: 'DeepSeek V4.1 Flash',
    cli: 'codex',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4.1-flash',
    reasoningEffort: 'low',
  },
] as const

export type AiModelPresetId = typeof AI_MODEL_PRESETS[number]['id']
export type AiModelPreset = typeof AI_MODEL_PRESETS[number]

export const DEFAULT_AI_MODEL_PRESET_ID: AiModelPresetId = 'sol-low'

const LEGACY_TERRA_PRESET_IDS = new Set(['terra-low', 'terra-medium', 'terra-high'])

export const isAiModelPresetId = (value: unknown): value is AiModelPresetId => (
  AI_MODEL_PRESETS.some((preset) => preset.id === value)
)

export const migrateAiModelPresetId = (value: unknown): AiModelPresetId | undefined => {
  if (typeof value === 'string' && LEGACY_TERRA_PRESET_IDS.has(value)) return 'luna-max'
  return isAiModelPresetId(value) ? value : undefined
}

export const getAiModelPreset = (id: AiModelPresetId): AiModelPreset => (
  AI_MODEL_PRESETS.find((preset) => preset.id === id)
  ?? AI_MODEL_PRESETS.find((preset) => preset.id === DEFAULT_AI_MODEL_PRESET_ID)
  ?? AI_MODEL_PRESETS[0]
)
