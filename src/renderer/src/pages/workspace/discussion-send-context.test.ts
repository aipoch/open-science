// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionReplayStore } from '@/stores/session-replay-store'
import type { SaveSessionDiscussionSnapshotRequest } from '../../../../shared/session-replay'
import type { ReplayStepContext } from './replay/replay-context'
import {
  captureDiscussionSendContext,
  prepareDiscussionSendAnnotations
} from './discussion-send-context'
import { createReplayStepAnnotation, replayAnnotationTarget } from './research-replay-context'

const focus = (): ReplayStepContext => ({
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
const binding = {
  projectId: 'project',
  sessionId: 'source',
  contextId: 'old',
  title: 'Study',
  branchId: 'main',
  promptMessageId: 'previous'
}

afterEach(() => {
  useSessionReplayStore.setState({ playhead: undefined })
  vi.unstubAllGlobals()
})

it('captures only at Send, freezes evidence and retains the frame across async preparation', async () => {
  const current = focus()
  const capture = vi.fn(() => current)
  let finish!: () => void
  const save = vi.fn<(request: SaveSessionDiscussionSnapshotRequest) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  vi.stubGlobal('window', { api: { sessionReplay: { saveSelectionSnapshot: save } } })
  useSessionReplayStore.setState({ playhead: { ...current, capture } })
  current.stepId = 'two'
  current.stepNumber = 2
  expect(save).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()
  const frozen = captureDiscussionSendContext([], binding, 'discussion')!
  const original = createReplayStepAnnotation(focus(), 'old')!
  const ordinary = { ...original, id: 'ordinary' }
  const annotations = [ordinary, original]
  const preparing = prepareDiscussionSendAnnotations(annotations, frozen)
  current.stepId = 'three'
  current.evidence[0].id = 'different-message'
  finish()
  const result = await preparing
  expect(save.mock.calls[0][0]).toMatchObject({
    context: {
      stepId: 'two',
      stepNumber: 2,
      stepOffsetMs: 50,
      scope: 'step',
      evidence: [{ id: 'message' }]
    }
  })
  expect(replayAnnotationTarget(result[1])).toMatchObject({
    stepId: 'two',
    scope: 'step',
    stepOffsetMs: 50
  })
  expect(result[0]).toBe(ordinary)
  expect(annotations).toEqual([ordinary, original])
})

it('matches the selected source, ignores self and unrelated replay, and preserves focus with no visible source', () => {
  const capture = vi.fn(focus)
  useSessionReplayStore.setState({ playhead: { ...focus(), capture } })
  expect(captureDiscussionSendContext([], undefined, 'discussion')).toBeUndefined()
  expect(captureDiscussionSendContext([], binding, 'source')).toBeUndefined()
  expect(
    captureDiscussionSendContext([], { ...binding, projectId: 'other' }, 'discussion')
  ).toBeUndefined()
  const other = createReplayStepAnnotation(
    {
      ...focus(),
      sourceSessionId: 'other',
      evidence: [{ kind: 'message', id: 'message', projectId: 'project', sessionId: 'other' }]
    },
    'other'
  )!
  expect(captureDiscussionSendContext([other], binding, 'discussion')).toBeUndefined()
  expect(capture).not.toHaveBeenCalled()
  expect(
    captureDiscussionSendContext(
      [createReplayStepAnnotation(focus(), 'old')!],
      undefined,
      'discussion'
    )
  ).toMatchObject({ stepId: 'one' })
  useSessionReplayStore.setState({ playhead: undefined })
  expect(captureDiscussionSendContext([], binding, 'discussion')).toBeUndefined()
})

it('rejects failed saves without mutating the original message annotations', async () => {
  vi.stubGlobal('window', {
    api: {
      sessionReplay: {
        saveSelectionSnapshot: vi.fn().mockRejectedValue(new Error('disk unavailable'))
      }
    }
  })
  const annotations = [createReplayStepAnnotation(focus(), 'old')!]
  await expect(prepareDiscussionSendAnnotations(annotations, focus())).rejects.toThrow(
    'disk unavailable'
  )
  expect(replayAnnotationTarget(annotations[0])?.contextId).toBe('old')
})
