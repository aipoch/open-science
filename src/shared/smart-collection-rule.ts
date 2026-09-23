import { z } from 'zod'

export const SMART_RULE_MAX_LENGTH = 2000
export const SMART_RULE_STORAGE_MAX_LENGTH = 12100
export const smartRuleSchema = z
  .object({
    description: z.string().trim(),
    inclusion: z.string().trim().min(1),
    exclusion: z.string().trim()
  })
  .strict()
  .refine(
    (rule) =>
      rule.description.length + rule.inclusion.length + rule.exclusion.length <=
      SMART_RULE_MAX_LENGTH,
    'Collection rule is too long.'
  )
export type SmartRuleFields = z.infer<typeof smartRuleSchema>

// JSON is the persisted representation. Markdown is only a model-facing presentation.
export function formatSmartRule(fields: SmartRuleFields): string {
  return JSON.stringify({
    description: fields.description.trim(),
    inclusion: fields.inclusion.trim(),
    exclusion: fields.exclusion.trim()
  })
}
export function parseSmartRule(text: string): SmartRuleFields | undefined {
  try {
    return smartRuleSchema.safeParse(JSON.parse(text)).data
  } catch {
    return undefined
  }
}
export const serializedSmartRuleSchema = z
  .string()
  .max(SMART_RULE_STORAGE_MAX_LENGTH)
  .refine((text) => parseSmartRule(text) !== undefined, 'Invalid structured collection rule.')
export function smartRulePrompt(text: string): string {
  const rule = smartRuleSchema.parse(JSON.parse(text))
  return `Background:\n${rule.description}\n\nInclusion criteria (all must be met):\n${rule.inclusion}\n\nExclusion criteria (none may apply):\n${rule.exclusion}`
}
