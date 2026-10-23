import { describe, expect, it } from 'vitest'
import {
  renderSkillDoc,
  renderCustomSkillDoc,
  renderConnectorInstructions
} from './skill-document-renderer'

describe('data-only Skill documents', () => {
  it('renders access guidance before tools without inventing a setup requirement', () => {
    const doc = renderSkillDoc(
      {
        id: 'public',
        useWhen: 'Search public data',
        accessGuidance: 'Public search needs no key.'
      },
      [{ id: 'search', description: 'Search', input: {} }]
    )
    expect(doc.indexOf('## Access requirements')).toBeLessThan(doc.indexOf('## Tools'))
    expect(doc).toContain('Public search needs no key.')
    expect(doc).toContain('Keep optional keys and public/demo access optional')
    expect(doc).toContain('Configured credentials do not prove dataset approval')
    expect(doc).toContain('Never request secrets in chat or tool arguments')
    expect(doc).toContain('not proof of a particular approval requirement')
    expect(doc.match(/## Access requirements/g)).toHaveLength(1)
  })

  it('does not infer a provider-specific requirement when metadata is absent', () => {
    const doc = renderSkillDoc({ id: 'public', useWhen: 'Search public data' }, [])
    expect(doc).not.toContain('Settings > Credentials')
    expect(doc).not.toContain('https://')
  })

  it('preserves custom permission instructions and keeps host OAuth recovery authoritative', () => {
    const doc = renderCustomSkillDoc({ name: 'dataset', displayName: 'Dataset', oauth: {} }, [
      { name: 'download', description: 'Apply at https://example.org/access before download.' }
    ])
    expect(doc).toContain('https://example.org/access')
    expect(doc).toContain('documented by its tools')
    expect(doc).toContain('do not invent an API-key requirement or application URL')
    expect(doc).toContain('host-managed OAuth')
    expect(doc).not.toContain('use a login or authentication tool listed in this Skill')
  })

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
