import { describe, expect, it, vi } from 'vitest'
import type { ReplayResource } from '../../../../../shared/replay'
import { recordedObservationTargetSchema } from '../../../../../shared/run-observation-recorded'
import {
  discoverRecordingPage,
  recordingCandidates,
  mergeRecordingCandidates,
  RECORDING_DISCOVERY_PAGE_SIZE,
  type RecordingCandidate
} from './recording-discovery'

const source = { projectId: 'receiver-project', sessionId: 'receiver-session' }
const resource = (overrides: Partial<ReplayResource> = {}): ReplayResource => ({
  id: 'version',
  name: 'renamed.json',
  ...source,
  artifactId: 'artifact',
  versionId: 'version',
  availability: 'recorded',
  mimeType: 'application/json',
  ...overrides
})
const archive = {
  content: '{"format":"open-science-run-observation","version":1,"records":[',
  encoding: 'utf8' as const,
  size: 10000,
  truncated: true
}

describe('receiving source recording discovery', () => {
  it('discovers portable web recordings by content and preserves their receiving target', async () => {
    const read = vi.fn().mockResolvedValue({
      ...archive,
      content: '{"format":"open-science-web-recording","version":1,"recordingId":'
    })
    const page = await discoverRecordingPage(recordingCandidates([resource()], source), read)
    expect(page.recordings).toHaveLength(1)
    expect(page.recordings[0]).toMatchObject({
      format: 'web-recording',
      target: { ...source, artifactId: 'artifact', versionId: 'version' }
    })
  })
  it('projects only the receiving viewer identity from a complete Replay source', async () => {
    const replaySource = { ...source, title: 'Received study', fingerprint: 'source-fingerprint' }
    const page = await discoverRecordingPage(
      recordingCandidates([resource()], replaySource),
      vi.fn().mockResolvedValue(archive)
    )
    expect(page.recordings).toHaveLength(1)
    // openRecorded and its recorded reader deliberately use this strict schema. Source display
    // metadata must not cross that IPC boundary, even though structural typing accepts it here.
    expect(recordedObservationTargetSchema.parse(page.recordings[0].target)).toEqual({
      projectId: source.projectId,
      sessionId: source.sessionId,
      artifactId: 'artifact',
      versionId: 'version'
    })
  })
  it('retains every immutable version and never searches another import, upload or binary file', async () => {
    const candidates = recordingCandidates(
      [
        resource({ versionId: 'old', versionNumber: 1 }),
        resource({ versionId: 'new', versionNumber: 2 }),
        resource({ sessionId: 'other-import' }),
        resource({ projectId: 'author-project' }),
        resource({ source: 'upload' }),
        resource({ name: 'frame.png', mimeType: 'image/png' }),
        resource({ artifactId: undefined }),
        resource({ locator: '/author/machine/archive.json' })
      ],
      source
    )
    const read = vi.fn().mockResolvedValue(archive)
    const page = await discoverRecordingPage(candidates, read)
    expect(page.recordings.map(({ target }) => target.versionId)).toEqual(['old', 'new'])
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[0][0]).toMatchObject({
      ...source,
      fileId: 'artifact',
      versionId: 'old',
      maxBytes: 4096,
      encoding: 'utf8'
    })
    expect(read.mock.calls[0][0].path).not.toContain('author')
  })

  it('deduplicates exact versions but excludes conflicting Artifact identity', () => {
    expect(recordingCandidates([resource(), resource()], source)).toHaveLength(1)
    expect(recordingCandidates([resource(), resource({ artifactId: 'other' })], source)).toEqual([])
  })

  it('does not treat a JSON filename as a recording and reports missing bytes without latest fallback', async () => {
    const candidates = recordingCandidates(
      [
        resource({ versionId: 'missing', availability: 'unavailable' }),
        resource({ versionId: 'ordinary' }),
        resource({ versionId: 'failed' })
      ],
      source
    )
    const read = vi
      .fn()
      .mockResolvedValueOnce({ ...archive, content: '{"some":"json"}', truncated: false })
      .mockRejectedValueOnce(new Error('Gone'))
    const page = await discoverRecordingPage(candidates, read)
    expect(page).toMatchObject({ recordings: [], unavailable: 2, unchecked: 0 })
    expect(read.mock.calls.map(([request]) => request.versionId)).toEqual(['ordinary', 'failed'])
  })

  it('bounds reads to one page, lets callers continue, and only keeps content header matches', async () => {
    const candidates = recordingCandidates(
      Array.from({ length: 35 }, (_, index) => resource({ versionId: `v-${index}` })),
      source
    )
    const read = vi.fn().mockResolvedValue(archive)
    const first = await discoverRecordingPage(candidates, read)
    expect(read).toHaveBeenCalledTimes(RECORDING_DISCOVERY_PAGE_SIZE)
    expect(first.unchecked).toBe(3)
    const next = await discoverRecordingPage(candidates, read, first.nextOffset)
    expect(next.recordings.map(({ target }) => target.versionId)).toEqual(['v-32', 'v-33', 'v-34'])
    expect(next.unchecked).toBe(0)
  })

  it('cancels remaining work when the source changes', async () => {
    const controller = new AbortController()
    const read = vi.fn().mockImplementation(async () => {
      controller.abort()
      return archive
    })
    await expect(
      discoverRecordingPage(
        recordingCandidates(
          Array.from({ length: 10 }, (_, index) => resource({ versionId: `v-${index}` })),
          source
        ),
        read,
        0,
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(read.mock.calls.length).toBeLessThanOrEqual(2)
  })
})

describe('publisher web recording checkpoint catalog', () => {
  const recordingId = 'fc7a7883-8c41-4c55-8b32-3a15ef8a7021'
  const index = (
    checkpoint: number | null,
    overrides: Partial<ReplayResource> = {}
  ): ReplayResource =>
    resource({
      artifactId: `artifact-${checkpoint ?? 'final'}`,
      versionId: `version-${checkpoint ?? 'final'}`,
      name: `web-recording-${recordingId}${checkpoint === null ? '' : `-checkpoint-${checkpoint}`}.json`,
      ...overrides
    })
  const web = (id = recordingId): typeof archive => ({
    ...archive,
    content: `{"format":"open-science-web-recording","version":1,"recordingId":"${id}","media":[`
  })
  it.each([true, false])(
    'prefers final over concurrent checkpoint reads regardless of order (final first: %s)',
    async (finalFirst) => {
      const resources = [index(2), index(5)]
      resources.splice(finalFirst ? 0 : 2, 0, index(null))
      const read = vi.fn(async ({ versionId }) => {
        if (versionId === 'version-final') await new Promise((done) => setTimeout(done, 10))
        return web()
      })
      const page = await discoverRecordingPage(recordingCandidates(resources, source), read)
      expect(page.recordings).toHaveLength(1)
      expect(page.recordings[0]).toMatchObject({
        target: { ...source, artifactId: 'artifact-final', versionId: 'version-final' },
        format: 'web-recording',
        browserIndex: { recordingId, checkpoint: null }
      })
      expect(read).toHaveBeenCalledTimes(3)
    }
  )
  it('uses the latest available checkpoint when the final or a later checkpoint cannot be read', async () => {
    const page = await discoverRecordingPage(
      recordingCandidates(
        [index(2), index(5), index(10, { availability: 'unavailable' }), index(null)],
        source
      ),
      vi.fn(async ({ versionId }) => {
        if (versionId === 'version-final') throw new Error('Final unavailable')
        return web()
      })
    )
    expect(page.recordings.map((candidate) => candidate.target.versionId)).toEqual(['version-5'])
    expect(page.unavailable).toBe(2)
  })
  it('replaces a checkpoint with a final discovered on a later page without mutating either exact target', async () => {
    // Exercise an incremental feed in which the final index only appears on a later page,
    // independently of the initial complete-resource-list probe prioritization.
    const candidates: RecordingCandidate[] = [
      index(1),
      ...Array.from({ length: 31 }, (_, n) => resource({ versionId: `ordinary-${n}` })),
      index(8),
      index(null)
    ].map((resource) => ({
      resource,
      target: { ...source, artifactId: resource.artifactId!, versionId: resource.versionId! }
    }))
    const read = vi.fn(async ({ versionId }) =>
      versionId.startsWith('ordinary-')
        ? { ...archive, content: '{"ordinary":true}', truncated: false }
        : web()
    )
    const first = await discoverRecordingPage(candidates, read)
    const opened = first.recordings[0]
    expect(opened.target.versionId).toBe('version-1')
    const second = await discoverRecordingPage(candidates, read, first.nextOffset)
    expect(second.nextOffset).toBe(34)
    expect(
      mergeRecordingCandidates(first.recordings, second.recordings).map(
        (candidate) => candidate.target.versionId
      )
    ).toEqual(['version-final'])
    expect(
      mergeRecordingCandidates(second.recordings, first.recordings).map(
        (candidate) => candidate.target.versionId
      )
    ).toEqual(['version-final'])
    expect(opened.target.versionId).toBe('version-1')
  })
  it('keeps renamed materials, mismatched IDs, old image/observation formats and ordinary JSON independent', async () => {
    const otherId = '418a28d5-c9fe-451e-8a55-a37b5b27fe9e'
    const candidates = recordingCandidates(
      [
        index(1),
        index(null),
        index(2, { name: 'custom-project-recording.json' }),
        index(3, { name: `web-recording-${otherId}-checkpoint-3.json` }),
        index(4),
        index(5),
        index(6)
      ],
      source
    )
    const page = await discoverRecordingPage(
      candidates,
      vi.fn(async ({ versionId }) => {
        if (versionId === 'version-4')
          return {
            ...archive,
            content: '{"format":"open-science-project-recording","version":1,"recordingId":"same"}',
            truncated: false
          }
        if (versionId === 'version-5') return archive
        if (versionId === 'version-6')
          return { ...archive, content: '{"ordinary":true}', truncated: false }
        return web()
      })
    )
    expect(page.recordings).toHaveLength(5)
    expect(
      page.recordings.map((candidate) => [candidate.target.versionId, candidate.format])
    ).toEqual(
      expect.arrayContaining([
        ['version-final', 'web-recording'],
        ['version-2', 'web-recording'],
        ['version-3', 'web-recording'],
        ['version-4', 'project-recording'],
        ['version-5', undefined]
      ])
    )
    expect(
      page.recordings.find((candidate) => candidate.target.versionId === 'version-2')?.browserIndex
    ).toBeUndefined()
    expect(
      page.recordings.find((candidate) => candidate.target.versionId === 'version-3')?.browserIndex
    ).toBeUndefined()
  })
  it.each([true, false])(
    'finds the final or newest checkpoint within the first bounded page (final: %s)',
    async (includeFinal) => {
      const resources = [
        resource({ versionId: 'ordinary-before' }),
        ...Array.from({ length: 1200 }, (_, n) => index(n + 1)),
        resource({ versionId: 'legacy-middle', name: 'project-recording.json' }),
        ...(includeFinal ? [index(null)] : []),
        resource({ versionId: 'ordinary-after' })
      ]
      const candidates = recordingCandidates(resources, source)
      const read = vi.fn(async () => web())
      const first = await discoverRecordingPage(candidates, read)
      expect(read).toHaveBeenCalledTimes(RECORDING_DISCOVERY_PAGE_SIZE)
      expect(first.recordings.map((candidate) => candidate.target.versionId)).toEqual([
        includeFinal ? 'version-final' : 'version-1200'
      ])
      expect(
        candidates
          .filter((candidate) => !candidate.resource.name.startsWith('web-recording-'))
          .map((candidate) => candidate.target.versionId)
      ).toEqual(['ordinary-before', 'legacy-middle', 'ordinary-after'])
      expect(
        candidates.every(
          (candidate) => candidate.format === undefined && candidate.browserIndex === undefined
        )
      ).toBe(true)
    }
  )
  it('only prioritizes strict generated names and still rejects ordinary JSON with a generated filename', async () => {
    const candidates = recordingCandidates(
      [
        resource({ versionId: 'ordinary', name: 'ordinary.json' }),
        index(10, { name: `web-recording-${recordingId}-checkpoint-010.json` }),
        index(100, { name: 'web-recording-not-a-uuid.json' }),
        index(null)
      ],
      source
    )
    expect(candidates.map((candidate) => candidate.target.versionId)).toEqual([
      'version-final',
      'ordinary',
      'version-10',
      'version-100'
    ])
    const page = await discoverRecordingPage(
      candidates,
      vi.fn(async () => ({ ...archive, content: '{"ordinary":true}', truncated: false }))
    )
    expect(page.recordings).toEqual([])
  })
  it('groups complete content headers too, never an ID outside the verified root header', async () => {
    const page = await discoverRecordingPage(
      recordingCandidates([index(1), index(null)], source),
      vi.fn(async () => ({
        ...archive,
        content: JSON.stringify({ version: 1, recordingId, format: 'open-science-web-recording' }),
        truncated: false
      }))
    )
    expect(page.recordings).toHaveLength(1)
    const incomplete = await discoverRecordingPage(
      recordingCandidates([index(1), index(null)], source),
      vi.fn(async () => ({
        ...archive,
        content: `{"format":"open-science-web-recording","version":1,"other":{"recordingId":"${recordingId}",`
      }))
    )
    expect(incomplete.recordings).toHaveLength(2)
    expect(incomplete.recordings.every((candidate) => !candidate.browserIndex)).toBe(true)
  })
})
