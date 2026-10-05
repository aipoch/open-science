// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_LIMITS,
  prepareAnnotationsForAgent,
  resolveManagedProjectFileAnnotationIdentity,
  sanitizeAnnotation
} from '../../../../shared/annotations'
import { parseUploadVersionReference } from '../../../../shared/uploads'
import type { SessionDiscussionCapture } from './replay/replay-context'
import {
  createSessionDiscussionAnnotation,
  replayAnnotationId,
  replayAnnotationTarget,
  sessionDiscussionQuote
} from './session-discussion-annotation'
import { applyDocToDom, domToDoc, docToMessageParts } from './composer/composer-doc'
import { replayReferenceText, splitReplayReferenceText } from './replay-reference-text'

const context: SessionDiscussionCapture = {
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
  it('retains discussion scope without changing native source or snapshot identity', () => {
    for (const contextId of [undefined, 'snapshot']) {
      const annotation = createSessionDiscussionAnnotation(
        { ...context, scope: 'session' },
        contextId
      )!
      expect(replayAnnotationTarget(annotation)).toMatchObject({
        scope: 'session',
        stepId: context.stepId
      })
      expect(replayAnnotationTarget(annotation)?.contextId).toBe(contextId)
    }
  })

  it('keeps an immutable step offset and source identity through ordinary annotations', () => {
    const annotation = createSessionDiscussionAnnotation(context)!
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
    expect(annotation.quote).toContain('print(result)')
    expect(annotation.quote).not.toContain('checksum')
    expect(annotation.quote).not.toContain('activity: two')
  })
  it('refuses forged source identities and malformed local locators', () => {
    const annotation = createSessionDiscussionAnnotation(context)!
    expect(
      replayAnnotationTarget({
        ...annotation,
        source: { kind: 'agent-message', sessionId: 'another-source', messageId: 'id' }
      })
    ).toBeUndefined()
    expect(replayAnnotationTarget({ ...annotation, id: 'session-replay:%broken' })).toBeUndefined()
    expect(
      replayAnnotationTarget({
        ...annotation,
        id: replayAnnotationId({ ...context, stepOffsetMs: -1 })
      })
    ).toBeUndefined()
  })
  it('uses the native Notebook run identity for the shared reading card', () => {
    expect(
      createSessionDiscussionAnnotation({
        ...context,
        evidence: [{ kind: 'notebook-run', id: 'run', projectId: 'project', sessionId: 'source' }]
      })
    ).toMatchObject({ source: { kind: 'session-item', itemType: 'notebook-run', itemId: 'run' } })
  })
  it('binds historical artifacts to their exact version and bounds the quote', () => {
    const annotation = createSessionDiscussionAnnotation({
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
    expect(annotation.quote).not.toContain('version-old')
    expect(annotation.quote).toContain('incomplete or truncated')
  })

  it('binds an archived upload to its saved replay selection without guessing its original owner', () => {
    const uploadContext: SessionDiscussionCapture = {
      ...context,
      stepId: 'resource:upload-version:upload-v1',
      stepTitle: 'observations.csv',
      stepNumber: 3,
      evidence: [
        {
          kind: 'upload-version',
          id: 'upload-v1',
          projectId: 'project',
          sessionId: 'source',
          fileId: 'original-upload-file',
          versionId: 'upload-v1'
        }
      ]
    }
    const annotation = createSessionDiscussionAnnotation(uploadContext, 'saved-upload')!
    expect(annotation).toMatchObject({
      source: {
        kind: 'project-file',
        projectId: 'project',
        sessionId: 'source',
        fileSource: 'upload',
        sourceFileId: 'original-upload-file',
        versionId: 'upload-v1',
        path: 'upload-version:upload-v1'
      }
    })
    expect(sanitizeAnnotation(annotation)).toEqual(annotation)
    if (annotation.source.kind !== 'project-file') throw new Error('Expected upload source')
    expect(resolveManagedProjectFileAnnotationIdentity(annotation.source)).toEqual({
      fileSource: 'upload',
      fileId: 'original-upload-file',
      versionId: 'upload-v1'
    })
    expect(parseUploadVersionReference(annotation.source.path)).toEqual({ versionId: 'upload-v1' })
    expect(replayAnnotationTarget(annotation)).toEqual({
      projectId: 'project',
      sourceSessionId: 'source',
      branchId: 'branch',
      stepId: uploadContext.stepId,
      stepOffsetMs: 142,
      contextId: 'saved-upload'
    })
    const prepared = prepareAnnotationsForAgent('Explain this file', [annotation])
    expect(prepared.promptText).toBe(
      'Explain this file\n[Session reading](#session-replay:project:saved-upload)'
    )
    expect(prepared.referencedArtifacts).toBeUndefined()

    // Legacy inline annotation transport would mistake the archive Session for the upload owner.
    expect(createSessionDiscussionAnnotation(uploadContext)).toBeUndefined()
    for (const field of ['fileId', 'versionId'] as const) {
      expect(
        createSessionDiscussionAnnotation(
          { ...uploadContext, evidence: [{ ...uploadContext.evidence[0], [field]: undefined }] },
          'saved-upload'
        )
      ).toBeUndefined()
    }
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
    const annotation = createSessionDiscussionAnnotation(dense, 'saved-context')!
    expect(replayAnnotationTarget(annotation)).toMatchObject({
      contextId: 'saved-context',
      stepOffsetMs: 142
    })
    expect(annotation.quote).toContain('Session: Research')
    expect(annotation.quote).not.toContain('Critical visible result')
    expect(annotation.quote).not.toContain('saved-context')
    expect(annotation.quote).not.toContain('host.sessions')
    expect(annotation.quote).not.toContain('Preview is truncated.')
    expect(annotation.quote.length).toBeLessThanOrEqual(ANNOTATION_LIMITS.quote)
    expect(sessionDiscussionQuote(dense, 12000).length).toBeLessThanOrEqual(12000)
    expect(
      replayAnnotationTarget({
        ...annotation,
        id:
          'session-replay:' +
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
