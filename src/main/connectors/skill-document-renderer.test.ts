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
      'Globally Enabled Connector Skills: `mcp-custom`.'
    )
    expect(renderConnectorInstructions([])).toBe('')
  })
})
