import { describe, expect, it } from 'vitest'

import {
  ANNOTATION_LIMITS,
  annotationPayloadText,
  imageAnnotationSourceIsFixed,
  parseSideChatAnnotationText,
  prepareAnnotationsForAgent,
  sanitizeAnnotations,
  sideChatAnnotationText,
  validateAnnotations,
  type Annotation,
  type ImagePointAnnotation,
  type PdfAnnotation,
  type TextAnnotation
} from './annotations'

const textAnnotation = (overrides: Partial<TextAnnotation> = {}): TextAnnotation => ({
  id: 'annotation-1',
  kind: 'text',
  target: 'agent',
  quote: 'The confidence intervals overlap.',
  source: {
    kind: 'agent-message',
    sessionId: 'session-1',
    messageId: 'message-1'
  },
  ...overrides
})

const imageAnnotation = (): ImagePointAnnotation => ({
  id: 'image-1',
  kind: 'image-point',
  target: 'agent',
  note: 'Inspect the peak.',
  source: {
    kind: 'artifact-version',
    projectId: 'project-1',
    sessionId: 'session-1',
    versionId: 'version-1',
    name: 'figure.png',
    path: 'artifact-version:project-1/session-1/artifact-1/version-1',
    mimeType: 'image/png'
  },
  point: { x: 0.5, y: 0.25 },
  naturalSize: { width: 1000, height: 800 }
})

const pdfAnnotation = (overrides: Partial<PdfAnnotation> = {}): PdfAnnotation => ({
  id: 'pdf-1',
  kind: 'pdf',
  target: 'agent',
  source: {
    kind: 'upload-version',
    projectId: 'project-1',
    sessionId: 'session-1',
    versionId: 'version-7',
    name: 'paper.pdf',
    path: 'upload-version:project-1/session-1/version-7',
    checksum: 'a'.repeat(64)
  },
  selector: {
    kind: 'text',
    pageNumber: 4,
    exact: 'The confidence intervals overlap.',
    prefix: 'Result: ',
    suffix: ' This matters.',
    position: { start: 8, end: 41 },
    quads: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
    extractorVersion: 'pdfjs-5.4.624'
  },
  ...overrides
})

const pdfRegionAnnotation = (): PdfAnnotation => ({
  ...pdfAnnotation(),
  id: 'pdf-region-1',
  selector: {
    kind: 'region',
    pageNumber: 6,
    rect: { x: 0.2, y: 0.3, width: 0.4, height: 0.25 },
    pageRotation: 0,
    text: 'Figure 2. Retrieval evaluator.',
    image: { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
  }
})

describe('annotations', () => {
  it('projects mixed annotations into canonical Side chat text without an image attachment', () => {
    const annotations: Annotation[] = [
      textAnnotation({ note: 'Explain this caveat.' }),
      imageAnnotation()
    ]
    const expected =
      'Compare these observations.\n\n[Annotations]\n' +
      '{"items":[{"type":"quote","content":"The confidence intervals overlap.","instruction":"Explain this caveat."},{"type":"image-point","source":{"kind":"artifact-version","artifactId":"artifact-1","versionId":"version-1","name":"figure.png"},"x":500,"y":200,"instruction":"Inspect the peak."}]}'

    expect(sideChatAnnotationText('  Compare these observations.  ', annotations)).toBe(expected)
    expect(expected).not.toContain('imageAttachment')
    expect(parseSideChatAnnotationText(expected)).toEqual({
      text: 'Compare these observations.',
      items: [
        {
          type: 'quote',
          content: 'The confidence intervals overlap.',
          instruction: 'Explain this caveat.'
        },
        {
          type: 'image-point',
          source: {
            kind: 'artifact-version',
            artifactId: 'artifact-1',
            versionId: 'version-1',
            name: 'figure.png'
          },
          x: 500,
          y: 200,
          instruction: 'Inspect the peak.'
        }
      ]
    })
  })

  it('projects and parses an annotation-only Side chat message', () => {
    const projected = sideChatAnnotationText('', [textAnnotation()])

    expect(projected).toBe(
      '[Annotations]\n{"items":[{"type":"quote","content":"The confidence intervals overlap."}]}'
    )
    expect(parseSideChatAnnotationText(projected)).toEqual({
      text: '',
      items: [{ type: 'quote', content: 'The confidence intervals overlap.' }]
    })
  })

  it.each([
    ['malformed JSON', '[Annotations]\n{"items":'],
    [
      'unknown payload field',
      '[Annotations]\n{"items":[{"type":"quote","content":"Evidence","future":true}]}'
    ],
    ['unknown item type', '[Annotations]\n{"items":[{"type":"future","content":"Evidence"}]}'],
    ['trailing text', '[Annotations]\n{"items":[{"type":"quote","content":"Evidence"}]}\ntrailing'],
    [
      'noncanonical JSON whitespace',
      '[Annotations]\n{ "items": [{"type":"quote","content":"Evidence"}]}'
    ],
    ['empty items', '[Annotations]\n{"items":[]}'],
    [
      'excessive quote',
      `[Annotations]\n${JSON.stringify({
        items: [{ type: 'quote', content: 'x'.repeat(ANNOTATION_LIMITS.quote + 1) }]
      })}`
    ]
  ])('treats %s as ordinary Side chat text', (_reason, value) => {
    expect(parseSideChatAnnotationText(value)).toBeUndefined()
  })

  it('uses the complete EOF suffix when the user text contains the annotation marker', () => {
    const projected = sideChatAnnotationText('Explain the literal marker [Annotations]\n here.', [
      textAnnotation()
    ])

    expect(parseSideChatAnnotationText(projected)).toEqual({
      text: 'Explain the literal marker [Annotations]\n here.',
      items: [{ type: 'quote', content: 'The confidence intervals overlap.' }]
    })
  })

  it('serializes text annotations as bounded structured Agent context', () => {
    expect(annotationPayloadText([textAnnotation({ note: 'Explain this caveat.' })])).toBe(
      '[Annotations]\n' +
        JSON.stringify({
          items: [
            {
              type: 'quote',
              content: 'The confidence intervals overlap.',
              instruction: 'Explain this caveat.'
            }
          ]
        })
    )
  })

  it('keeps immutable PDF text anchors in persisted and Agent context', () => {
    const annotation = pdfAnnotation()

    const sanitized = sanitizeAnnotations([annotation])

    expect(sanitized).toEqual([annotation])
    expect(annotationPayloadText(sanitized)).toBe(
      '[Annotations]\n' +
        JSON.stringify({
          items: [
            {
              type: 'quote',
              content: 'The confidence intervals overlap.',
              source: {
                kind: 'pdf',
                versionId: 'version-7',
                name: 'paper.pdf',
                checksum: 'a'.repeat(64),
                page: 4,
                selector: {
                  prefix: 'Result: ',
                  suffix: ' This matters.',
                  position: { start: 8, end: 41 },
                  quads: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.03 }],
                  extractorVersion: 'pdfjs-5.4.624'
                }
              }
            }
          ]
        })
    )
    expect(parseSideChatAnnotationText(sideChatAnnotationText('', sanitized))).toEqual({
      text: '',
      items: [
        {
          type: 'quote',
          content: 'The confidence intervals overlap.',
          source: expect.objectContaining({
            kind: 'pdf',
            versionId: 'version-7',
            checksum: 'a'.repeat(64),
            page: 4
          })
        }
      ]
    })
    expect(
      sanitizeAnnotations([
        {
          ...annotation,
          selector: { ...annotation.selector, pageNumber: 0 }
        }
      ])
    ).toEqual([])
  })

  it('keeps a bounded PDF region image out of prompt text and returns it as visual input', () => {
    const annotation = pdfRegionAnnotation()
    const sanitized = sanitizeAnnotations([annotation])

    expect(sanitized).toEqual([annotation])
    expect(annotationPayloadText(sanitized)).toContain('"type":"pdf-region"')
    expect(annotationPayloadText(sanitized)).not.toContain('AQID')
    expect(prepareAnnotationsForAgent('', sanitized).images).toEqual([
      { mimeType: 'image/png', data: 'AQID', byteLength: 3 }
    ])
  })

  it('sanitizes and serializes a Session item text annotation', () => {
    const annotation = textAnnotation({
      source: {
        kind: 'session-item',
        sessionId: '  session-1  ',
        itemId: '  activity-1  ',
        itemType: 'tool-activity',
        sectionId: '  output  '
      }
    })

    const sanitized = sanitizeAnnotations([annotation])

    expect(sanitized).toEqual([
      textAnnotation({
        source: {
          kind: 'session-item',
          sessionId: 'session-1',
          itemId: 'activity-1',
          itemType: 'tool-activity',
          sectionId: 'output'
        }
      })
    ])
    expect(annotationPayloadText(sanitized)).toBe(
      '[Annotations]\n' +
        JSON.stringify({
          items: [
            {
              type: 'quote',
              content: 'The confidence intervals overlap.'
            }
          ]
        })
    )
  })

  it('rejects a Session item annotation with an unknown item type', () => {
    expect(
      sanitizeAnnotations([
        {
          ...textAnnotation(),
          source: {
            kind: 'session-item',
            sessionId: 'session-1',
            itemId: 'activity-1',
            itemType: 'unknown-item'
          }
        }
      ])
    ).toEqual([])
  })

  it('rejects excessive count, quote, note, and aggregate payloads', () => {
    expect(
      validateAnnotations(
        Array.from({ length: ANNOTATION_LIMITS.count + 1 }, (_, index) =>
          textAnnotation({ id: `annotation-${index}` })
        )
      )
    ).toBe('too-many')
    expect(
      validateAnnotations([textAnnotation({ quote: 'x'.repeat(ANNOTATION_LIMITS.quote + 1) })])
    ).toBe('quote-too-long')
    expect(
      validateAnnotations([textAnnotation({ note: 'x'.repeat(ANNOTATION_LIMITS.note + 1) })])
    ).toBe('note-too-long')
    expect(
      validateAnnotations([
        textAnnotation({ quote: 'x'.repeat(ANNOTATION_LIMITS.quote) }),
        textAnnotation({ id: 'annotation-2', quote: 'y'.repeat(ANNOTATION_LIMITS.quote) }),
        textAnnotation({ id: 'annotation-3', quote: 'z'.repeat(ANNOTATION_LIMITS.quote) })
      ])
    ).toBe('payload-too-large')
    expect(validateAnnotations([textAnnotation()], 'x'.repeat(100_000))).toBe('payload-too-large')
    expect(validateAnnotations([], 'x'.repeat(100_001))).toBeUndefined()
  })

  it('sanitizes persisted input and drops invalid or duplicate annotations', () => {
    expect(
      sanitizeAnnotations([
        textAnnotation({ note: '  useful note  ' }),
        textAnnotation({ note: 'duplicate' }),
        { kind: 'text', quote: '', source: {} },
        { kind: 'future-kind' }
      ])
    ).toEqual([textAnnotation({ note: 'useful note' })])
  })

  it.each([
    {
      kind: 'artifact-version' as const,
      path: 'artifact-version:project-1/session-1/artifact-1/version-1'
    },
    {
      kind: 'upload-version' as const,
      path: 'upload-version:project-1/session-1/version-1'
    }
  ])('accepts a fixed $kind identity only when every locator field matches', ({ kind, path }) => {
    const source = {
      kind,
      projectId: 'project-1',
      sessionId: 'session-1',
      versionId: 'version-1',
      name: 'figure.png',
      path,
      mimeType: 'image/png'
    }
    expect(imageAnnotationSourceIsFixed(source)).toBe(true)
    expect(imageAnnotationSourceIsFixed({ ...source, versionId: 'current-version' })).toBe(false)
    expect(imageAnnotationSourceIsFixed({ ...source, path: '/mutable/current/figure.png' })).toBe(
      false
    )
    expect(imageAnnotationSourceIsFixed({ ...source, mimeType: 'image/gif' })).toBe(false)
  })
})
