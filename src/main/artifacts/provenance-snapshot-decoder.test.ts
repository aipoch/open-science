import { describe, expect, it } from 'vitest'

import { decodeArtifactExecutionSnapshot } from './provenance-execution-evidence'
import {
  decodeArtifactMessageSnapshot,
  decodeReviewScopeSnapshot
} from './provenance-snapshot-decoder'

const messageSnapshot = (schemaVersion: number): Record<string, unknown> => ({
  schemaVersion,
  snapshotId: 'snapshot-1',
  rootFrameId: 'root-1',
  agentFrameId: 'agent-1',
  messageBranchId: 'branch-1',
  terminalMessageId: 'message-1',
  createdAt: '2026-08-20T00:00:00.000Z',
  messages: [],
  ...(schemaVersion === 3 ? { activities: [], activityGroups: [] } : {})
})

const executionSnapshot = (schemaVersion: number): Record<string, unknown> => ({
  schemaVersion,
  rootFrameId: 'root-1',
  agentFrameId: 'agent-1',
  messageBranchId: 'branch-1',
  terminalPromptMessageId: 'prompt-1',
  producerRunId: 'run-1',
  producerRunIndex: 0,
  createdAt: '2026-08-20T00:00:00.000Z',
  inputFiles: [],
  runs: [
    {
      runId: 'run-1',
      runIndex: 0,
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      kernelKind: 'python',
      script: 'print(1)',
      status: 'completed',
      startedAt: '2026-08-20T00:00:00.000Z',
      outputs: [],
      inputFileVersionKeys: []
    }
  ]
})

describe('Artifact persistence decoders', () => {
  it('classifies Message v3 as valid, v2 as legacy, and future versions as unsupported', () => {
    expect(decodeArtifactMessageSnapshot(JSON.stringify(messageSnapshot(3))).status).toBe('valid')
    expect(decodeArtifactMessageSnapshot(JSON.stringify(messageSnapshot(2))).status).toBe('legacy')
    expect(decodeArtifactMessageSnapshot(JSON.stringify(messageSnapshot(4)))).toEqual({
      status: 'unsupported',
      version: 4
    })
  })

  it('classifies Execution v2 as valid and future versions as unsupported', () => {
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(executionSnapshot(2))).status).toBe(
      'valid'
    )
    expect(decodeArtifactExecutionSnapshot(JSON.stringify(executionSnapshot(3)))).toEqual({
      status: 'unsupported',
      version: 3
    })
  })

  it('classifies Review scope v2 as valid, v1 as legacy, and future versions as unsupported', () => {
    expect(decodeReviewScopeSnapshot('{"schemaVersion":2,"blocks":[]}').status).toBe('valid')
    expect(decodeReviewScopeSnapshot('{"schemaVersion":1,"blocks":[]}').status).toBe('legacy')
    expect(decodeReviewScopeSnapshot('{"schemaVersion":3,"blocks":[]}')).toEqual({
      status: 'unsupported',
      version: 3
    })
  })

  it('classifies malformed and structurally invalid Artifact snapshots as corrupt', () => {
    expect(decodeArtifactMessageSnapshot('{')).toEqual({ status: 'corrupt' })
    expect(decodeArtifactExecutionSnapshot('{"schemaVersion":2}')).toEqual({
      status: 'corrupt'
    })
    expect(decodeReviewScopeSnapshot('{"schemaVersion":2,"blocks":false}')).toEqual({
      status: 'corrupt'
    })
  })

  it('rejects invalid Message and Review domain records instead of trusting their arrays', () => {
    expect(
      decodeArtifactMessageSnapshot(
        JSON.stringify({
          ...messageSnapshot(3),
          messages: [{ id: 'message-1', role: 'robot', content: 42, createdAt: 'now' }]
        })
      )
    ).toEqual({ status: 'corrupt' })
    expect(
      decodeReviewScopeSnapshot(
        JSON.stringify({
          schemaVersion: 2,
          blocks: [
            {
              blockIndex: 'zero',
              id: 'block-1',
              kind: 'message',
              sourceId: 'message-1',
              contentHash: 'hash',
              payload: {}
            }
          ]
        })
      )
    ).toEqual({ status: 'corrupt' })
  })

  it('rejects invalid Message activities and Execution domain records', () => {
    expect(
      decodeArtifactMessageSnapshot(JSON.stringify({ ...messageSnapshot(3), activities: [null] }))
    ).toEqual({ status: 'corrupt' })
    expect(
      decodeArtifactExecutionSnapshot(
        JSON.stringify({
          ...executionSnapshot(2),
          inputFiles: [null],
          runs: [
            { ...(executionSnapshot(2).runs as Record<string, unknown>[])[0], status: 'invented' }
          ]
        })
      )
    ).toEqual({ status: 'corrupt' })
  })

  it('rejects an invalid nested Message elicitation projection', () => {
    expect(
      decodeArtifactMessageSnapshot(
        JSON.stringify({
          ...messageSnapshot(3),
          activities: [
            {
              id: 'activity-1',
              kind: 'tool',
              title: 'Ask a question',
              status: 'completed',
              sortIndex: 0,
              eventIds: [],
              elicitation: {},
              createdAt: 1,
              updatedAt: 2
            }
          ]
        })
      )
    ).toEqual({ status: 'corrupt' })
  })
})
