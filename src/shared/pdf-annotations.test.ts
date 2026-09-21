import { describe, expect, it } from 'vitest'
import {
  createPdfAnnotationRequestSchema,
  updatePdfAnnotationRequestSchema,
  deletePdfAnnotationRequestSchema,
  listPdfAnnotationsRequestSchema,
  type CreatePdfAnnotationRequest
} from './pdf-annotations'

export const annotationRequest: CreatePdfAnnotationRequest = {
  id: 'annotation-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  kind: 'highlight',
  color: 'yellow',
  tagIds: ['review'],
  note: 'Check this passage',
  target: {
    source: {
      kind: 'upload-version',
      projectId: 'project-1',
      sessionId: 'source-session',
      sourceFileId: 'file-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'upload-version:version-1'
    },
    selector: {
      kind: 'text',
      pageNumber: 1,
      pageRotation: 0,
      coordinateVersion: 1,
      extractorVersion: 'pdfjs-test',
      exact: 'A passage',
      position: { start: 0, end: 9 },
      quads: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.02 }]
    }
  }
}

describe('PDF annotation contract', () => {
  it.each(['highlight', 'underline', 'squiggly', 'strikethrough'])(
    'accepts a %s text mark',
    (kind) => {
      expect(
        createPdfAnnotationRequestSchema.safeParse({ ...annotationRequest, kind }).success
      ).toBe(true)
    }
  )
  it.each(['area', 'page-note', 'document-note'])('rejects mismatched %s geometry', (kind) => {
    expect(createPdfAnnotationRequestSchema.safeParse({ ...annotationRequest, kind }).success).toBe(
      false
    )
  })
  it('rejects style metadata inside the geometry and unbounded notes', () => {
    expect(
      createPdfAnnotationRequestSchema.safeParse({
        ...annotationRequest,
        target: {
          ...annotationRequest.target,
          selector: { ...annotationRequest.target.selector, color: 'pink' }
        }
      }).success
    ).toBe(false)
    expect(
      createPdfAnnotationRequestSchema.safeParse({ ...annotationRequest, note: 'a'.repeat(20_001) })
        .success
    ).toBe(false)
  })
  it.each([
    null,
    {},
    { source: null, selector: null },
    { source: annotationRequest.target.source, selector: { kind: 'text' } }
  ])('rejects malformed targets without throwing: %j', (target) => {
    expect(
      createPdfAnnotationRequestSchema.safeParse({ ...annotationRequest, target }).success
    ).toBe(false)
  })
  it('accepts document notes without fabricating page coordinates', () => {
    expect(
      createPdfAnnotationRequestSchema.safeParse({
        ...annotationRequest,
        kind: 'document-note',
        target: {
          ...annotationRequest.target,
          selector: { kind: 'document-note', coordinateVersion: 1 }
        }
      }).success
    ).toBe(true)
  })
})

it('validates history restoration timestamps and conditional mutation tokens', () => {
  expect(
    createPdfAnnotationRequestSchema.safeParse({
      ...annotationRequest,
      createdAt: '2020-01-01T00:00:00.000Z'
    }).success
  ).toBe(true)
  expect(
    createPdfAnnotationRequestSchema.safeParse({ ...annotationRequest, createdAt: 'yesterday' })
      .success
  ).toBe(false)
  const scope = { id: 'a', projectId: 'p', sessionId: 's' }
  expect(
    updatePdfAnnotationRequestSchema.safeParse({
      ...scope,
      color: null,
      expectedUpdatedAt: '2026-09-19T00:00:00.000Z'
    }).success
  ).toBe(true)
  expect(
    deletePdfAnnotationRequestSchema.safeParse({ ...scope, expectedUpdatedAt: '' }).success
  ).toBe(false)
})

it('requires one complete scope and binds global Literature writes to the exact PDF version', () => {
  const global = {
    ...annotationRequest,
    projectId: undefined,
    sessionId: undefined,
    literatureVersionId: 'version-1',
    target: {
      ...annotationRequest.target,
      source: {
        ...annotationRequest.target.source,
        projectId: undefined,
        sessionId: undefined,
        kind: 'literature-attachment-version'
      }
    }
  }
  expect(createPdfAnnotationRequestSchema.safeParse(global).success).toBe(true)
  for (const change of [
    { projectId: 'project-1' },
    { sessionId: 'session-1' },
    { literatureVersionId: 'other' }
  ])
    expect(createPdfAnnotationRequestSchema.safeParse({ ...global, ...change }).success).toBe(false)
  expect(
    createPdfAnnotationRequestSchema.safeParse({ ...global, target: annotationRequest.target })
      .success
  ).toBe(false)
  expect(listPdfAnnotationsRequestSchema.safeParse({ projectId: 'p1' }).success).toBe(true)
  for (const scope of [
    {},
    { sessionId: 's1' },
    { projectId: 'p1', sessionId: 's1', literatureVersionId: 'v1' }
  ])
    expect(listPdfAnnotationsRequestSchema.safeParse(scope).success).toBe(false)
})
