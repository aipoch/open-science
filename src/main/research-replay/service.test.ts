import { createHash } from 'node:crypto'
import { browserRecordedFixture } from '../run-observation/browser-recorded.test-support'
import { projectReplayScene } from '../../renderer/src/lib/replay/scene'
import { describe, it, expect, vi } from 'vitest'
import { createTaskCallerContext } from '../caller-context'
import { researchReplayHarness } from './test-support'

describe('scoped research Replay source and evidence', () => {
  it('uses the saved receiving Session, paginates compact steps, and freezes the source snapshot', async () => {
    const h = researchReplayHarness(),
      view = await h.service.open(h.target, h.caller)
    const doc = await h.service.document(view.viewerId, h.caller)
    h.session.messages[0].content = 'changed after viewer opened'
    const page = (await h.service.read(view.viewerId, { kind: 'steps', limit: 1 }, h.caller)) as {
      nextOffset: number
      steps: Array<{ id: string }>
      branchId: string
    }
    expect(page.nextOffset).toBe(1)
    expect(page.steps).toHaveLength(1)
    expect(page.steps[0]).not.toHaveProperty('message')
    const read = await h.service.read(
      view.viewerId,
      { kind: 'step', branchId: page.branchId, stepId: page.steps[0].id },
      h.caller
    )
    expect(read).toMatchObject({ step: { message: { content: 'Why test this?' } } })
    expect(doc.document.source).toMatchObject(h.target)
    expect(h.dependencies.reader.notebook.state).not.toHaveBeenCalled()
  })
  it('rejects unknown evidence, foreign source scopes, bad pagination and arbitrary paths', async () => {
    const h = researchReplayHarness(),
      view = await h.service.open(h.target, h.caller)
    await expect(h.service.resource(view.viewerId, 'private-file', h.caller)).rejects.toMatchObject(
      { code: 'forbidden' }
    )
    await expect(
      h.service.read(view.viewerId, { kind: 'notebook', runIds: ['foreign'] }, h.caller)
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      h.service.read(view.viewerId, { kind: 'steps', limit: 51 }, h.caller)
    ).rejects.toThrow()
    await expect(
      h.service.read(view.viewerId, { kind: 'steps', offset: 999 }, h.caller)
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(h.service.open({ ...h.target, path: '/private' }, h.caller)).rejects.toThrow()
    vi.mocked(h.dependencies.immutable.resolveVersion).mockImplementationOnce(
      async () => ({ sourceProjectId: 'foreign', sourceSessionId: 'foreign' }) as never
    )
    await expect(
      h.service.resource(view.viewerId, 'artifact-version:version', h.caller)
    ).rejects.toMatchObject({ code: 'not-found' })
  })
  it('returns exact immutable resource bytes in bounded chunks and checks the original caller', async () => {
    const h = researchReplayHarness(),
      view = await h.service.open(h.target, h.caller)
    expect(
      await h.service.read(
        view.viewerId,
        { kind: 'resource', resourceId: 'artifact-version:version', offset: 1, length: 4 },
        h.caller
      )
    ).toMatchObject({
      offset: 1,
      nextOffset: 5,
      dataBase64: h.content.subarray(1, 5).toString('base64')
    })
    const other = createTaskCallerContext({ clientId: 'other' })
    await expect(h.service.document(view.viewerId, other)).rejects.toMatchObject({
      code: 'unauthorized'
    })
    h.setCurrent(false)
    await expect(h.service.document(view.viewerId, h.caller)).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })
  it('keeps selected evidence fixed and earlier selection IDs resolvable, then revokes access', async () => {
    const h = researchReplayHarness(),
      view = await h.service.open(h.target, h.caller),
      doc = await h.service.document(view.viewerId, h.caller),
      branch = doc.document.branches[0],
      step = branch.steps[0]
    const selected = await h.service.select(
      view.viewerId,
      {
        branchId: branch.id,
        stepId: step.id,
        timeMs: step.startMs,
        resourceId: 'artifact-version:version'
      },
      h.caller
    )
    expect(selected.resource?.versionId).toBe('version')
    selected.excerpt = 'consumer mutation'
    await h.service.select(
      view.viewerId,
      { branchId: branch.id, stepId: step.id, timeMs: step.startMs },
      h.caller
    )
    expect(
      (await h.service.selection(view.viewerId, h.caller, selected.selectionId))?.excerpt
    ).not.toBe('consumer mutation')
    await expect(
      h.service.select(
        view.viewerId,
        { branchId: branch.id, stepId: step.id, timeMs: 0, recordedAt: 999999 },
        h.caller
      )
    ).rejects.toMatchObject({ code: 'invalid' })
    await h.service.revoke(view.viewerId, h.caller)
    await expect(h.service.selection(view.viewerId, h.caller)).rejects.toMatchObject({
      code: 'unavailable'
    })
  })
  it('does not expose source data when receiver scope disappears during a read', async () => {
    const h = researchReplayHarness(),
      view = await h.service.open(h.target, h.caller)
    vi.mocked(h.dependencies.authorize).mockRejectedValue(new Error('deleted'))
    await expect(h.service.document(view.viewerId, h.caller)).rejects.toThrow('deleted')
  })
  it('does not attach later steps or not-yet-visible output to a playback selection', async () => {
    const h = researchReplayHarness()
    h.session.activities = [
      {
        id: 'tool',
        kind: 'tool',
        title: 'Execute',
        status: 'completed',
        createdAt: 2000,
        updatedAt: 4000,
        sortIndex: 1,
        eventIds: [],
        executionInvocationId: 'invoke',
        promptMessageId: 'q',
        rawInput: { code: 'print(1)' },
        rawOutput: 'SECRET FINAL OUTPUT',
        terminalOutput: 'SECRET FINAL OUTPUT'
      }
    ]
    vi.mocked(h.dependencies.reader.notebook.runIndex!).mockResolvedValue([
      {
        runId: 'run',
        cellId: 'cell',
        source: 'agent',
        kernelKind: 'python',
        status: 'completed',
        startedAt: 2000,
        endedAt: 4000,
        promptMessageId: 'q',
        executionInvocationId: 'invoke',
        hasOutput: true
      }
    ])
    const view = await h.service.open(h.target, h.caller),
      document = (await h.service.document(view.viewerId, h.caller)).document,
      branch = document.branches[0],
      step = branch.steps.find((item) => item.runs.length)!
    const selected = await h.service.select(
      view.viewerId,
      { branchId: branch.id, stepId: step.id, timeMs: step.startMs + 1 },
      h.caller
    )
    expect(selected.phase).toBe('activity')
    expect(JSON.stringify(selected)).not.toContain('SECRET FINAL OUTPUT')
    expect(selected.evidence.find((item) => item.kind === 'notebook-run')?.part).toBe('input')
    await expect(
      h.service.select(
        view.viewerId,
        { branchId: branch.id, stepId: branch.steps.at(-1)!.id, timeMs: 0 },
        h.caller
      )
    ).rejects.toMatchObject({ code: 'invalid' })
  })
  it('provides an explicit chunk query for large step records instead of an unbounded prompt', async () => {
    const h = researchReplayHarness()
    h.session.messages[0].content = 'x'.repeat(180000)
    const view = await h.service.open(h.target, h.caller),
      document = (await h.service.document(view.viewerId, h.caller)).document,
      branch = document.branches[0],
      step = branch.steps[0]
    const read = await h.service.read(
      view.viewerId,
      { kind: 'step', branchId: branch.id, stepId: step.id },
      h.caller
    )
    expect(read).toMatchObject({
      step: null,
      contentTruncated: true,
      contentQuery: { kind: 'step-content' }
    })
    const chunk = await h.service.read(
      view.viewerId,
      { kind: 'step-content', branchId: branch.id, stepId: step.id, length: 100 },
      h.caller
    )
    expect(chunk).toMatchObject({
      encoding: 'json',
      offset: 0,
      nextOffset: 100,
      text: JSON.stringify(step).slice(0, 100)
    })
  })
  it('binds video moment evidence to the same receiving recording, branch and master time', async () => {
    const h = researchReplayHarness(),
      fixture = browserRecordedFixture()
    const receiving = { ...h.target, artifactId: 'artifact', versionId: 'version' }
    const recording = { ...fixture.payload.recording, source: h.target }
    const payload = { ...fixture.payload, receiving, recording }
    const content = Buffer.from(JSON.stringify(recording)),
      checksum = createHash('sha256').update(content).digest('hex')
    h.session.artifacts![0].sha256 = checksum
    h.session.artifacts![0].size = content.length
    const lineage = await h.dependencies.reader.artifacts.getLineage({
      projectId: 'project',
      appSessionId: 'session',
      artifactId: 'artifact'
    })
    if (!lineage || 'failure' in lineage) throw new Error('fixture lineage')
    lineage.versions[0].messageId = 'q'
    lineage.versions[0].checksum = checksum
    lineage.versions[0].size = content.length
    vi.mocked(h.dependencies.reader.artifacts.getLineage).mockResolvedValue(lineage)
    const original = await h.dependencies.immutable.resolveVersion({
      projectId: 'project',
      sourceKind: 'artifact-version',
      inputFileVersionId: 'version'
    })
    vi.mocked(h.dependencies.immutable.resolveVersion).mockResolvedValue({
      ...original!,
      checksum,
      sizeBytes: content.length
    })
    vi.mocked(h.dependencies.immutable.openContent).mockResolvedValue({
      readRange: async () => content,
      verifyUnchanged: async () => undefined,
      close: async () => undefined
    } as never)
    vi.mocked(h.dependencies.recordings.readBrowser).mockResolvedValue(payload)
    vi.mocked(h.dependencies.recordings.selectBrowserMoment).mockResolvedValue({
      ...fixture.moment,
      receiving
    })
    const view = await h.service.open(h.target, h.caller),
      doc = await h.service.document(view.viewerId, h.caller)
    expect(doc.recordings).toHaveLength(1)
    const branch = doc.document.branches[0],
      scene = projectReplayScene(doc.document, branch.id, 1500, 1000)
    const position = {
      branchId: branch.id,
      stepId: scene.step!.id,
      timeMs: 1500,
      recordedAt: 2500,
      recordingId: doc.recordings[0].id,
      offsetMs: 1500
    }
    expect(await h.service.select(view.viewerId, position, h.caller)).toMatchObject({
      inspection: 'recorded-moment',
      moment: { offsetMs: 1500 }
    })
    await expect(
      h.service.select(view.viewerId, { ...position, offsetMs: 500 }, h.caller)
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})

it('captures an explicitly inspected Notebook run at the actual clock across overlapping messages', async () => {
  const h = researchReplayHarness()
  h.session.messages[1].createdAt = 3000
  h.session.activities = [
    {
      id: 'tool',
      kind: 'tool',
      title: 'Execute',
      status: 'completed',
      createdAt: 2000,
      updatedAt: 4000,
      sortIndex: 1,
      eventIds: [],
      executionInvocationId: 'invoke',
      promptMessageId: 'q',
      rawInput: { code: 'print(1)' },
      rawOutput: 'SAVED RUN RESULT'
    }
  ]
  vi.mocked(h.dependencies.reader.notebook.runIndex!).mockResolvedValue([
    {
      runId: 'run',
      cellId: 'cell',
      source: 'agent',
      kernelKind: 'python',
      status: 'completed',
      startedAt: 2000,
      endedAt: 4000,
      promptMessageId: 'q',
      executionInvocationId: 'invoke',
      hasOutput: true
    }
  ])
  const view = await h.service.open(h.target, h.caller)
  const source = await h.service.document(view.viewerId, h.caller)
  const branch = source.document.branches[0]
  const step = branch.steps.find((item) => item.runs.some((run) => run.runId === 'run'))!
  const origin = source.timing.recordedTimeOrigins[branch.id]
  for (const recordedAt of [3500, 4000]) {
    const timeMs = recordedAt - origin
    expect(projectReplayScene(source.document, branch.id, timeMs, origin).step?.id).not.toBe(
      step.id
    )
    const position = {
      branchId: branch.id,
      stepId: step.id,
      timeMs,
      recordedAt,
      notebookRunId: 'run'
    }
    const selected = await h.service.select(view.viewerId, position, h.caller)
    expect(selected.position).toEqual(position)
    expect(selected.step.id).toBe(step.id)
    expect(selected.step.runs.map((run) => run.runId)).toEqual(['run'])
    expect(selected.phase).toBe(recordedAt === 4000 ? 'result' : 'activity')
    expect(JSON.stringify(selected).includes('SAVED RUN RESULT')).toBe(recordedAt === 4000)
    expect(selected.evidence.find((item) => item.kind === 'notebook-run')?.part).toBe(
      recordedAt === 4000 ? 'record' : 'input'
    )
    await expect(
      h.service.select(view.viewerId, { ...position, notebookRunId: undefined }, h.caller)
    ).rejects.toMatchObject({ code: 'invalid' })
    const inspectedStep = await h.service.select(
      view.viewerId,
      { ...position, notebookRunId: undefined, inspectStep: 'visible' },
      h.caller
    )
    expect(inspectedStep.step.id).toBe(step.id)
    expect(inspectedStep.phase).toBe(selected.phase)
    expect(JSON.stringify(inspectedStep).includes('SAVED RUN RESULT')).toBe(recordedAt === 4000)
  }
  for (const position of [
    { timeMs: 0, notebookRunId: 'run' },
    { timeMs: 3000, notebookRunId: 'foreign' },
    { timeMs: 3000, notebookRunId: 'run', recordingId: 'anything' },
    { timeMs: 3000, notebookRunId: 'run', scope: 'session' }
  ])
    await expect(
      h.service.select(
        view.viewerId,
        { branchId: branch.id, stepId: step.id, ...position },
        h.caller
      )
    ).rejects.toMatchObject({ code: 'invalid' })
  expect(h.dependencies.readRun).not.toHaveBeenCalled()
})

it('distinguishes full saved-history inspection from future evidence on the visible clock', async () => {
  const h = researchReplayHarness()
  const access = await h.service.open(h.target, h.caller)
  const { document, timing } = await h.service.document(access.viewerId, h.caller)
  const branch = document.branches[0]
  const future = branch.steps.find((step) => step.message?.role === 'agent')!
  const position = {
    branchId: branch.id,
    stepId: future.id,
    timeMs: 0,
    recordedAt: timing.recordedTimeOrigins[branch.id]
  }
  await expect(
    h.service.select(access.viewerId, { ...position, inspectStep: 'visible' }, h.caller)
  ).rejects.toMatchObject({ code: 'invalid' })
  const saved = await h.service.select(
    access.viewerId,
    { ...position, inspectStep: 'saved-history' },
    h.caller
  )
  expect(saved.step.message?.content).toBe(future.message?.content)
  expect(saved.position).toMatchObject({ ...position, inspectStep: 'saved-history' })
  await expect(
    h.service.select(
      access.viewerId,
      { ...position, stepId: 'foreign', inspectStep: 'saved-history' },
      h.caller
    )
  ).rejects.toMatchObject({ code: 'invalid' })
})
