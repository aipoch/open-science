import { describe, expect, it } from 'vitest'

import { getAgentFramework, listAgentFrameworks } from './registry'

describe('agent framework registry', () => {
  it('exposes Codex and CodeBuddy as selectable frameworks', () => {
    expect(listAgentFrameworks().map((framework) => framework.id)).toEqual([
      'claude-code',
      'opencode',
      'codex',
      'codebuddy'
    ])
    expect(getAgentFramework('codex')).toMatchObject({
      displayName: 'Codex',
      supportedApiTypes: ['responses'],
      supportsSkills: true,
      acceptsStdioMcp: true,
      supportsDelegatedWork: true
    })
    expect(getAgentFramework('codebuddy')).toMatchObject({
      displayName: 'CodeBuddy',
      supportedApiTypes: ['openai'],
      supportsSkills: false,
      acceptsStdioMcp: true,
      supportsDelegatedWork: true
    })
  })

  it('admits delegated work only for certified frameworks', () => {
    expect(
      listAgentFrameworks().map(({ id, supportsDelegatedWork }) => ({ id, supportsDelegatedWork }))
    ).toEqual([
      { id: 'claude-code', supportsDelegatedWork: true },
      { id: 'opencode', supportsDelegatedWork: true },
      { id: 'codex', supportsDelegatedWork: true },
      { id: 'codebuddy', supportsDelegatedWork: true }
    ])
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
      command: '/compact'
    })
    expect(getAgentFramework('codex').contextCompaction).toEqual({
      kind: 'native-command',
      command: '/compact'
    })
  })
})
