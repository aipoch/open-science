import { describe, expect, it } from 'vitest'
import type { RunObservationSnapshot } from '../../../../shared/run-observation'
import {
  buildObservationReplayDocument,
  isObservationTerminal,
  normalizeObservationHistory,
  observationSourceIdentity
} from './live-source'

const snapshot = (sequence: number): RunObservationSnapshot => ({
  identity: { projectId: 'p', sessionId: 's', operationId: 'operation', runId: 'run' },
  cursor: { epoch: 'epoch', sequence },
  observedAt: 1000 + sequence * 100,
  phase: 'running',
  stepId: 'run:run',
  run: {
    runId: 'run',
    kernelKind: 'bash',
    status: 'running',
    startedAt: 1000,
    logs: {
      stdout: { text: `observed ${sequence}`, truncated: false, redacted: false },
      stderr: { text: '', truncated: false, redacted: false },
      traceback: { text: '', truncated: false, redacted: false }
    }
  },
  artifacts: [],
  artifactsTruncated: false
})

describe('actual observation replay projection', () => {
  it('retains real time and exact evidence without inventing notebook code or execution durations', () => {
    const early = {
      ...snapshot(3),
      run: null,
      identity: { projectId: 'p', sessionId: 's', operationId: 'operation' },
      phase: 'preparing' as const
    }
    const latest = {
      ...snapshot(5),
      artifacts: [{ versionId: 'v', name: 'result.csv', producerRunId: 'run' }]
    }
    const document = buildObservationReplayDocument([early, latest], 'Selected study')
    expect(document.branches[0].steps).toHaveLength(2)
    expect(document.branches[0].steps[0]).toMatchObject({
      recordedAt: 1300,
      runs: [],
      resourceIds: []
    })
    expect(document.branches[0].steps[1]).toMatchObject({
      recordedAt: 1500,
      runs: [],
      resourceIds: ['v'],
      evidence: [
        { kind: 'notebook-run', id: 'run' },
        { kind: 'artifact-version', id: 'v' }
      ]
    })
    expect(document.resources[0]).toMatchObject({ versionId: 'v', producerRunId: 'run' })
    expect(JSON.stringify(document)).not.toContain('script')
    expect(observationSourceIdentity(early.identity)).toBe(
      observationSourceIdentity(latest.identity)
    )
    expect(
      observationSourceIdentity({ ...early.identity, operationId: undefined, runId: 'operation' })
    ).not.toBe(observationSourceIdentity(early.identity))
  })

  it('deduplicates an unchanged latest cursor but rejects changed old evidence or reordered records', () => {
    const one = snapshot(1)
    const two = snapshot(2)
    expect(normalizeObservationHistory(two, [one, two])).toEqual([one, two])
    expect(() => normalizeObservationHistory({ ...two, phase: 'failed' }, [one, two])).toThrow(
      'changed at an existing cursor'
    )
    expect(() => normalizeObservationHistory(two, [two, one])).toThrow('out of order')
  })

  it.each([
    ['project', { identity: { ...snapshot(2).identity, projectId: 'other' } }],
    ['session', { identity: { ...snapshot(2).identity, sessionId: 'other' } }],
    ['operation', { identity: { ...snapshot(2).identity, operationId: 'other' } }],
    ['run', { identity: { ...snapshot(2).identity, runId: 'other' } }],
    ['epoch', { cursor: { epoch: 'other', sequence: 1 } }],
    ['time', { observedAt: Number.NaN }]
  ])('rejects foreign or malformed %s history', (_label, changed) => {
    expect(() =>
      normalizeObservationHistory(snapshot(2), [{ ...snapshot(1), ...changed }])
    ).toThrow()
  })

  it('never treats collecting as completion or a failed execution as still running', () => {
    expect(isObservationTerminal({ ...snapshot(1), phase: 'collecting' })).toBe(false)
    for (const phase of ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'] as const)
      expect(isObservationTerminal({ ...snapshot(1), phase })).toBe(true)
  })
  it('uses canonical exact-Version locators only when a real Artifact identity exists', () => {
    const original = snapshot(1)
    const document = buildObservationReplayDocument(
      [
        {
          ...original,
          artifacts: [
            { versionId: 'v1', artifactId: 'a1', name: 'known.txt' },
            { versionId: 'v2', name: 'unresolved.txt' }
          ]
        }
      ],
      'Study'
    )
    expect(document.resources[0].locator).toBe('artifact-version:p/s/a1/v1')
    expect(document.resources[1].locator).toBeUndefined()
    expect(document.resources[1].artifactId).toBeUndefined()
  })
})
