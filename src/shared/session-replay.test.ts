import { describe, expect, it } from 'vitest'
import {
  sessionReplayCommandContracts,
  saveSessionDiscussionSnapshotRequestSchema,
  replayViewStateSchema
} from './session-replay'

describe('local research workspace contracts', () => {
  it('validates explicit membership mutations and does not accept caller titles or negative revisions', () => {
    const request = {
      projectId: 'p',
      sessionId: 'discussion',
      expectedRevision: 3,
      source: { projectId: 'p', sourceSessionId: 'source', importId: 'import' }
    }
    const codec = sessionReplayCommandContracts.setResearchMembership.args
    expect(codec.parse([request])).toEqual([request])
    expect(codec.parse([{ ...request, source: undefined }])).toEqual([
      { ...request, source: undefined }
    ])
    expect(() => codec.parse([{ ...request, expectedRevision: -1 }])).toThrow()
    expect(() =>
      codec.parse([{ ...request, source: { ...request.source, sourceTitle: 'spoofed' } }])
    ).toThrow()
    expect(() =>
      codec.parse([{ ...request, source: { ...request.source, importId: '../foreign' } }])
    ).toThrow()
  })

  it('bounds frozen question context and rejects mismatched research evidence', () => {
    const context = {
      id: 'reference',
      projectId: 'project',
      sourceSessionId: 'source',
      sourceTitle: 'Research',
      fingerprint: 'original',
      branchId: 'main',
      stepId: 'step',
      stepOffsetMs: 1,
      recordedAt: 1,
      excerpt: 'Original input',
      evidence: [
        {
          kind: 'notebook-run',
          id: 'run',
          projectId: 'project',
          sessionId: 'source',
          part: 'input'
        }
      ]
    }
    const request = { projectId: 'project', sourceSessionId: 'source', context }
    expect(saveSessionDiscussionSnapshotRequestSchema.parse(request)).toEqual(request)
    expect(
      saveSessionDiscussionSnapshotRequestSchema.parse({
        ...request,
        context: {
          ...context,
          evidence: Array.from({ length: 256 }, (_, index) => ({
            kind: 'upload-version',
            id: `upload-${index}`,
            fileId: `file-${index}`,
            versionId: `version-${index}`,
            projectId: 'project',
            sessionId: 'source',
            part: 'record'
          }))
        }
      }).context.evidence
    ).toHaveLength(256)
    for (const patch of [
      { excerpt: 'x'.repeat(12_001) },
      { evidence: Array(257).fill(context.evidence[0]) },
      { stepOffsetMs: -1 },
      { recordedAt: Infinity },
      { projectId: 'other' },
      { evidence: [{ ...context.evidence[0], sessionId: 'other' }] },
      { evidence: [{ ...context.evidence[0], part: 'future' }] }
    ]) {
      expect(() =>
        saveSessionDiscussionSnapshotRequestSchema.parse({
          ...request,
          context: { ...context, ...patch }
        })
      ).toThrow()
    }
  })
  it('rejects stale-state bypasses and uncontrolled playback values at ingress', () => {
    const request = {
      projectId: 'project',
      sourceSessionId: 'import-source',
      expectedRevision: 0,
      state: { fingerprint: 'checksum', generatorVersion: 1, branchId: 'main', timeMs: 0, rate: 1 }
    }
    expect(sessionReplayCommandContracts.saveView.args.parse([request])).toEqual([request])
    expect(
      sessionReplayCommandContracts.saveView.args.parse([
        { ...request, state: { ...request.state, rate: 4 } }
      ])[0].state.rate
    ).toBe(4)
    const positions = [{ branchId: 'main', stepId: 'review:first', stepOffsetMs: 30, timeMs: 100 }]
    expect(
      sessionReplayCommandContracts.saveView.args.parse([
        { ...request, state: { ...request.state, branchPositions: positions } }
      ])[0].state.branchPositions
    ).toEqual(positions)
    for (const state of [
      { ...request.state, branchPositions: [{ ...positions[0], stepOffsetMs: -1 }] },
      { ...request.state, branchPositions: Array(513).fill(positions[0]) },
      { ...request.state, timeMs: NaN },
      { ...request.state, timeMs: -1 },
      { ...request.state, rate: 100 },
      { ...request.state, playing: true }
    ]) {
      expect(() =>
        sessionReplayCommandContracts.saveView.args.parse([{ ...request, state }])
      ).toThrow()
    }
    expect(() =>
      sessionReplayCommandContracts.saveView.args.parse([{ ...request, expectedRevision: -1 }])
    ).toThrow()
  })
})

it('keeps old playback checkpoints readable and validates the explicit clock for each branch', () => {
  const legacy = { fingerprint: 'fp', generatorVersion: 3, branchId: 'main', timeMs: 1000, rate: 1 }
  expect(replayViewStateSchema.parse(legacy)).toEqual(legacy)
  const recorded = {
    ...legacy,
    clock: 'recorded',
    branchPositions: [{ branchId: 'other', clock: 'presentation', timeMs: 10, stepOffsetMs: 10 }]
  }
  expect(replayViewStateSchema.parse(recorded)).toEqual(recorded)
  expect(() => replayViewStateSchema.parse({ ...recorded, clock: 'wall-time' })).toThrow()
  expect(() =>
    replayViewStateSchema.parse({
      ...recorded,
      branchPositions: [{ ...recorded.branchPositions[0], clock: 'wall-time' }]
    })
  ).toThrow()
})
