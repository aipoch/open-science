import { describe, expect, it } from 'vitest'
import type {
  ReplayDocument,
  ReplayStep,
  ReplayNotebookRunDetails
} from '../../../../../shared/replay'
import { projectReplayScene } from '@/lib/replay'
import { captureReplayStepContext } from './replay-context'

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
  message: {
    id: 'answer',
    role: 'agent',
    content: 'Recorded conclusion',
    createdAt: 0,
    updatedAt: 0,
    eventIds: [],
    status: 'complete'
  },
  evidence: [{ kind: 'message', id: 'answer', projectId: 'p', sessionId: 's' }]
}
const document: ReplayDocument = {
  generatorVersion: 2,
  presentationVersion: 2,
  source: { projectId: 'p', sessionId: 's', title: 'study', fingerprint: 'hash' },
  defaultBranchId: 'main',
  branches: [{ id: 'main', kind: 'conversation', steps: [execution, answer], durationMs: 2000 }],
  resources: [
    {
      id: 'version',
      name: 'observations.csv',
      versionId: 'version',
      projectId: 'p',
      sessionId: 's',
      availability: 'recorded'
    }
  ],
  issues: []
}
const details: Record<string, ReplayNotebookRunDetails> = {
  run: {
    status: 'ready',
    bytes: 1000,
    run: {
      runId: 'run',
      cellId: 'cell',
      source: 'agent',
      kernelKind: 'python',
      status: 'completed',
      startedAt: 0,
      script: 'print(mean(values))',
      outputs: [{ type: 'stream', name: 'stdout', text: 'Mean = 4.50' }],
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      workingFiles: []
    }
  }
}
const resources = {
  version: {
    status: 'ready' as const,
    kind: 'table' as const,
    content: 'sample,value\n1,4.50',
    mimeType: 'text/csv',
    truncated: false
  }
}
describe('whole-frame question excerpts', () => {
  it('keeps input-only questions free of unrevealed run results and file contents', () => {
    const context = captureReplayStepContext(
      document,
      projectReplayScene(document, 'main', 100),
      details,
      resources
    )
    expect(context.excerpt).toContain('print(mean(values))')
    expect(context.excerpt).not.toContain('Mean = 4.50')
    expect(context.excerpt).not.toContain('observations.csv')
    expect(context.stepOffsetMs).toBe(100)
  })
  it('captures saved output and retained previous material alongside the current message', () => {
    const context = captureReplayStepContext(
      document,
      projectReplayScene(document, 'main', 1750),
      details,
      resources
    )
    expect(context.excerpt).toContain('Recorded conclusion')
    expect(context.excerpt).toContain('print(mean(values))')
    expect(context.excerpt).toContain('Mean = 4.50')
    expect(context.excerpt).toContain('observations.csv')
    expect(context.excerpt).toContain('sample,value')
    expect(context.evidence.map((reference) => reference.id)).toEqual(['answer', 'run', 'version'])
    expect(context.excerpt.length).toBeLessThanOrEqual(1800)
  })
})
