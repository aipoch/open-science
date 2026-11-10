import { describe, expect, it } from 'vitest'
import {
  optimizePromptRequestSchema,
  optimizationEventSchema,
  resolveOptimizationPrompt,
  DEFAULT_OPTIMIZATION_PROMPT
} from './prompt-optimization'
import { createProjectRequestSchema, updateProjectRequestSchema } from './projects'

describe('project optimization prompt', () => {
  it('rejects the removed scope field on project writes', () => {
    expect(
      createProjectRequestSchema.safeParse({
        name: 'Biology',
        optimizationPromptScope: 'all'
      }).success
    ).toBe(false)
    expect(
      updateProjectRequestSchema.safeParse({
        id: 'biology',
        expectedUpdatedAt: 1,
        optimizationPromptScope: 'current'
      }).success
    ).toBe(false)
  })
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

  it('uses only the current-project prompt and then the built-in default', () => {
    expect(
      resolveOptimizationPrompt({ id: 'current', optimizationPrompt: 'Use the current template.' })
    ).toBe('Use the current template.')
    expect(resolveOptimizationPrompt({ id: 'other', optimizationPrompt: '' })).toBe(
      DEFAULT_OPTIMIZATION_PROMPT
    )
    expect(resolveOptimizationPrompt({ id: 'other', optimizationPrompt: '  ' })).toBe(
      DEFAULT_OPTIMIZATION_PROMPT
    )
    expect(resolveOptimizationPrompt(undefined)).toBe(DEFAULT_OPTIMIZATION_PROMPT)
    expect(DEFAULT_OPTIMIZATION_PROMPT).toBe(
      "Rewrite the user's input into a clear, specific, and actionable prompt while preserving its original intent and important details."
    )
  })
})

it('accepts bounded renderer diagnostics and rejects arbitrary error details', () => {
  const event = { action: 'failed', requestId: crypto.randomUUID(), stage: 'references' }
  expect(optimizationEventSchema.safeParse(event).success).toBe(true)
  expect(optimizationEventSchema.safeParse({ ...event, message: 'private output' }).success).toBe(
    false
  )
  expect(optimizationEventSchema.safeParse({ ...event, stage: 'private output' }).success).toBe(
    false
  )
  expect(optimizationEventSchema.safeParse({ ...event, requestId: 'private input' }).success).toBe(
    false
  )
})
