// @vitest-environment jsdom
import { expect, it } from 'vitest'
import type { SessionDiscussionCapture } from './replay/replay-context'
import { discussionDraftAnnotations } from './discussion-send-context'
import { createSessionDiscussionAnnotation } from './session-discussion-annotation'

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
const binding = {
  projectId: 'project',
  sessionId: 'source',
  contextId: 'old',
  title: 'Study',
  branchId: 'main',
  promptMessageId: 'previous'
}

it('restores a previously unlinked child from its own saved parent reference', () => {
  const own = createSessionDiscussionAnnotation(focus(), 'saved')!
  const foreign = createSessionDiscussionAnnotation(
    { ...focus(), sourceSessionId: 'other' },
    'foreign'
  )!
  const child = {
    id: 'child',
    projectId: 'project',
    parentSessionId: 'source',
    messages: [
      { id: 'first', role: 'user', annotations: [own] },
      { id: 'later', role: 'user', annotations: [foreign] }
    ]
  }
  expect(discussionDraftAnnotations(child, [foreign])).toEqual([own])
  expect(
    discussionDraftAnnotations(
      {
        ...child,
        runtimeContext: { revision: 1, sessionContext: { version: 1, bindings: [binding] } }
      },
      [foreign]
    )
  ).toEqual([])
})

it('uses the existing reading binding for a plain follow-up and stages only explicit Ask annotations', () => {
  const old = createSessionDiscussionAnnotation(focus(), 'old')!
  const next = createSessionDiscussionAnnotation({ ...focus(), stepId: 'two' }, 'next')!
  const child = {
    id: 'child',
    projectId: 'project',
    parentSessionId: 'source',
    messages: [{ id: binding.promptMessageId, role: 'user', annotations: [old] }],
    runtimeContext: { revision: 1, sessionContext: { version: 1 as const, bindings: [binding] } }
  }
  expect(discussionDraftAnnotations(child, [next])).toEqual([next])
  expect(discussionDraftAnnotations(child, [])).toEqual([])
})
