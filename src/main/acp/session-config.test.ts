import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { matchSessionModelOption } from './session-config'

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
