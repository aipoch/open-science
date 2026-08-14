import { describe, expect, it } from 'vitest'

import { requireAgentArtifactVersion } from './provenance-version-kind'

const completeAgentVersion = {
  originKind: 'agent_generated',
  artifactRunId: 'run-1',
  rootFrameId: 'root-1',
  agentFrameId: 'agent-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'segment-1',
  promptMessageId: 'prompt-1',
  evidenceStorageKey: 'artifact/evidence.json',
  evidenceJson: '{}',
  evidenceChecksum: 'checksum',
  evidenceSchemaVersion: 1
}

describe('Agent Artifact Version narrowing', () => {
  it('returns a complete Agent-generated version with non-null provenance', () => {
    expect(requireAgentArtifactVersion({ id: 'version-1', ...completeAgentVersion })).toEqual({
      id: 'version-1',
      ...completeAgentVersion
    })
  })

  it.each([
    'artifactRunId',
    'rootFrameId',
    'agentFrameId',
    'messageBranchId',
    'runtimeSegmentId',
    'promptMessageId',
    'evidenceStorageKey',
    'evidenceJson',
    'evidenceChecksum',
    'evidenceSchemaVersion'
  ] as const)('rejects agent_generated when required provenance %s is null', (field) => {
    expect(() =>
      requireAgentArtifactVersion({
        id: 'version-agent-incomplete',
        ...completeAgentVersion,
        [field]: null
      })
    ).toThrow(/does not contain complete Agent provenance/)
  })

  it('rejects a complete non-Agent version based on originKind alone', () => {
    expect(() =>
      requireAgentArtifactVersion({
        id: 'version-edit',
        ...completeAgentVersion,
        originKind: 'user_edit'
      })
    ).toThrow(/does not contain complete Agent provenance/)
  })
})
