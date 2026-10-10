import { describe, expect, it, vi } from 'vitest'
import { ResearchReplayClient } from './research-client'
import { ReplayViewerClient } from './client'
import {
  researchFixture,
  researchRecordingFixture,
  researchSelectionFixture
} from './research-replay.test-support'
import { researchResults, researchResourcePosition } from './research-materials'
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

describe('scoped research browser reads', () => {
  it('reports transport/authorization failures, not missing files or cancelled reads', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new ResearchReplayClient(fetcher)
    const listener = vi.fn()
    const unsubscribe = client.onConnectionFailure(listener)
    fetcher.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(client.context()).rejects.toMatchObject({ kind: 'unavailable' })
    expect(listener).not.toHaveBeenCalled()
    fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(client.context()).rejects.toMatchObject({ kind: 'authorization' })
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'authorization' }))
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(client.context()).rejects.toMatchObject({ kind: 'network' })
    expect(listener).toHaveBeenCalledTimes(2)
    const abort = new AbortController()
    abort.abort()
    fetcher.mockRejectedValueOnce(new Error('cancelled'))
    await expect(client.context(abort.signal)).rejects.toThrow('cancelled')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(client.context()).rejects.toMatchObject({ kind: 'network' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('anchors a file question to its saved publication while watching a different moment', () => {
    const { document, timing } = researchFixture()
    const resource = {
      id: 'report',
      name: 'report.txt',
      projectId: 'local-project',
      sessionId: 'local-session',
      versionId: 'report-v1',
      artifactId: 'report',
      availability: 'recorded' as const,
      createdAt: 9000
    }
    document.resources.push(resource)
    document.branches[0].steps[1].resourceIds.push(resource.id)
    const playback = {
      branchId: 'main',
      positionMs: 2000,
      recordedAt: 3000,
      playing: false,
      speed: 1,
      onSeekRecordedAt: vi.fn()
    }
    expect(
      researchResourcePosition(document, timing.recordedTimeOrigins, resource, playback)
    ).toMatchObject({ branchId: 'main', stepId: 'activity', timeMs: 8000, recordedAt: 9000 })
    expect(playback.positionMs).toBe(2000)
  })
  it('accepts only read-only research context and rejects execution capabilities', async () => {
    const context = {
      mode: 'research',
      viewerId: 'research-viewer',
      target: { projectId: 'local-project', sessionId: 'local-session' },
      expiresAt: 12345,
      presentation: 'browser',
      canInteract: false,
      canCancel: false,
      canReadArtifacts: true
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(context))
    const client = new ReplayViewerClient(fetcher)
    expect(await client.context()).toEqual(context)
    fetcher.mockResolvedValueOnce(json({ ...context, canInteract: true }))
    await expect(client.context()).rejects.toMatchObject({ kind: 'invalid-response' })
  })
  it('checks the receiving research and exact recording version before mounting historical content', async () => {
    const research = researchFixture(),
      payload = researchRecordingFixture()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(research))
      .mockResolvedValueOnce(json(payload))
    const client = new ResearchReplayClient(fetcher)
    expect(await client.document(research.document.source)).toEqual(research)
    expect(await client.researchRecording(research.recordings[0])).toEqual(payload)
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      '/api/research/document',
      '/api/research/read'
    ])
    fetcher.mockResolvedValueOnce(
      json({
        ...research,
        document: {
          ...research.document,
          source: { ...research.document.source, sessionId: 'another-copy' }
        }
      })
    )
    await expect(client.document(research.document.source)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
    fetcher.mockResolvedValueOnce(
      json({ ...payload, receiving: { ...payload.receiving, versionId: 'another-version' } })
    )
    await expect(client.researchRecording(research.recordings[0])).rejects.toMatchObject({
      kind: 'invalid-response'
    })
  })
  it('requires authoritative timing instead of deriving a new clock from filtered history', async () => {
    const research = researchFixture()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ...research, timing: undefined }))
      .mockResolvedValueOnce(
        json({
          ...research,
          timing: {
            ...research.timing,
            timelineCoverage: { main: [{ startedAt: 3000, endedAt: 1000 }] }
          }
        })
      )
    const client = new ResearchReplayClient(fetcher)
    await expect(client.document(research.document.source)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
    await expect(client.document(research.document.source)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
  })
  it('saves the exact click position and rejects substituted selections', async () => {
    const research = researchFixture(),
      position = {
        branchId: 'main',
        stepId: 'activity',
        timeMs: 3400,
        recordedAt: 4400,
        recordingId: 'index-version',
        offsetMs: 1400
      }
    const saved = researchSelectionFixture(research.document, position)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(saved))
    const client = new ResearchReplayClient(fetcher)
    expect(await client.selectResearch(research.document, position)).toEqual(saved)
    expect(fetcher).toHaveBeenCalledWith(
      '/api/research/select',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        credentials: 'same-origin',
        body: JSON.stringify(position)
      })
    )
    fetcher.mockResolvedValueOnce(json({ ...saved, position: { ...position, offsetMs: 1500 } }))
    await expect(client.selectResearch(research.document, position)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
    fetcher.mockResolvedValueOnce(
      json({ ...saved, source: { ...saved.source, fingerprint: 'changed-history' } })
    )
    await expect(client.researchSelection(research.document)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
  })
  it('builds media URLs only for verified saved bytes and retains containers as technical attachments', () => {
    const research = researchFixture(),
      payload = researchRecordingFixture(),
      client = new ResearchReplayClient()
    expect(client.researchMediaUrl('index-version', payload, 'media-0')).toBe(
      '/api/research/media?recordingId=index-version&mediaKey=media-0'
    )
    expect(
      client.researchMediaUrl(
        'index-version',
        { ...payload, media: [{ ...payload.media[0], checksum: 'c'.repeat(64) }] },
        'media-0'
      )
    ).toBeNull()
    research.document.resources = [
      {
        id: 'index',
        name: 'recording.json',
        projectId: 'local-project',
        sessionId: 'local-session',
        artifactId: 'index',
        versionId: 'index-version',
        availability: 'recorded',
        createdAt: 10000
      },
      {
        id: 'report',
        name: 'report.md',
        projectId: 'local-project',
        sessionId: 'local-session',
        artifactId: 'report',
        versionId: 'report-version',
        availability: 'recorded',
        createdAt: 9000
      }
    ]
    expect(
      researchResults(research.document, [{ descriptor: research.recordings[0], payload }]).map(
        (entry) => ({
          name: entry.resource.name,
          technical: entry.technical,
          availableAt: entry.availableAt
        })
      )
    ).toEqual([
      { name: 'recording.json', technical: true, availableAt: 10000 },
      { name: 'report.md', technical: false, availableAt: 9000 }
    ])
  })
})
