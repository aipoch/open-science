import { describe, expect, it } from 'vitest'
import { createProjectRequestSchema, updateProjectRequestSchema } from './projects'

describe('project optimization prompt', () => {
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
