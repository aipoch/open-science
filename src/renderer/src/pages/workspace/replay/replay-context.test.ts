import { describe, expect, it } from 'vitest'
import type {
  ReplayDocument,
  ReplayStep,
  ReplayNotebookRunDetails
} from '../../../../../shared/replay'
import { projectReplayScene } from '@/lib/replay'
import { captureDiscussionStep, captureDiscussionSession } from './replay-context'

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
  generatorVersion: 3,
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

it('captures whole-session discussions without requiring imported history or a populated default branch', () => {
  expect(captureDiscussionSession(document)).toMatchObject({
    scope: 'session',
    sourceSessionId: 's',
    branchId: 'main',
    stepId: 'execution',
    stepNumber: undefined
  })
  expect(captureDiscussionSession({ ...document, branches: [] })).toBeUndefined()
  expect(
    captureDiscussionSession({
      ...document,
      defaultBranchId: 'empty',
      branches: [{ ...document.branches[0], id: 'empty', steps: [] }, ...document.branches]
    })
  ).toMatchObject({ branchId: 'main', scope: 'session' })
})
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
describe('step-scoped captured records', () => {
  it('keeps input-only questions free of unrevealed run results and file contents', () => {
    const context = captureDiscussionStep(
      document,
      projectReplayScene(document, 'main', 100),
      details,
      resources
    )
    expect(context.excerpt).toContain('print(mean(values))')
    expect(JSON.stringify(context.records)).not.toContain('Mean = 4.50')
    expect(JSON.stringify(context.records)).not.toContain('observations.csv')
    expect(context.stepOffsetMs).toBe(100)
  })
  it('quotes only the current message without retaining earlier material as its source', () => {
    const context = captureDiscussionStep(
      document,
      projectReplayScene(document, 'main', 1750),
      details,
      resources
    )
    expect(context.excerpt).toContain('Recorded conclusion')
    expect(context.excerpt).not.toContain('Mean = 4.50')
    expect(context.records).toHaveLength(1)
    expect(JSON.stringify(context.records)).not.toContain('Mean = 4.50')
    expect(context.evidence.map((reference) => reference.id)).toEqual(['answer'])
    expect(context.excerpt.length).toBeLessThanOrEqual(1800)
  })
  it('keeps a partially revealed message frozen and reports unloaded material explicitly', () => {
    const scene = projectReplayScene(document, 'main', 1500)
    const captured = captureDiscussionStep(document, scene)
    expect(captured.records?.find((record) => record.id === 'step')?.text).toBe(
      scene.step!.message!.content.slice(0, scene.messageCharacters)
    )
    const unloaded = captureDiscussionStep(document, projectReplayScene(document, 'main', 100))
    expect(unloaded.records?.find((record) => record.id === 'notebook-run:run')).toMatchObject({
      scope: 'step',
      status: 'unavailable',
      text: ''
    })
  })
  it('marks bounded text and prepared file truncation instead of presenting them as complete records', () => {
    const modified = structuredClone(document)
    modified.branches[0].steps[1].message!.content = 'x'.repeat(100_000)
    modified.branches[0].steps[1].resourceIds = ['version']
    modified.branches[0].steps[1].evidence.push(execution.evidence[1])
    const captured = captureDiscussionStep(
      modified,
      projectReplayScene(modified, 'main', 2000),
      details,
      {
        ...resources,
        version: {
          status: 'ready',
          kind: 'text',
          content: 'partial csv',
          mimeType: 'text/csv',
          truncated: true
        }
      }
    )
    expect(captured.records?.find((record) => record.id === 'step')).toMatchObject({
      truncated: true
    })
    expect(captured.records?.find((record) => record.id === 'step')?.text.length).toBe(64 * 1024)
    expect(
      captured.records?.find((record) => record.id === 'artifact-version:version')
    ).toMatchObject({ truncated: true })
  })
})
