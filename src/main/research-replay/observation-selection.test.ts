import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ReplayDocument } from '../../shared/replay'
import type { ResearchReplayDocument, ResearchReplayPosition } from '../../shared/research-replay'
import type { RecordedObservationPayload } from '../../shared/run-observation-recorded'
import { recordedFixture } from '../run-observation/recorded-viewer.test-support'
import { researchReplayHarness } from './test-support'

type TestHarness = ReturnType<typeof researchReplayHarness>
async function fixture(preparing = false): Promise<{
  h: TestHarness
  view: Awaited<ReturnType<TestHarness['service']['open']>>
  research: ResearchReplayDocument
  payload: RecordedObservationPayload
  position: ResearchReplayPosition
}> {
  const h = researchReplayHarness()
  const payload = {
    ...recordedFixture().payload,
    receiving: { ...h.target, artifactId: 'artifact', versionId: 'version' }
  }
  const record = payload.archive.records[0]
  record.observedAt = 2500
  record.phase = 'running'
  record.run!.status = 'running'
  record.run!.startedAt = 2000
  delete record.run!.endedAt
  record.run!.logs.stdout.text = 'Only the first saved state'
  payload.archive.coverage.firstObservedAt = 2500
  payload.archive.coverage.lastObservedAt = 2500
  payload.archive.coverage.terminalRunObserved = false
  payload.archive.capturedAt = 2600
  if (preparing) {
    const beforeRun = structuredClone(record)
    beforeRun.stepKey = 'preparing-state'
    beforeRun.observedAt = 1500
    beforeRun.phase = 'preparing'
    beforeRun.run = null
    record.sourceEvidence.cursor.sequence = 1
    payload.archive.records.unshift(beforeRun)
    payload.archive.coverage.firstObservedAt = 1500
  }
  const content = Buffer.from(JSON.stringify(payload.archive))
  const checksum = createHash('sha256').update(content).digest('hex')
  h.session.artifacts![0].sha256 = checksum
  h.session.artifacts![0].size = content.length
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
      rawOutput: 'LATER FINAL OUTPUT'
    }
  ]
  vi.mocked(h.dependencies.reader.notebook.runIndex!).mockResolvedValue([
    {
      runId: 'receiver-run',
      cellId: 'cell',
      source: 'agent',
      kernelKind: 'bash',
      status: 'completed',
      startedAt: 2000,
      endedAt: 4000,
      promptMessageId: 'q',
      executionInvocationId: 'invoke',
      hasOutput: true
    }
  ])
  const lineage = await h.dependencies.reader.artifacts.getLineage({
    projectId: 'project',
    appSessionId: 'session',
    artifactId: 'artifact'
  })
  if (!lineage || 'failure' in lineage) throw new Error('Invalid fixture')
  Object.assign(lineage.versions[0], { checksum, size: content.length })
  vi.mocked(h.dependencies.reader.artifacts.getLineage).mockResolvedValue(lineage)
  const input = await h.dependencies.immutable.resolveVersion({
    projectId: 'project',
    sourceKind: 'artifact-version',
    inputFileVersionId: 'version'
  })
  vi.mocked(h.dependencies.immutable.resolveVersion).mockResolvedValue({
    ...input!,
    checksum,
    sizeBytes: content.length
  })
  vi.mocked(h.dependencies.immutable.openContent).mockResolvedValue({
    readRange: async () => content,
    verifyUnchanged: async () => undefined,
    close: async () => undefined
  } as never)
  vi.mocked(h.dependencies.recordings.read).mockResolvedValue(payload)
  h.dependencies.observationBindings = vi.fn(async (document: ReplayDocument) => [
    {
      target: payload.receiving,
      recordingId: payload.archive.recordingId,
      archiveChecksum: checksum,
      runId: 'receiver-run',
      branchIds: [document.branches[0].id],
      basis: 'import-receipt' as const
    }
  ])
  const view = await h.service.open(h.target, h.caller)
  const research = await h.service.document(view.viewerId, h.caller)
  const branch = research.document.branches[0]
  const step = branch.steps.find((item) => item.runs.some((run) => run.runId === 'receiver-run'))!
  const position: ResearchReplayPosition = {
    branchId: branch.id,
    stepId: step.id,
    timeMs: 3500,
    recordedAt: 4500,
    observation: {
      recordingId: research.recordings[0].id,
      stepKey: payload.archive.records[0].stepKey
    }
  }
  return { h, view, research, payload, position }
}

describe('exact archived state selections in the research viewer', () => {
  it('references a preparing sample before the Notebook run exists without advancing its evidence cutoff', async () => {
    const { h, view, position } = await fixture(true)
    const selected = await h.service.select(view.viewerId, position, h.caller)
    expect(selected.observation?.record).toMatchObject({
      observedAt: 1500,
      phase: 'preparing',
      run: null
    })
    expect(selected.position).toEqual(position)
    expect(selected.step.id).toBe(position.stepId)
    expect(selected.step.runs).toEqual([])
    expect(selected.step.activities).toEqual([])
    expect(selected.step.resourceIds).toEqual([])
    expect(selected.evidence).toEqual([])
    expect(selected.step.message).toBeUndefined()
    expect(JSON.stringify(selected)).not.toContain('LATER FINAL OUTPUT')
    expect(JSON.stringify(selected)).not.toContain('Only the first saved state')
    expect(JSON.stringify(selected)).not.toContain('print(1)')
    expect(
      (await h.service.selection(view.viewerId, h.caller, selected.selectionId))?.observation
        ?.record.observedAt
    ).toBe(1500)
    await expect(
      h.service.select(view.viewerId, { ...position, timeMs: 499, recordedAt: 1499 }, h.caller)
    ).rejects.toMatchObject({ code: 'invalid' })
  })
  it('freezes the selected earlier state without including final output at a later watching position', async () => {
    const { h, view, position, research } = await fixture()
    const before = research.document.branches.flatMap((branch) =>
      branch.steps.map((step) => step.id)
    )
    const selected = await h.service.select(view.viewerId, position, h.caller)
    expect(selected.inspection).toBe('recorded-observation')
    expect(selected.observation).toMatchObject({
      selectionId: selected.selectionId,
      selectedAt: selected.selectedAt,
      receiving: { versionId: 'version' },
      record: { observedAt: 2500 }
    })
    expect(selected.phase).toBe('activity')
    expect(JSON.stringify(selected)).not.toContain('LATER FINAL OUTPUT')
    expect(JSON.stringify(selected)).toContain('Only the first saved state')
    selected.observation!.record.run!.logs.stdout.text = 'Mutated'
    expect(
      (await h.service.selection(view.viewerId, h.caller, selected.selectionId))?.observation
        ?.record.run?.logs.stdout.text
    ).toBe('Only the first saved state')
    expect(
      (await h.service.document(view.viewerId, h.caller)).document.branches.flatMap((branch) =>
        branch.steps.map((step) => step.id)
      )
    ).toEqual(before)
    h.setCurrent(false)
    await expect(
      h.service.selection(view.viewerId, h.caller, selected.selectionId)
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })
  it('rejects future states, absent records, conflicting selectors, wrong owners and expired sources', async () => {
    const { h, view, position, research } = await fixture()
    const bad = [
      { ...position, timeMs: 1000, recordedAt: 2000 },
      { ...position, observation: { ...position.observation!, stepKey: 'missing' } },
      { ...position, notebookRunId: 'receiver-run' },
      { ...position, resourceId: 'artifact-version:version' },
      { ...position, recordingId: position.observation!.recordingId },
      { ...position, stepId: research.document.branches[0].steps[0].id }
    ]
    for (const input of bad)
      await expect(h.service.select(view.viewerId, input, h.caller)).rejects.toMatchObject({
        code: 'invalid'
      })
    await expect(
      h.service.select(
        view.viewerId,
        {
          ...position,
          observation: { ...position.observation!, recordingId: 'foreign' }
        },
        h.caller
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await h.service.revoke(view.viewerId, h.caller)
    await expect(h.service.select(view.viewerId, position, h.caller)).rejects.toMatchObject({
      code: 'unavailable'
    })
  })
  it('fails closed when no verified observation association exists', async () => {
    const { h, position } = await fixture()
    h.dependencies.observationBindings = vi.fn(async () => [])
    const view = await h.service.open(h.target, h.caller)
    await expect(h.service.select(view.viewerId, position, h.caller)).rejects.toMatchObject({
      code: 'invalid'
    })
  })
  it.each(['checksum', 'branch', 'run'] as const)('rejects stale %s bindings', async (change) => {
    const { h, position } = await fixture()
    const resolve = h.dependencies.observationBindings!
    h.dependencies.observationBindings = async (...args) => {
      const bindings = await resolve(...args)
      if (change === 'checksum') bindings[0].archiveChecksum = '0'.repeat(64)
      if (change === 'branch') bindings[0].branchIds = ['foreign-branch']
      if (change === 'run') bindings[0].runId = 'foreign-run'
      return bindings
    }
    const view = await h.service.open(h.target, h.caller)
    await expect(h.service.select(view.viewerId, position, h.caller)).rejects.toMatchObject({
      code: 'invalid'
    })
  })
})
