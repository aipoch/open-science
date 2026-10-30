import { describe, expect, it } from 'vitest'
import { optimizePromptRequestSchema } from './prompt-optimization'
import { createProjectRequestSchema, updateProjectRequestSchema } from './projects'

describe('project optimization prompt', () => {
  it('rejects requests without a composer model selection rather than falling back globally', () => {
    expect(
      optimizePromptRequestSchema.safeParse({ projectId: 'project', input: 'Help' }).success
    ).toBe(false)
  })
  it('accepts an independent project template on create and reset on update', () => {
    expect(
      createProjectRequestSchema.safeParse({
        name: 'Biology',
        optimizationPrompt: 'Keep it brief.'
      }).success
    ).toBe(true)
    expect(
      updateProjectRequestSchema.safeParse({
        id: 'biology',
        expectedUpdatedAt: 1,
        optimizationPrompt: ''
      }).success
    ).toBe(true)
  })
  it('rejects oversized templates', () => {
    expect(
      createProjectRequestSchema.safeParse({
        name: 'Biology',
        optimizationPrompt: 'x'.repeat(16001)
      }).success
    ).toBe(false)
  })
})
