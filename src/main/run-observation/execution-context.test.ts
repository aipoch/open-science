import { describe, expect, it } from 'vitest'
import { buildRunObservationArchive } from './archive'
import { projectDemoViewing, readCollectionExecutionContext } from './execution-context'
import { runObservationExecutionContextSchema } from '../../shared/run-observation'
import type { RunObservationSnapshot } from '../../shared/run-observation'

const snapshot: RunObservationSnapshot = {
  identity: { projectId: 'p', sessionId: 's', runId: 'r', executionInvocationId: 'i' },
  cursor: { epoch: 'e', sequence: 0 },
  observedAt: 20,
  phase: 'completed',
  stepId: 'run:r',
  artifacts: [],
  artifactsTruncated: false,
  executionContext: { purpose: 'research', conditionChanges: ['smaller input'] },
  run: {
    runId: 'r',
    executionInvocationId: 'i',
    kernelKind: 'bash',
    status: 'completed',
    startedAt: 10,
    logs: {
      stdout: { text: '', truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  }
}
const archive = buildRunObservationArchive({
  recordingId: 'recording',
  capturedAt: 20,
  history: { coverage: 'process-local', truncated: false, snapshots: [snapshot] },
  stopReason: 'run-ended'
})
const receipt = {
  kind: 'managed-research-execution',
  version: 1,
  purpose: 'offline-demo',
  result: {
    runId: 'r',
    executionInvocationId: 'i',
    observation: { recordingId: 'recording', versionId: 'v' }
  }
}
const read = (value: unknown): ReturnType<typeof readCollectionExecutionContext> =>
  readCollectionExecutionContext(Buffer.from(JSON.stringify(value)), archive)
describe('recorded public collection context', () => {
  it.each([
    ['completed', 'process-exited'],
    ['timeout', 'time-limit'],
    ['cancelled', 'stopped'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['running', undefined],
    ['queued', undefined]
  ] as const)(
    'reports %s from actual Run status without interpreting duration as completion',
    (status, endReason) => {
      const admitted = { mode: 'until-stop-or-timeout' as const, timeoutMs: 600000 }
      const run = { ...snapshot.run!, status }
      const result = projectDemoViewing(admitted, run)
      expect(result).toEqual({
        ...admitted,
        ...(endReason ? { endReason } : {})
      })
      expect(projectDemoViewing(undefined, run)).toBeUndefined()
      expect(projectDemoViewing(admitted, null)).toEqual(admitted)
      const stopped = buildRunObservationArchive({
        recordingId: 'recording',
        capturedAt: 20,
        history: {
          coverage: 'process-local',
          truncated: false,
          snapshots: [{ ...snapshot, phase: status, run }]
        },
        stopReason: ['running', 'queued'].includes(status) ? 'manual' : 'run-ended'
      })
      const restored = readCollectionExecutionContext(
        Buffer.from(JSON.stringify({ ...receipt, demoViewing: admitted })),
        stopped
      )
      expect(restored?.demoViewing).toEqual(result)
      expect(stopped.version).toBe(1)
      expect(stopped.records[0]).not.toHaveProperty('executionContext')
    }
  )

  it('rejects forged outcomes, unsafe budgets and research use of offline viewing metadata', () => {
    for (const demoViewing of [
      { mode: 'until-stop-or-timeout', timeoutMs: 600001 },
      { mode: 'until-stop-or-timeout', timeoutMs: 10000, deadlineAt: 1 },
      { mode: 'until-stop-or-timeout', timeoutMs: 10000, endReason: 'time-limit' },
      { mode: 'forever', timeoutMs: 10000 }
    ])
      expect(read({ ...receipt, demoViewing })).toBeUndefined()
    const demoViewing = { mode: 'process-lifetime', timeoutMs: 10000 }
    expect(
      runObservationExecutionContextSchema.safeParse({
        purpose: 'offline-demo',
        conditionChanges: [],
        demoViewing: { ...demoViewing, deadlineAt: 1 }
      }).success
    ).toBe(false)
    expect(read({ ...receipt, purpose: 'research', demoViewing })).toBeUndefined()
    expect(read({ ...receipt, purpose: undefined, demoViewing })).toBeUndefined()
    expect(
      runObservationExecutionContextSchema.safeParse({
        purpose: 'research',
        conditionChanges: [],
        demoViewing
      }).success
    ).toBe(false)
  })
  it('leaves archive v1 unchanged and does not interpret process completion as research success', () => {
    expect(archive.records[0]).not.toHaveProperty('executionContext')
    expect(archive.version).toBe(1)
    expect(read(receipt)).toEqual({ purpose: 'offline-demo', conditionChanges: [] })
    expect(read({ ...receipt, purpose: undefined })).toEqual({
      purpose: 'unknown',
      conditionChanges: []
    })
  })
  it('requires exact format, source Run, invocation and recording membership', () => {
    for (const invalid of [
      { ...receipt, kind: 'other' },
      { ...receipt, version: 2 },
      { ...receipt, purpose: 'success' },
      { ...receipt, result: { ...receipt.result, runId: 'other' } },
      { ...receipt, result: { ...receipt.result, executionInvocationId: 'other' } },
      {
        ...receipt,
        result: {
          ...receipt.result,
          observation: { ...receipt.result.observation, recordingId: 'other' }
        }
      },
      { ...receipt, result: { ...receipt.result, observation: undefined } }
    ])
      expect(read(invalid)).toBeUndefined()
  })
  it('projects bounded condition differences and omits configuration and local paths', () => {
    expect(
      read({
        ...receipt,
        purpose: 'research',
        executionProfile: {
          profileId: 'not-a-live-reference',
          variables: { KEY: 'not-projected' },
          displayName: 'Small baseline',
          conditionChanges: ['half the samples', 'input /Users/alice/data']
        }
      })
    ).toEqual({
      purpose: 'research',
      profileName: 'Small baseline',
      conditionChanges: ['half the samples', 'input [local path]']
    })
    expect(
      read({
        ...receipt,
        executionProfile: { displayName: 'x', conditionChanges: Array(33).fill('x') }
      })
    ).toBeUndefined()
  })
})
