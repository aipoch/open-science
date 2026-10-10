// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { TextAnnotation } from '../../../../shared/annotations'
import type { SaveSessionDiscussionSnapshotRequest } from '../../../../shared/session-replay'
import type { SessionDiscussionCapture } from './replay/replay-context'
import { prepareDiscussionSendAnnotations } from './discussion-send-context'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationTarget
} from './session-discussion-annotation'

const focus = (): SessionDiscussionCapture => ({
  projectId: 'project',
  sourceSessionId: 'source',
  sourceTitle: 'Study',
  fingerprint: 'fp',
  branchId: 'main',
  stepId: 'one',
  stepNumber: 1,
  stepOffsetMs: 50,
  excerpt: 'saved evidence',
  evidence: [{ kind: 'message', id: 'message', projectId: 'project', sessionId: 'source' }]
})
const ordinary = (): TextAnnotation => ({
  id: 'ordinary',
  kind: 'text',
  target: 'agent',
  source: { kind: 'agent-message', sessionId: 'source', messageId: 'message' },
  quote: 'Quoted text'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each(['step', 'session'] as const)(
  'retains an explicit %s selection instead of replacing it with an older queued capture',
  async (scope) => {
    const save = vi.fn()
    vi.stubGlobal('window', { api: { sessionReplay: { saveSelectionSnapshot: save } } })
    const selected = createSessionDiscussionAnnotation({ ...focus(), scope }, 'selected')!
    const annotations = [ordinary(), selected]
    const result = await prepareDiscussionSendAnnotations(annotations, {
      ...focus(),
      scope: 'step',
      stepId: 'two',
      stepNumber: 2
    })
    expect(result).toEqual(annotations)
    expect(replayAnnotationTarget(result[1])).toMatchObject({
      contextId: 'selected',
      stepId: 'one',
      scope
    })
    expect(save).not.toHaveBeenCalled()
  }
)

it('freezes legacy queued evidence while awaiting storage without mutating ordinary annotations', async () => {
  const current = focus()
  let finish!: () => void
  const save = vi.fn<(request: SaveSessionDiscussionSnapshotRequest) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal('window', { api: { sessionReplay: { saveSelectionSnapshot: save } } })
  const annotations = [ordinary()]
  const preparing = prepareDiscussionSendAnnotations(annotations, current)
  current.stepId = 'two'
  current.evidence[0].id = 'different-message'
  finish()
  const result = await preparing
  expect(save.mock.calls[0][0]).toMatchObject({
    context: {
      stepId: 'one',
      stepNumber: 1,
      stepOffsetMs: 50,
      evidence: [{ id: 'message' }]
    }
  })
  expect(replayAnnotationTarget(result[1])).toMatchObject({ stepId: 'one', stepOffsetMs: 50 })
  expect(result[0]).toBe(annotations[0])
  expect(annotations).toEqual([ordinary()])
})

it('rejects failed legacy saves without changing the capture or original annotations', async () => {
  vi.stubGlobal('window', {
    api: {
      sessionReplay: {
        saveSelectionSnapshot: vi.fn().mockRejectedValue(new Error('disk unavailable'))
      }
    }
  })
  const annotations = [ordinary()]
  const capture = focus()
  const before = structuredClone(capture)
  await expect(prepareDiscussionSendAnnotations(annotations, capture)).rejects.toThrow(
    'disk unavailable'
  )
  expect(annotations).toEqual([ordinary()])
  expect(capture).toEqual(before)
})
