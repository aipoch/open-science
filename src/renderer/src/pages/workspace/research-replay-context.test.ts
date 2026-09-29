// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ANNOTATION_LIMITS } from '../../../../shared/annotations'
import type { ReplayStepContext } from './replay/replay-context'
import {
  createReplayStepAnnotation,
  referenceReplaySource,
  replayAnnotationId,
  replayAnnotationTarget,
  replayQuestionQuote
} from './research-replay-context'
import { applyDocToDom, domToDoc, docToMessageParts } from './composer/composer-doc'
import { replayReferenceText, splitReplayReferenceText } from './replay-reference-text'

const context: ReplayStepContext = {
  projectId: 'project',
  sourceSessionId: 'source',
  sourceTitle: 'Research',
  fingerprint: 'checksum',
  branchId: 'branch',
  stepId: 'activity:one',
  stepOffsetMs: 142,
  evidence: [
    { kind: 'activity', id: 'one', projectId: 'project', sessionId: 'source', part: 'input' }
  ],
  excerpt: 'print(result)'
}
describe('fixed replay question references', () => {
  it('keeps an immutable step offset and source identity through ordinary annotations', () => {
    const annotation = createReplayStepAnnotation(context)!
    context.evidence[0] = { ...context.evidence[0], id: 'two' }
    expect(annotation.source).toEqual({
      kind: 'session-item',
      sessionId: 'source',
      itemId: 'one',
      itemType: 'tool-activity'
    })
    expect(replayAnnotationTarget(annotation)).toEqual({
      projectId: 'project',
      sourceSessionId: 'source',
      branchId: 'branch',
      stepId: 'activity:one',
      stepOffsetMs: 142
    })
    expect(annotation.quote).toContain('[input]')
    expect(annotation.quote).toContain('checksum')
    expect(annotation.quote).not.toContain('activity: two')
  })
  it('refuses forged source identities and malformed local locators', () => {
    const annotation = createReplayStepAnnotation(context)!
    expect(
      replayAnnotationTarget({
        ...annotation,
        source: { kind: 'agent-message', sessionId: 'another-source', messageId: 'id' }
      })
    ).toBeUndefined()
    expect(replayAnnotationTarget({ ...annotation, id: 'research-replay:%broken' })).toBeUndefined()
    expect(
      replayAnnotationTarget({
        ...annotation,
        id: replayAnnotationId({ ...context, stepOffsetMs: -1 })
      })
    ).toBeUndefined()
  })
  it('does not fabricate a tool activity for a standalone Notebook run', () => {
    expect(
      createReplayStepAnnotation({
        ...context,
        evidence: [{ kind: 'notebook-run', id: 'run', projectId: 'project', sessionId: 'source' }]
      })
    ).toBeUndefined()
  })
  it('binds historical artifacts to their exact version and bounds the quote', () => {
    const annotation = createReplayStepAnnotation({
      ...context,
      excerpt: 'x'.repeat(10_000),
      evidence: [
        {
          kind: 'artifact-version',
          id: 'version-old',
          projectId: 'project',
          sessionId: 'source',
          artifactId: 'figure',
          versionId: 'version-old'
        }
      ]
    })!
    expect(annotation.source).toMatchObject({
      kind: 'project-file',
      sourceFileId: 'figure',
      versionId: 'version-old'
    })
    expect(annotation.quote.length).toBeLessThanOrEqual(ANNOTATION_LIMITS.quote)
    expect(annotation.quote).toContain('version-old')
  })
  it('preserves current references and reports the existing limit instead of dropping one', () => {
    const doc = referenceReplaySource({ nodes: [{ type: 'text', text: 'Why?' }] }, context)
    expect(referenceReplaySource(doc, context)).toBe(doc)
    expect(() =>
      referenceReplaySource(
        {
          nodes: Array.from({ length: 5 }, (_, index) => ({
            type: 'session' as const,
            sessionId: `other-${index}`,
            title: 'Other'
          }))
        },
        context
      )
    ).toThrow('Remove a session reference')
  })
  it('keeps dense-frame excerpts readable and resolves the new saved snapshot without breaking old locators', () => {
    const dense = {
      ...context,
      excerpt: 'Critical visible result',
      evidence: Array.from({ length: 108 }, (_, index) => ({
        ...context.evidence[0],
        id: `record-${index}-${'x'.repeat(100)}`
      }))
    }
    const annotation = createReplayStepAnnotation(dense, 'saved-context')!
    expect(replayAnnotationTarget(annotation)).toMatchObject({
      contextId: 'saved-context',
      stepOffsetMs: 142
    })
    expect(annotation.quote).toContain('Critical visible result')
    expect(annotation.quote).toContain('Preview is truncated.')
    expect(annotation.quote.length).toBeLessThanOrEqual(ANNOTATION_LIMITS.quote)
    expect(replayQuestionQuote(dense, 12000).length).toBeLessThanOrEqual(12000)
    expect(
      replayAnnotationTarget({
        ...annotation,
        id:
          'research-replay:' +
          encodeURIComponent(JSON.stringify(['project', 'source', 'branch', 'activity:one']))
      })
    ).toEqual({
      projectId: 'project',
      sourceSessionId: 'source',
      branchId: 'branch',
      stepId: 'activity:one',
      stepOffsetMs: 0
    })
  })
  it('renders a local reference as an editable atomic chip while persisting only existing text parts', () => {
    const token = replayReferenceText('abc-123', 'Replay step reference')
    const doc = { nodes: [{ type: 'text' as const, text: `Question ${token}\nRecorded code` }] }
    const root = document.createElement('div')
    applyDocToDom(root, doc)
    expect(root.textContent).toBe('Question Replay step reference\nRecorded code')
    expect(
      root.querySelector('[data-replay-reference-text]')?.getAttribute('contenteditable')
    ).toBe('false')
    expect(domToDoc(root)).toEqual(doc)
    expect(docToMessageParts(domToDoc(root))).toEqual(doc.nodes)
    root.querySelector('[data-replay-reference-text]')?.remove()
    expect(domToDoc(root).nodes).toEqual([{ type: 'text', text: 'Question \nRecorded code' }])
    expect(splitReplayReferenceText(token)[0]).toMatchObject({ kind: 'reference', id: 'abc-123' })
  })
})
