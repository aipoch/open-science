import { describe, expect, it } from 'vitest'

import { getAgentFramework, listAgentFrameworks } from './registry'

describe('agent framework registry', () => {
  it('exposes Codex as a selectable Responses-only framework', () => {
    expect(listAgentFrameworks().map((framework) => framework.id)).toEqual([
      'claude-code',
      'opencode',
      'codex'
    ])
    expect(getAgentFramework('codex')).toMatchObject({
      displayName: 'Codex',
      supportedApiTypes: ['responses'],
      supportsSkills: true,
      acceptsStdioMcp: true
    })
  })
})
