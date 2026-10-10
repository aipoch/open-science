import { describe, expect, it } from 'vitest'
import { createConnectorRegistry } from './registry'
import type { ToolDescriptor } from './types'

const descriptor = (connector: string): ToolDescriptor => ({
  connector,
  id: 'read',
  description: 'Read a record',
  input: {
    type: 'object',
    properties: { id: { type: 'integer' } },
    required: ['id'],
    additionalProperties: false
  }
})

describe('independent Connector registry', () => {
  it('registers only supplied tools and retains their identities and ordering', () => {
    const first = descriptor('first')
    const second = descriptor('second')
    const tools = [first, second]
    const registry = createConnectorRegistry(tools)
    tools.pop()
    expect(registry.connectorIds).toEqual(['first', 'second'])
    expect(registry.getDescriptor('first', 'read')).toBe(first)
    expect(registry.getDescriptor('second', 'read')).toBe(second)
    expect(registry.getDescriptor('first', 'unknown')).toBeUndefined()
    expect(registry.getConnectorTools('first')).toEqual([first])
    registry.getConnectorTools('first').pop()
    expect(registry.getConnectorTools('first')).toEqual([first])
    expect(createConnectorRegistry([]).connectorIds).toEqual([])
  })

  it('does not accept a descriptor registered only in another instance', () => {
    const first = descriptor('same')
    const other = descriptor('same')
    const registry = createConnectorRegistry([first])
    const otherRegistry = createConnectorRegistry([other])
    expect(() => registry.validateToolArguments(first, { id: 1 })).not.toThrow()
    expect(() => otherRegistry.validateToolArguments(other, { id: 1 })).not.toThrow()
    expect(() => registry.validateToolArguments(other, { id: 1 })).toThrow(
      'unregistered tool descriptor: same/read'
    )
  })

  it('preserves strict validation without argument coercion, defaults or removal', () => {
    const tool = descriptor('standalone')
    const registry = createConnectorRegistry([tool])
    for (const args of [{}, { id: '1' }, { id: 1, extra: true }]) {
      const before = JSON.stringify(args)
      expect(() => registry.validateToolArguments(tool, args)).toThrow('invalid_arguments')
      expect(JSON.stringify(args)).toBe(before)
    }
    expect(() => registry.validateToolArguments(tool, Object.create({ id: 1 }))).toThrow(
      'field "id" is required'
    )
  })
})
