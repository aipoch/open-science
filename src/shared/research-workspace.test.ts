import { describe, expect, it } from 'vitest'
import {
  researchWorkspaceCommandContracts,
  saveReplayQuestionContextRequestSchema
} from './research-workspace'

describe('local research workspace contracts', () => {
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
    expect(saveReplayQuestionContextRequestSchema.parse(request)).toEqual(request)
    expect(
      saveReplayQuestionContextRequestSchema.parse({
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
        saveReplayQuestionContextRequestSchema.parse({
          ...request,
          context: { ...context, ...patch }
        })
      ).toThrow()
    }
  })
  it('accepts only an explicit source identity, local title and guarded replacement', () => {
    const request = { projectId: 'project', sourceSessionId: 'import-source', title: 'Discussion' }
    expect(researchWorkspaceCommandContracts.ensureDiscussion.args.parse([request])).toEqual([
      request
    ])
    for (const extra of [
      { providerSessionId: 'foreign' },
      { packageOrigin: {} },
      { agentModel: 'foreign-model' },
      { recreateMissing: true }
    ]) {
      expect(() =>
        researchWorkspaceCommandContracts.ensureDiscussion.args.parse([{ ...request, ...extra }])
      ).toThrow()
    }
    expect(() =>
      researchWorkspaceCommandContracts.get.args.parse([
        { projectId: '../other', sourceSessionId: 'source' }
      ])
    ).toThrow()
  })
  it('rejects stale-state bypasses and uncontrolled playback values at ingress', () => {
    const request = {
      projectId: 'project',
      sourceSessionId: 'import-source',
      expectedRevision: 0,
      state: { fingerprint: 'checksum', generatorVersion: 1, branchId: 'main', timeMs: 0, rate: 1 }
    }
    expect(researchWorkspaceCommandContracts.saveView.args.parse([request])).toEqual([request])
    for (const state of [
      { ...request.state, timeMs: NaN },
      { ...request.state, timeMs: -1 },
      { ...request.state, rate: 100 },
      { ...request.state, playing: true }
    ]) {
      expect(() =>
        researchWorkspaceCommandContracts.saveView.args.parse([{ ...request, state }])
      ).toThrow()
    }
    expect(() =>
      researchWorkspaceCommandContracts.saveView.args.parse([{ ...request, expectedRevision: -1 }])
    ).toThrow()
  })
})
