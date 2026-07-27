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
  })
})
