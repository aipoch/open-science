import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { matchSessionModelOption, resolveSessionEffortOption } from './session-config'

// Builds a minimal `model` select option like opencode returns from session/new.
const modelOption = (
  values: string[],
  extra: Partial<SessionConfigOption> = {}
): SessionConfigOption =>
  ({
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: values[0],
    options: values.map((value) => ({ value, name: value })),
    ...extra
  }) as SessionConfigOption

describe('matchSessionModelOption', () => {
  it('matches an opencode provider/model value by its bare-model suffix', () => {
    const options = [modelOption(['anthropic/claude-sonnet-4-5', 'openai/gpt-5'])]

    expect(matchSessionModelOption(options, 'claude-sonnet-4-5')).toEqual({
      configId: 'model',
      value: 'anthropic/claude-sonnet-4-5'
    })
  })

  it('prefers an exact value match over a suffix match', () => {
    const options = [modelOption(['claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5'])]

    expect(matchSessionModelOption(options, 'claude-sonnet-4-5')).toEqual({
      configId: 'model',
      value: 'claude-sonnet-4-5'
    })
  })

  it('flattens grouped select options', () => {
    const grouped = {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'anthropic/claude-opus-4-8',
      options: [
        { name: 'Anthropic', options: [{ value: 'anthropic/claude-opus-4-8', name: 'Opus' }] }
      ]
    } as unknown as SessionConfigOption

    expect(matchSessionModelOption([grouped], 'claude-opus-4-8')).toEqual({
      configId: 'model',
      value: 'anthropic/claude-opus-4-8'
    })
  })

  it('returns undefined when nothing matches or inputs are empty', () => {
    const options = [modelOption(['openai/gpt-5'])]

    expect(matchSessionModelOption(options, 'claude-sonnet-4-5')).toBeUndefined()
    expect(matchSessionModelOption(options, undefined)).toBeUndefined()
    expect(matchSessionModelOption([], 'claude-sonnet-4-5')).toBeUndefined()
    expect(matchSessionModelOption(undefined, 'claude-sonnet-4-5')).toBeUndefined()
  })

  it('identifies the model option by category even when its id differs', () => {
    const options = [modelOption(['x/y-model'], { id: 'primary_model' })]

    expect(matchSessionModelOption(options, 'y-model')).toEqual({
      configId: 'primary_model',
      value: 'x/y-model'
    })
  })
})

// Builds a minimal `thought_level` select option like an agent returns from session/new.
const effortOption = (
  values: string[],
  extra: Partial<SessionConfigOption> = {}
): SessionConfigOption =>
  ({
    type: 'select',
    id: 'thought_level',
    name: 'Thought level',
    category: 'thought_level',
    currentValue: values[0],
    options: values.map((value) => ({ value, name: value })),
    ...extra
  }) as SessionConfigOption

describe('resolveSessionEffortOption', () => {
  it('matches the desired level exactly when the model advertises it', () => {
    const options = [effortOption(['low', 'medium', 'high'])]

    expect(resolveSessionEffortOption(options, 'high')).toEqual({
      configId: 'thought_level',
      value: 'high'
    })
  })

  it('falls back to the effort id when the category differs', () => {
    // Claude Code advertises the option as id `effort`, not under the thought_level category.
    const options = [effortOption(['low', 'high'], { id: 'effort', category: undefined })]

    expect(resolveSessionEffortOption(options, 'low')).toEqual({
      configId: 'effort',
      value: 'low'
    })
  })

  it('flattens grouped select options', () => {
    const grouped = {
      type: 'select',
      id: 'effort',
      name: 'Effort',
      currentValue: 'low',
      options: [{ name: 'Levels', options: [{ value: 'max', name: 'Max' }] }]
    } as unknown as SessionConfigOption

    expect(resolveSessionEffortOption([grouped], 'max')).toEqual({
      configId: 'effort',
      value: 'max'
    })
  })

  it('clamps max to the model\u2019s highest advertised level, skipping the default sentinel', () => {
    // Claude Code's effort select: a 'default' sentinel plus the model's supported levels.
    const options = [effortOption(['default', 'low', 'medium', 'high'])]

    expect(resolveSessionEffortOption(options, 'max')).toEqual({
      configId: 'thought_level',
      value: 'high'
    })
  })

  it('clamps low to the model\u2019s lowest advertised level', () => {
    const options = [effortOption(['medium', 'high'])]

    expect(resolveSessionEffortOption(options, 'low')).toEqual({
      configId: 'thought_level',
      value: 'medium'
    })
  })

  it('resolves equidistant levels to the lower (cheaper) one', () => {
    const options = [effortOption(['medium', 'xhigh'])]

    expect(resolveSessionEffortOption(options, 'high')).toEqual({
      configId: 'thought_level',
      value: 'medium'
    })
  })

  it('returns undefined when there is nothing usable to apply', () => {
    // Only the 'default' sentinel advertised: no real level to clamp onto.
    expect(resolveSessionEffortOption([effortOption(['default'])], 'high')).toBeUndefined()
    // 'default'/unknown desired levels never reach the agent.
    expect(resolveSessionEffortOption([effortOption(['low'])], 'default')).toBeUndefined()
    expect(resolveSessionEffortOption([effortOption(['low'])], 'turbo')).toBeUndefined()
    expect(resolveSessionEffortOption([effortOption(['low'])], undefined)).toBeUndefined()
    expect(resolveSessionEffortOption([], 'high')).toBeUndefined()
    expect(resolveSessionEffortOption(undefined, 'high')).toBeUndefined()
  })

  it('does not mistake the model option for an effort option', () => {
    const options = [modelOption(['high'])]

    expect(resolveSessionEffortOption(options, 'high')).toBeUndefined()
  })
})
