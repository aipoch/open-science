import type { SkillReplacementPreview } from './types'

export type ImportOutcome = { status: 'imported' | 'unchanged' | 'updated'; id: string }

export type ParsedSkillPreview = {
  replacement?: SkillReplacementPreview
  name: string
  description: string
  metadata: Record<string, string>
  body: string
  files: string[]
}
