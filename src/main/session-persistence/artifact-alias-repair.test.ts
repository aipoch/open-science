import { describe, expect, it } from 'vitest'

import type { PersistedArtifact, PersistedChatSession } from '../../shared/session-persistence'
import { repairHistoricalArtifactAliases } from './artifact-alias-repair'

const nativeVersion: PersistedArtifact = {
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  versionNumber: 1,
  kind: 'managed-file',
  path: '/managed/result.csv',
  name: 'result.csv',
  mimeType: 'text/csv',
  size: 12,
  mtimeMs: 2,
  sha256: 'a'.repeat(64)
}

const legacyAlias: PersistedArtifact = {
  ...nativeVersion,
  id: 'session-1:message-1:result.csv'
}

const createSession = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'message-1',
      role: 'agent',
      content: 'Historical content must remain byte-for-byte stable.',
      status: 'complete',
      eventIds: ['event-1'],
      artifactIds: [legacyAlias.id, nativeVersion.id],
      createdAt: 10,
      updatedAt: 20
    }
  ],
  artifacts: [legacyAlias, nativeVersion],
  filesRevision: 4,
  createdAt: 1,
  updatedAt: 30
})

describe('historical Artifact alias repair', () => {
  it('canonicalizes only the duplicate descriptor and reference mapping', () => {
    const session = createSession()

    const repaired = repairHistoricalArtifactAliases(session)

    expect(repaired.messages[0]).toEqual({
      ...session.messages[0],
      artifactIds: ['version-1']
    })
    expect(repaired.messages[0].content).toBe(session.messages[0].content)
    expect(repaired.messages[0].createdAt).toBe(10)
    expect(repaired.messages[0].updatedAt).toBe(20)
    expect(repaired.artifacts).toEqual([nativeVersion])
    expect(repaired.filesRevision).toBe(5)
    expect(repaired.updatedAt).toBe(30)
  })

  it('is a no-op by identity after the repair has been applied', () => {
    const repaired = repairHistoricalArtifactAliases(createSession())

    expect(repairHistoricalArtifactAliases(repaired)).toBe(repaired)
  })
})
