import { describe, expect, it, vi } from 'vitest'
import { recordedFixture } from '../../main/run-observation/recorded-viewer.test-support'
import { captureRecordedObservationSelection } from '../../shared/recorded-observation-selection'
import type {
  ResearchReplayDocument,
  ResearchReplayRecording,
  ResearchReplayPosition,
  ResearchReplaySelection
} from '../../shared/research-replay'
import { researchFixture, researchSelectionFixture } from './research-replay.test-support'
import type { RecordedObservationPayload } from '../../shared/run-observation-recorded'
import { ResearchReplayClient } from './research-client'

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

function fixture(): {
  research: ResearchReplayDocument
  payload: RecordedObservationPayload
  descriptor: ResearchReplayRecording
  position: ResearchReplayPosition
  selection: ResearchReplaySelection
} {
  const research = researchFixture()
  const payload = {
    ...recordedFixture().payload,
    receiving: {
      projectId: research.document.source.projectId,
      sessionId: research.document.source.sessionId,
      artifactId: 'state-artifact',
      versionId: 'state-version'
    }
  }
  payload.archive.records[0].observedAt = 3000
  payload.archive.records[0].run!.startedAt = 2500
  payload.archive.records[0].run!.endedAt = 2900
  payload.archive.coverage.firstObservedAt = 3000
  payload.archive.coverage.lastObservedAt = 3000
  payload.archive.capturedAt = 3500
  const owner = research.document.branches[0].steps[1]
  owner.runs = [
    {
      runId: 'receiver-run',
      cellId: 'cell',
      source: 'agent',
      kernelKind: 'bash',
      status: 'completed',
      startedAt: 2500,
      endedAt: 2900
    }
  ]
  const descriptor = {
    id: 'state-version',
    kind: 'run-observation' as const,
    target: payload.receiving,
    name: 'States'
  }
  research.recordings.push(descriptor)
  research.document.resources.push({
    ...payload.receiving,
    id: descriptor.id,
    name: 'States.json',
    availability: 'recorded',
    checksum: 'a'.repeat(64)
  })
  research.observationBindings = [
    {
      target: payload.receiving,
      recordingId: payload.archive.recordingId,
      archiveChecksum: 'a'.repeat(64),
      runId: 'receiver-run',
      branchIds: ['main'],
      basis: 'import-receipt'
    }
  ]
  const position: ResearchReplayPosition = {
    branchId: 'main',
    stepId: owner.id,
    timeMs: 3500,
    recordedAt: 4500,
    observation: { recordingId: descriptor.id, stepKey: payload.archive.records[0].stepKey }
  }
  const selection: ResearchReplaySelection = {
    ...researchSelectionFixture(research.document, position),
    inspection: 'recorded-observation',
    observation: captureRecordedObservationSelection(payload, position.observation!.stepKey, {
      selectionId: 'saved-selection',
      selectedAt: 12000
    })
  }
  return { research, payload, descriptor, position, selection }
}

describe('research observation selection verification', () => {
  it('preserves ordinary selections with omitted optional UI hints', async () => {
    const research = researchFixture()
    const position: ResearchReplayPosition = {
      branchId: 'main',
      stepId: 'request',
      timeMs: 0,
      scope: undefined,
      notebookRunId: undefined,
      inspectStep: undefined
    }
    const selection = researchSelectionFixture(research.document, position)
    const client = new ResearchReplayClient(
      vi.fn<typeof fetch>().mockResolvedValue(json(selection))
    )
    expect(await client.selectResearch(research.document, position)).toEqual(
      JSON.parse(JSON.stringify(selection))
    )
  })
  it('uses the same selection identity and exact payload for Ask and later readback', async () => {
    const { research, payload, descriptor, position, selection } = fixture()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(research))
      .mockResolvedValueOnce(json(payload))
      .mockResolvedValueOnce(json(selection))
      .mockResolvedValueOnce(json(selection))
    const client = new ResearchReplayClient(fetcher)
    await client.document(research.document.source)
    const mutable = await client.researchRecording(descriptor)
    if ('archive' in mutable) mutable.archive.records[0].run!.logs.stdout.text = 'Client mutation'
    expect(await client.selectResearch(research.document, position)).toEqual(selection)
    expect(await client.researchSelection(research.document)).toEqual(selection)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it.each(['logs', 'future', 'identity', 'missing', 'selector'] as const)(
    'rejects a mismatched %s response rather than accepting client-provided history',
    async (change) => {
      const { research, payload, descriptor, position, selection } = fixture()
      if (change === 'logs') selection.observation!.record.run!.logs.stdout.text = 'Forged log'
      if (change === 'future') selection.position = { ...position, timeMs: 1000, recordedAt: 2000 }
      if (change === 'identity') selection.observation!.receiving.versionId = 'another-version'
      if (change === 'missing') delete selection.observation
      if (change === 'selector')
        selection.position.observation = { ...position.observation!, stepKey: 'other-step' }
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(research))
        .mockResolvedValueOnce(json(payload))
        .mockResolvedValueOnce(json(selection))
      const client = new ResearchReplayClient(fetcher)
      await client.document(research.document.source)
      await client.researchRecording(descriptor)
      await expect(
        client.selectResearch(
          research.document,
          change === 'future' ? selection.position : position
        )
      ).rejects.toMatchObject({ kind: 'invalid-response' })
    }
  )
})
