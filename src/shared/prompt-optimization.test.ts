import { describe, expect, it } from 'vitest'
import {
  optimizePromptRequestSchema,
  resolveOptimizationPrompt,
  type OptimizationPromptProject
} from './prompt-optimization'
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

  it('resolves a current-project prompt before an all-project prompt and then the built-in default', () => {
    const allProjects: OptimizationPromptProject[] = [
      {
        id: 'global',
        optimizationPrompt: 'Use the global template.',
        optimizationPromptScope: 'all'
      },
      {
        id: 'current',
        optimizationPrompt: 'Use the current template.',
        optimizationPromptScope: 'current'
      }
    ]

    expect(resolveOptimizationPrompt(allProjects[1], allProjects)).toBe('Use the current template.')
    expect(
      resolveOptimizationPrompt(
        { id: 'other', optimizationPrompt: '', optimizationPromptScope: 'current' },
        allProjects
      )
    ).toBe('Use the global template.')
    expect(resolveOptimizationPrompt(undefined, [])).toBeDefined()
  })
})
