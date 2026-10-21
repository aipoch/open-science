import { describe, expect, it } from 'vitest'
import {
  renderSkillDoc,
  renderCustomSkillDoc,
  renderConnectorInstructions
} from './skill-document-renderer'

describe('data-only Skill documents', () => {
  it('renders an independently configured provider without a registry or host', () => {
    const doc = renderSkillDoc({ id: 'custom', useWhen: 'Use for custom data' }, [
      {
        id: 'lookup',
        description: 'Look up data',
        input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        returns: '{ value }'
      }
    ])
    expect(doc).toContain('name: mcp-custom')
    expect(doc).toContain('host.mcp("custom", "lookup", {"id": "..."})')
    expect(doc).toContain('**Returns:** { value }')
  })
  it('keeps custom authentication guidance and successful materialized names explicit', () => {
    const doc = renderCustomSkillDoc({ name: 'custom', displayName: 'Custom', oauth: true }, [
      { name: 'read' }
    ])
    expect(doc).toContain('host-managed OAuth')
    expect(doc).toContain('host.mcp("custom", "read")')
    expect(renderConnectorInstructions(['mcp-custom', 'mcp-custom', 'invalid'])).toContain(
      'Available Connector Skills: `mcp-custom`.'
    )
    expect(renderConnectorInstructions([])).toBe('')
  })
})

it('renders structured provider arguments as a host call without evaluating argument strings', () => {
  const exampleArgs = { query: 'literal `code` and "quotes"', limit: 2 }
  const doc = renderSkillDoc({ id: 'custom', useWhen: 'Search' }, [
    { id: 'search', description: 'Search', input: {}, exampleArgs }
  ])
  expect(doc).toContain(`host.mcp("custom", "search", ${JSON.stringify(exampleArgs)})`)
  expect(doc).toContain('Do not bypass `host.mcp` with raw HTTP')
})
