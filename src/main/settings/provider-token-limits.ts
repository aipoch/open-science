import type { ProviderDraft } from '../../shared/settings'

type CustomTokenLimitKey = 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens'
export type CustomTokenLimits = Partial<Record<CustomTokenLimitKey, number>>

const CUSTOM_TOKEN_LIMIT_FIELDS = [
  ['contextWindow', 'Context window'],
  ['maxInputTokens', 'Maximum input tokens'],
  ['maxOutputTokens', 'Maximum output tokens']
] as const satisfies readonly (readonly [CustomTokenLimitKey, string])[]

export const isPositiveWholeTokenLimit = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0

export const resolveCustomTokenLimits = (
  request: ProviderDraft,
  existing?: CustomTokenLimits
): CustomTokenLimits => {
  const result: CustomTokenLimits = {}
  for (const [field, label] of CUSTOM_TOKEN_LIMIT_FIELDS) {
    const value = request[field] === null ? undefined : (request[field] ?? existing?.[field])
    if (value !== undefined && !isPositiveWholeTokenLimit(value)) {
      throw new Error(`${label} must be a positive whole number of tokens.`)
    }
    if (value !== undefined) result[field] = value
  }
  return result
}
