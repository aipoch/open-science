import { describe, expect, it } from 'vitest'

import { getAgentFramework, listAgentFrameworks } from './registry'

describe('agent framework registry', () => {
  it('exposes Codex and Cursor as selectable frameworks', () => {
    expect(listAgentFrameworks().map((framework) => framework.id)).toEqual([
      'claude-code',
      'opencode',
      'codex',
      'cursor'
    ])
    expect(getAgentFramework('codex')).toMatchObject({
      displayName: 'Codex',
      supportedApiTypes: ['responses'],
      supportsSkills: true,
      acceptsStdioMcp: true
    })
    expect(getAgentFramework('cursor')).toMatchObject({
      displayName: 'Cursor Agent',
      supportedApiTypes: [],
      supportsSkills: false,
      acceptsStdioMcp: false
    })
  })

  it('declares native compaction commands separately from host-owned auto thresholds', () => {
    expect(getAgentFramework('claude-code').contextCompaction).toEqual({
      kind: 'native-command',
      command: '/compact',
      triggerAtPercent: 90,
      failureTextPrefix: 'Compacting failed'
    })
    expect(getAgentFramework('opencode').contextCompaction).toEqual({
      kind: 'native-command',
      command: '/compact',
      triggerAtPercent: 90
    })
    expect(getAgentFramework('codex').contextCompaction).toEqual({
      kind: 'native-command',
      command: '/compact'
    })
    expect(getAgentFramework('cursor').contextCompaction).toEqual({
      kind: 'framework-managed'
    })
  })
})
