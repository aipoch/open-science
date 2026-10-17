import { describe, expect, it } from 'vitest'
import type { ReplayDocument, ReplayStep } from '../../../../shared/replay'
import { projectReplayScene } from './scene'

describe('visible replay evidence', () => {
  it('retains the previous run and exact file version still visible beside a later message', () => {
    const execution: ReplayStep = {
      id: 'execution',
      kind: 'notebook',
      branchId: 'main',
      startMs: 0,
      durationMs: 1000,
      endMs: 1000,
      activities: [],
      runs: [
        {
          runId: 'run',
          cellId: 'cell',
          source: 'agent',
          kernelKind: 'python',
          status: 'completed',
          startedAt: 0
        }
      ],
      resourceIds: ['version'],
      issues: [],
      evidence: [
        { kind: 'notebook-run', id: 'run', projectId: 'p', sessionId: 's' },
        {
          kind: 'artifact-version',
          id: 'version',
          versionId: 'version',
          projectId: 'p',
          sessionId: 's'
        }
      ]
    }
    const answer: ReplayStep = {
      ...execution,
      id: 'answer',
      kind: 'message',
      startMs: 1000,
      endMs: 2000,
      runs: [],
      resourceIds: [],
      evidence: [{ kind: 'message', id: 'answer', projectId: 'p', sessionId: 's' }]
    }
    const document: ReplayDocument = {
      generatorVersion: 3,
      presentationVersion: 2,
      source: { projectId: 'p', sessionId: 's', title: 'study', fingerprint: 'hash' },
      defaultBranchId: 'main',
      branches: [
        { id: 'main', kind: 'conversation', steps: [execution, answer], durationMs: 2000 }
      ],
      resources: [
        {
          id: 'version',
          name: 'chart.svg',
          projectId: 'p',
          sessionId: 's',
          versionId: 'version',
          availability: 'recorded'
        }
      ],
      issues: []
    }
    expect(
      projectReplayScene(document, 'main', 100).visibleEvidence.map((item) => [item.id, item.part])
    ).toEqual([['run', 'input']])
    expect(
      projectReplayScene(document, 'main', 1300).visibleEvidence.map((item) => [item.id, item.part])
    ).toEqual([
      ['answer', 'record'],
      ['run', 'record'],
      ['version', 'record']
    ])
    // In elapsed playback a later message does not complete an overlapping Notebook run.
    execution.recordedAt = 0
    execution.recordedEndAt = 1900
    const elapsed = projectReplayScene(document, 'main', 1300, 0)
    expect(elapsed.visibleEvidence.find((item) => item.id === 'run')?.part).toBe('input')
    expect(elapsed.visibleEvidence.some((item) => item.id === 'version')).toBe(false)
    expect(elapsed.visibleResourceIds).toEqual([])
    expect(projectReplayScene(document, 'main', 1950, 0).visibleResourceIds).toEqual(['version'])
  })
  it('includes the bounded retained conversation while excluding future current-step results', () => {
    const steps: ReplayStep[] = Array.from({ length: 15 }, (_, index) => ({
      id: `step-${index}`,
      kind: 'activity',
      branchId: 'main',
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      durationMs: 1000,
      resourceIds: index === 14 ? ['file'] : [],
      runs: [],
      issues: [],
      activities: [
        {
          id: `tool-${index}`,
          kind: 'tool',
          title: 'Archived tool',
          status: 'completed',
          sortIndex: index,
          eventIds: [],
          createdAt: 0,
          updatedAt: 1
        }
      ],
      evidence: [
        { kind: 'activity', id: `tool-${index}`, projectId: 'p', sessionId: 's' },
        ...(index === 14
          ? [
              {
                kind: 'artifact-version' as const,
                id: 'file',
                versionId: 'version',
                projectId: 'p',
                sessionId: 's'
              }
            ]
          : [])
      ]
    }))
    const document: ReplayDocument = {
      generatorVersion: 3,
      presentationVersion: 2,
      source: { projectId: 'p', sessionId: 's', title: 'study', fingerprint: 'hash' },
      defaultBranchId: 'main',
      branches: [{ id: 'main', kind: 'conversation', steps, durationMs: 15000 }],
      resources: [
        {
          id: 'file',
          name: 'result.txt',
          projectId: 'p',
          sessionId: 's',
          versionId: 'version',
          availability: 'recorded'
        }
      ],
      issues: []
    }
    const input = projectReplayScene(document, 'main', 14100).visibleEvidence
    expect(input).toHaveLength(12)
    expect(input.find((reference) => reference.id === 'tool-14')?.part).toBe('input')
    expect(
      input.some((reference) => ['tool-0', 'tool-1', 'tool-2', 'file'].includes(reference.id))
    ).toBe(false)
    expect(input.find((reference) => reference.id === 'tool-3')?.part).toBe('record')
    expect(
      projectReplayScene(document, 'main', 14800).visibleEvidence.some(
        (reference) => reference.id === 'file'
      )
    ).toBe(true)
  })
})
