import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from './acp'

const eventBase = {
  id: 'event-1',
  timestamp: 1,
  level: 'info'
} as const

// @ts-expect-error artifact events require their run and artifact payload
const artifactWithoutPayload: AcpRuntimeEvent = { ...eventBase, kind: 'artifact' }

// @ts-expect-error message events require a role and text
const messageWithoutContent: AcpRuntimeEvent = { ...eventBase, kind: 'message' }

// @ts-expect-error permission events require their request identity
const permissionWithoutRequestId: AcpRuntimeEvent = { ...eventBase, kind: 'permission' }

// @ts-expect-error tool events cannot carry artifact payloads
const toolWithArtifactPayload: AcpRuntimeEvent = {
  ...eventBase,
  kind: 'tool',
  toolCallId: 'tool-1',
  artifacts: []
}

describe('AcpRuntimeEvent contract', () => {
  it('rejects payloads that do not match their event kind', () => {
    expect([
      artifactWithoutPayload,
      messageWithoutContent,
      permissionWithoutRequestId,
      toolWithArtifactPayload
    ]).toHaveLength(4)
  })
})
